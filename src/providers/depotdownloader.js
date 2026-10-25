// DepotDownloader (github.com/SteamRE/DepotDownloader) handles everything that needs a Steam account:
// unlike SteamCMD it can sign in with a QR code scanned in the Steam mobile app, and it keeps the
// session (a refresh token, in .NET isolated storage of the Windows user running the panel) for later downloads.
import fs from 'node:fs';
import path from 'node:path';
import { TOOLS_DIR, db } from '../store.js';
import { IS_WIN, download, extract, run, serialized } from '../util.js';

const VERSION = '3.4.0';
const PACKAGES = {
  win: { file: 'DepotDownloader-windows-x64.zip', sha256: '41c9e9f0df54b3ad02e67a11726756e5c73283bd7c2e1b04acfa5ae4c2ed3767' },
  linux: { file: 'DepotDownloader-linux-x64.zip', sha256: 'a999dec66b4850fc961bd50366696d23c2d0fad7b18790e6a5647b2f19097a53' },
};
const DIR = path.join(TOOLS_DIR, 'depotdownloader');
const EXE = path.join(DIR, IS_WIN ? 'DepotDownloader.exe' : 'DepotDownloader');
// Any small public app works for signing in; this one is the Steamworks redistributables.
const LOGIN_APP = '1007';
const QR_TIMEOUT = 5 * 60 * 1000;

// The account settings file is shared, so runs never overlap.
const queued = fn => serialized('depotdownloader', fn);

async function ensure(log) {
  if (fs.existsSync(EXE)) return EXE;
  const pkg = PACKAGES[IS_WIN ? 'win' : 'linux'];
  log(`Baixando DepotDownloader ${VERSION}...`);
  const archive = path.join(DIR, pkg.file);
  await download(`https://github.com/SteamRE/DepotDownloader/releases/download/DepotDownloader_${VERSION}/${pkg.file}`, archive, { sha256: pkg.sha256 });
  await extract(archive, DIR);
  fs.rmSync(archive);
  if (!IS_WIN) fs.chmodSync(EXE, 0o755);
  return EXE;
}

// Turns the QR code DepotDownloader draws in text (two characters per module, one line per row) into rows of 0/1.
function qrCollector(onQr) {
  let rows = null, width = 0;
  const flush = () => {
    const lines = rows.filter(r => r.trim());
    if (lines.length >= 21) onQr(rows.map(r => Array.from({ length: width / 2 }, (_, i) => (r[i * 2] === ' ' ? 0 : 1))));
    rows = null;
  };
  return line => {
    if (/sign in with this QR code/i.test(line)) { rows = []; width = 0; return true; }
    if (!rows) return false;
    if ((!width || line.length === width) && line.length >= 42 && line.length % 2 === 0 && /^[^\w]*$/.test(line)) {
      width = line.length;
      rows.push(line);
      // The code is square: the last row arrives right away, the next text line only when Steam renews it.
      if (rows.length === width / 2) flush();
      return true;
    }
    flush();
    return false;
  };
}

// Questions like "Enter account password:" or the Steam Guard code prompt end without a newline, so line
// reading never sees them; this watches the raw output for the unfinished last line.
const PROMPT = /(STEAM GUARD!|Please enter|Enter account password)/i;
function watchPrompts(child, onPrompt) {
  let tail = '', shown = '';
  child.stdout.on('data', chunk => {
    tail = (tail + String(chunk)).slice(-500);
    const last = tail.split(/\r?\n/).pop().trim();
    if (last && last !== shown && PROMPT.test(last)) { shown = last; onPrompt(last); }
  });
}

