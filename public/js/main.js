import { $, $$, act, api, badge, esc, findInst, gameArt, icon, isAdmin, openModal, route, setUnauthorizedHandler, state, toast } from './core.js';
import { renderInstances, updateInstancesView } from './views/instances.js';
import { renderInstance, onInstanceConsole, onInstanceStatus } from './views/instance.js';
import { openCreateDialog } from './views/create.js';
import { renderActivity, renderAccount, renderSchedules, renderSettings, renderUsers, onSteamLine, showPanelUpdateNotice } from './views/admin.js';

const NAV = [
  { view: '', label: 'Servidores', icon: 'server' },
  { view: 'schedules', label: 'Agendador', icon: 'clock' },
  { view: 'activity', label: 'Atividade', icon: 'activity', admin: true },
  { view: 'users', label: 'Usuários', icon: 'users', admin: true },
  { view: 'settings', label: 'Configurações', icon: 'settings', admin: true },
];

// ---------- login ----------
function showLogin(setup) {
  state.ws?.close();
  state.ws = null;
  $('#app').hidden = true;
  $('#login').hidden = false;
  const f = $('#loginForm');
  $('#loginTitle').textContent = setup ? 'Criar conta de administrador' : 'Entrar';
  $('#loginHint').hidden = !setup;
  $('#forgotBtn').hidden = setup;
  $('#codeRow').hidden = true;
  f.code.value = '';
  f.dataset.setup = setup ? '1' : '';
  f.password.autocomplete = setup ? 'new-password' : 'current-password';
}
setUnauthorizedHandler(() => showLogin(false));

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const body = { username: f.username.value.trim(), password: f.password.value, code: f.code.value.trim() || undefined };
  try {
    await api('POST', f.dataset.setup ? '/api/auth/setup' : '/api/auth/login', body);
  } catch (err) {
    if (err.data?.needCode) {
      $('#codeRow').hidden = false;
      f.code.focus();
      return;
    }
    toast(err.message, 'error');
    return;
  }
  f.password.value = '';
  f.code.value = '';
  await enterApp();
});

// ---------- forgotten password ----------
// The code is written to a file on the panel's PC, so only someone with access to that computer can use it.
$('#forgotBtn').addEventListener('click', act(async () => {
  const { file } = await api('POST', '/api/auth/recover/start');
  const { el, close } = openModal(`
    <div class="modal-head"><h2>Recuperar senha</h2><button class="icon-btn" data-close aria-label="Fechar">✕</button></div>
    <p>No computador onde o painel está instalado, abra este arquivo. Ele tem um código válido por 15 minutos e a lista de usuários do painel:</p>
    <code class="recover-file">${esc(file)}</code>
    <p class="hint">Na versão instalada, use Menu Iniciar → Host My Game → Pasta de dados.</p>
    <form class="form" id="recoverForm">
      <label>Usuário<input name="username" autocomplete="username" required value="${esc($('#loginForm').username.value.trim())}"></label>
      <label>Código do arquivo<input name="code" autocomplete="one-time-code" required spellcheck="false" placeholder="xxxxx-xxxxx"></label>
      <label>Nova senha<input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
      <label>Repita a nova senha<input name="confirm" type="password" autocomplete="new-password" minlength="8" required></label>
      <label class="check"><input type="checkbox" name="disableTotp"> Também desativar a verificação em duas etapas (perdi o celular do autenticador)</label>
      <div class="modal-actions"><button type="button" data-close>Cancelar</button><button class="primary">Trocar senha</button></div>
    </form>`);
  $('#recoverForm', el).addEventListener('submit', act(async e => {
    e.preventDefault();
    const f = e.target;
    if (f.password.value !== f.confirm.value) throw new Error('As senhas não são iguais');
    await api('POST', '/api/auth/recover/finish', { username: f.username.value.trim(), code: f.code.value.trim(), password: f.password.value, disableTotp: f.disableTotp.checked });
    close();
    $('#loginForm').username.value = f.username.value.trim();
    $('#loginForm').password.focus();
    toast('Senha alterada. Entre com a nova senha.', 'ok', 8000);
  }));
  $('[name=code]', el).focus();
}));

$('#logoutBtn').addEventListener('click', act(async () => {
  closeUserMenu();
  await api('POST', '/api/auth/logout');
  showLogin(false);
}));

async function enterApp() {
  const auth = await api('GET', '/api/auth/state');
  if (!auth.user) return showLogin(auth.setup);
  state.user = auth.user;
  state.version = auth.version;
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#userName').textContent = auth.user.username;
  $('#userRole').textContent = auth.user.role === 'admin' ? 'Administrador' : 'Usuário';
  $('#avatar').textContent = auth.user.username[0].toUpperCase();
  $('#versionLabel').textContent = `Versão ${auth.version}`;
  $('#footVersion').textContent = `v${auth.version}`;
  const [catalog, instances, sysinfo] = await Promise.all([api('GET', '/api/catalog'), api('GET', '/api/instances'), api('GET', '/api/system').catch(() => null)]);
  state.games = catalog.games;
  state.actions = catalog.actions;
  state.instances = instances;
  state.sysinfo = sysinfo;
  connectWs();
  render();
  if (isAdmin()) checkPanelUpdateNotice();
}

async function checkPanelUpdateNotice() {
  try { showPanelUpdateNotice(await api('GET', '/api/panel/update')); } catch { /* not important enough to toast */ }
  setTimeout(checkPanelUpdateNotice, 60 * 60 * 1000);
}

