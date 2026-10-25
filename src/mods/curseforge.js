// CurseForge (api.curseforge.com) for Minecraft mods and modpacks. The API needs a personal key, which each
// panel owner creates for free at console.curseforge.com and saves in Configurações; it is never shipped.
import fs from 'node:fs';
import path from 'node:path';
import { db, save } from '../store.js';
import { download, httpError, sleep } from '../util.js';
import { listInstalled } from './modrinth.js';

const API = 'https://api.curseforge.com/v1';
const MINECRAFT = 432;
export const CLASS = { mods: 6, modpacks: 4471 };
export const LOADER_TYPE = { forge: 1, fabric: 4, neoforge: 6 };
const LOADERS = Object.keys(LOADER_TYPE);

export const hasKey = () => Boolean(db.curseforgeKey);
export const supportsCurseForge = inst => inst.template.provider === 'minecraft' && LOADERS.includes(inst.template.flavor);

// CurseForge's servers don't all learn a key at the same time: for a while after it is created, the same valid
// key is refused by some of them at random. A refused request is retried a few times before giving up.
const KEY_RETRIES = 6;

export async function cf(pathAndQuery, body, key = db.curseforgeKey) {
  if (!key) throw httpError(400, 'Configure a chave da API do CurseForge em Configurações do painel');
  let res;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(API + pathAndQuery, {
        method: body ? 'POST' : 'GET',
        headers: { 'x-api-key': key, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw httpError(502, `Não foi possível falar com o CurseForge: ${e.message}`);
    }
    if ((res.status !== 403 && res.status !== 401) || attempt >= KEY_RETRIES) break;
    await res.arrayBuffer();
    await sleep(250 * attempt);
  }
  if (res.status === 403 || res.status === 401) {
    throw httpError(400, 'O CurseForge recusou a chave da API. Se você acabou de criar a chave, ela pode levar alguns minutos (às vezes horas) para funcionar em todos os servidores do CurseForge; tente de novo mais tarde. Se continuar, confira a chave em Configurações do painel.');
  }
  if (res.status === 404) return null;
  if (!res.ok) throw httpError(502, `CurseForge respondeu ${res.status}`);
  return res.json();
}

// Saves the key after checking it against the API, so a typo shows up right away.
export async function setKey(key) {
  const k = String(key || '').trim();
  if (k) await cf(`/games/${MINECRAFT}`, null, k);
  db.curseforgeKey = k;
  save();
}

export const cardOf = m => ({
  id: String(m.id), slug: m.slug, title: m.name, description: m.summary, icon: m.logo?.thumbnailUrl || null,
  downloads: m.downloadCount, author: m.authors?.[0]?.name || '', url: m.links?.websiteUrl || `https://www.curseforge.com/minecraft/search?search=${encodeURIComponent(m.name)}`,
});

export async function searchProjects({ classId, query = '', offset = 0, gameVersion, loader }) {
  const p = new URLSearchParams({ gameId: MINECRAFT, classId, index: Math.min(Number(offset) || 0, 9980), pageSize: 20, sortOrder: 'desc' });
  if (query.trim()) p.set('searchFilter', query.trim());
  else p.set('sortField', '2'); // popularity
  if (gameVersion) p.set('gameVersion', gameVersion);
  if (loader) p.set('modLoaderType', LOADER_TYPE[loader]);
  const r = await cf(`/mods/search?${p}`);
  return { total: Math.min(r.pagination?.totalCount || 0, 10000), hits: r.data.map(cardOf) };
}

const sha1Of = f => f.hashes?.find(h => h.algo === 1)?.value;

// Authors can forbid third-party downloads; then the API gives no URL and the file must come from the website.
function blocked(mod, file) {
  const page = mod?.links?.websiteUrl ? `${mod.links.websiteUrl}/files/${file.id}` : 'o site do CurseForge';
  return httpError(400, `O autor de ${mod?.name || file.displayName} não permite download por programas. Baixe ${file.fileName} em ${page} e envie pelo botão "Enviar .jar".`);
}

// ---- mods on an existing server ----
function target(inst) {
  if (!supportsCurseForge(inst)) throw httpError(400, 'Mods do CurseForge só funcionam em servidores Fabric, Forge ou NeoForge');
  const gameVersion = inst.cfg.installed?.version;
  if (!gameVersion) throw httpError(400, 'Instale o servidor primeiro para o painel saber a versão do Minecraft');
  return { loader: inst.template.flavor, gameVersion, dir: path.join(inst.dir, 'mods') };
}

export const search = (inst, query, offset) => {
  const t = target(inst);
  return searchProjects({ classId: CLASS.mods, query, offset, gameVersion: t.gameVersion, loader: t.loader });
};

async function compatibleFile(t, modId) {
  const p = new URLSearchParams({ gameVersion: t.gameVersion, modLoaderType: LOADER_TYPE[t.loader], pageSize: 50 });
  const files = (await cf(`/mods/${modId}/files?${p}`))?.data || [];
  const sorted = files.filter(f => f.isAvailable !== false).sort((a, b) => new Date(b.fileDate) - new Date(a.fileDate));
  return sorted.find(f => f.releaseType === 1) || sorted[0] || null;
}

// What the panel installed from CurseForge, by file name (without ".disabled"), so the list can show names and
// icons and updates can be found. Jars sent by hand that Modrinth recognizes are listed from Modrinth instead.
const records = inst => (inst.cfg.curseforge ??= {});
const baseName = f => String(f).replace(/\.disabled$/i, '');

export function annotate(inst, list) {
  const rec = records(inst);
  return list.map(m => {
    const r = rec[baseName(m.file)];
    if (!r || m.projectId) return m;
    return { ...m, source: 'curseforge', cfModId: r.modId, title: r.name, icon: r.icon, url: r.url, version: r.version };
  });
}

export function forget(inst, file) {
  delete records(inst)[baseName(file)];
  save();
}

// Mods already in mods/, whatever their source, keyed by project slug and by a normalized title. Most mods use the
// same slug on CurseForge and Modrinth (fabric-api, balm, cloth-config...), which is how a dependency that came
// from Modrinth or a modpack is recognized instead of being downloaded a second time.
const norm = s => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '');
async function presentMods(inst) {
  const list = annotate(inst, await listInstalled(inst));
  const slugs = new Set(), titles = new Set(), ids = new Set();
  for (const m of list) {
    if (m.slug) slugs.add(m.slug);
    if (m.cfModId) ids.add(String(m.cfModId));
    titles.add(norm(m.title));
  }
  for (const r of Object.values(records(inst))) { ids.add(String(r.modId)); if (r.slug) slugs.add(r.slug); }
  return { has: mod => ids.has(String(mod.id)) || slugs.has(mod.slug) || titles.has(norm(mod.name)) };
}

