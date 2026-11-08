import fs from 'node:fs';
import path from 'node:path';
import { save } from '../store.js';
import { httpError } from '../util.js';
import { downloadWorkshopItems, pruneWorkshopRegistry } from '../providers/steamcmd.js';

// Steam Workshop mods for Project Zomboid. The server .ini is the source of truth:
//   WorkshopItems=<workshop ids>  Mods=<mod ids, load order>  Map=<map folders>;Muldraugh, KY
// Items are downloaded ahead of time so the panel can read each mod.info (mod ids, names, dependencies).

const STEAM = 'https://api.steampowered.com/ISteamRemoteStorage';
const VANILLA_MAP = 'Muldraugh, KY';

export const supportsWorkshop = inst => inst.template.mods?.type === 'pz-workshop';

const appId = inst => inst.template.mods.appId;
const iniPath = inst => path.join(inst.dir, inst.expand(inst.template.mods.ini));
const contentDir = (inst, id) => path.join(inst.dir, 'steamapps', 'workshop', 'content', appId(inst), String(id));
// Build 42 ships projectzomboid.jar and expects "\" before each mod id in Mods=.
const isB42 = inst => fs.existsSync(path.join(inst.dir, 'java', 'projectzomboid.jar'));

async function steamPost(method, form) {
  let res;
  try {
    res = await fetch(`${STEAM}/${method}/v1/`, { method: 'POST', body: new URLSearchParams(form) });
  } catch (e) {
    throw httpError(502, `Não foi possível falar com a Steam: ${e.message}`);
  }
  if (!res.ok) throw httpError(502, `A Steam respondeu ${res.status}`);
  return (await res.json()).response;
}

async function details(ids) {
  if (!ids.length) return {};
  const form = { itemcount: ids.length };
  ids.forEach((id, i) => { form[`publishedfileids[${i}]`] = id; });
  const r = await steamPost('GetPublishedFileDetails', form);
  return Object.fromEntries((r.publishedfiledetails || []).filter(d => d.result === 1).map(d => [d.publishedfileid, d]));
}

// Returns the item ids inside each collection; ids that aren't collections map to themselves.
async function expandCollections(ids) {
  const form = { collectioncount: ids.length };
  ids.forEach((id, i) => { form[`publishedfileids[${i}]`] = id; });
  const r = await steamPost('GetCollectionDetails', form);
  const out = [];
  for (const id of ids) {
    const c = r.collectiondetails?.find(x => x.publishedfileid === id);
    if (c?.result === 1 && c.children?.length) out.push(...c.children.sort((a, b) => a.sortorder - b.sortorder).map(x => x.publishedfileid));
    else out.push(id);
  }
  return out;
}

// ---- browsing ----
// Steam's search API needs a Web API key, but the public Workshop page lists the same results. The page embeds
// its data as JSON, so we take the item ids in order from it and get the details from the keyless details API.
const SORTS = { relevance: 'textsearch', popular: 'totaluniquesubscribers', trend: 'trend', recent: 'mostrecent', updated: 'lastupdated' };
const searchCache = new Map(); // url -> { at, ids, total }

async function browsePage(app, { q, sort, tag, page }) {
  const params = new URLSearchParams({ appid: app, section: 'readytouseitems', numperpage: '30', p: String(page) });
  if (q) params.set('searchtext', q);
  params.set('browsesort', q && sort === 'popular' ? 'textsearch' : SORTS[sort] || 'textsearch');
  if (params.get('browsesort') === 'trend') params.set('days', '-1');
  if (tag) params.append('requiredtags[]', tag);
  const url = `https://steamcommunity.com/workshop/browse/?${params}`;
  const hit = searchCache.get(url);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit;
  let html;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'en-US,en;q=0.8' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (e) {
    throw httpError(502, `Não foi possível abrir a Oficina Steam: ${e.message}`);
  }
  const ids = [...new Set([...html.matchAll(/publishedfileid\\?":\\?"(\d+)/g)].map(m => m[1]))].slice(0, 30);
  const total = Number(html.match(/([\d,.]+) entries matching/)?.[1]?.replace(/[,.]/g, '')) || ids.length;
  const result = { at: Date.now(), ids, total };
  searchCache.set(url, result);
  if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
  return result;
}

const plainText = bb => String(bb || '').replace(/\[[^\]]*\]/g, ' ').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();

