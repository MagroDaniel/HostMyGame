import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IS_WIN, copyOver, download, extract, fetchJson, run } from '../util.js';
import { resolveJava } from './java.js';

const MOJANG = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const FILL = 'https://fill.papermc.io/v3/projects';

async function mojangVersion(requested) {
  const manifest = await fetchJson(MOJANG);
  const id = !requested || requested === 'latest' ? manifest.latest.release : requested;
  const entry = manifest.versions.find(v => v.id === id);
  if (!entry) throw new Error(`Versão do Minecraft ${id} não encontrada`);
  return { id, meta: await fetchJson(entry.url) };
}

async function fillLatest(project, requested) {
  let versions;
  if (!requested || requested === 'latest') {
    const list = await fetchJson(`${FILL}/${project}/versions`);
    versions = list.versions.map(v => v.version.id).filter(v => !/(pre|rc|snapshot)/i.test(v));
  } else versions = [requested];
  for (const v of versions.slice(0, 5)) {
    const res = await fetch(`${FILL}/${project}/versions/${v}/builds/latest`, { headers: { 'User-Agent': 'host-my-game/1.0' } });
    if (!res.ok) continue;
    const build = await res.json();
    const file = build.downloads?.['server:default'];
    if (!file) continue;
    let java = null;
    try { java = (await fetchJson(`${FILL}/${project}/versions/${v}`)).version?.java?.version?.minimum ?? null; } catch { /* optional */ }
    return { version: v, build: build.id, url: file.url, sha256: file.checksums?.sha256, java };
  }
  throw new Error(`Nenhuma build do ${project} encontrada para ${requested || 'latest'}`);
}

