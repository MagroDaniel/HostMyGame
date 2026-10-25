import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IS_WIN, copyOver, download, extract, fetchJson } from '../util.js';

async function terraria(inst, log) {
  const names = await fetchJson('https://terraria.org/api/get/dedicated-servers-names');
  const file = names[0];
  const version = file.match(/(\d+)/)?.[1];
  log(`Baixando servidor Terraria ${version}...`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hmg-terraria-'));
  try {
    await download(`https://terraria.org/api/download/pc-dedicated-server/${file}`, path.join(tmp, 'server.zip'));
    await extract(path.join(tmp, 'server.zip'), path.join(tmp, 'files'));
    const platformDir = path.join(tmp, 'files', version, IS_WIN ? 'Windows' : 'Linux');
    if (!fs.existsSync(platformDir)) throw new Error('Estrutura inesperada no pacote do Terraria');
    copyOver(platformDir, inst.dir, ['serverconfig.txt']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(inst.dir, 'worlds'), { recursive: true });
  return { version };
}

async function mindustry(inst, log) {
  const release = await fetchJson('https://api.github.com/repos/Anuken/Mindustry/releases/latest');
  const asset = release.assets.find(a => a.name === 'server-release.jar');
  if (!asset) throw new Error('server-release.jar não encontrado na última versão');
  log(`Baixando Mindustry ${release.tag_name}...`);
  await download(asset.browser_download_url, path.join(inst.dir, 'server-release.jar'));
  return { version: release.tag_name, requiredJava: 17 };
}

const SOURCES = { terraria, mindustry };

export function installDownload(inst, log) {
  const fn = SOURCES[inst.template.source];
  if (!fn) throw new Error(`Fonte de download desconhecida: ${inst.template.source}`);
  return fn(inst, log);
}

export async function latestDownload(inst) {
  if (inst.template.source === 'terraria') {
    const names = await fetchJson('https://terraria.org/api/get/dedicated-servers-names');
    return { version: names[0].match(/(\d+)/)?.[1] };
  }
  if (inst.template.source === 'mindustry') {
    return { version: (await fetchJson('https://api.github.com/repos/Anuken/Mindustry/releases/latest')).tag_name };
  }
  return null;
}
