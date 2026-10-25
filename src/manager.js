import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { db, instancesRoot, newId, save } from './store.js';
import { spawnSync } from 'node:child_process';
import { IS_WIN, dirSize, httpError, randomPassword, slugify } from './util.js';
import { getTemplate } from './catalog.js';
import { Instance, OVERRIDABLE } from './instance.js';
import { sampleProcesses } from './metrics.js';
import { portFree } from './network.js';
import { normalizeSchedule, schedule, unschedule, validateSchedule } from './scheduler.js';
import { removeInstanceAccess } from './auth.js';
import { createBackup } from './backups.js';

export const instances = new Map();
export const bus = new EventEmitter(); // re-emits instance events tagged with the instance id

function register(inst) {
  instances.set(inst.cfg.id, inst);
  inst.on('console', entry => bus.emit('console', inst.cfg.id, entry));
  inst.on('state', () => bus.emit('state', inst.cfg.id));
  for (const s of inst.cfg.schedules) { normalizeSchedule(s); s.running = false; schedule(inst, s); }
}

function defaultValue(def) {
  return def.default === '$random' ? randomPassword(12) : def.default;
}

export function loadInstances() {
  let changed = false;
  for (const cfg of db.instances) {
    const template = getTemplate(cfg.templateId);
    // Settings added to a template after the instance was created get their defaults.
    for (const def of template?.settings || []) {
      if (cfg.settings[def.key] === undefined) { cfg.settings[def.key] = defaultValue(def); changed = true; }
    }
    // The panel folder was renamed or moved: a server folder stored with the old absolute path is found
    // again by its name inside the current instances folder.
    if (cfg.dir && !fs.existsSync(cfg.dir)) {
      const moved = path.join(instancesRoot(), path.basename(cfg.dir));
      if (fs.existsSync(moved)) {
        console.log(`Pasta do servidor "${cfg.name}" encontrada em ${moved} (antes: ${cfg.dir})`);
        cfg.dir = moved;
        changed = true;
      }
    }
    const inst = new Instance(cfg);
    register(inst);
    if (cfg.pid) { killLeftover(inst, cfg.pid); delete cfg.pid; changed = true; }
  }
  if (changed) save();
}

// A server still running from before the panel restarted can't be controlled (its console is gone)
// and would hold the ports, so it is ended, but only if the PID still belongs to the same program.
function killLeftover(inst, { pid, image }) {
  if (!IS_WIN || !pid) return;
  const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }).stdout || '';
  if (!out.toLowerCase().includes(`"${String(image).toLowerCase()}"`)) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  inst.print(`O servidor ainda estava rodando de uma sessão anterior do painel (PID ${pid}) e foi encerrado.`, 'panel');
}

export function getInstance(id) {
  const inst = instances.get(id);
  if (!inst) throw httpError(404, 'Instância não encontrada');
  return inst;
}

function coerceSetting(def, v) {
  switch (def.type) {
    case 'bool':
      return v === true || v === 'true' || v === 'on' || v === 1;
    case 'number':
    case 'port': {
      const n = Number(v);
      if (!Number.isFinite(n) || !Number.isInteger(n)) throw httpError(400, `${def.label}: número inválido`);
      const [min, max] = def.type === 'port' ? [1, 65535] : [def.min ?? -Infinity, def.max ?? Infinity];
      if (n < min || n > max) throw httpError(400, `${def.label}: deve ficar entre ${min} e ${max}`);
      return n;
    }
    case 'select':
      if (!def.options.some(o => o[0] === String(v))) throw httpError(400, `${def.label}: opção inválida`);
      return String(v);
    default:
      return String(v ?? '');
  }
}

function applySettings(cfg, template, input = {}) {
  for (const def of template.settings) {
    if (def.key in input) cfg.settings[def.key] = coerceSetting(def, input[def.key]);
    else if (cfg.settings[def.key] === undefined) cfg.settings[def.key] = defaultValue(def);
  }
}

const int = (v, min, max, label) => {
  const n = Number.parseInt(v, 10);
  if (!(n >= min && n <= max)) throw httpError(400, `${label} deve ficar entre ${min} e ${max}`);
  return n;
};

