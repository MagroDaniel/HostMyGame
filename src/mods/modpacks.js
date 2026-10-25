// Minecraft modpacks from Modrinth (.mrpack) and CurseForge. Installing one turns the server into the pack's
// loader and versions, replaces mods/ and copies the pack's configs; worlds stay, and a full backup comes first.
import fs from 'node:fs';
import path from 'node:path';
import { TOOLS_DIR, save } from '../store.js';
import { copyOver, download, extract, httpError } from '../util.js';
import { createBackup } from '../backups.js';
import { LOADER_FILES, MC_JAVA } from '../manager.js';
import { CLASS, cf, searchProjects } from './curseforge.js';

const MR = 'https://api.modrinth.com/v2';
const UA = 'host-my-game/0.3 (painel local de servidores de jogos)';

export const supportsModpacks = inst => inst.template.provider === 'minecraft' && MC_JAVA.includes(inst.template.flavor);

async function mr(p) {
  const res = await fetch(MR + p, { headers: { 'User-Agent': UA } }).catch(e => { throw httpError(502, `Não foi possível falar com o Modrinth: ${e.message}`); });
  if (res.status === 404) return null;
  if (!res.ok) throw httpError(502, `Modrinth respondeu ${res.status}`);
  return res.json();
}

// ---- browsing ----
export async function search(source, query = '', offset = 0) {
  if (source === 'curseforge') return searchProjects({ classId: CLASS.modpacks, query, offset });
  const facets = encodeURIComponent(JSON.stringify([['project_type:modpack'], ['server_side!=unsupported']]));
  const r = await mr(`/search?query=${encodeURIComponent(query.trim())}&facets=${facets}&index=${query.trim() ? 'relevance' : 'downloads'}&limit=20&offset=${Number(offset) || 0}`);
  return {
    total: r.total_hits,
    hits: r.hits.map(h => ({ id: h.project_id, slug: h.slug, title: h.title, description: h.description, icon: h.icon_url || null, downloads: h.downloads, author: h.author, url: `https://modrinth.com/modpack/${h.slug}` })),
  };
}

const LOADER_NAMES = { forge: 'Forge', neoforge: 'NeoForge', fabric: 'Fabric', quilt: 'Quilt' };

// Versions of a pack, newest first, with the Minecraft version and loader each one needs.
export async function versions(source, projectId) {
  if (source === 'curseforge') {
    const files = (await cf(`/mods/${encodeURIComponent(projectId)}/files?pageSize=30`))?.data || [];
    return files.filter(f => !f.isServerPack).sort((a, b) => new Date(b.fileDate) - new Date(a.fileDate)).map(f => ({
      id: String(f.id), name: f.displayName, date: f.fileDate, serverPack: Boolean(f.serverPackFileId),
      gameVersion: f.gameVersions?.find(v => /^\d+\.\d+/.test(v)) || null,
      loader: f.gameVersions?.map(v => v.toLowerCase()).find(v => LOADER_NAMES[v]) || null,
    }));
  }
  const list = await mr(`/project/${encodeURIComponent(projectId)}/version`) || [];
  return list.map(v => ({ id: v.id, name: `${v.name || v.version_number}`, date: v.date_published, gameVersion: v.game_versions?.[0] || null, loader: v.loaders?.[0] || null, serverPack: false }));
}

// ---- installing ----
function inside(dir, rel) {
  const full = path.resolve(dir, rel);
  if (!full.startsWith(path.resolve(dir) + path.sep)) throw new Error(`Caminho inválido no modpack: ${rel}`);
  return full;
}

// The pack's single top folder, if it has one (many server packs are zipped inside a folder).
function rootOf(dir) {
  const entries = fs.readdirSync(dir);
  return entries.length === 1 && fs.statSync(path.join(dir, entries[0])).isDirectory() ? path.join(dir, entries[0]) : dir;
}

// Server packs ship their own start scripts and loader jars; the panel installs and starts the loader itself.
const SKIP_FROM_SERVER_PACK = name => /\.(jar|bat|sh|cmd|ps1|command|exe)$/i.test(name) || ['libraries', 'user_jvm_args.txt', 'eula.txt', 'versions'].includes(name.toLowerCase());

