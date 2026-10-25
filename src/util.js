import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export const IS_WIN = process.platform === 'win32';

// Use the bsdtar that ships with Windows: Git for Windows' GNU tar can't read zips and mangles C:\ paths.
const TAR = IS_WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function readLines(stream, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buf += chunk;
    const lines = buf.split(/\r?\n|\r(?!\n)/);
    buf = lines.pop();
    for (const line of lines) onLine(line);
  });
  stream.on('end', () => { if (buf) onLine(buf); });
}

export function run(cmd, args, { cwd, env, onLine = () => {}, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: env && { ...process.env, ...env }, windowsHide: true });
    onSpawn?.(child);
    child.stdin.on('error', () => {});
    readLines(child.stdout, onLine);
    readLines(child.stderr, onLine);
    child.on('error', reject);
    child.on('close', resolve);
  });
}

export async function tar(args, cwd) {
  const output = [];
  const code = await run(TAR, args, { cwd, onLine: l => output.push(l) });
  if (code !== 0) throw new Error(`tar falhou (código ${code}): ${output.slice(-3).join(' ')}`);
}

export async function extract(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  await tar(['-xf', archive, '-C', dest]);
}

const UA = { 'User-Agent': 'host-my-game/1.0' };

export async function fetchJson(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`Falha ao acessar ${url} (${res.status})`);
  return res.json();
}

export async function download(url, dest, { sha1, sha256, onProgress } = {}) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`Download falhou (${res.status}): ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0, lastReport = Date.now();
  const body = Readable.fromWeb(res.body);
  body.on('data', chunk => {
    received += chunk.length;
    if (onProgress && total && Date.now() - lastReport > 2000) {
      lastReport = Date.now();
      onProgress(received, total);
    }
  });
  await pipeline(body, fs.createWriteStream(tmp));
  for (const [algo, expected] of [['sha1', sha1], ['sha256', sha256]]) {
    if (!expected) continue;
    const hash = crypto.createHash(algo);
    await pipeline(fs.createReadStream(tmp), hash);
    if (hash.digest('hex') !== expected.toLowerCase()) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`Checksum inválido para ${url}`);
    }
  }
  fs.renameSync(tmp, dest);
}

// Copies a directory tree over another, leaving the listed top-level names alone if they already exist
// (used to update servers without clobbering worlds and configs).
export function copyOver(src, dest, preserve = []) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const target = path.join(dest, name);
    if (preserve.includes(name) && fs.existsSync(target)) continue;
    fs.cpSync(path.join(src, name), target, { recursive: true, force: true });
  }
}

// Splits a command line into arguments; double quotes group words and may appear mid-token (-name="My server").
export function splitArgs(str = '') {
  const args = [];
  let token = '', inQuotes = false, hasToken = false;
  for (const ch of str) {
    if (ch === '"') { inQuotes = !inQuotes; hasToken = true; }
    else if (/\s/.test(ch) && !inQuotes) {
      if (hasToken) args.push(token);
      token = ''; hasToken = false;
    } else { token += ch; hasToken = true; }
  }
  if (hasToken) args.push(token);
  return args;
}

// Replaces {{key}}, {{key+1}} and {{key-1}} placeholders using resolve(key).
export function expand(str, resolve) {
  return String(str ?? '').replace(/\{\{\s*([\w.]+)\s*(?:([+-])\s*(\d+))?\s*\}\}/g, (_, key, op, n) => {
    const value = resolve(key);
    if (op) return String(Number(value) + (op === '+' ? Number(n) : -Number(n)));
    return value ?? '';
  });
}

export const randomPassword = (len = 16) => crypto.randomBytes(len).toString('base64url').slice(0, len);

export const slugify = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40) || 'servidor';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Serializes async work per key (e.g. SteamCMD can only run one instance at a time).
const queues = new Map();
export function serialized(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(key, next);
  return next;
}

// Total size of a folder tree; unreadable entries are skipped and symlinks aren't followed.
export async function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        try { total += (await fs.promises.stat(full)).size; } catch { /* vanished or locked */ }
      }
    }
  }
  return total;
}