function applyGeneral(cfg, input) {
  if ('name' in input) {
    const name = String(input.name).trim();
    if (!name) throw httpError(400, 'Informe um nome');
    cfg.name = name.slice(0, 60);
  }
  if ('description' in input) cfg.description = String(input.description || '').trim().slice(0, 200);
  for (const k of ['autoStart', 'autoRestart', 'updateOnStart']) if (k in input) cfg[k] = Boolean(input[k]);
  if ('stopTimeoutSec' in input) cfg.stopTimeoutSec = int(input.stopTimeoutSec, 5, 600, 'Tempo limite para parar');
  if ('backupKeep' in input) cfg.backupKeep = int(input.backupKeep, 1, 100, 'Quantidade de backups');
  if ('backupPaths' in input) cfg.backupPaths = String(input.backupPaths).trim() || '.';
  if ('backupExclude' in input) cfg.backupExclude = String(input.backupExclude || '').slice(0, 2000);
  for (const k of ['steamBranch', 'steamBetaPassword']) if (k in input) cfg[k] = String(input[k] || '').trim();
  if ('steamAppId' in input && getTemplate(cfg.templateId)?.custom) {
    if (input.steamAppId && !/^\d+$/.test(input.steamAppId)) throw httpError(400, 'Steam App ID deve ser numérico');
    cfg.steamAppId = String(input.steamAppId || '');
  }
  if (input.overrides) {
    cfg.overrides = { ...cfg.overrides };
    for (const k of OVERRIDABLE) {
      if (!(k in input.overrides)) continue;
      const v = String(input.overrides[k] ?? '');
      if (k === 'ready' && v) { try { new RegExp(v); } catch { throw httpError(400, 'Texto de "pronto" não é uma regex válida'); } }
      if (k === 'console' && v && !['stdin', 'rcon', 'telnet', 'log'].includes(v)) throw httpError(400, 'Modo de console inválido');
      if (v === '') delete cfg.overrides[k]; else cfg.overrides[k] = v;
    }
  }
}

export function createInstance(input) {
  const template = getTemplate(input.templateId);
  if (!template) throw httpError(400, 'Jogo inválido');
  if (template.eula && !input.eula) throw httpError(400, 'É preciso aceitar o EULA do Minecraft');
  const id = newId();
  const name = String(input.name || '').trim() || template.name;
  let dir = String(input.dir || '').trim();
  if (dir) {
    if (!path.isAbsolute(dir)) throw httpError(400, 'A pasta de instalação deve ser um caminho completo (ex.: D:\\Servidores\\Valheim)');
    if (instances.size && [...instances.values()].some(i => path.resolve(i.dir) === path.resolve(dir))) throw httpError(409, 'Outra instância já usa essa pasta');
  } else {
    dir = path.join(instancesRoot(), `${slugify(name)}-${id}`);
  }
  const cfg = {
    id, name: '', templateId: template.id, dir, settings: {}, overrides: {},
    autoStart: false, autoRestart: true, updateOnStart: false, stopTimeoutSec: 60, backupKeep: 10,
    backupPaths: template.backupPaths, schedules: [], createdAt: Date.now(),
  };
  applyGeneral(cfg, { ...input, name });
  applySettings(cfg, template, input.settings);
  if (template.id === 'generic' && !cfg.overrides.exe) throw httpError(400, 'Informe o executável do programa');
  if (template.id === 'steam-custom' && !cfg.steamAppId) throw httpError(400, 'Informe o Steam App ID');
  if (template.eula) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n'); // the user ticked the EULA box
  }
  db.instances.push(cfg);
  save();
  const inst = new Instance(cfg);
  register(inst);
  return inst;
}

// ---------- Minecraft: switch loader / version ----------
// The Java flavors share the same settings and world format, so a server can move between them.
export const MC_JAVA = ['vanilla', 'paper', 'purpur', 'fabric', 'forge', 'neoforge'];
const MODS_DIR = { fabric: 'mods', forge: 'mods', neoforge: 'mods', paper: 'plugins', purpur: 'plugins' };
// Loader files that the new install recreates; worlds, configs, mods/ and plugins/ stay.
export const LOADER_FILES = ['server.jar', 'libraries', 'versions', 'cache', '.fabric', 'run.bat', 'run.sh', 'user_jvm_args.txt', 'installer.jar', 'installer.jar.log'];