function copyFiltered(src, dest) {
  for (const name of fs.readdirSync(src)) {
    if (SKIP_FROM_SERVER_PACK(name)) continue;
    fs.cpSync(path.join(src, name), path.join(dest, name), { recursive: true, force: true });
  }
}

function parseCfLoader(id) {
  const m = String(id || '').match(/^(forge|neoforge|fabric|quilt)-(.+)$/i);
  if (!m) throw new Error(`Loader do modpack não reconhecido: ${id}`);
  return { flavor: m[1].toLowerCase(), version: m[2] };
}

// Reads what the pack needs and stages its content in a temp folder; returns how to apply it.
async function prepare(source, projectId, versionId, tmp, log) {
  if (source === 'curseforge') {
    const [mod, file] = await Promise.all([
      cf(`/mods/${encodeURIComponent(projectId)}`).then(r => r?.data),
      cf(`/mods/${encodeURIComponent(projectId)}/files/${encodeURIComponent(versionId)}`).then(r => r?.data),
    ]);
    if (!file) throw httpError(404, 'Versão do modpack não encontrada');
    if (!file.downloadUrl) throw httpError(400, `O autor de ${mod?.name} não permite download por programas. Baixe o server pack no site e envie pela aba Arquivos.`);
    log(`Baixando ${file.fileName}...`);
    await download(file.downloadUrl, path.join(tmp, 'pack.zip'));
    await extract(path.join(tmp, 'pack.zip'), path.join(tmp, 'pack'));
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'pack', 'manifest.json'), 'utf8'));
    const loader = parseCfLoader((manifest.minecraft.modLoaders.find(l => l.primary) || manifest.minecraft.modLoaders[0])?.id);
    let serverPack = null;
    if (file.serverPackFileId) {
      const sp = (await cf(`/mods/${encodeURIComponent(projectId)}/files/${file.serverPackFileId}`))?.data;
      if (sp?.downloadUrl) {
        log(`Baixando o server pack oficial (${sp.fileName})...`);
        await download(sp.downloadUrl, path.join(tmp, 'server.zip'));
        await extract(path.join(tmp, 'server.zip'), path.join(tmp, 'server'));
        serverPack = rootOf(path.join(tmp, 'server'));
      }
    }
    return {
      meta: { source, projectId: String(projectId), versionId: String(versionId), name: mod?.name || manifest.name, version: file.displayName, icon: mod?.logo?.thumbnailUrl || null, url: mod?.links?.websiteUrl || null },
      gameVersion: manifest.minecraft.version, loader,
      async apply(dir) {
        if (serverPack) return copyFiltered(serverPack, dir);
        log('Este modpack não tem server pack oficial; baixando os mods da lista do pack.');
        const ids = manifest.files.filter(f => f.required !== false).map(f => f.fileID);
        const files = ids.length ? (await cf('/mods/files', { fileIds: ids })).data : [];
        const mods = files.length ? (await cf('/mods', { modIds: [...new Set(files.map(f => f.modId))] })).data : [];
        const byId = Object.fromEntries(mods.map(m => [m.id, m]));
        const blocked = [];
        fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
        let n = 0;
        for (const f of files) {
          const m = byId[f.modId];
          if (m && m.classId !== CLASS.mods) continue; // resource packs, shaders: client side only
          if (!f.downloadUrl) { blocked.push(`${m?.name || f.displayName} (${m?.links?.websiteUrl || ''}/files/${f.id})`); continue; }
          log(`[${++n}/${files.length}] ${f.fileName}`);
          await download(f.downloadUrl, path.join(dir, 'mods', f.fileName), { sha1: f.hashes?.find(h => h.algo === 1)?.value });
        }
        const overrides = path.join(tmp, 'pack', manifest.overrides || 'overrides');
        if (fs.existsSync(overrides)) copyOver(overrides, dir);
        log('Atenção: packs sem server pack às vezes trazem mods só de cliente, que podem impedir o servidor de abrir. Se acontecer, desative o mod indicado no console pela aba Mods.');
        if (blocked.length) log(`Estes mods não permitem download por programas; baixe no site e envie pela aba Mods: ${blocked.join('; ')}`);
      },
    };
  }

  const v = await mr(`/version/${encodeURIComponent(versionId)}`);
  if (!v) throw httpError(404, 'Versão do modpack não encontrada');
  const project = await mr(`/project/${encodeURIComponent(projectId)}`);
  const pack = v.files.find(f => f.filename.endsWith('.mrpack')) || v.files[0];
  log(`Baixando ${pack.filename}...`);
  await download(pack.url, path.join(tmp, 'pack.zip'), { sha1: pack.hashes?.sha1 });
  await extract(path.join(tmp, 'pack.zip'), path.join(tmp, 'pack'));
  const index = JSON.parse(fs.readFileSync(path.join(tmp, 'pack', 'modrinth.index.json'), 'utf8'));
  const d = index.dependencies || {};
  const flavor = d.neoforge ? 'neoforge' : d.forge ? 'forge' : d['fabric-loader'] ? 'fabric' : d['quilt-loader'] ? 'quilt' : null;
  if (!flavor) throw httpError(400, 'O modpack não informa qual loader usa');
  return {
    meta: { source, projectId: String(projectId), versionId: String(versionId), name: project?.title || index.name, version: v.version_number, icon: project?.icon_url || null, url: project ? `https://modrinth.com/modpack/${project.slug}` : null },
    gameVersion: d.minecraft, loader: { flavor, version: d.neoforge || d.forge || d['fabric-loader'] || d['quilt-loader'] },
    async apply(dir) {
      const files = index.files.filter(f => f.env?.server !== 'unsupported');
      let n = 0;
      for (const f of files) {
        log(`[${++n}/${files.length}] ${path.basename(f.path)}`);
        await download(f.downloads[0], inside(dir, f.path), { sha1: f.hashes?.sha1 });
      }
      for (const o of ['overrides', 'server-overrides']) {
        const src = path.join(tmp, 'pack', o);
        if (fs.existsSync(src)) copyOver(src, dir);
      }
    },
  };
}