// Signs in and stores the session. Without a password it shows a QR code (onQr receives the module matrix).
// With a password, Steam Guard either asks for a code (answer through the child's stdin) or for approval in the app.
export function login({ username, password, log, onQr, onSpawn }) {
  return queued(async () => {
    const exe = await ensure(log);
    const tmp = path.join(DIR, 'login');
    const args = ['-app', LOGIN_APP, '-manifest-only', '-remember-password', '-dir', tmp];
    if (password) args.push('-username', username, '-password', password);
    else args.push('-qr');
    let account = null, failure = null, timer = null, expired = false;
    const qr = qrCollector(onQr);
    const code = await run(exe, args, {
      cwd: DIR,
      onSpawn: child => {
        onSpawn?.(child);
        watchPrompts(child, text => log(/2.factor|authenticator/i.test(text)
          ? `${text}  →  digite o código do app Steam Guard no campo abaixo`
          : /email/i.test(text) ? `${text}  →  digite o código enviado ao seu e-mail no campo abaixo` : text));
        // Steam keeps renewing the QR code forever; give up after a while so the queue isn't held.
        if (!password) timer = setTimeout(() => { expired = true; child.kill(); }, QR_TIMEOUT);
      },
      onLine: line => {
        if (qr(line)) return;
        const ok = line.match(/Next time you can login with -username (\S+)/);
        if (ok) account = ok[1];
        if (password && /Logging '.+' into Steam3\.\.\./.test(line)) account ??= username;
        const bad = line.match(/Unable to login to Steam3: (\w+)/);
        if (bad) failure = bad[1];
        if (/QR code has changed/i.test(line)) return log('O QR code foi renovado pela Steam; escaneie o novo.');
        if (line.trim()) log(line);
      },
    });
    clearTimeout(timer);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (expired) throw new Error('O QR code não foi escaneado em 5 minutos. Clique em "Entrar com QR code" para gerar outro.');
    if (failure) throw new Error(failure === 'InvalidPassword' ? 'Usuário ou senha incorretos' : `A Steam recusou o login (${failure})`);
    if (code === null) throw new Error('Login cancelado');
    if (code !== 0 || !account) throw new Error(`Login não concluído (código ${code})`);
    return account;
  });
}

// Downloads an app with the saved session. Never prompts: if the session is gone it fails with a clear message.
export function installApp({ dir, appId, branch, betaPassword, log, onSpawn }) {
  if (!db.steamUser) throw new Error('Este jogo exige uma conta Steam. Faça login em Configurações > Conta Steam.');
  return queued(async () => {
    const exe = await ensure(log);
    const args = ['-app', String(appId), '-username', db.steamUser, '-remember-password', '-dir', dir];
    if (branch) args.push('-branch', branch);
    if (betaPassword) args.push('-branchpassword', betaPassword);
    let done = false, failure = null;
    const expired = 'a sessão da Steam expirou ou não existe neste PC. Entre de novo em Configurações > Conta Steam.';
    const code = await run(exe, args, {
      cwd: DIR,
      onSpawn: child => {
        onSpawn?.(child);
        // Nobody can answer here: any question means there is no usable saved session.
        child.stdin.end();
        watchPrompts(child, () => { failure = expired; child.kill(); });
      },
      onLine: line => {
        if (/Total downloaded:/.test(line)) done = true;
        if (/has stored credentials|Enter account password|Please enter/i.test(line)) failure = expired;
        if (/Depot \d+ is not available from this account/.test(line)) failure = 'a conta Steam conectada não tem este jogo';
        const bad = line.match(/Unable to login to Steam3: (\w+)|Access token was rejected \((\w+)\)/);
        if (bad) failure = `a Steam recusou o login (${bad[1] || bad[2]}). Entre de novo em Configurações > Conta Steam.`;
        // Per-file lines would flood the console; progress shows per depot.
        if (/^\s*[\d.]+% /.test(line) || /^(Pre-allocating|Validating) /.test(line)) return;
        if (line.trim()) log(line);
      },
    });
    if (!done) throw new Error(`Download pela conta Steam falhou${failure ? `: ${failure}` : ` (código ${code})`}`);
  });
}
