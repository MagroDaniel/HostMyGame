import fs from 'node:fs';
import path from 'node:path';
import { BACKUPS_DIR, save } from './store.js';
import { httpError, sleep, tar } from './util.js';
import { resolveSafe } from './files.js';

const NAME_RE = /^[\w.-]+\.tar\.gz$/;

const dirFor = inst => path.join(BACKUPS_DIR, inst.cfg.id);
// Per-backup extras kept in the instance config: { [name]: { locked, note } }
const meta = inst => (inst.cfg.backupMeta ??= {});

export function listBackups(inst) {
  const dir = dirFor(inst);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(n => NAME_RE.test(n))
    .map(name => { const s = fs.statSync(path.join(dir, name)); const m = meta(inst)[name] || {}; return { name, size: s.size, created: s.mtimeMs, locked: Boolean(m.locked), note: m.note || '' }; })
    .sort((a, b) => b.created - a.created);
}

export function backupFile(inst, name) {
  if (!NAME_RE.test(name)) throw httpError(400, 'Nome de backup inválido');
  const file = path.join(dirFor(inst), name);
  if (!fs.existsSync(file)) throw httpError(404, 'Backup não encontrado');
  return file;
}

export async function createBackup(inst, { note = '' } = {}) {
  const paths = (inst.cfg.backupPaths || '.').split(',').map(p => p.trim()).filter(Boolean);
  for (const p of paths) {
    if (!fs.existsSync(resolveSafe(inst.dir, p))) throw httpError(400, `Pasta de backup não existe: ${p}`);
  }
  const dir = dirFor(inst);
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const name = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.tar.gz`;
  const file = path.join(dir, name);

  // Minecraft keeps writing chunks while running; pause autosave so the archive is consistent.
  const { provider, flavor } = inst.template;
  const pause = inst.state === 'Running' && provider === 'minecraft'
    ? (flavor === 'bedrock' ? { before: ['save hold'], after: ['save resume'] } : flavor !== 'velocity' ? { before: ['save-off', 'save-all flush'], after: ['save-on'] } : null)
    : null;
  if (pause) {
    for (const c of pause.before) await inst.sendCommand(c, 'panel');
    await sleep(5000);
  }
  inst.print(`Criando backup ${name}...`, 'panel');
  try {
    // Lock files are held open exclusively by running servers on Windows and aren't worth restoring anyway.
    // Extra patterns from the backup settings (one per line), e.g. logs or big caches.
    const extra = excludePatterns(inst).flatMap(x => ['--exclude', x]);
    await tar(['-czf', file, '--exclude', '*.lock', ...extra, ...paths], inst.dir);
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw e;
  } finally {
    if (pause && inst.running) for (const c of pause.after) await inst.sendCommand(c, 'panel').catch(() => {});
  }
  inst.print('Backup concluído.', 'panel');
  if (note) { meta(inst)[name] = { ...meta(inst)[name], note: String(note).slice(0, 100) }; save(); }

  // Keep the newest N; locked backups don't count and are never removed automatically.
  for (const old of listBackups(inst).filter(b => !b.locked).slice(inst.cfg.backupKeep || 10)) deleteBackup(inst, old.name, { auto: true });
  return name;
}

export async function restoreBackup(inst, name) {
  if (inst.busy) throw httpError(409, 'Pare o servidor antes de restaurar um backup');
  const file = backupFile(inst, name);
  inst.print(`Restaurando backup ${name}...`, 'panel');
  await tar(['-xzf', file], inst.dir);
  inst.print('Backup restaurado.', 'panel');
}

export function deleteBackup(inst, name, { auto = false } = {}) {
  const file = backupFile(inst, name);
  if (!auto && meta(inst)[name]?.locked) throw httpError(409, 'Este backup está travado. Destrave antes de excluir.');
  fs.rmSync(file);
  if (meta(inst)[name]) { delete meta(inst)[name]; save(); }
}

export function setBackupLock(inst, name, locked) {
  backupFile(inst, name);
  meta(inst)[name] = { ...meta(inst)[name], locked: Boolean(locked) };
  save();
}

export function excludePatterns(inst) {
  return String(inst.cfg.backupExclude || '').split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#')).slice(0, 50);
}
