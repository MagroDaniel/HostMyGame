import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';

const FILE = path.join(DATA_DIR, 'activity.log');
const MAX_BYTES = 5 * 1024 * 1024;

// Append-only audit trail of who did what (JSON lines).
// instanceId (optional) lets the server page show its own history even after the server is renamed.
export function record(user, action, target = '', detail = '', instanceId = undefined) {
  const entry = { t: Date.now(), user: user || 'sistema', action, target, detail: String(detail ?? '').slice(0, 500), ...(instanceId ? { instanceId } : {}) };
  try {
    if (fs.existsSync(FILE) && fs.statSync(FILE).size > MAX_BYTES) fs.renameSync(FILE, FILE + '.1');
    fs.appendFileSync(FILE, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('Falha ao gravar o registro de atividades:', e.message);
  }
}

export function readActivity({ limit = 300, user, target, search, instance } = {}) {
  if (!fs.existsSync(FILE)) return [];
  const lines = fs.readFileSync(FILE, 'utf8').trim().split('\n');
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (user && e.user !== user) continue;
    if (target && e.target !== target) continue;
    // { id, name }: entries tagged with the id, or older untagged entries with the current name
    if (instance && !(e.instanceId === instance.id || (!e.instanceId && e.target === instance.name))) continue;
    if (search && !`${e.action} ${e.target} ${e.detail}`.toLowerCase().includes(search.toLowerCase())) continue;
    out.push(e);
  }
  return out;
}
