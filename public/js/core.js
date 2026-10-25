export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const state = {
  user: null,          // { username, role, access, totp }
  version: '',
  instances: [],
  games: [],
  actions: {},
  system: null,
  sysinfo: null,       // static host info (OS, CPU, LAN IP)
  history: {},
  ws: null,
  view: 'grid',
  search: '',
};

export const isAdmin = () => state.user?.role === 'admin';

export const STATE_LABELS = {
  Stopped: 'Parado', Starting: 'Iniciando', Running: 'Rodando', Stopping: 'Parando', Installing: 'Instalando', Failed: 'Falhou',
};

export class AuthError extends Error {}
let onUnauthorized = () => {};
export const setUnauthorizedHandler = fn => { onUnauthorized = fn; };

export async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (res.status === 401 && !url.startsWith('/api/auth')) {
    onUnauthorized();
    throw new AuthError('Sessão expirada, entre novamente');
  }
  if (!res.ok) throw Object.assign(new Error(data?.error || `Erro ${res.status}`), { data });
  return data;
}

export function toast(msg, kind = 'info', ms = 4500) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

// Wraps a UI handler so failures show as a toast instead of vanishing.
export const act = fn => async (...args) => {
  try { return await fn(...args); } catch (e) { if (!(e instanceof AuthError)) toast(e.message, 'error'); }
};

export const fmtBytes = b => {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.max(0, Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024))));
  return `${(b / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
};
export const fmtDate = t => (t ? new Date(t).toLocaleString('pt-BR') : '—');
export const fmtTime = t => new Date(t).toLocaleTimeString('pt-BR');
export const fmtUptime = ms => {
  if (!ms) return '—';
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
};
export const joinPath = (a, b) => (a ? `${a}/${b}` : b);
export const instApi = (id, sub = '') => `/api/instances/${id}${sub}`;
export const findInst = id => state.instances.find(i => i.id === id);
// Address players on the home network use: LAN IP + the first (main) game port.
export const address = i => (i.ports?.length ? `${state.sysinfo?.lanIp || '127.0.0.1'}:${i.ports[0].port}` : '—');
export const badge = s => `<span class="badge state-${s}"><span class="dot ${s}"></span>${STATE_LABELS[s] || s}</span>`;
export const playersText = i => (i.players === null || i.players === undefined ? '—' : `${i.players}${i.maxPlayers ? ` / ${i.maxPlayers}` : ''}`);

// Line icons (24x24 stroke paths), rendered inline so they follow the text color.
const ICONS = {
  server: '<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  archive: '<path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  network: '<rect x="9" y="2" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M12 8v4M5 16v-2h14v2"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  play: '<path d="m6 3 14 9-14 9z"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
  restart: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  kill: '<path d="M18 6 6 18M6 6l12 12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>',
  memory: '<rect x="2" y="7" width="20" height="10" rx="1"/><path d="M6 7v10M10 7v10M14 7v10M18 7v10"/>',
  disk: '<path d="M22 12H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11zM6 16h.01M10 16h.01"/>',
  wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  trash: '<path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  puzzle: '<path d="M19.44 12.01a2 2 0 1 0 0-4H18V5a2 2 0 0 0-2-2h-3.06a2 2 0 1 0-4 0H6a2 2 0 0 0-2 2v3h1.51a2 2 0 1 1 0 4H4v4a2 2 0 0 0 2 2h3v-1.5a2 2 0 1 1 4 0V18h3a2 2 0 0 0 2-2v-3.99z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
};
export const icon = name => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// Banner image for a game, with a generated fallback for games without Steam art.
export function gameArt(image, name, cls = '') {
  const initials = String(name || '?').replace(/\(.*?\)/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  let hue = 0;
  for (const ch of String(name)) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  const fallback = `<div class="art-fallback" style="--h:${hue}"><span>${esc(initials)}</span></div>`;
  if (!image) return `<div class="art ${cls}">${fallback}</div>`;
  return `<div class="art ${cls}"><img src="${esc(image)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'art-fallback',innerHTML:'<span>${esc(initials)}</span>'}))"></div>`;
}

export function route() {
  const [, view = '', id, tab] = location.hash.split('/');
  return { view, id, tab };
}

// ---------- modal ----------
export function openModal(html, { wide = false, onClose } = {}) {
  const root = $('#modalRoot');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  root.append(backdrop);
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) close(); });
  $$('[data-close]', backdrop).forEach(b => b.addEventListener('click', close));
  return { el: $('.modal', backdrop), close };
}

export function confirmDialog(message, { okText = 'Confirmar', danger = false } = {}) {
  return new Promise(resolve => {
    let answered = false;
    const { el, close } = openModal(`
      <div class="modal-head"><h2>Confirmação</h2><button class="icon-btn" data-close aria-label="Fechar">✕</button></div>
      <p>${esc(message)}</p>
      <div class="modal-actions"><button data-close>Cancelar</button><button class="${danger ? 'danger' : 'primary'}" id="okBtn">${esc(okText)}</button></div>`,
    { onClose: () => { if (!answered) resolve(false); } });
    $('#okBtn', el).addEventListener('click', () => { answered = true; resolve(true); close(); });
    $('#okBtn', el).focus();
  });
}

export function promptDialog(title, value = '', { label = '', okText = 'OK' } = {}) {
  return new Promise(resolve => {
    let answered = false;
    const { el, close } = openModal(`
      <div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Fechar">✕</button></div>
      <form id="pf" class="form"><label>${esc(label)}<input name="v" value="${esc(value)}" autocomplete="off"></label>
      <div class="modal-actions"><button type="button" data-close>Cancelar</button><button class="primary">${esc(okText)}</button></div></form>`,
    { onClose: () => { if (!answered) resolve(null); } });
    const f = $('#pf', el);
    f.v.focus();
    f.v.select();
    f.addEventListener('submit', e => { e.preventDefault(); answered = true; resolve(f.v.value.trim()); close(); });
  });
}

// ---------- settings form fields ----------
export function settingField(def, value, prefix = 's_') {
  const name = prefix + def.key;
  const v = value ?? def.default;
  const hint = def.hint ? `<span class="hint">${esc(def.hint)}</span>` : '';
  if (def.type === 'bool') return `<label class="check"><input type="checkbox" name="${name}" ${v ? 'checked' : ''}> ${esc(def.label)}</label>`;
  if (def.type === 'select') {
    return `<label>${esc(def.label)}<select name="${name}">${def.options.map(([val, l]) => `<option value="${esc(val)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>${hint}</label>`;
  }
  const type = def.type === 'password' ? 'text' : ['number', 'port'].includes(def.type) ? 'number' : 'text';
  const shown = v === '$random' ? '' : v;
  const ph = v === '$random' ? 'placeholder="(gerada automaticamente)"' : '';
  return `<label>${esc(def.label)}<input name="${name}" type="${type}" value="${esc(shown)}" ${ph} ${def.min !== undefined ? `min="${def.min}"` : ''} ${def.max !== undefined ? `max="${def.max}"` : ''} ${def.type === 'password' ? 'autocomplete="off" class="secret"' : ''}>${hint}</label>`;
}

