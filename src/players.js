import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fetchJson, httpError } from './util.js';

// Player management ("Jogadores" tab).
//   minecraft: online list + whitelist / operators / bans. Uses console commands while the server runs and
//              edits the JSON files directly while it is stopped (the server reads them on start).
//   pz:        Project Zomboid admin commands (needs the server running); online list from the "players" command.

export function playersKind(inst) {
  const t = inst.template;
  if (t.provider === 'minecraft' && !['bedrock', 'velocity'].includes(t.flavor)) return 'minecraft';
  if (t.id === 'projectzomboid') return 'pz';
  return null;
}

const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i;
const quote = s => `"${String(s).replace(/"/g, '')}"`;

// ---------- Minecraft ----------
const MC_FILES = { whitelist: 'whitelist.json', ops: 'ops.json', bans: 'banned-players.json', ipBans: 'banned-ips.json' };

function readJson(inst, file) {
  try { return JSON.parse(fs.readFileSync(path.join(inst.dir, file), 'utf8')); } catch { return []; }
}
const writeJson = (inst, file, data) => fs.writeFileSync(path.join(inst.dir, file), JSON.stringify(data, null, 2));

// Same algorithm the server uses for offline-mode accounts (UUID v3 of "OfflinePlayer:<name>").
function offlineUuid(name) {
  const h = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

async function mcProfile(inst, name) {
  if (inst.cfg.settings?.onlineMode === false) return { uuid: offlineUuid(name), name };
  let p;
  try { p = await fetchJson(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`); } catch { p = null; }
  if (!p?.id) throw httpError(404, `Conta "${name}" não encontrada na Mojang. Confira o nome (ou desative o modo online).`);
  const id = p.id;
  return { uuid: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`, name: p.name };
}

function mcDate() {
  const d = new Date(), pad = n => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${sign}${pad(Math.floor(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)}`;
}

function mcLists(inst) {
  return {
    whitelist: readJson(inst, MC_FILES.whitelist).map(e => ({ name: e.name, uuid: e.uuid })),
    ops: readJson(inst, MC_FILES.ops).map(e => ({ name: e.name, uuid: e.uuid, level: e.level })),
    bans: readJson(inst, MC_FILES.bans).map(e => ({ name: e.name, uuid: e.uuid, reason: e.reason, created: e.created })),
    ipBans: readJson(inst, MC_FILES.ipBans).map(e => ({ ip: e.ip, reason: e.reason, created: e.created })),
    whitelistOn: inst.cfg.settings?.whitelist === true,
  };
}

const MC_COMMANDS = {
  kick: (n, r) => `kick ${n}${r ? ` ${r}` : ''}`,
  ban: (n, r) => `ban ${n}${r ? ` ${r}` : ''}`,
  pardon: n => `pardon ${n}`,
  'ban-ip': (ip, r) => `ban-ip ${ip}${r ? ` ${r}` : ''}`,
  'pardon-ip': ip => `pardon-ip ${ip}`,
  op: n => `op ${n}`,
  deop: n => `deop ${n}`,
  'whitelist-add': n => `whitelist add ${n}`,
  'whitelist-remove': n => `whitelist remove ${n}`,
};

async function mcOffline(inst, action, target, reason) {
  const byName = e => e.name?.toLowerCase() !== target.toLowerCase();
  const edit = (key, fn) => writeJson(inst, MC_FILES[key], fn(readJson(inst, MC_FILES[key])));
  switch (action) {
    case 'whitelist-add': { const p = await mcProfile(inst, target); return edit('whitelist', l => [...l.filter(byName), p]); }
    case 'whitelist-remove': return edit('whitelist', l => l.filter(byName));
    case 'op': { const p = await mcProfile(inst, target); return edit('ops', l => [...l.filter(byName), { ...p, level: 4, bypassesPlayerLimit: false }]); }
    case 'deop': return edit('ops', l => l.filter(byName));
    case 'ban': {
      const p = await mcProfile(inst, target);
      return edit('bans', l => [...l.filter(byName), { ...p, created: mcDate(), source: 'Host My Game', expires: 'forever', reason: reason || 'Banido por um administrador.' }]);
    }
    case 'pardon': return edit('bans', l => l.filter(byName));
    case 'ban-ip': return edit('ipBans', l => [...l.filter(e => e.ip !== target), { ip: target, created: mcDate(), source: 'Host My Game', expires: 'forever', reason: reason || 'Banido por um administrador.' }]);
    case 'pardon-ip': return edit('ipBans', l => l.filter(e => e.ip !== target));
    default: throw httpError(400, 'Esta ação precisa do servidor ligado');
  }
}

// ---------- Project Zomboid ----------
const PZ_COMMANDS = {
  kick: (n, r) => `kickuser ${quote(n)}${r ? ` -r ${quote(r)}` : ''}`,
  ban: (n, r) => `banuser ${quote(n)}${r ? ` -r ${quote(r)}` : ''}`,
  pardon: n => `unbanuser ${quote(n)}`,
  op: n => `setaccesslevel ${quote(n)} admin`,
  moderator: n => `setaccesslevel ${quote(n)} moderator`,
  deop: n => `setaccesslevel ${quote(n)} none`,
  'whitelist-add': n => `addusertowhitelist ${quote(n)}`,
  'whitelist-remove': n => `removeuserfromwhitelist ${quote(n)}`,
};

// "Players connected (2):" followed by "-Name" lines.
async function pzOnline(inst) {
  if (inst.state !== 'Running' || !inst.canSendCommands()) return null;
  const lines = await inst.commandOutput('players', 1200);
  const start = lines.findIndex(l => /Players connected \(\d+\)/i.test(l));
  if (start < 0) return null;
  const names = [];
  for (const l of lines.slice(start + 1)) {
    const m = l.match(/^\s*-\s*(.+?)\s*$/);
    if (!m) break;
    names.push(m[1]);
  }
  return names;
}

// ---------- public API ----------
export async function getPlayers(inst) {
  const kind = playersKind(inst);
  if (!kind) throw httpError(400, 'Este servidor não tem gerenciamento de jogadores');
  const running = inst.state === 'Running';
  const status = inst.status();
  if (kind === 'minecraft') {
    return { kind, running, online: running ? status.playerNames || [] : [], lists: mcLists(inst), canCommand: inst.canSendCommands() };
  }
  const online = await pzOnline(inst).catch(() => null);
  return { kind, running, online: online ?? [], onlineKnown: online !== null, players: status.players, canCommand: inst.canSendCommands() };
}

export async function playerAction(inst, { action, target, reason }) {
  const kind = playersKind(inst);
  const name = String(target || '').trim();
  const why = String(reason || '').replace(/[\r\n]/g, ' ').trim().slice(0, 120);
  const isIp = action === 'ban-ip' || action === 'pardon-ip';
  if (isIp ? !IP_RE.test(name) : kind === 'minecraft' ? !NAME_RE.test(name) : !/^[^"\r\n]{1,40}$/.test(name)) {
    throw httpError(400, isIp ? 'IP inválido' : 'Nome de jogador inválido');
  }
  const commands = kind === 'minecraft' ? MC_COMMANDS : PZ_COMMANDS;
  if (!commands[action]) throw httpError(400, 'Ação desconhecida');
  const live = inst.state === 'Running' && inst.canSendCommands();
  if (live) {
    await inst.sendCommand(commands[action](name, why), 'panel');
    return { applied: 'command' };
  }
  if (kind === 'minecraft') {
    if (inst.busy) throw httpError(409, 'Aguarde o servidor terminar de iniciar ou parar');
    await mcOffline(inst, action, name, why);
    return { applied: 'file' };
  }
  throw httpError(409, 'Ligue o servidor para usar os comandos de administrador do Project Zomboid');
}
