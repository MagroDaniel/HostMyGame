import * as modrinth from './modrinth.js';
import * as curseforge from './curseforge.js';
import * as modpacks from './modpacks.js';
import * as workshop from './workshop.js';

export { modrinth, curseforge, modpacks, workshop };

// 'modrinth' (Minecraft Java: mods/plugins from Modrinth and CurseForge, and modpacks; vanilla gets only
// modpacks), 'workshop' (Steam Workshop) or null.
export function modKind(inst) {
  if (modrinth.supportsModrinth(inst) || modpacks.supportsModpacks(inst)) return 'modrinth';
  if (workshop.supportsWorkshop(inst)) return 'workshop';
  return null;
}

// Long mod operations (Workshop downloads) run in the background, queued one after another per instance,
// so the user can click "Instalar" on several mods in a row. Progress goes to the instance console.
export function startJob(inst, label, fn) {
  const log = line => inst.print(line, 'panel');
  const q = (inst.modQueue ??= { chain: Promise.resolve(), pending: 0, current: null, lastError: null });
  q.pending++;
  if (q.pending > 1) log(`${label}: na fila (${q.pending - 1} antes).`);
  q.chain = q.chain.then(async () => {
    q.current = label;
    log(`${label}...`);
    try {
      await fn(log);
      log(`${label}: concluído.`);
    } catch (e) {
      q.lastError = `${label}: ${e.message}`;
      log(`${label}: erro — ${e.message}`);
    } finally {
      q.pending--;
      q.current = null;
    }
  });
}

export function jobStatus(inst) {
  const q = inst.modQueue;
  if (!q) return null;
  return { running: q.pending > 0, label: q.current, pending: q.pending, error: q.lastError };
}

// The error is shown once, then forgotten.
export function clearJobError(inst) {
  if (inst.modQueue) inst.modQueue.lastError = null;
}