export function settingsFields(defs, values = {}, prefix = 's_') {
  const basic = defs.filter(d => !d.advanced);
  const adv = defs.filter(d => d.advanced);
  return `<div class="form-grid">${basic.map(d => settingField(d, values[d.key], prefix)).join('')}</div>
    ${adv.length ? `<details class="advanced"><summary>Opções avançadas</summary><div class="form-grid">${adv.map(d => settingField(d, values[d.key], prefix)).join('')}</div></details>` : ''}`;
}

export function readSettings(form, defs, prefix = 's_') {
  const out = {};
  for (const d of defs) {
    const input = form.elements[prefix + d.key];
    if (!input) continue;
    if (d.type === 'bool') out[d.key] = input.checked;
    else if (d.default === '$random' && input.value === '') continue; // keep the generated default
    else out[d.key] = input.value;
  }
  return out;
}

// ---------- tiny line chart ----------
export function drawChart(canvas, series, { max, fmt, integer = false, color }) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, hgt = canvas.clientHeight;
  if (!w || !hgt) return;
  canvas.width = w * dpr;
  canvas.height = hgt * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const values = series.filter(v => v !== null && v !== undefined);
  // Integer series (player counts) get an even top so the middle gridline is a whole number too.
  const top = max ?? (integer ? Math.max(2, Math.ceil(Math.max(0, ...values) * 1.25 / 2) * 2) : Math.max(1, ...values) * 1.2);
  const pad = { l: 58, r: 8, t: 8, b: 8 };
  const plotW = w - pad.l - pad.r, plotH = hgt - pad.t - pad.b;
  ctx.font = '11px "IBM Plex Sans", system-ui';
  ctx.fillStyle = css.getPropertyValue('--g400');
  ctx.strokeStyle = css.getPropertyValue('--g600');
  ctx.lineWidth = 1;
  for (let i = 0; i <= 2; i++) {
    const y = pad.t + plotH * (i / 2);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(fmt(top * (1 - i / 2)), 4, y + 4);
  }
  if (series.length < 2) return;
  const x = i => pad.l + plotW * (i / (series.length - 1));
  const y = v => pad.t + plotH * (1 - Math.min(v ?? 0, top) / top);
  const accent = color || css.getPropertyValue('--cyan');
  ctx.beginPath();
  series.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineTo(x(series.length - 1), pad.t + plotH);
  ctx.lineTo(x(0), pad.t + plotH);
  ctx.closePath();
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.globalAlpha = 1;
}