export function switchMinecraft(inst, { templateId, version }) {
  const from = inst.template;
  const to = getTemplate(String(templateId || ''));
  if (inst.busy) throw httpError(409, 'Pare o servidor antes de trocar o tipo ou a versão');
  if (from.provider !== 'minecraft' || !MC_JAVA.includes(from.flavor)) throw httpError(400, 'Só servidores Minecraft Java podem trocar de tipo');
  if (!to || to.provider !== 'minecraft' || !MC_JAVA.includes(to.flavor)) throw httpError(400, 'Tipo de servidor inválido');
  const v = String(version || 'latest').trim();
  if (!/^(latest|[0-9A-Za-z][\w.+-]{0,30})$/.test(v)) throw httpError(400, 'Versão inválida (use "latest" ou algo como 1.21.4)');

  const log = line => inst.print(line, 'panel');
  return (async () => {
    inst.setState('Installing'); // blocks start/install while the backup runs
    try {
      const same = from.id === to.id && (inst.cfg.settings.version || 'latest') === v;
      log((same ? `Reinstalando ${to.name} ${v}...` : `Trocando de ${from.name} ${inst.cfg.installed?.version || ''} para ${to.name} ${v}...`).replace(/\s+/g, ' '));
      log('Fazendo backup completo antes da troca...');
      const b = await createBackup(inst);
      log(`Backup criado: ${b} (aba Backups).`);
      for (const f of LOADER_FILES) fs.rmSync(path.join(inst.dir, f), { recursive: true, force: true });
      const oldDir = MODS_DIR[from.flavor], newDir = MODS_DIR[to.flavor];
      if (oldDir && oldDir !== newDir && fs.existsSync(path.join(inst.dir, oldDir))) {
        log(`Atenção: a pasta ${oldDir}/ (${oldDir === 'plugins' ? 'plugins' : 'mods'}) foi mantida, mas não funciona no ${to.name}.`);
      }
      if (oldDir === 'plugins' && newDir !== 'plugins' && fs.existsSync(path.join(inst.dir, 'world_nether'))) {
        log('Atenção: o Nether e o End do Paper/Purpur (world_nether, world_the_end) não são lidos por este tipo; o mundo principal continua.');
      }
      if (MODS_DIR[from.flavor] === 'mods' && from.flavor !== to.flavor && newDir === 'mods') {
        log(`Atenção: mods feitos para ${from.flavor} geralmente não funcionam no ${to.flavor}. Confira a aba Mods.`);
      }
      inst.cfg.templateId = to.id;
      inst.cfg.settings.version = v;
      inst.cfg.installed = null;
      inst.cfg.updateAvailable = false;
      save();
    } finally {
      inst.setState('Stopped');
    }
    await inst.install();
    log(`Pronto: agora é ${to.name} ${inst.cfg.installed?.version || v}. Inicie o servidor quando quiser.`);
  })();
}

export function updateInstance(inst, input) {
  const next = structuredClone(inst.cfg);
  applyGeneral(next, input);
  if (input.settings) applySettings(next, inst.template, input.settings);
  Object.assign(inst.cfg, next);
  save();
}

export function deleteInstance(inst, deleteFiles) {
  if (inst.busy) throw httpError(409, 'Pare o servidor antes de excluir');
  for (const s of inst.cfg.schedules) unschedule(s.id);
  instances.delete(inst.cfg.id);
  db.instances = db.instances.filter(c => c.id !== inst.cfg.id);
  removeInstanceAccess(inst.cfg.id);
  save();
  inst.removeAllListeners();
  if (deleteFiles) fs.rmSync(inst.dir, { recursive: true, force: true });
}