// ---------- live updates ----------
function connectWs() {
  if (state.ws) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  state.ws = ws;
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'console') onInstanceConsole(msg.id, msg.entry);
    if (msg.type === 'status') onStatus(msg);
    if (msg.type === 'steam') onSteamLine(msg.entry);
  };
  ws.onclose = () => {
    if (state.ws !== ws) return;
    state.ws = null;
    if (!$('#app').hidden) setTimeout(connectWs, 3000);
  };
}

function onStatus(msg) {
  const before = state.instances.map(i => i.id).join();
  state.instances = msg.instances;
  state.system = msg.system;
  for (const inst of msg.instances) {
    const h = state.history[inst.id];
    if (h && msg.t - (h.at(-1)?.t ?? 0) >= 1500) {
      h.push({ t: msg.t, cpu: inst.cpu, mem: inst.mem, players: inst.players });
      if (h.length > 180) h.shift();
    }
  }
  const r = route();
  if (r.view === 'instance') {
    if (!findInst(r.id) && before !== state.instances.map(i => i.id).join()) location.hash = '#/';
    else onInstanceStatus(findInst(r.id));
  }
  if (r.view === '') updateInstancesView();
}

// ---------- navbar ----------
function renderNav() {
  const r = route();
  const current = r.view === 'instance' ? '' : r.view;
  $('#navLinks').innerHTML = NAV.filter(m => !m.admin || isAdmin()).map(m => `
    <a href="#/${m.view}" class="${current === m.view ? 'active' : ''}">${icon(m.icon)}<span>${esc(m.label)}</span></a>`).join('');
}

function closeUserMenu() {
  $('#userDropdown').hidden = true;
  $('#userBtn').setAttribute('aria-expanded', 'false');
}
$('#userBtn').addEventListener('click', e => {
  e.stopPropagation();
  const dd = $('#userDropdown');
  dd.hidden = !dd.hidden;
  $('#userBtn').setAttribute('aria-expanded', String(!dd.hidden));
});
document.addEventListener('click', e => {
  if (!e.target.closest('.user-menu')) closeUserMenu();
  if (!e.target.closest('#navLinks, #menuToggle')) $('#navLinks').classList.remove('open');
});
$('#userDropdown').addEventListener('click', e => { if (e.target.closest('a')) closeUserMenu(); });
$('#menuToggle').addEventListener('click', () => $('#navLinks').classList.toggle('open'));
$('#searchBtn').innerHTML = icon('search');
$('#menuToggle').innerHTML = icon('menu');
$$('#userDropdown [data-icon]').forEach(el => el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon)));

// ---------- quick search (Ctrl+K) ----------
function openSearch() {
  if ($('#app').hidden || $('.search-modal')) return;
  const { el, close } = openModal(`
    <input id="qs" placeholder="Buscar servidor por nome ou jogo…" autocomplete="off" spellcheck="false">
    <div class="search-results" id="qsResults"></div>`);
  el.classList.add('search-modal');
  const input = $('#qs', el);
  let sel = 0, results = [];
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    results = state.instances.filter(i => !q || `${i.name} ${i.game}`.toLowerCase().includes(q)).slice(0, 12);
    sel = Math.min(sel, Math.max(0, results.length - 1));
    $('#qsResults', el).innerHTML = results.length
      ? results.map((i, n) => `<a href="#/instance/${i.id}" class="${n === sel ? 'sel' : ''}">${gameArt(i.image, i.game, 'mini')}<span style="flex:1;min-width:0"><strong>${esc(i.name)}</strong><br><span class="muted small">${esc(i.game)}</span></span>${badge(i.state)}</a>`).join('')
      : '<div class="empty">Nenhum servidor encontrado.</div>';
  };
  input.addEventListener('input', () => { sel = 0; draw(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') sel = Math.min(sel + 1, results.length - 1);
    else if (e.key === 'ArrowUp') sel = Math.max(sel - 1, 0);
    else if (e.key === 'Enter' && results[sel]) { location.hash = `#/instance/${results[sel].id}`; close(); return; }
    else return;
    e.preventDefault();
    draw();
  });
  $('#qsResults', el).addEventListener('click', e => { if (e.target.closest('a')) close(); });
  draw();
  input.focus();
}
$('#searchBtn').addEventListener('click', openSearch);
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
});

// ---------- routing ----------
function render() {
  renderNav();
  closeUserMenu();
  $('#navLinks').classList.remove('open');
  // Each view fills these in; the server page replaces the page header with its own.
  $('#subnav').hidden = true;
  $('#pageHead').hidden = false;
  $('#pageActions').innerHTML = '';
  const r = route();
  const views = {
    '': () => renderInstances(),
    instance: () => (findInst(r.id) ? renderInstance(r.id, r.tab || 'console') : renderInstances()),
    new: () => { renderInstances(); openCreateDialog(); },
    schedules: renderSchedules,
    activity: renderActivity,
    users: renderUsers,
    settings: renderSettings,
    account: renderAccount,
  };
  act(views[r.view] || views[''])();
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', () => { if (!$('#app').hidden) render(); });

// ---------- boot ----------
act(async () => {
  const auth = await api('GET', '/api/auth/state');
  if (auth.user) await enterApp();
  else showLogin(auth.setup);
})();