// Installs a mod plus its required dependencies; returns the file names that were added.
export async function install(inst, modId, log) {
  const t = target(inst);
  fs.mkdirSync(t.dir, { recursive: true });
  const rec = records(inst);
  const present = await presentMods(inst);
  const seen = new Set();
  const added = [];
  const queue = [String(modId)];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const mod = (await cf(`/mods/${id}`))?.data;
    if (mod && present.has(mod)) {
      if (id === String(modId)) throw httpError(409, `${mod.name} já está instalado neste servidor`);
      log(`${mod.name} já está instalado; mantendo o que existe.`);
      continue;
    }
    const file = await compatibleFile(t, id);
    if (!file) {
      if (id === String(modId)) throw httpError(400, `Não há versão compatível com ${t.loader} ${t.gameVersion}`);
      log(`Dependência ${mod?.name || id} não tem versão compatível; instale manualmente se o servidor reclamar.`);
      continue;
    }
    if (!file.downloadUrl) {
      if (id === String(modId)) throw blocked(mod, file);
      log(blocked(mod, file).message);
      continue;
    }
    log(`Baixando ${file.fileName}...`);
    await download(file.downloadUrl, path.join(t.dir, file.fileName), { sha1: sha1Of(file) });
    rec[file.fileName] = { modId: Number(id), fileId: file.id, slug: mod?.slug || null, name: mod?.name || file.displayName, version: file.displayName, icon: mod?.logo?.thumbnailUrl || null, url: mod?.links?.websiteUrl || null };
    save();
    added.push(file.fileName);
    for (const dep of file.dependencies || []) if (dep.relationType === 3) queue.push(String(dep.modId));
  }
  return added;
}

// Map of file name -> newer file for mods the panel installed from CurseForge.
export async function checkUpdates(inst) {
  if (!hasKey() || !supportsCurseForge(inst) || !inst.cfg.installed?.version) return {};
  const t = target(inst);
  const rec = records(inst);
  const present = fs.existsSync(t.dir) ? fs.readdirSync(t.dir) : [];
  const out = {};
  await Promise.all(present.map(async file => {
    const r = rec[baseName(file)];
    if (!r) return;
    const next = await compatibleFile(t, r.modId).catch(() => null);
    if (next && next.id !== r.fileId && next.downloadUrl) out[file] = { version: next.displayName, fileId: next.id, source: 'curseforge' };
  }));
  return out;
}

export async function updateFile(inst, file, u, log) {
  const t = target(inst);
  const rec = records(inst);
  const old = rec[baseName(file)];
  const next = (await cf(`/mods/${old.modId}/files/${u.fileId}`))?.data;
  if (!next?.downloadUrl) throw httpError(400, `Não foi possível baixar a nova versão de ${old.name}`);
  const enabled = !file.endsWith('.disabled');
  log(`Atualizando ${old.name} para ${next.displayName}...`);
  await download(next.downloadUrl, path.join(t.dir, next.fileName + (enabled ? '' : '.disabled')), { sha1: sha1Of(next) });
  if (next.fileName !== baseName(file)) fs.rmSync(path.join(t.dir, file), { force: true });
  delete rec[baseName(file)];
  rec[next.fileName] = { ...old, fileId: next.id, version: next.displayName };
  save();
}
