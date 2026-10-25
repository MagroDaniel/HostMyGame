import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TOOLS_DIR } from './store.js';
import { IS_WIN, download, fetchJson, run, splitArgs, tar, httpError } from './util.js';

// Ready-made starting points. Every value can be changed later in the instance settings.
export const PRESETS = [
  {
    id: 'minecraft', type: 'minecraft', label: 'Minecraft Java (vanilla)',
    defaults: { version: 'latest', memoryMb: 2048, port: 25565, javaPath: 'java', backupPaths: '.' },
  },
  {
    id: 'valheim', type: 'steamcmd', label: 'Valheim',
    defaults: {
      appId: '896660', executable: 'valheim_server.exe',
      args: '-nographics -batchmode -name "Meu servidor" -port 2456 -world "Dedicated" -password "trocar123" -public 1 -savedir "saves"',
      stopCommand: '', readyPattern: 'Game server connected', backupPaths: 'saves',
    },
  },
  {
    id: 'palworld', type: 'steamcmd', label: 'Palworld',
    defaults: {
      appId: '2394010', executable: 'PalServer.exe',
      args: '-port=8211 -useperfthreads -NoAsyncLoadingThread -UseMultithreadForDS',
      stopCommand: '', readyPattern: '', backupPaths: 'Pal/Saved',
    },
  },
  {
    id: 'cs2', type: 'steamcmd', label: 'Counter-Strike 2',
    defaults: {
      appId: '730', executable: 'game/bin/win64/cs2.exe', args: '-dedicated -console +map de_dust2',
      stopCommand: 'quit', readyPattern: '', backupPaths: 'game/csgo/cfg',
    },
  },
  {
    id: 'steam-custom', type: 'steamcmd', label: 'Outro jogo Steam (SteamCMD)',
    defaults: { appId: '', executable: '', args: '', stopCommand: '', readyPattern: '', backupPaths: '.' },
  },
];

// Editable settings and their types, shared by create and update.
export const FIELDS = {
  common: { name: 'string', autoStart: 'bool', autoRestart: 'bool', stopTimeoutSec: 'int', backupPaths: 'string', backupKeep: 'int' },
  minecraft: { version: 'string', memoryMb: 'int', port: 'int', javaPath: 'string' },
  steamcmd: { appId: 'string', executable: 'string', args: 'string', stopCommand: 'string', readyPattern: 'string' },
};

export function validateConfig(cfg) {
  if (!cfg.name?.trim()) throw httpError(400, 'Informe um nome');
  if (cfg.stopTimeoutSec < 5 || cfg.stopTimeoutSec > 600) throw httpError(400, 'Tempo limite para parar deve ficar entre 5 e 600 segundos');
  if (cfg.backupKeep < 1 || cfg.backupKeep > 100) throw httpError(400, 'Quantidade de backups deve ficar entre 1 e 100');
  if (cfg.type === 'minecraft') {
    if (!(cfg.memoryMb >= 512 && cfg.memoryMb <= 65536)) throw httpError(400, 'Memória deve ficar entre 512 e 65536 MB');
    if (!(cfg.port >= 1 && cfg.port <= 65535)) throw httpError(400, 'Porta inválida');
    if (!/^(latest|[\w.-]+)$/.test(cfg.version)) throw httpError(400, 'Versão inválida');
  } else {
    if (!/^\d+$/.test(cfg.appId)) throw httpError(400, 'Steam App ID deve ser numérico');
    if (cfg.readyPattern) {
      try { new RegExp(cfg.readyPattern); } catch { throw httpError(400, 'Texto de "pronto" não é uma regex válida'); }
    }
  }
}

export function isInstalled(cfg, dir) {
  if (cfg.type === 'minecraft') return fs.existsSync(path.join(dir, 'server.jar'));
  return Boolean(cfg.executable) && fs.existsSync(path.resolve(dir, cfg.executable));
}

