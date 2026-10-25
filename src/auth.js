import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { db, save } from './store.js';
import { httpError } from './util.js';
import * as totp from './totp.js';

const COOKIE = 'hmg_session';
const SESSION_TTL = 12 * 60 * 60 * 1000;
const LOCKOUT_MS = 5 * 60 * 1000;
const MAX_FAILURES = 5;

// Per-instance permissions for non-admin users. Viewing status is implied by having any entry.
export const PERMISSIONS = {
  console: 'Ver console e enviar comandos',
  control: 'Iniciar, parar e reiniciar',
  update: 'Instalar e atualizar',
  files: 'Gerenciar arquivos',
  backups: 'Gerenciar backups',
  schedule: 'Gerenciar agendamentos',
  settings: 'Alterar configurações',
};

const sessions = new Map(); // token -> { username, expires }
const failures = new Map(); // ip -> { count, until }

export const needsSetup = () => db.users.length === 0;
const findUser = name => db.users.find(u => u.username === name);

export const publicUser = u => ({
  username: u.username, role: u.role || 'admin', access: u.access || {}, createdAt: u.createdAt, totp: Boolean(u.totpSecret), lastLogin: u.lastLogin, recoveryLeft: (u.recoveryHashes || []).length,
});
export const listUsers = () => db.users.map(publicUser);
export const getUser = name => { const u = findUser(name); return u ? publicUser(u) : null; };

function validate(username, password) {
  if (!/^[\w.-]{3,32}$/.test(username || '')) throw httpError(400, 'O usuário deve ter de 3 a 32 caracteres (letras, números, . _ -)');
  if (typeof password !== 'string' || password.length < 8) throw httpError(400, 'A senha deve ter pelo menos 8 caracteres');
}

function cleanAccess(access) {
  const out = {};
  for (const [id, perms] of Object.entries(access || {})) {
    if (Array.isArray(perms)) out[id] = perms.filter(p => p in PERMISSIONS);
  }
  return out;
}

export async function createUser(username, password, role = 'admin', access = {}) {
  validate(username, password);
  if (db.users.some(u => u.username.toLowerCase() === username.toLowerCase())) throw httpError(409, 'Esse usuário já existe');
  db.users.push({ username, hash: await bcrypt.hash(password, 12), role: role === 'user' ? 'user' : 'admin', access: cleanAccess(access), createdAt: Date.now() });
  save();
}

export function updateUser(username, { role, access }) {
  const user = findUser(username);
  if (!user) throw httpError(404, 'Usuário não encontrado');
  if (role) {
    const admins = db.users.filter(u => (u.role || 'admin') === 'admin');
    if (role === 'user' && (user.role || 'admin') === 'admin' && admins.length === 1) throw httpError(400, 'É preciso manter pelo menos um administrador');
    user.role = role === 'user' ? 'user' : 'admin';
  }
  if (access) user.access = cleanAccess(access);
  save();
}

export async function resetPassword(username, password) {
  const user = findUser(username);
  if (!user) throw httpError(404, 'Usuário não encontrado');
  validate(username, password);
  user.hash = await bcrypt.hash(password, 12);
  save();
  dropSessions(username);
}

export function deleteUser(username) {
  const idx = db.users.findIndex(u => u.username === username);
  if (idx < 0) throw httpError(404, 'Usuário não encontrado');
  const admins = db.users.filter(u => (u.role || 'admin') === 'admin');
  if ((db.users[idx].role || 'admin') === 'admin' && admins.length === 1) throw httpError(400, 'Não é possível excluir o último administrador');
  db.users.splice(idx, 1);
  save();
  dropSessions(username);
}

export function removeInstanceAccess(instanceId) {
  for (const u of db.users) if (u.access?.[instanceId]) delete u.access[instanceId];
}

function dropSessions(username) {
  for (const [token, s] of sessions) if (s.username === username) sessions.delete(token);
}

export async function changePassword(username, current, next) {
  const user = findUser(username);
  if (!user || !(await bcrypt.compare(String(current), user.hash))) throw httpError(400, 'Senha atual incorreta');
  validate(username, next);
  user.hash = await bcrypt.hash(next, 12);
  save();
}

// ---- two-factor ----
export async function beginTotp(username) {
  const user = findUser(username);
  user.pendingTotp = totp.newSecret();
  const url = totp.otpauthUrl(user.pendingTotp, username);
  return { secret: user.pendingTotp, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }) };
}

export function confirmTotp(username, code) {
  const user = findUser(username);
  if (!user.pendingTotp || !totp.verify(user.pendingTotp, code)) throw httpError(400, 'Código inválido');
  user.totpSecret = user.pendingTotp;
  delete user.pendingTotp;
  return newRecoveryCodes(user); // saves
}

export async function disableTotp(username, password) {
  const user = findUser(username);
  if (!(await bcrypt.compare(String(password), user.hash))) throw httpError(400, 'Senha incorreta');
  delete user.totpSecret;
  delete user.recoveryHashes;
  save();
}

export function adminDisableTotp(username) {
  const u = findUser(username);
  if (u) delete u.recoveryHashes;
  const user = findUser(username);
  if (!user) throw httpError(404, 'Usuário não encontrado');
  delete user.totpSecret;
  save();
}