export async function install(inst, { source, projectId, versionId }, log) {
  if (!supportsModpacks(inst)) throw httpError(400, 'Modpacks só funcionam em servidores Minecraft Java');
  if (inst.busy) throw httpError(409, 'Pare o servidor antes de instalar um modpack');
  const tmp = path.join(TOOLS_DIR, 'modpack-tmp', inst.cfg.id);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  inst.setState('Installing');
  let plan;
  try {
    plan = await prepare(source === 'curseforge' ? 'curseforge' : 'modrinth', projectId, versionId, tmp, log);
    if (plan.loader.flavor === 'quilt') throw httpError(400, 'Modpacks de Quilt ainda não são suportados pelo painel');
    log(`${plan.meta.name} ${plan.meta.version}: Minecraft ${plan.gameVersion}, ${LOADER_NAMES[plan.loader.flavor]} ${plan.loader.version}.`);
    if (inst.cfg.installed) {
      log('Fazendo backup completo antes de instalar o modpack...');
      log(`Backup criado: ${await createBackup(inst, { note: `Antes do modpack ${plan.meta.name}` })} (aba Backups).`);
    }
    // The pack replaces mods and the loader; worlds and server.properties stay.
    for (const f of [...LOADER_FILES, 'mods']) fs.rmSync(path.join(inst.dir, f), { recursive: true, force: true });
    inst.cfg.templateId = `minecraft-${plan.loader.flavor}`;
    inst.cfg.settings.version = plan.gameVersion;
    inst.cfg.settings.loaderVersion = plan.loader.version;
    inst.cfg.installed = null;
    inst.cfg.curseforge = {};
    save();
  } catch (e) {
    inst.setState('Stopped');
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  inst.setState('Stopped');
  try {
    await inst.install();
    log('Baixando os arquivos do modpack...');
    await plan.apply(inst.dir);
    inst.cfg.modpack = { ...plan.meta, installedAt: Date.now() };
    if ((inst.cfg.settings.memoryMb || 0) < 6144) log('Dica: modpacks costumam precisar de 6 a 8 GB de RAM. Ajuste a memória na aba Inicialização.');
    save();
    log(`Modpack ${plan.meta.name} ${plan.meta.version} instalado. Inicie o servidor quando quiser.`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Newest version of the installed pack, if it differs from the one installed.
export async function checkUpdate(inst) {
  const p = inst.cfg.modpack;
  if (!p) return null;
  const list = await versions(p.source, p.projectId);
  const newest = list[0];
  return newest && newest.id !== p.versionId ? newest : null;
}
