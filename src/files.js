import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { download, extract as extractArchive, httpError, tar } from './util.js';

const MAX_EDIT_BYTES = 5 * 1024 * 1024;

const outside = (base, target) => {
  const rel = path.relative(base, target);
  return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
};

// Resolves a user-supplied path inside an instance folder, rejecting ../ tricks and symlink/junction escapes.
export function resolveSafe(base, rel = '') {
  const target = path.resolve(base, '.' + path.sep + String(rel).replace(/^[/\\]+/, ''));
  if (outside(base, target)) throw httpError(400, 'Caminho inválido');
  let existing = target;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  if (outside(fs.realpathSync(base), fs.realpathSync(existing))) throw httpError(400, 'Caminho inválido');
  return target;
}

const statOrThrow = p => {
  try { return fs.statSync(p); } catch { throw httpError(404, 'Arquivo ou pasta não encontrado'); }
};

export function list(base, rel) {
  const dir = resolveSafe(base, rel);
  if (!statOrThrow(dir).isDirectory()) throw httpError(400, 'Não é uma pasta');
  const entries = fs.readdirSync(dir, { withFileTypes: true }).map(e => {
    let size = 0, mtime = 0;
    try { const s = fs.statSync(path.join(dir, e.name)); size = s.size; mtime = s.mtimeMs; } catch { /* locked or vanished */ }
    return { name: e.name, dir: e.isDirectory(), size, mtime };
  });
  entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  return entries;
}

export function readText(base, rel) {
  const file = resolveSafe(base, rel);
  const st = statOrThrow(file);
  if (st.isDirectory()) throw httpError(400, 'É uma pasta');
  if (st.size > MAX_EDIT_BYTES) throw httpError(413, 'Arquivo grande demais para editar aqui; use o download');
  const buf = fs.readFileSync(file);
  if (buf.includes(0)) throw httpError(415, 'Arquivo binário; use o download');
  return buf.toString('utf8');
}

