import fs from 'node:fs';
import path from 'node:path';
import { TOOLS_DIR } from '../store.js';
import { IS_WIN, download, extract, serialized } from '../util.js';

// Adoptium publishes JREs for the LTS releases; anything in between runs on the next LTS up.
const LTS = [8, 11, 17, 21, 25];
export const ltsFor = major => LTS.find(v => v >= major) ?? LTS.at(-1);

function findJava(dir) {
  if (!fs.existsSync(dir)) return null;
  const exe = IS_WIN ? 'java.exe' : 'java';
  for (const entry of fs.readdirSync(dir)) {
    const candidate = path.join(dir, entry, 'bin', exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Returns a java executable for the requested major version, downloading a private JRE once if needed.
export function ensureJava(major, log = () => {}) {
  const version = ltsFor(major || 21);
  const dir = path.join(TOOLS_DIR, 'java', String(version));
  return serialized(`java-${version}`, async () => {
    const existing = findJava(dir);
    if (existing) return existing;
    const os = IS_WIN ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
    const url = `https://api.adoptium.net/v3/binary/latest/${version}/ga/${os}/${arch}/jre/hotspot/normal/eclipse`;
    log(`Baixando Java ${version} (Eclipse Temurin)...`);
    const archive = path.join(TOOLS_DIR, 'java', `jre-${version}${IS_WIN ? '.zip' : '.tar.gz'}`);
    await download(url, archive, { onProgress: (r, t) => log(`Java ${version}: ${Math.round(r / t * 100)}%`) });
    await extract(archive, dir);
    fs.rmSync(archive, { force: true });
    const exe = findJava(dir);
    if (!exe) throw new Error('Java baixado, mas o executável não foi encontrado');
    log(`Java ${version} pronto.`);
    return exe;
  });
}

export async function resolveJava(javaPath, major, log) {
  if (javaPath && javaPath !== 'auto') return javaPath;
  return ensureJava(major, log);
}