function setProperty(file, key, value) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  fs.writeFileSync(file, re.test(text) ? text.replace(re, `${key}=${value}`) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${key}=${value}\n`);
}

function javaMajor(javaPath) {
  const res = spawnSync(javaPath, ['-version'], { encoding: 'utf8', windowsHide: true });
  const m = `${res.stderr}${res.stdout}`.match(/version "(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return m[1] === '1' ? Number(m[2]) : Number(m[1]); // "1.8.0" means Java 8
}

function checkJava(cfg) {
  if (!cfg.requiredJava) return;
  const java = cfg.javaPath || 'java';
  const have = javaMajor(java);
  if (have === null) throw httpError(400, `Java não encontrado ("${java}"). Instale o Java ${cfg.requiredJava} ou ajuste o caminho em Configurações.`);
  if (have < cfg.requiredJava) {
    throw httpError(400, `O Minecraft ${cfg.installedVersion} precisa do Java ${cfg.requiredJava}, mas "${java}" é o Java ${have}. `
      + `Instale o Java ${cfg.requiredJava} (ex.: Adoptium Temurin) ou escolha uma versão mais antiga em Configurações e clique em Atualizar.`);
  }
}

export function launchCommand(cfg, dir) {
  if (cfg.type === 'minecraft') {
    checkJava(cfg);
    setProperty(path.join(dir, 'server.properties'), 'server-port', cfg.port);
    return {
      cmd: cfg.javaPath || 'java',
      args: [`-Xms${cfg.memoryMb}M`, `-Xmx${cfg.memoryMb}M`, '-jar', 'server.jar', 'nogui'],
      stopCommand: 'stop',
      readyPattern: /Done \(/,
    };
  }
  return {
    cmd: path.resolve(dir, cfg.executable),
    args: splitArgs(cfg.args),
    stopCommand: cfg.stopCommand,
    readyPattern: cfg.readyPattern ? new RegExp(cfg.readyPattern) : null,
  };
}

async function installMinecraft(inst) {
  const manifest = await fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
  const version = inst.cfg.version === 'latest' ? manifest.latest.release : inst.cfg.version;
  const entry = manifest.versions.find(v => v.id === version);
  if (!entry) throw new Error(`Versão ${version} não encontrada`);
  const meta = await fetchJson(entry.url);
  if (!meta.downloads?.server) throw new Error(`A versão ${version} não tem servidor oficial`);
  inst.print(`Baixando servidor Minecraft ${version} (requer Java ${meta.javaVersion?.majorVersion ?? '?'})...`, 'panel');
  await download(meta.downloads.server.url, path.join(inst.dir, 'server.jar'), { sha1: meta.downloads.server.sha1 });
  // Only reached when the user ticked the EULA box at creation time.
  fs.writeFileSync(path.join(inst.dir, 'eula.txt'), 'eula=true\n');
  inst.cfg.installedVersion = version;
  inst.cfg.requiredJava = meta.javaVersion?.majorVersion ?? null;
}

async function ensureSteamCmd(inst) {
  const dir = path.join(TOOLS_DIR, 'steamcmd');
  const exe = path.join(dir, IS_WIN ? 'steamcmd.exe' : 'steamcmd.sh');
  if (fs.existsSync(exe)) return exe;
  inst.print('Baixando SteamCMD...', 'panel');
  fs.mkdirSync(dir, { recursive: true });
  const url = `https://steamcdn-a.akamaihd.net/client/installer/${IS_WIN ? 'steamcmd.zip' : 'steamcmd_linux.tar.gz'}`;
  const archive = path.join(dir, path.basename(url));
  await download(url, archive);
  await tar(['-xf', archive], dir);
  fs.rmSync(archive);
  return exe;
}

async function installSteam(inst) {
  const exe = await ensureSteamCmd(inst);
  let success = false, selfUpdated = false, code;
  for (let attempt = 1; attempt <= 2 && !success; attempt++) {
    code = await run(exe, [
      '+force_install_dir', inst.dir, '+login', 'anonymous', '+app_update', inst.cfg.appId, 'validate', '+quit',
    ], {
      cwd: path.dirname(exe),
      onLine: line => {
        if (/Success! App '\d+' (fully installed|already up to date)/.test(line)) success = true;
        if (/Update complete, launching/.test(line)) selfUpdated = true;
        if (line.trim()) inst.print(line, 'steamcmd');
      },
    });
    // After updating itself SteamCMD exits (code 7) without running the queued commands.
    if (!success && attempt === 1 && (selfUpdated || code === 7)) inst.print('SteamCMD foi atualizado; executando novamente...', 'panel');
    else break;
  }
  if (!success) throw new Error(`SteamCMD terminou (código ${code}) sem confirmar a instalação. Verifique o App ID e o log acima.`);
}

export const installServer = inst => (inst.cfg.type === 'minecraft' ? installMinecraft(inst) : installSteam(inst));