export async function search(inst, { q = '', sort = 'popular', build = 'auto', page = 1 } = {}) {
  const tag = build === 'auto' ? (isB42(inst) ? 'Build 42' : 'Build 41') : build === 'all' ? '' : build;
  const { ids, total } = await browsePage(appId(inst), { q: q.trim(), sort, tag, page: Math.max(1, Number(page) || 1) });
  const info = await details(ids);
  const installed = new Set(readState(inst)?.items || []);
  return {
    total, tag,
    hits: ids.filter(id => info[id]).map(id => {
      const d = info[id];
      return {
        id, title: d.title, preview: d.preview_url || null, subscriptions: d.subscriptions || 0, size: Number(d.file_size) || 0,
        updated: d.time_updated, tags: (d.tags || []).map(t => t.tag), description: plainText(d.description).slice(0, 220),
        installed: installed.has(id),
      };
    }),
  };
}

// Accepts Workshop links, collection links or bare ids, separated by spaces, commas or new lines.
export function parseInput(text) {
  const ids = [];
  for (const part of String(text || '').split(/[\s,;]+/)) {
    const id = part.match(/[?&]id=(\d{6,})/)?.[1] || part.match(/^(\d{6,})$/)?.[1];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// ---- .ini handling ----
function readIni(inst) {
  const file = iniPath(inst);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}
const getKey = (text, key) => text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
const splitList = v => v.split(';').map(s => s.trim()).filter(Boolean);
const stripSlash = id => id.replace(/^\\+/, '');

function setKey(text, key, value) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, () => `${key}=${value}`) : `${text.replace(/\s*$/, '')}\n${key}=${value}\n`;
}

function readState(inst) {
  const text = readIni(inst);
  if (text === null) return null;
  return {
    items: splitList(getKey(text, 'WorkshopItems')),
    mods: splitList(getKey(text, 'Mods')).map(stripSlash),
    maps: splitList(getKey(text, 'Map')),
  };
}

function writeState(inst, st) {
  const text = readIni(inst);
  if (text === null) throw httpError(409, 'O arquivo de configuração do servidor ainda não existe. Inicie o servidor uma vez para criá-lo.');
  const prefix = isB42(inst) ? '\\' : '';
  // The vanilla map must stay last so mod maps load on top of it.
  const maps = [...st.maps.filter(m => m !== VANILLA_MAP), VANILLA_MAP];
  let out = setKey(text, 'WorkshopItems', st.items.join(';'));
  out = setKey(out, 'Mods', st.mods.map(m => prefix + m).join(';'));
  out = setKey(out, 'Map', maps.join(';'));
  fs.writeFileSync(iniPath(inst), out);
}

// ---- downloaded content ----
function findFiles(dir, name, depth = 5, out = []) {
  if (depth < 0 || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findFiles(full, name, depth - 1, out);
    else if (e.name === name) out.push(full);
  }
  return out;
}

function parseModInfo(file) {
  const info = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(\w+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in info)) info[m[1]] = m[2];
  }
  return info;
}

// Mod ids, names, requirements and map folders found in a downloaded item.
function scan(inst, id) {
  const dir = contentDir(inst, id);
  if (!fs.existsSync(dir)) return null;
  const mods = new Map();
  for (const file of findFiles(path.join(dir, 'mods'), 'mod.info')) {
    const info = parseModInfo(file);
    if (!info.id) continue;
    const ids = v => splitList((v || '').replace(/,/g, ';')).map(stripSlash).filter(Boolean);
    const prev = mods.get(info.id);
    // B42 mods ship one mod.info per version folder: keep the first, but merge the incompatibility lists.
    if (prev) { prev.incompatible = [...new Set([...prev.incompatible, ...ids(info.incompatible)])]; continue; }
    mods.set(info.id, {
      id: info.id, name: info.name || info.id, require: ids(info.require),
      loadAfter: ids(info.loadModAfter), loadBefore: ids(info.loadModBefore), incompatible: ids(info.incompatible),
    });
  }
  const maps = new Set();
  for (const modDir of fs.existsSync(path.join(dir, 'mods')) ? fs.readdirSync(path.join(dir, 'mods')) : []) {
    for (const base of ['media', '42/media', 'common/media']) {
      const mapsDir = path.join(dir, 'mods', modDir, base, 'maps');
      if (fs.existsSync(mapsDir)) for (const m of fs.readdirSync(mapsDir, { withFileTypes: true })) if (m.isDirectory()) maps.add(m.name);
    }
  }
  return { mods: [...mods.values()], maps: [...maps] };
}

const cache = inst => (inst.cfg.workshop ??= {});

function remember(inst, d) {
  const c = cache(inst);
  const scanned = scan(inst, d.publishedfileid);
  c[d.publishedfileid] = {
    title: d.title, preview: d.preview_url || null, updated: d.time_updated, size: Number(d.file_size) || 0,
    tags: (d.tags || []).map(t => t.tag), mods: scanned?.mods || [], maps: scanned?.maps || [],
  };
}

