import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { download, httpError } from '../util.js';

const API = 'https://api.modrinth.com/v2';
const UA = 'host-my-game/0.3 (painel local de servidores de jogos)';

// Which Modrinth loaders and folder each Minecraft flavor uses. Vanilla and Bedrock have no mod loader.
const TARGETS = {
  fabric: { loaders: ['fabric'], folder: 'mods', kind: 'mods' },
  forge: { loaders: ['forge'], folder: 'mods', kind: 'mods' },
  neoforge: { loaders: ['neoforge'], folder: 'mods', kind: 'mods' },
  paper: { loaders: ['paper', 'spigot', 'bukkit'], folder: 'plugins', kind: 'plugins' },
  purpur: { loaders: ['purpur', 'paper', 'spigot', 'bukkit'], folder: 'plugins', kind: 'plugins' },
  velocity: { loaders: ['velocity'], folder: 'plugins', kind: 'plugins', anyVersion: true },
};

export const supportsModrinth = inst => inst.template.provider === 'minecraft' && Boolean(TARGETS[inst.template.flavor]);

function target(inst) {
  const t = TARGETS[inst.template.flavor];
  if (!t) throw httpError(400, 'Este servidor não suporta mods');
  const gameVersion = inst.cfg.installed?.version;
  if (!gameVersion && !t.anyVersion) throw httpError(400, 'Instale o servidor primeiro para o painel saber a versão do Minecraft');
  return { ...t, gameVersion: t.anyVersion ? null : gameVersion, dir: path.join(inst.dir, t.folder) };
}