// ---- login / sessions ----
export async function login(username, password, ip, code) {
  const now = Date.now();
  const f = failures.get(ip);
  if (f && f.count >= MAX_FAILURES && now < f.until) throw httpError(429, 'Muitas tentativas. Aguarde alguns minutos.');
  const fail = msg => {
    failures.set(ip, { count: (f && now < f.until ? f.count : 0) + 1, until: now + LOCKOUT_MS });
    throw httpError(401, msg);
  };
  const user = findUser(username);
  if (!user || !(await bcrypt.compare(String(password), user.hash))) fail('Usuário ou senha incorretos');
  if (user.totpSecret) {
    if (!code) throw Object.assign(httpError(401, 'Informe o código do autenticador'), { needCode: true });
    if (!totp.verify(user.totpSecret, code) && !useRecoveryCode(user, code)) fail('Código do autenticador inválido');
  }
  failures.delete(ip);
  user.lastLogin = now;
  save();
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username: user.username, expires: now + SESSION_TTL });
  return token;
}

const tokenFrom = req => (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]+)`))?.[1];

export function sessionUser(req) {
  const token = tokenFrom(req);
  const s = token && sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now() || !findUser(s.username)) { sessions.delete(token); return null; }
  s.expires = Date.now() + SESSION_TTL;
  return s.username;
}

export function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}`);
}

export function endSession(req, res) {
  sessions.delete(tokenFrom(req));
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

export function requireAuth(req, res, next) {
  const username = sessionUser(req);
  if (username) {
    req.user = username;
    req.account = findUser(username);
    return next();
  }
  const keyUser = apiKeyUser(req);
  if (!keyUser) return res.status(401).json({ error: 'Não autenticado' });
  req.user = keyUser.username;
  req.account = keyUser;
  req.viaApiKey = true;
  next();
}

// Account security (password, 2FA, keys) can only be changed from a logged-in browser session.
export function requireSession(req, res, next) {
  if (req.viaApiKey) return res.status(403).json({ error: 'Não disponível por chave de API' });
  next();
}

export const isAdmin = account => (account?.role || 'admin') === 'admin';

export function can(account, instanceId, perm) {
  if (isAdmin(account)) return true;
  const perms = account?.access?.[instanceId];
  if (!perms) return false;
  return !perm || perms.includes(perm);
}

export function requireAdmin(req, res, next) {
  if (!isAdmin(req.account)) return res.status(403).json({ error: 'Apenas administradores' });
  next();
}

// ---------- 2FA recovery codes ----------
// One-time codes (xxxx-xxxx) that replace the authenticator code if the phone is lost. Only hashes are stored.
const sha256 = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const normCode = c => String(c || '').trim().toLowerCase().replace(/[^0-9a-f]/g, '');

function newRecoveryCodes(user) {
  const codes = Array.from({ length: 8 }, () => {
    const x = crypto.randomBytes(4).toString('hex');
    return x.slice(0, 4) + '-' + x.slice(4);
  });
  user.recoveryHashes = codes.map(c => sha256(normCode(c)));
  save();
  return codes;
}

function useRecoveryCode(user, code) {
  const n = normCode(code);
  if (n.length !== 8) return false;
  const i = (user.recoveryHashes || []).indexOf(sha256(n));
  if (i < 0) return false;
  user.recoveryHashes.splice(i, 1);
  save();
  return true;
}

export function regenerateRecoveryCodes(username) {
  const user = findUser(username);
  if (!user?.totpSecret) throw httpError(400, 'Ative a verificação em duas etapas primeiro');
  return newRecoveryCodes(user);
}

// ---------- API keys ----------
// "Authorization: Bearer hmg_..." acts as the key's owner, with the same permissions (no 2FA prompt).
// Keys can't manage keys, passwords or 2FA. Only a SHA-256 of the key is stored.
const KEY_RE = /^hmg_[0-9a-f]{48}$/;

export function listApiKeys(username) {
  return (findUser(username)?.apiKeys || []).map(k => ({ id: k.id, name: k.name, prefix: k.prefix, createdAt: k.createdAt, lastUsed: k.lastUsed || null }));
}

export function createApiKey(username, name) {
  const user = findUser(username);
  const label = String(name || '').trim().slice(0, 40);
  if (!label) throw httpError(400, 'Dê um nome para a chave (ex.: "Bot do Discord")');
  user.apiKeys ??= [];
  if (user.apiKeys.length >= 20) throw httpError(400, 'Limite de 20 chaves');
  const token = 'hmg_' + crypto.randomBytes(24).toString('hex');
  const key = { id: crypto.randomBytes(6).toString('hex'), name: label, prefix: token.slice(0, 10), hash: sha256(token), createdAt: Date.now() };
  user.apiKeys.push(key);
  save();
  return { id: key.id, token };
}

export function deleteApiKey(username, id) {
  const user = findUser(username);
  const before = (user.apiKeys || []).length;
  user.apiKeys = (user.apiKeys || []).filter(k => k.id !== id);
  if (user.apiKeys.length === before) throw httpError(404, 'Chave não encontrada');
  save();
}

let lastKeySave = 0;
function apiKeyUser(req) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i);
  if (!m || !KEY_RE.test(m[1])) return null;
  const hash = sha256(m[1]);
  for (const u of db.users) {
    const k = (u.apiKeys || []).find(x => x.hash === hash);
    if (k) {
      k.lastUsed = Date.now();
      if (Date.now() - lastKeySave > 60000) { lastKeySave = Date.now(); save(); }
      return u;
    }
  }
  return null;
}