// ---- public API ----
export async function list(inst) {
  const st = readState(inst);
  if (!st) return { iniExists: false, b42: isB42(inst), items: [], mods: [], maps: [] };
  const c = cache(inst);
  const unknown = st.items.filter(id => !c[id]);
  if (unknown.length) {
    try { for (const d of Object.values(await details(unknown))) remember(inst, d); save(); } catch { /* offline */ }
  }
  // Re-scan items the server downloaded on its own since the last look, and entries cached
  // before the panel read incompatible= from mod.info.
  let rescanned = false;
  for (const id of st.items) {
    if (!c[id] || !fs.existsSync(contentDir(inst, id))) continue;
    if (c[id].mods.length && c[id].mods.every(m => Array.isArray(m.incompatible))) continue;
    const s = scan(inst, id);
    if (s) { Object.assign(c[id], s); rescanned = true; }
  }
  if (rescanned) save();
  const enabled = new Set(st.mods);
  const allIds = new Set(st.items.flatMap(id => (c[id]?.mods || []).map(m => m.id)));
  const conflictsOf = m => (m.incompatible || []).filter(x => x !== m.id && enabled.has(x));
  const items = st.items.map(id => ({
    id, title: c[id]?.title || `Item ${id}`, preview: c[id]?.preview || null, tags: c[id]?.tags || [], size: c[id]?.size || 0,
    downloaded: fs.existsSync(contentDir(inst, id)),
    mods: (c[id]?.mods || []).map(m => ({
      ...m, enabled: enabled.has(m.id), missing: m.require.filter(r => !enabled.has(r)),
      conflicts: enabled.has(m.id) ? conflictsOf(m) : [],
    })),
    maps: (c[id]?.maps || []).map(m => ({ name: m, enabled: st.maps.includes(m) })),
  }));
  // Each conflicting pair once, whichever side declares it.
  const seen = new Set(), conflicts = [];
  for (const it of items) for (const m of it.mods) for (const other of m.conflicts) {
    const key = [m.id, other].sort().join('\n');
    if (!seen.has(key)) { seen.add(key); conflicts.push({ a: m.id, b: other }); }
  }
  const pairOf = new Map();
  for (const { a, b } of conflicts) {
    pairOf.set(a, [...(pairOf.get(a) || []), b]);
    pairOf.set(b, [...(pairOf.get(b) || []), a]);
  }
  for (const it of items) for (const m of it.mods) m.conflicts = m.enabled ? (pairOf.get(m.id) || []) : [];
  return {
    iniExists: true, b42: isB42(inst), items, conflicts,
    mods: st.mods.map(id => ({ id, known: allIds.has(id) })),
    maps: st.maps.filter(m => m !== VANILLA_MAP),
  };
}

// Adds Workshop items (or whole collections): downloads them, enables every mod id and map they contain.
export async function add(inst, input, log) {
  const st = readState(inst);
  if (!st) throw httpError(409, 'O arquivo de configuração do servidor ainda não existe. Inicie o servidor uma vez para criá-lo.');
  let ids = parseInput(input);
  if (!ids.length) throw httpError(400, 'Cole um link da Oficina Steam ou o número do item');
  ids = await expandCollections(ids);
  const info = await details(ids);
  const wrongGame = ids.filter(id => info[id] && String(info[id].consumer_app_id) !== appId(inst));
  ids = ids.filter(id => info[id] && !wrongGame.includes(id) && !st.items.includes(id));
  if (wrongGame.length) log(`Ignorados (não são do ${inst.template.name}): ${wrongGame.join(', ')}`);
  if (!ids.length) return { added: 0 };
  log(`Baixando ${ids.length} item(ns) da Oficina...`);
  // Big collections go in batches so one bad item doesn't stop everything.
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    try { await downloadWorkshopItems({ dir: inst.dir, appId: appId(inst), itemIds: batch, log }); } catch (e) { log(e.message); }
  }
  const fresh = readState(inst);
  for (const id of ids) {
    remember(inst, info[id]);
    const entry = cache(inst)[id];
    fresh.items.push(id);
    for (const m of entry.mods) if (!fresh.mods.includes(m.id)) fresh.mods.push(m.id);
    for (const m of entry.maps) if (!fresh.maps.includes(m)) fresh.maps.unshift(m);
    log(`${entry.title}: ${entry.mods.length ? `mod(s) ${entry.mods.map(m => m.id).join(', ')}` : 'nenhum mod.info encontrado (o servidor baixa ao iniciar)'}${entry.maps.length ? ` · mapa(s) ${entry.maps.join(', ')}` : ''}`);
  }
  writeState(inst, fresh);
  save();
  return { added: ids.length };
}

