// Checks GitHub Releases for a newer version of the panel itself and, in the installed build, applies it.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, TOOLS_DIR, VERSION } from './store.js';
import { download, fetchJson, httpError, IS_WIN } from './util.js';

const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const REPO = process.env.HMG_UPDATE_REPO || PKG.updateRepo || '';
// Set by the Windows service config; a copy run from source can only point to the release page.
export const INSTALLED = process.env.HMG_INSTALLED === '1';

const state = { current: VERSION, latest: null, notes: '', url: null, publishedAt: null, checkedAt: 0, error: null, applying: false };
let asset = null;
let checking = null;
const TASK = 'HostMyGameUpdate';

// The installer has finished by the time the service starts again, so its one-off task can go.
if (INSTALLED && IS_WIN) spawnSync('schtasks', ['/Delete', '/TN', TASK, '/F'], { windowsHide: true, stdio: 'ignore' });

// "1.2.10" > "1.2.9"; pre-release suffixes are ignored.
function newer(a, b) {
  const pa = String(a).replace(/^v/i, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

export function panelUpdateState() {
  return { ...state, repo: REPO || null, installed: INSTALLED, available: Boolean(state.latest && newer(state.latest, VERSION)), canApply: INSTALLED && Boolean(asset) };
}

export function checkPanelUpdate() {
  if (!REPO) return Promise.resolve(panelUpdateState());
  if (checking) return checking;
  checking = (async () => {
    try {
      const rel = await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`);
      state.latest = rel.tag_name.replace(/^v/i, '');
      state.notes = rel.body || '';
      state.url = rel.html_url;
      state.publishedAt = rel.published_at;
      asset = rel.assets?.find(a => /setup.*\.exe$/i.test(a.name)) || null;
      state.error = null;
    } catch (e) {
      state.error = e.message;
      console.error('Verificação de atualização do painel falhou:', e.message);
    }
    state.checkedAt = Date.now();
    return panelUpdateState();
  })().finally(() => { checking = null; });
  return checking;
}

// Downloads the installer, stops the game servers and hands over to the installer, which restarts the service.
export async function applyPanelUpdate(stopAll) {
  if (!INSTALLED || !IS_WIN) throw httpError(400, 'A atualização automática só funciona na versão instalada. Baixe a nova versão na página do GitHub.');
  if (state.applying) throw httpError(409, 'A atualização já está em andamento');
  await checkPanelUpdate();
  if (!panelUpdateState().available || !asset) throw httpError(400, 'Não há atualização disponível');
  state.applying = true;
  try {
    const file = path.join(TOOLS_DIR, 'update', asset.name);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
    const sha256 = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : undefined;
    await download(asset.browser_download_url, file, { sha256 });
    await stopAll();
    // A one-off scheduled task runs the installer outside this process tree,
    // so it survives the service stop that the installer itself triggers.
    const log = path.join(path.dirname(file), 'install.log');
    const cmd = `"${file}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG="${log}"`;
    const create = spawnSync('schtasks', ['/Create', '/TN', TASK, '/TR', cmd, '/SC', 'ONCE', '/ST', '23:59', '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/F'], { encoding: 'utf8', windowsHide: true });
    if (create.status !== 0) throw new Error(`Não foi possível agendar o instalador: ${(create.stderr || create.stdout).trim()}`);
    const runTask = spawnSync('schtasks', ['/Run', '/TN', TASK], { encoding: 'utf8', windowsHide: true });
    if (runTask.status !== 0) throw new Error(`Não foi possível iniciar o instalador: ${(runTask.stderr || runTask.stdout).trim()}`);
  } catch (e) {
    state.applying = false;
    throw e;
  }
}
