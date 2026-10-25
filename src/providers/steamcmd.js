import fs from 'node:fs';
import path from 'node:path';
import { TOOLS_DIR } from '../store.js';
import { IS_WIN, download, extract, run, serialized } from '../util.js';
import { installApp as accountInstall } from './depotdownloader.js';

const DIR = path.join(TOOLS_DIR, 'steamcmd');
const EXE = path.join(DIR, IS_WIN ? 'steamcmd.exe' : 'steamcmd.sh');

// SteamCMD keeps global state in its folder, so every call goes through one queue.
const queued = fn => serialized('steamcmd', fn);

async function ensureSteamCmd(log) {
  if (fs.existsSync(EXE)) return EXE;
  log('Baixando SteamCMD...');
  const url = `https://steamcdn-a.akamaihd.net/client/installer/${IS_WIN ? 'steamcmd.zip' : 'steamcmd_linux.tar.gz'}`;
  const archive = path.join(DIR, path.basename(url));
  await download(url, archive);
  await extract(archive, DIR);
  fs.rmSync(archive);
  return EXE;
}

// Runs SteamCMD, retrying once when it only updated itself (it exits with code 7 without running the commands).
async function steamcmd(args, { log, onSpawn, isDone }) {
  const exe = await ensureSteamCmd(log);
  let code;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let selfUpdated = false;
    code = await run(exe, args, {
      cwd: DIR,
      onSpawn,
      onLine: line => {
        if (/Update complete, launching/.test(line)) selfUpdated = true;
        if (line.trim()) log(line);
      },
    });
    if (isDone?.() || !(selfUpdated || code === 7) || attempt === 2) break;
    log('SteamCMD foi atualizado; executando novamente...');
  }
  return code;
}

// Games that need an account go through DepotDownloader, which keeps the session from the QR or password login.
export async function installApp(opts) {
  if (opts.login !== 'account') return installAnonymous(opts);
  await accountInstall(opts);
  // DepotDownloader doesn't write Steam's app manifest; a minimal one keeps installedBuild() and update checks working.
  const build = latestBuild((await appInfo([opts.appId]))[opts.appId], opts.branch);
  if (build) {
    fs.mkdirSync(path.join(opts.dir, 'steamapps'), { recursive: true });
    fs.writeFileSync(path.join(opts.dir, 'steamapps', `appmanifest_${opts.appId}.acf`), `"AppState"\n{\n\t"appid"\t\t"${opts.appId}"\n\t"buildid"\t\t"${build}"\n}\n`);
  }
}

function installAnonymous({ dir, appId, branch, betaPassword, log, onSpawn }) {
  return queued(async () => {
    let success = false, failure = null;
    const args = ['+force_install_dir', dir, '+login', 'anonymous', '+app_update', String(appId)];
    if (branch) args.push('-beta', branch);
    if (betaPassword) args.push('-betapassword', betaPassword);
    args.push('validate', '+quit');
    const code = await steamcmd(args, {
      onSpawn,
      isDone: () => success,
      log: line => {
        if (/Success! App '\d+' (fully installed|already up to date)/.test(line)) success = true;
        const err = line.match(/ERROR! (.+)/);
        if (err) failure = err[1];
        if (/No subscription/i.test(line)) failure = 'este jogo exige uma conta Steam que tenha o jogo (No subscription)';
        log(line);
      },
    });
    if (!success) throw new Error(`SteamCMD não confirmou a instalação${failure ? `: ${failure}` : ` (código ${code})`}`);
  });
}

// Downloads Workshop items into <dir>/steamapps/workshop/content/<appId>/<item>, where dedicated servers look for them.
export function downloadWorkshopItems({ dir, appId, itemIds, log }) {
  return queued(async () => {
    const done = new Set();
    let failure = null;
    const args = ['+force_install_dir', dir, '+login', 'anonymous'];
    for (const id of itemIds) args.push('+workshop_download_item', String(appId), String(id));
    args.push('+quit');
    await steamcmd(args, {
      isDone: () => done.size === itemIds.length,
      log: line => {
        const ok = line.match(/Success\. Downloaded item (\d+)/);
        if (ok) done.add(ok[1]);
        const err = line.match(/ERROR! Download item (\d+) failed \(([^)]+)\)/);
        if (err) failure = `item ${err[1]}: ${err[2]}`;
        if (ok || err) log(line.replace(/ to ".*?"/, ''));
      },
    });
    const missing = itemIds.filter(id => !done.has(String(id)));
    if (missing.length) throw new Error(`Não foi possível baixar ${missing.join(', ')}${failure ? ` (${failure})` : ''}`);
  });
}

// ---- app_info (launch options and current build ids) ----
function parseVdf(text) {
  const tokens = [...text.matchAll(/"((?:[^"\\]|\\.)*)"|([{}])/g)].map(m => m[2] ?? m[1].replace(/\\\\/g, '\\'));
  let i = 0;
  const obj = () => {
    const o = {};
    while (i < tokens.length) {
      const t = tokens[i++];
      if (t === '}') return o;
      const v = tokens[i++];
      o[t] = v === '{' ? obj() : v;
    }
    return o;
  };
  return obj();
}

export function appInfo(appIds, log = () => {}) {
  return queued(async () => {
    const args = ['+login', 'anonymous', '+app_info_update', '1'];
    for (const id of appIds) args.push('+app_info_print', String(id));
    args.push('+quit');
    let out = '';
    await steamcmd(args, { log: () => {}, onSpawn: child => child.stdout.on('data', d => { out += d; }) });
    const result = {};
    const blocks = out.split(/AppID : (\d+), change number/).slice(1);
    for (let k = 0; k < blocks.length; k += 2) {
      const id = blocks[k];
      const start = blocks[k + 1].indexOf(`"${id}"`);
      if (start < 0) continue;
      try { result[id] = parseVdf(blocks[k + 1].slice(start))[id]; } catch (e) { log(`Falha ao ler app_info de ${id}: ${e.message}`); }
    }
    return result;
  });
}

export function windowsLaunch(info) {
  const launches = Object.values(info?.config?.launch || {});
  const usable = launches.filter(l => l.executable && !/\.(txt|html?|url)$/i.test(l.executable) && !l.executable.startsWith('steam://'));
  const pick = usable.find(l => /windows/.test(l.config?.oslist || '')) || usable.find(l => !l.config?.oslist);
  return pick ? { exe: pick.executable.replace(/\\/g, '/').replace(/^\/+/, ''), args: pick.arguments || '' } : null;
}

export function latestBuild(info, branch = 'public') {
  return info?.depots?.branches?.[branch || 'public']?.buildid ?? null;
}

export function installedBuild(dir, appId) {
  const manifest = path.join(dir, 'steamapps', `appmanifest_${appId}.acf`);
  if (!fs.existsSync(manifest)) return null;
  return fs.readFileSync(manifest, 'utf8').match(/"buildid"\s+"(\d+)"/)?.[1] ?? null;
}