// Saves which mod ids / maps are enabled and their order.
export function setActive(inst, { mods, maps }) {
  const st = readState(inst);
  if (!st) throw httpError(409, 'O arquivo de configuração do servidor ainda não existe.');
  if (Array.isArray(mods)) st.mods = mods.map(String).map(stripSlash).filter(Boolean);
  if (Array.isArray(maps)) st.maps = maps.map(String).filter(Boolean);
  writeState(inst, st);
}

// Reorders the enabled mod ids so every mod loads after what it requires / asks to load after
// (require=, loadModAfter=, loadModBefore= from mod.info). Stable: mods with no rule between
// them keep their current relative order, so a hand-tuned list only changes where it must.
export function autoSort(inst) {
  const st = readState(inst);
  if (!st) throw httpError(409, 'O arquivo de configuração do servidor ainda não existe.');
  const c = cache(inst);
  const info = new Map();
  for (const id of st.items) {
    // Read mod.info again from disk: older cache entries don't have loadModAfter/Before.
    const s = fs.existsSync(contentDir(inst, id)) ? scan(inst, id) : null;
    if (s && c[id]) Object.assign(c[id], s);
    for (const m of s?.mods || c[id]?.mods || []) if (!info.has(m.id)) info.set(m.id, m);
  }
  const order = st.mods;
  const pos = new Map(order.map((id, i) => [id, i]));
  const after = new Map(order.map(id => [id, new Set()])); // id -> ids that must come before it
  const edge = (first, then) => { if (first !== then && pos.has(first) && pos.has(then)) after.get(then).add(first); };
  for (const id of order) {
    const m = info.get(id);
    if (!m) continue;
    for (const r of [...(m.require || []), ...(m.loadAfter || [])]) edge(r, id);
    for (const r of m.loadBefore || []) edge(id, r);
  }
  // Kahn's algorithm, always taking the ready mod that is highest in the current list.
  const out = [], done = new Set(), cycle = [];
  while (out.length < order.length) {
    let next = order.find(id => !done.has(id) && [...after.get(id)].every(p => done.has(p)));
    // Circular rule: take the first remaining one anyway and go on.
    if (!next) { next = order.find(id => !done.has(id)); cycle.push(next); }
    out.push(next); done.add(next);
  }
  const moved = out.filter((id, i) => order[i] !== id).length;
  const missing = [...new Set(order.flatMap(id => (info.get(id)?.require || []).filter(r => !pos.has(r))))];
  if (moved) { st.mods = out; writeState(inst, st); }
  save();
  return { moved, cycle, missing, unknown: order.filter(id => !info.has(id)) };
}

export function remove(inst, id, deleteFiles) {
  const st = readState(inst);
  if (!st) throw httpError(409, 'O arquivo de configuração do servidor ainda não existe.');
  const entry = cache(inst)[id];
  // Keep mod ids/maps that another remaining item also provides.
  const others = st.items.filter(x => x !== id).map(x => cache(inst)[x]).filter(Boolean);
  const keepMods = new Set(others.flatMap(o => o.mods.map(m => m.id)));
  const keepMaps = new Set(others.flatMap(o => o.maps));
  st.items = st.items.filter(x => x !== id);
  if (entry) {
    st.mods = st.mods.filter(m => keepMods.has(m) || !entry.mods.some(e => e.id === m));
    st.maps = st.maps.filter(m => keepMaps.has(m) || !entry.maps.includes(m));
  }
  writeState(inst, st);
  delete cache(inst)[id];
  save();
  if (deleteFiles) {
    fs.rmSync(contentDir(inst, id), { recursive: true, force: true });
    // Otherwise Steam still thinks the files are there (see pruneWorkshopRegistry).
    pruneWorkshopRegistry(inst.dir, { ids: [String(id)] });
  }
}

// Re-downloads every item (Workshop updates); the server also does this on start.
export async function updateAll(inst, log) {
  const st = readState(inst);
  if (!st?.items.length) return 0;
  for (let i = 0; i < st.items.length; i += 10) {
    await downloadWorkshopItems({ dir: inst.dir, appId: appId(inst), itemIds: st.items.slice(i, i + 10), log });
  }
  for (const id of st.items) { const s = scan(inst, id); if (s && cache(inst)[id]) Object.assign(cache(inst)[id], s); }
  save();
  return st.items.length;
}