// Ports used by more than one instance, plus (for stopped instances) ports already taken by other programs.
export async function portWarnings(inst) {
  const warnings = [];
  const mine = inst.ports();
  for (const other of instances.values()) {
    if (other === inst) continue;
    for (const p of other.ports()) {
      const clash = mine.find(m => m.port === p.port && (m.proto === p.proto || m.proto === 'both' || p.proto === 'both'));
      if (clash) warnings.push(`A porta ${p.port} (${clash.name}) também é usada por "${other.cfg.name}".`);
    }
  }
  if (!inst.proc) {
    for (const p of mine) {
      for (const proto of p.proto === 'both' ? ['tcp', 'udp'] : [p.proto]) {
        if (!(await portFree(p.port, proto))) warnings.push(`A porta ${p.port}/${proto.toUpperCase()} (${p.name}) já está em uso por outro programa.`);
      }
    }
  }
  return [...new Set(warnings)];
}

// ---- schedules ----
// Accepts { steps: [{action, payload}] } or the older single { action, payload }.
function stepsFrom(input) {
  const raw = Array.isArray(input.steps) ? input.steps : input.action ? [{ action: input.action, payload: input.payload }] : [];
  return raw.map(st => ({ action: String(st?.action || ''), payload: String(st?.payload ?? '').trim() }));
}

export function addSchedule(inst, input) {
  const s = {
    id: newId(), name: String(input.name || '').trim().slice(0, 60), cron: String(input.cron || '').trim(),
    steps: stepsFrom(input), onlyOnline: Boolean(input.onlyOnline), enabled: input.enabled !== false,
  };
  validateSchedule(s);
  inst.cfg.schedules.push(s);
  save();
  schedule(inst, s);
  return s;
}

export function getSchedule(inst, sid) {
  const s = inst.cfg.schedules.find(x => x.id === sid);
  if (!s) throw httpError(404, 'Tarefa não encontrada');
  return s;
}

export function updateSchedule(inst, s, input) {
  const next = { ...s };
  if ('cron' in input) next.cron = String(input.cron).trim();
  if ('name' in input) next.name = String(input.name || '').trim().slice(0, 60);
  if ('steps' in input || 'action' in input) next.steps = stepsFrom(input);
  if ('onlyOnline' in input) next.onlyOnline = Boolean(input.onlyOnline);
  if ('enabled' in input) next.enabled = Boolean(input.enabled);
  validateSchedule(next);
  Object.assign(s, next);
  save();
  schedule(inst, s);
}

export function deleteSchedule(inst, s) {
  unschedule(s.id);
  inst.cfg.schedules = inst.cfg.schedules.filter(x => x !== s);
  save();
}

// ---- metrics ----
const CORES = os.cpus().length;
let sampling = false;

// Folder sizes are slow to compute (big Steam installs), so they're refreshed in the background, one instance at a time.
let measuringDisk = false;
export async function refreshDiskUsage({ onlyUnknown = false } = {}) {
  if (measuringDisk) return;
  measuringDisk = true;
  try {
    for (const inst of [...instances.values()]) {
      if (onlyUnknown && inst.diskSize !== undefined && !inst.diskStale) continue;
      inst.diskStale = false;
      inst.diskSize = await dirSize(inst.dir);
    }
  } finally {
    measuringDisk = false;
  }
}

export async function sampleMetrics() {
  if (sampling) return; // a slow sample must not pile up behind the next tick
  sampling = true;
  try {
    const running = [...instances.values()].filter(i => i.proc?.pid);
    const usage = await sampleProcesses(running.map(i => i.proc.pid));
    const now = Date.now();
    for (const inst of instances.values()) {
      const pid = inst.proc?.pid;
      const u = pid && usage.get(pid);
      if (u) {
        const prev = inst.lastSample;
        const cpu = prev?.pid === pid ? (u.cpuSec - prev.cpuSec) / ((now - prev.t) / 1000) / CORES * 100 : 0;
        inst.metrics = { cpu: Math.max(0, Math.min(100, cpu)), mem: u.mem };
        inst.lastSample = { pid, cpuSec: u.cpuSec, t: now };
      } else {
        inst.metrics = { cpu: 0, mem: 0 };
        inst.lastSample = null;
      }
      inst.pushHistory(now);
    }
  } finally {
    sampling = false;
  }
}

export async function queryAll() {
  await Promise.all([...instances.values()].map(i => i.query()));
}

export async function stopAll() {
  await Promise.all([...instances.values()].map(i => i.stop().catch(() => {})));
}