export function writeText(base, rel, content) {
  if (typeof content !== 'string') throw httpError(400, 'Conteúdo inválido');
  const file = resolveSafe(base, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

export async function upload(base, rel, stream) {
  const file = resolveSafe(base, rel);
  if (file === path.resolve(base)) throw httpError(400, 'Caminho inválido');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.upload';
  try {
    await pipeline(stream, fs.createWriteStream(tmp));
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export function downloadPath(base, rel) {
  const file = resolveSafe(base, rel);
  if (statOrThrow(file).isDirectory()) throw httpError(400, 'Não é possível baixar uma pasta');
  return file;
}

export function mkdir(base, rel) {
  fs.mkdirSync(resolveSafe(base, rel), { recursive: true });
}

export function rename(base, from, to) {
  const src = resolveSafe(base, from);
  const dest = resolveSafe(base, to);
  statOrThrow(src);
  if (fs.existsSync(dest)) throw httpError(409, 'Já existe um item com esse nome');
  fs.renameSync(src, dest);
}

export function remove(base, rel) {
  const target = resolveSafe(base, rel);
  if (target === path.resolve(base)) throw httpError(400, 'Não é possível excluir a pasta raiz');
  statOrThrow(target);
  fs.rmSync(target, { recursive: true, force: true });
}

// ---------- bulk actions ----------
const asList = paths => {
  if (!Array.isArray(paths) || !paths.length) throw httpError(400, 'Nenhum item selecionado');
  if (paths.length > 500) throw httpError(400, 'Itens demais de uma vez');
  return paths.map(String);
};
const notRoot = (base, target) => { if (target === path.resolve(base)) throw httpError(400, 'Não é possível usar a pasta raiz'); return target; };

export function removeMany(base, paths) {
  for (const rel of asList(paths)) remove(base, rel);
}

// A free name in dir: "mundo", "mundo (2)", "mundo (3)"... (keeps the extension of files)
function freeName(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name), stem = ext && name.length > ext.length ? name.slice(0, -ext.length) : name, e = stem === name ? '' : ext;
  for (let i = 2; ; i++) { const n = `${stem} (${i})${e}`; if (!fs.existsSync(path.join(dir, n))) return n; }
}

function destDir(base, to) {
  const dir = resolveSafe(base, to || '');
  if (!statOrThrow(dir).isDirectory()) throw httpError(400, 'O destino não é uma pasta');
  return dir;
}

export function move(base, paths, to) {
  const dir = destDir(base, to);
  for (const rel of asList(paths)) {
    const src = notRoot(base, resolveSafe(base, rel));
    statOrThrow(src);
    if (dir === src || !outside(src, dir)) throw httpError(400, 'Não é possível mover uma pasta para dentro dela mesma');
    const dest = path.join(dir, path.basename(src));
    if (dest === src) continue;
    if (fs.existsSync(dest)) throw httpError(409, `Já existe "${path.basename(src)}" no destino`);
    fs.renameSync(src, dest);
  }
}

export function copy(base, paths, to) {
  const dir = destDir(base, to);
  for (const rel of asList(paths)) {
    const src = notRoot(base, resolveSafe(base, rel));
    statOrThrow(src);
    if (dir === src || !outside(src, dir)) throw httpError(400, 'Não é possível copiar uma pasta para dentro dela mesma');
    fs.cpSync(src, path.join(dir, freeName(dir, path.basename(src))), { recursive: true, errorOnExist: true });
  }
}

// Makes a .zip (or .tar.gz) of the selected items, inside the folder they are in.
export async function compress(base, paths, cwd, name) {
  const dir = destDir(base, cwd);
  const items = asList(paths).map(rel => {
    const full = notRoot(base, resolveSafe(base, rel));
    statOrThrow(full);
    if (path.dirname(full) !== dir) throw httpError(400, 'Selecione itens da mesma pasta');
    return path.basename(full);
  });
  let file = String(name || '').trim() || (items.length === 1 ? items[0] : 'arquivos');
  if (!/\.(zip|tar\.gz|tgz)$/i.test(file)) file += '.zip';
  if (/[\\/:*?"<>|]/.test(file)) throw httpError(400, 'Nome de arquivo inválido');
  file = freeName(dir, file);
  // Windows' tar picks the format from the extension with -a (zip or gzip'd tar).
  await tar(['-a', '-cf', file, ...items], dir);
  return file;
}

export async function extract(base, rel, to) {
  const archive = resolveSafe(base, rel);
  const ARCHIVE = /\.(zip|tar\.gz|tgz|tar\.bz2|tar\.xz|tar|7z|rar)$/i;
  if (!statOrThrow(archive).isFile() || !ARCHIVE.test(archive)) throw httpError(400, 'Não é um arquivo compactado');
  const dest = to === undefined || to === null || to === ''
    ? path.join(path.dirname(archive), freeName(path.dirname(archive), path.basename(archive).replace(ARCHIVE, '')))
    : resolveSafe(base, to);
  // tar refuses absolute paths and ".." entries, so archives can't write outside the destination.
  await extractArchive(archive, dest);
  return path.relative(path.resolve(base), dest).split(path.sep).join('/');
}

// Downloads a file from the internet into a folder of the server (mods, maps, configs…).
export async function pull(base, url, to, name, onProgress) {
  let u;
  try { u = new URL(String(url)); } catch { throw httpError(400, 'Link inválido'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw httpError(400, 'Use um link http(s)');
  const dir = destDir(base, to);
  let file = String(name || '').trim() || decodeURIComponent(path.basename(u.pathname)) || 'download';
  file = file.replace(/[\\/:*?"<>|]/g, '_').slice(0, 150) || 'download';
  file = freeName(dir, file);
  await download(u.href, path.join(dir, file), { onProgress });
  return file;
}
