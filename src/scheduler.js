import cron from 'node-cron';
import { save } from './store.js';
import { httpError, sleep } from './util.js';
import { createBackup } from './backups.js';
import { record } from './activity.js';

export const ACTIONS = {
  start: 'Iniciar',
  stop: 'Parar',
  restart: 'Reiniciar',
  command: 'Enviar comando',
  wait: 'Esperar',
  backup: 'Fazer backup',
  update: 'Atualizar servidor',
};

const jobs = new Map(); // schedule id -> cron task
const MAX_STEPS = 20;

// A schedule runs a list of steps in order. Older schedules had a single action/payload; they become one step.
export function normalizeSchedule(s) {
  if (!Array.isArray(s.steps) || !s.steps.length) s.steps = s.action ? [{ action: s.action, payload: s.payload || '' }] : [];
  delete s.action;
  delete s.payload;
  s.name = s.name || '';
  s.onlyOnline = Boolean(s.onlyOnline);
  return s;
}

export function validateSchedule(s) {
  if (!cron.validate(s.cron || '')) throw httpError(400, 'Expressão cron inválida');
  if (!s.steps.length) throw httpError(400, 'Adicione pelo menos um passo');
  if (s.steps.length > MAX_STEPS) throw httpError(400, `No máximo ${MAX_STEPS} passos por tarefa`);
  s.steps.forEach((st, i) => {
    const n = `Passo ${i + 1}`;
    if (!ACTIONS[st.action]) throw httpError(400, `${n}: ação inválida`);
    if (st.action === 'command' && !st.payload?.trim()) throw httpError(400, `${n}: informe o comando a enviar`);
    if (st.action === 'wait' && !(Number(st.payload) >= 1 && Number(st.payload) <= 3600)) throw httpError(400, `${n}: espera deve ser de 1 a 3600 segundos`);
  });
}

export function schedule(inst, s) {
  unschedule(s.id);
  if (s.enabled) jobs.set(s.id, cron.schedule(s.cron, () => runTask(inst, s)));
}

export function unschedule(id) {
  jobs.get(id)?.stop();
  jobs.delete(id);
}

export const stepLabel = st => `${ACTIONS[st.action] || st.action}${st.payload ? (st.action === 'wait' ? ` ${st.payload}s` : `: ${st.payload}`) : ''}`;

async function runStep(inst, st) {
  switch (st.action) {
    case 'start':
      if (!inst.busy) await inst.start();
      break;
    case 'stop':
      await inst.stop();
      break;
    case 'restart':
      // Optional payload is a warning sent to players before restarting.
      if (inst.running && st.payload) {
        await inst.sendCommand(st.payload, 'scheduler');
        await sleep(5000);
      }
      if (inst.running) await inst.restart();
      else if (!inst.busy) await inst.start();
      break;
    case 'command':
      if (!inst.running) throw new Error('o servidor não está ligado');
      await inst.sendCommand(st.payload, 'scheduler');
      break;
    case 'wait':
      await sleep(Number(st.payload) * 1000);
      break;
    case 'backup':
      await createBackup(inst);
      break;
    case 'update': {
      const wasRunning = inst.running;
      await inst.stop();
      await inst.install();
      if (wasRunning) await inst.start({ skipUpdate: true });
      break;
    }
  }
}

export async function runTask(inst, s, user = 'agendador') {
  normalizeSchedule(s);
  const title = s.name || s.steps.map(stepLabel).join(' → ');
  if (s.running) return inst.print(`Tarefa "${title}" ainda está em andamento; esta execução foi pulada.`, 'scheduler');
  if (s.onlyOnline && !inst.running) {
    s.lastRun = Date.now();
    s.lastResult = 'pulada: servidor desligado';
    save();
    return;
  }
  s.running = true;
  inst.print(`Tarefa agendada: ${title}`, 'scheduler');
  record(user, 'executou tarefa', inst.cfg.name, title, inst.cfg.id);
  try {
    for (const [i, st] of s.steps.entries()) {
      if (s.steps.length > 1) inst.print(`Passo ${i + 1}/${s.steps.length}: ${stepLabel(st)}`, 'scheduler');
      try {
        await runStep(inst, st);
      } catch (e) {
        throw new Error(`passo ${i + 1} (${ACTIONS[st.action]}): ${e.message}`);
      }
    }
    s.lastResult = 'ok';
  } catch (e) {
    inst.print(`Tarefa falhou: ${e.message}`, 'scheduler');
    s.lastResult = e.message;
  } finally {
    s.running = false;
  }
  s.lastRun = Date.now();
  save();
}