// Downloads/installs the server and returns what was installed ({ version, build, requiredJava }).
export async function installMinecraft(inst, log) {
  const { flavor } = inst.template;
  const s = inst.cfg.settings;
  const dir = inst.dir;
  const jar = path.join(dir, 'server.jar');
  const progress = name => (r, t) => log(`${name}: ${Math.round(r / t * 100)}%`);

  if (flavor === 'bedrock') {
    const links = await fetchJson('https://net-secondary.web.minecraft-services.net/api/v1.0/download/links');
    const type = IS_WIN ? 'serverBedrockWindows' : 'serverBedrockLinux';
    const url = links.result.links.find(l => l.downloadType === type)?.downloadUrl;
    if (!url) throw new Error('Link de download do Bedrock não encontrado');
    const version = url.match(/bedrock-server-([\d.]+)\.zip/)?.[1] ?? '?';
    if (inst.cfg.installed?.version === version && fs.existsSync(path.join(dir, 'bedrock_server.exe'))) {
      log(`Bedrock ${version} já está instalado.`);
      return inst.cfg.installed;
    }
    log(`Baixando Minecraft Bedrock ${version}...`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hmg-bedrock-'));
    try {
      await download(url, path.join(tmp, 'server.zip'), { onProgress: progress('Bedrock') });
      await extract(path.join(tmp, 'server.zip'), path.join(tmp, 'files'));
      // Updates must not overwrite the world or the admin's edits.
      copyOver(path.join(tmp, 'files'), dir, ['worlds', 'server.properties', 'permissions.json', 'allowlist.json', 'whitelist.json']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return { version };
  }

  if (flavor === 'velocity') {
    const v = await fillLatest('velocity', s.version);
    log(`Baixando Velocity ${v.version} (build ${v.build})...`);
    await download(v.url, jar, { sha256: v.sha256, onProgress: progress('Velocity') });
    return { version: v.version, build: v.build, requiredJava: v.java || 21 };
  }

  // Java edition flavors: the vanilla metadata tells which Java the version needs.
  let base;
  if (flavor === 'paper' || flavor === 'purpur') {
    let version = s.version;
    if (flavor === 'purpur' && (!version || version === 'latest')) version = (await fetchJson('https://api.purpurmc.org/v2/purpur')).metadata.current;
    if (flavor === 'paper') {
      const p = await fillLatest('paper', version);
      base = await mojangVersion(p.version);
      log(`Baixando Paper ${p.version} (build ${p.build})...`);
      await download(p.url, jar, { sha256: p.sha256, onProgress: progress('Paper') });
      return { version: p.version, build: p.build, requiredJava: Math.max(p.java || 0, base.meta.javaVersion?.majorVersion || 0) || null };
    }
    base = await mojangVersion(version);
    const info = await fetchJson(`https://api.purpurmc.org/v2/purpur/${base.id}/latest`);
    log(`Baixando Purpur ${base.id} (build ${info.build})...`);
    await download(`https://api.purpurmc.org/v2/purpur/${base.id}/latest/download`, jar, { onProgress: progress('Purpur') });
    return { version: base.id, build: info.build, requiredJava: base.meta.javaVersion?.majorVersion };
  }

  base = await mojangVersion(s.version);
  const requiredJava = base.meta.javaVersion?.majorVersion;

  if (flavor === 'vanilla') {
    const server = base.meta.downloads?.server;
    if (!server) throw new Error(`A versão ${base.id} não tem servidor oficial`);
    log(`Baixando Minecraft ${base.id}...`);
    await download(server.url, jar, { sha1: server.sha1, onProgress: progress('Minecraft') });
    return { version: base.id, requiredJava };
  }

  if (flavor === 'fabric') {
    const loaders = await fetchJson('https://meta.fabricmc.net/v2/versions/loader');
    const installers = await fetchJson('https://meta.fabricmc.net/v2/versions/installer');
    const loader = (loaders.find(l => l.stable) || loaders[0]).version;
    const installer = (installers.find(i => i.stable) || installers[0]).version;
    log(`Baixando Fabric ${loader} para Minecraft ${base.id}...`);
    await download(`https://meta.fabricmc.net/v2/versions/loader/${base.id}/${loader}/${installer}/server/jar`, jar);
    fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
    return { version: base.id, build: loader, requiredJava };
  }

  // Forge and NeoForge ship an installer that must be run with Java.
  let installerUrl, loaderVersion;
  if (flavor === 'forge') {
    const promos = (await fetchJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).promos;
    loaderVersion = promos[`${base.id}-recommended`] || promos[`${base.id}-latest`];
    if (!loaderVersion) throw new Error(`Não há Forge para o Minecraft ${base.id}`);
    const full = `${base.id}-${loaderVersion}`;
    installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`;
    loaderVersion = full;
  } else {
    const all = (await fetchJson('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge')).versions;
    const [, minor, patch = '0'] = base.id.split('.');
    const prefix = base.id.startsWith('1.') ? `${minor}.${patch}.` : `${base.id}.`;
    const matching = all.filter(v => v.startsWith(prefix) && !v.includes('craftmine'));
    loaderVersion = matching.filter(v => !v.includes('beta')).at(-1) || matching.at(-1);
    if (!loaderVersion) throw new Error(`Não há NeoForge para o Minecraft ${base.id}`);
    installerUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`;
  }
  const installer = path.join(dir, 'installer.jar');
  log(`Baixando instalador ${flavor === 'forge' ? 'Forge' : 'NeoForge'} ${loaderVersion}...`);
  await download(installerUrl, installer);
  const java = await resolveJava(s.javaPath, requiredJava, log);
  log('Executando o instalador (pode levar alguns minutos)...');
  const code = await run(java, ['-jar', 'installer.jar', '--installServer'], { cwd: dir, onLine: log });
  fs.rmSync(installer, { force: true });
  fs.rmSync(path.join(dir, 'installer.jar.log'), { force: true });
  if (code !== 0) throw new Error(`O instalador terminou com código ${code}`);
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  return { version: base.id, build: loaderVersion, requiredJava };
}

// Builds the java command line; Forge/NeoForge 1.17+ start through an args file instead of a jar.
export function minecraftLaunchArgs(inst) {
  const { flavor } = inst.template;
  const s = inst.cfg.settings;
  const mem = [`-Xms${s.memoryMb}M`, `-Xmx${s.memoryMb}M`];
  const extra = s.jvmArgs ? s.jvmArgs.split(/\s+/).filter(Boolean) : [];
  if (flavor === 'forge' || flavor === 'neoforge') {
    const build = inst.cfg.installed?.build;
    const group = flavor === 'forge' ? 'net/minecraftforge/forge' : 'net/neoforged/neoforge';
    const argsFile = `libraries/${group}/${build}/${IS_WIN ? 'win' : 'unix'}_args.txt`;
    if (build && fs.existsSync(path.join(inst.dir, argsFile))) return [...mem, ...extra, `@${argsFile}`, 'nogui'];
    const legacy = fs.readdirSync(inst.dir).find(f => /^forge-.*\.jar$/.test(f) && !f.includes('installer'));
    if (legacy) return [...mem, ...extra, '-jar', legacy, 'nogui'];
    throw new Error('Arquivos do Forge/NeoForge não encontrados. Reinstale o servidor.');
  }
  return [...mem, ...extra, '-jar', 'server.jar', ...(flavor === 'velocity' ? ['--port', String(s.port)] : ['nogui'])];
}

export async function latestMinecraft(inst) {
  const { flavor } = inst.template;
  const s = inst.cfg.settings;
  if (flavor === 'bedrock') {
    const links = await fetchJson('https://net-secondary.web.minecraft-services.net/api/v1.0/download/links');
    const url = links.result.links.find(l => l.downloadType === (IS_WIN ? 'serverBedrockWindows' : 'serverBedrockLinux'))?.downloadUrl;
    return { version: url?.match(/bedrock-server-([\d.]+)\.zip/)?.[1] };
  }
  if (flavor === 'paper' || flavor === 'velocity') {
    const v = await fillLatest(flavor, s.version);
    return { version: v.version, build: v.build };
  }
  if (s.version && s.version !== 'latest') return null; // pinned versions don't auto-update
  const manifest = await fetchJson(MOJANG);
  return { version: manifest.latest.release };
}