async function mr(pathAndQuery, body) {
  let res;
  try {
    res = await fetch(API + pathAndQuery, {
      method: body ? 'POST' : 'GET',
      headers: { 'User-Agent': UA, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw httpError(502, `Não foi possível falar com o Modrinth: ${e.message}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw httpError(502, `Modrinth respondeu ${res.status}`);
  return res.json();
}
const q = v => encodeURIComponent(JSON.stringify(v));

export function info(inst) {
  const t = TARGETS[inst.template.flavor];
  return { type: t.kind, folder: t.folder, loaders: t.loaders, gameVersion: t.anyVersion ? null : inst.cfg.installed?.version || null };
}

export async function search(inst, query = '', offset = 0) {
  const t = target(inst);
  const facets = [t.loaders.map(l => `categories:${l}`), [`project_type:${t.kind === 'plugins' ? 'plugin' : 'mod'}`]];
  if (t.gameVersion) facets.push([`versions:${t.gameVersion}`]);
  if (t.kind === 'mods') facets.push(['server_side!=unsupported']);
  const index = query.trim() ? 'relevance' : 'downloads';
  const r = await mr(`/search?query=${encodeURIComponent(query.trim())}&facets=${q(facets)}&index=${index}&limit=20&offset=${Number(offset) || 0}`);
  return {
    total: r.total_hits,
    hits: r.hits.map(h => ({
      id: h.project_id, slug: h.slug, title: h.title, description: h.description, icon: h.icon_url || null,
      downloads: h.downloads, author: h.author, clientOnly: h.server_side === 'unsupported',
    })),
  };
}

// The newest version of a project that fits this server's loader and Minecraft version.
async function compatibleVersion(t, projectId) {
  let url = `/project/${encodeURIComponent(projectId)}/version?loaders=${q(t.loaders)}`;
  if (t.gameVersion) url += `&game_versions=${q([t.gameVersion])}`;
  const versions = await mr(url);
  if (!versions?.length) return null;
  return versions.find(v => v.version_type === 'release') || versions[0];
}

const primaryFile = v => v.files.find(f => f.primary) || v.files[0];

// ---- installed files ----
const hashCache = new Map(); // "path|size|mtime" -> sha1
function sha1(file) {
  const st = fs.statSync(file);
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  if (!hashCache.has(key)) hashCache.set(key, crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'));
  return hashCache.get(key);
}

function jarFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && /\.jar(\.disabled)?$/i.test(e.name))
    .map(e => {
      const full = path.join(dir, e.name);
      return { file: e.name, full, enabled: !e.name.endsWith('.disabled'), size: fs.statSync(full).size, sha1: sha1(full) };
    });
}

export async function listInstalled(inst) {
  const t = TARGETS[inst.template.flavor];
  const dir = path.join(inst.dir, t.folder);
  const files = jarFiles(dir);
  if (!files.length) return [];
  // Modrinth recognizes files by hash, so even jars uploaded by hand get a name and icon.
  let versions = {}, projects = {};
  try {
    versions = await mr('/version_files', { hashes: files.map(f => f.sha1), algorithm: 'sha1' }) || {};
    const ids = [...new Set(Object.values(versions).map(v => v.project_id))];
    if (ids.length) for (const p of await mr(`/projects?ids=${q(ids)}`) || []) projects[p.id] = p;
  } catch { /* offline: still list the files */ }
  return files.map(f => {
    const v = versions[f.sha1];
    const p = v && projects[v.project_id];
    return {
      file: f.file, enabled: f.enabled, size: f.size,
      projectId: v?.project_id || null, versionId: v?.id || null, version: v?.version_number || null,
      title: p?.title || f.file.replace(/\.jar(\.disabled)?$/i, ''), icon: p?.icon_url || null, slug: p?.slug || null,
    };
  }).sort((a, b) => a.title.localeCompare(b.title));
}

function safeFile(dir, name) {
  const full = path.join(dir, path.basename(String(name || '')));
  if (!/\.jar(\.disabled)?$/i.test(full) || !fs.existsSync(full)) throw httpError(404, 'Arquivo não encontrado');
  return full;
}

const lockedError = e => (['EBUSY', 'EPERM'].includes(e.code) ? httpError(409, 'O arquivo está em uso. Pare o servidor e tente de novo.') : e);

// Installs a project plus its required dependencies; returns the titles that were added.
export async function install(inst, projectId, log) {
  const t = target(inst);
  fs.mkdirSync(t.dir, { recursive: true });
  const installed = new Set((await listInstalled(inst)).map(m => m.projectId).filter(Boolean));
  const added = [];
  const queue = [projectId];
  while (queue.length) {
    const id = queue.shift();
    if (installed.has(id)) continue;
    installed.add(id);
    const v = await compatibleVersion(t, id);
    if (!v) {
      if (id === projectId) throw httpError(400, `Não há versão compatível com ${t.loaders[0]} ${t.gameVersion || ''}`.trim());
      log(`Dependência ${id} não tem versão compatível; instale manualmente se o servidor reclamar.`);
      continue;
    }
    const file = primaryFile(v);
    log(`Baixando ${file.filename}...`);
    await download(file.url, path.join(t.dir, file.filename), { sha1: file.hashes?.sha1 });
    added.push(file.filename);
    for (const dep of v.dependencies || []) {
      if (dep.dependency_type !== 'required') continue;
      if (dep.project_id) queue.push(dep.project_id);
      else if (dep.version_id) {
        const dv = await mr(`/version/${dep.version_id}`);
        if (dv) queue.push(dv.project_id);
      }
    }
  }
  return added;
}

export function toggle(inst, name) {
  const dir = path.join(inst.dir, TARGETS[inst.template.flavor].folder);
  const full = safeFile(dir, name);
  const next = full.endsWith('.disabled') ? full.slice(0, -'.disabled'.length) : `${full}.disabled`;
  try { fs.renameSync(full, next); } catch (e) { throw lockedError(e); }
  return path.basename(next);
}

export function remove(inst, name) {
  const dir = path.join(inst.dir, TARGETS[inst.template.flavor].folder);
  try { fs.rmSync(safeFile(dir, name)); } catch (e) { throw lockedError(e); }
}

// Map of file name -> newer version available for this server.
export async function checkUpdates(inst) {
  const t = target(inst);
  const files = jarFiles(t.dir);
  if (!files.length) return {};
  const known = await mr('/version_files', { hashes: files.map(f => f.sha1), algorithm: 'sha1' }) || {};
  const out = {};
  // Same rule as installing: newest stable release (betas only when the project has nothing else).
  await Promise.all(files.map(async f => {
    const now = known[f.sha1];
    if (!now) return;
    const next = await compatibleVersion(t, now.project_id);
    if (next && next.id !== now.id && new Date(next.date_published) > new Date(now.date_published)) {
      out[f.file] = { version: next.version_number, versionId: next.id };
    }
  }));
  return out;
}

export async function update(inst, name, log) {
  const t = target(inst);
  const updates = await checkUpdates(inst);
  const names = name ? [name] : Object.keys(updates);
  let count = 0;
  for (const n of names) {
    const u = updates[n];
    if (!u) continue;
    const v = await mr(`/version/${u.versionId}`);
    const file = primaryFile(v);
    const enabled = !n.endsWith('.disabled');
    const dest = path.join(t.dir, file.filename + (enabled ? '' : '.disabled'));
    log(`Atualizando ${n} para ${u.version}...`);
    await download(file.url, dest, { sha1: file.hashes?.sha1 });
    if (path.basename(dest) !== n) { try { fs.rmSync(path.join(t.dir, n)); } catch (e) { throw lockedError(e); } }
    count++;
  }
  return count;
}
