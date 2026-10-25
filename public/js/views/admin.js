import { $, $$, act, api, confirmDialog, esc, fmtBytes, fmtDate, fmtTime, isAdmin, openModal, state, toast } from '../core.js';
import { scheduleForm, scheduleTable, wireScheduleForm, wireScheduleTable } from './schedules.js';

const main = () => $('#main');
const title = t => { $('#pageTitle').textContent = t; document.title = `${t} · Host My Game`; };

// ---------- global scheduler ----------
export async function renderSchedules() {
  title('Agendador');
  const tasks = await api('GET', '/api/schedules');
  const allowed = state.instances.filter(i => isAdmin() || state.user.access?.[i.id]?.includes('schedule'));
  main().innerHTML = `
    ${scheduleTable(tasks, { showInstance: true })}
    ${allowed.length ? scheduleForm(`<label>Servidor<select name="instance">${allowed.map(i => `<option value="${i.id}">${esc(i.name)}</option>`).join('')}</select></label>`) : ''}`;
  const form = $('#taskForm');
  if (form) {
    wireScheduleForm(form, async payload => {
      await api('POST', `/api/instances/${form.instance.value}/schedules`, payload);
      toast('Tarefa criada', 'ok');
      renderSchedules();
    });
  }
  wireScheduleTable(main(), null, renderSchedules);
}

// ---------- activity log ----------
export async function renderActivity() {
  title('Registro de atividades');
  main().innerHTML = `
    <div class="toolbar">
      <input id="actSearch" class="search inline" placeholder="Filtrar por ação, instância ou detalhe…">
      <button id="actRefresh">⟳ Atualizar</button>
    </div>
    <div class="card table-wrap flush"><table><thead><tr><th>Quando</th><th>Usuário</th><th>Ação</th><th>Alvo</th><th>Detalhes</th></tr></thead><tbody id="actBody"></tbody></table></div>`;
  const load = act(async () => {
    const q = $('#actSearch').value.trim();
    const rows = await api('GET', `/api/activity?limit=500${q ? `&search=${encodeURIComponent(q)}` : ''}`);
    $('#actBody').innerHTML = rows.map(r => `<tr><td class="nowrap">${fmtDate(r.t)}</td><td>${esc(r.user)}</td><td>${esc(r.action)}</td><td>${esc(r.target)}</td><td class="muted small">${esc(r.detail)}</td></tr>`).join('')
      || '<tr><td colspan="5" class="muted">Nenhum registro.</td></tr>';
  });
  let timer;
  $('#actSearch').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 300); });
  $('#actRefresh').addEventListener('click', load);
  load();
}

// ---------- users ----------
export async function renderUsers() {
  title('Usuários');
  const { users, permissions } = await api('GET', '/api/users');
  main().innerHTML = `
    <div class="card table-wrap flush" style="margin-bottom:16px">
      <table>
        <thead><tr><th>Usuário</th><th>Função</th><th>Acesso</th><th>2FA</th><th>Último login</th><th></th></tr></thead>
        <tbody>${users.map(u => `
          <tr data-user="${esc(u.username)}">
            <td><strong>${esc(u.username)}</strong>${u.username === state.user.username ? ' <span class="muted">(você)</span>' : ''}</td>
            <td>${u.role === 'admin' ? 'Administrador' : 'Usuário'}</td>
            <td class="muted small">${u.role === 'admin' ? 'Todas as instâncias' : `${Object.keys(u.access).length} instância(s)`}</td>
            <td>${u.totp ? '✔ ativo' : '—'}</td>
            <td>${fmtDate(u.lastLogin)}</td>
            <td class="actions">
              <button class="small" data-act="edit">Permissões</button>
              <button class="small" data-act="password">Redefinir senha</button>
              ${u.totp ? '<button class="small" data-act="totp">Desativar 2FA</button>' : ''}
              ${u.username === state.user.username ? '' : '<button class="small danger" data-act="delete">Excluir</button>'}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <form class="card form narrow" id="addUser">
      <h3>Adicionar usuário</h3>
      <div class="form-grid">
        <label>Usuário <input name="username" required autocomplete="off"></label>
        <label>Senha <input name="password" type="password" required autocomplete="new-password"></label>
        <label>Função <select name="role"><option value="user">Usuário (acesso só às instâncias liberadas)</option><option value="admin">Administrador (acesso total)</option></select></label>
      </div>
      <div><button class="primary">Adicionar</button></div>
    </form>`;
  $('#addUser').addEventListener('submit', act(async e => {
    e.preventDefault();
    const f = e.target;
    await api('POST', '/api/users', { username: f.username.value.trim(), password: f.password.value, role: f.role.value });
    toast('Usuário criado. Defina as permissões dele.', 'ok');
    renderUsers();
  }));
  $$('tr[data-user]').forEach(tr => tr.addEventListener('click', act(async e => {
    const action = e.target.closest('[data-act]')?.dataset.act;
    const name = tr.dataset.user;
    const user = users.find(u => u.username === name);
    const url = `/api/users/${encodeURIComponent(name)}`;
    if (action === 'edit') editAccess(user, permissions);
    if (action === 'password') {
      const { el, close } = openModal(`
        <div class="modal-head"><h2>Nova senha para ${esc(name)}</h2><button class="icon-btn" data-close aria-label="Fechar">✕</button></div>
        <form class="form" id="pwf"><label>Nova senha<input name="pw" type="password" autocomplete="new-password" required minlength="8"></label>
        <div class="modal-actions"><button type="button" data-close>Cancelar</button><button class="primary">Salvar</button></div></form>`);
      $('#pwf', el).addEventListener('submit', act(async ev => {
        ev.preventDefault();
        await api('PATCH', url, { password: ev.target.pw.value });
        close();
        toast('Senha redefinida', 'ok');
      }));
    }
    if (action === 'totp' && await confirmDialog(`Desativar a verificação em duas etapas de ${name}?`)) {
      await api('PATCH', url, { disableTotp: true });
      renderUsers();
    }
    if (action === 'delete' && await confirmDialog(`Excluir o usuário ${name}?`, { danger: true, okText: 'Excluir' })) {
      await api('DELETE', url);
      renderUsers();
    }
  })));
}

function editAccess(user, permissions) {
  const perms = Object.entries(permissions);
  const { el, close } = openModal(`
    <div class="modal-head"><h2>Permissões de ${esc(user.username)}</h2><button class="icon-btn" data-close aria-label="Fechar">✕</button></div>
    <form id="accessForm" class="form">
      <label>Função <select name="role"><option value="user" ${user.role === 'user' ? 'selected' : ''}>Usuário</option><option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Administrador (acesso total)</option></select></label>
      <div id="accessTable" class="table-wrap">
        <table class="compact">
          <thead><tr><th>Instância</th><th>Ver</th>${perms.map(([, l]) => `<th class="small">${esc(l)}</th>`).join('')}</tr></thead>
          <tbody>${state.instances.map(i => {
            const a = user.access[i.id];
            return `<tr data-inst="${i.id}"><td>${esc(i.name)}</td><td><input type="checkbox" data-view ${a ? 'checked' : ''}></td>${perms.map(([k]) => `<td><input type="checkbox" data-perm="${k}" ${a?.includes(k) ? 'checked' : ''}></td>`).join('')}</tr>`;
          }).join('') || `<tr><td colspan="${perms.length + 2}" class="muted">Nenhuma instância criada.</td></tr>`}</tbody>
        </table>
      </div>
      <div class="modal-actions"><button type="button" data-close>Cancelar</button><button class="primary">Salvar</button></div>
    </form>`, { wide: true });
  const form = $('#accessForm', el);
  const sync = () => { $('#accessTable', el).hidden = form.role.value === 'admin'; };
  form.role.addEventListener('change', sync);
  sync();
  // Ticking any permission implies viewing; unticking "view" clears the row.
  $$('tr[data-inst]', el).forEach(tr => tr.addEventListener('change', e => {
    if (e.target.dataset.perm && e.target.checked) $('[data-view]', tr).checked = true;
    if (e.target.hasAttribute('data-view') && !e.target.checked) $$('[data-perm]', tr).forEach(c => { c.checked = false; });
  }));
  form.addEventListener('submit', act(async e => {
    e.preventDefault();
    const access = {};
    for (const tr of $$('tr[data-inst]', el)) {
      if ($('[data-view]', tr).checked) access[tr.dataset.inst] = $$('[data-perm]', tr).filter(c => c.checked).map(c => c.dataset.perm);
    }
    await api('PATCH', `/api/users/${encodeURIComponent(user.username)}`, { role: form.role.value, access });
    close();
    toast('Permissões salvas', 'ok');
    renderUsers();
  }));
}

// ---------- panel settings ----------
export function onSteamLine(entry) {
  const out = $('#steamOut');
  if (!out) return;
  $('#steamSession').hidden = false;
  const d = document.createElement('div');
  d.textContent = `[${fmtTime(entry.t)}] ${entry.text}`;
  out.append(d);
  out.scrollTop = out.scrollHeight;
}

// The QR code arrives as rows of 0/1 modules; drawn as SVG on white so phone cameras read it.
function qrSvg(rows) {
  const w = rows[0].length, h = rows.length;
  const cells = rows.flatMap((r, y) => r.map((v, x) => (v ? `M${x} ${y}h1v1h-1z` : ''))).join('');
  return `<svg viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" role="img" aria-label="QR code de login da Steam"><rect width="${w}" height="${h}" fill="#fff"/><path d="${cells}" fill="#000"/></svg>
    <p class="small">Abra o app <strong>Steam</strong> no celular → ícone do escudo (Steam Guard) → <strong>Escanear QR code</strong>.</p>`;
}

export function onSteamQr(rows) {
  const box = $('#steamQr');
  if (!box) return;
  box.hidden = !rows;
  box.innerHTML = rows ? qrSvg(rows) : '';
}

// The login finished (or failed): redraw the card so the connected account and buttons are current.
export function onSteamDone() {
  if ($('#steamQrBtn')) renderSettings();
}

export async function renderSettings() {
  title('Configurações');
  const [panel, steam, upd] = await Promise.all([api('GET', '/api/panel'), api('GET', '/api/steam'), api('GET', '/api/panel/update')]);
  const sys = panel.system;
  main().innerHTML = `
    <div class="settings-grid">
      <form class="card form" id="panelForm">
        <h3>Painel</h3>
        <label>Acesso ao painel
          <select name="host">
            <option value="127.0.0.1" ${panel.host === '127.0.0.1' ? 'selected' : ''}>Somente este computador (127.0.0.1)</option>
            <option value="0.0.0.0" ${panel.host === '0.0.0.0' ? 'selected' : ''}>Qualquer computador da rede (0.0.0.0)</option>
          </select>
        </label>
        <label>Porta do painel<input name="port" type="number" min="1" max="65535" value="${panel.port}"></label>
        <label>Pasta padrão para novas instâncias<input name="instancesDir" value="${esc(panel.instancesDir)}"></label>
        <p class="hint">Mudanças de acesso e porta valem depois de reiniciar o painel.</p>
        <div><button class="primary">Salvar</button></div>
      </form>

      <div class="card form">
        <h3>Conta Steam</h3>
        <p class="muted small">Necessária só para jogos que exigem uma conta que possua o jogo (ex.: DayZ, Arma 3). A senha não é guardada pelo painel: a sessão fica salva neste PC.</p>
        ${steam.user ? `<p class="steam-connected">Conectado como <strong>${esc(steam.user)}</strong> <button class="small" id="steamLogout">Desconectar</button></p>` : ''}
        <div class="steam-qr-row">
          <button class="primary" id="steamQrBtn" ${steam.running ? 'disabled' : ''}>Entrar com QR code (app Steam)</button>
          <button id="steamCancel" ${steam.running ? '' : 'hidden'}>Cancelar</button>
        </div>
        <div id="steamQr" class="steam-qr" ${steam.qr ? '' : 'hidden'}>${steam.qr ? qrSvg(steam.qr) : ''}</div>
        <details ${steam.running && !steam.qr ? 'open' : ''}>
          <summary class="muted small">Ou entrar com usuário e senha</summary>
          <form id="steamForm" class="form-grid">
            <label>Usuário Steam<input name="username" autocomplete="off" value="${esc(steam.user || '')}"></label>
            <label>Senha<input name="password" type="password" autocomplete="new-password"></label>
            <div><button ${steam.running ? 'disabled' : ''}>Entrar</button></div>
          </form>
        </details>
        <div id="steamSession" ${steam.log.length || steam.running ? '' : 'hidden'}>
          <div class="console small-console" id="steamOut">${steam.log.map(l => `<div>[${fmtTime(l.t)}] ${esc(l.text)}</div>`).join('')}</div>
          <form id="steamInput" class="cmd"><input name="text" placeholder="Código do Steam Guard (se pedir)" autocomplete="one-time-code"><button>Enviar</button></form>
        </div>
      </div>

      <div class="card" id="panelUpdateCard">${panelUpdateCard(upd)}</div>

      <form class="card form" id="cfForm">
        <h3>CurseForge</h3>
        <p class="muted small">Necessário só para mods e modpacks do CurseForge no Minecraft (os do Modrinth funcionam sem nada). A chave é gratuita e pessoal:</p>
        <ol class="small cf-steps">
          <li>Entre em <a href="https://console.curseforge.com" target="_blank" rel="noopener">console.curseforge.com</a> com uma conta CurseForge ou Google.</li>
          <li>Abra <b>API Keys</b> e copie a sua chave (se pedir, crie uma organização com qualquer nome).</li>
          <li>Cole abaixo e salve. Ela fica só neste PC.</li>
        </ol>
        <p>${panel.curseforgeKey ? '<span class="badge-ok">Chave configurada</span>' : '<span class="muted small">Nenhuma chave configurada.</span>'}</p>
        <label>Chave da API do CurseForge<input name="key" type="password" autocomplete="off" spellcheck="false" placeholder="${panel.curseforgeKey ? 'Cole uma nova chave para trocar' : '$2a$10$...'}"></label>
        <div class="row-gap"><button class="primary">Salvar chave</button>${panel.curseforgeKey ? '<button type="button" id="cfRemove">Remover chave</button>' : ''}</div>
      </form>

      <div class="card">
        <h3>Atualizações dos servidores</h3>
        <p class="muted small">O painel verifica novas versões a cada 30 minutos. Última verificação: <span id="lastCheck">${fmtDate(panel.lastUpdateCheck)}</span></p>
        <button id="checkUpdates">Verificar agora</button>
      </div>

      <div class="card">
        <h3>Sistema</h3>
        <table class="compact">
          <tr><td>Sistema operacional</td><td>${esc(sys.os)}</td></tr>
          <tr><td>Computador</td><td>${esc(sys.hostname)}</td></tr>
          <tr><td>Processador</td><td>${esc(sys.cpuModel)} (${sys.cores} threads)</td></tr>
          <tr><td>Memória</td><td>${fmtBytes(sys.memTotal)}</td></tr>
          <tr><td>Node.js</td><td>${esc(sys.node)}</td></tr>
          <tr><td>Host My Game</td><td>v${esc(panel.version)}</td></tr>
        </table>
      </div>
    </div>`;
  $('#panelForm').addEventListener('submit', act(async e => {
    e.preventDefault();
    const f = e.target;
    const r = await api('PATCH', '/api/panel', { host: f.host.value, port: f.port.value, instancesDir: f.instancesDir.value.trim() });
    toast(r.restartNeeded ? 'Salvo. Reinicie o painel para aplicar acesso/porta.' : 'Salvo', 'ok');
  }));
  const startSteamLogin = async body => {
    $('#steamOut').replaceChildren();
    $('#steamSession').hidden = false;
    await api('POST', '/api/steam/login', body);
    $('#steamQrBtn').disabled = true;
    $('#steamForm button').disabled = true;
    $('#steamCancel').hidden = false;
  };
  $('#steamQrBtn').addEventListener('click', act(() => startSteamLogin({ qr: true })));
  $('#steamCancel').addEventListener('click', act(() => api('POST', '/api/steam/cancel')));
  $('#steamForm').addEventListener('submit', act(async e => {
    e.preventDefault();
    const f = e.target;
    await startSteamLogin({ username: f.username.value.trim(), password: f.password.value });
    f.password.value = '';
  }));
  $('#steamInput').addEventListener('submit', act(async e => {
    e.preventDefault();
    await api('POST', '/api/steam/input', { text: e.target.text.value.trim() });
    e.target.text.value = '';
  }));
  $('#steamLogout')?.addEventListener('click', act(async () => { await api('POST', '/api/steam/logout'); renderSettings(); }));
  wirePanelUpdateCard();
  $('#cfForm').addEventListener('submit', act(async e => {
    e.preventDefault();
    const key = e.target.key.value.trim();
    if (!key) throw new Error('Cole a chave da API do CurseForge');
    const btn = e.target.querySelector('button.primary');
    btn.disabled = true;
    btn.textContent = 'Testando a chave…';
    try { await api('PUT', '/api/panel/curseforge', { key }); } finally { btn.disabled = false; btn.textContent = 'Salvar chave'; }
    toast('Chave do CurseForge salva e testada', 'ok');
    renderSettings();
  }));
  $('#cfRemove')?.addEventListener('click', act(async () => {
    if (!await confirmDialog('Remover a chave do CurseForge? Mods já instalados continuam no servidor.', { okText: 'Remover', danger: true })) return;
    await api('PUT', '/api/panel/curseforge', { key: '' });
    renderSettings();
  }));
  $('#checkUpdates').addEventListener('click', act(async e => {
    e.target.disabled = true;
    e.target.textContent = 'Verificando…';
    try {
      const r = await api('POST', '/api/updates/check');
      $('#lastCheck').textContent = fmtDate(r.lastCheck);
      toast('Verificação concluída', 'ok');
    } finally {
      e.target.disabled = false;
      e.target.textContent = 'Verificar agora';
    }
  }));
}

// ---------- updates of the panel itself ----------
function panelUpdateCard(u) {
  let status;
  if (!u.repo) status = '<p class="muted small">Nenhum repositório do GitHub configurado para atualizações.</p>';
  else if (u.error && !u.latest) status = `<p class="muted small">Não foi possível verificar: ${esc(u.error)}</p>`;
  else if (u.available) {
    status = `<div class="notice">Versão <strong>${esc(u.latest)}</strong> disponível (você tem a ${esc(u.current)}).</div>
      ${u.notes ? `<pre class="release-notes">${esc(u.notes)}</pre>` : ''}`;
  } else if (u.latest) status = '<p class="muted small">Você está na versão mais recente.</p>';
  else status = '<p class="muted small">Ainda não verificado.</p>';
  let action = '';
  if (u.available && u.canApply) action = '<button class="primary" id="applyPanelUpdate">Atualizar</button>';
  else if (u.available && u.url) action = `<a class="button" href="${esc(u.url)}" target="_blank" rel="noopener">Baixar no GitHub</a>`;
  return `
    <h3>Atualizações do painel</h3>
    <p class="muted small">Versão instalada: v${esc(u.current)}. O painel verifica o GitHub a cada 6 horas e só atualiza quando você clicar. Última verificação: ${fmtDate(u.checkedAt)}</p>
    ${status}
    <div style="display:flex;gap:8px;flex-wrap:wrap">${action}${u.repo ? '<button id="checkPanelUpdate">Verificar agora</button>' : ''}</div>`;
}

function wirePanelUpdateCard() {
  const card = $('#panelUpdateCard');
  $('#checkPanelUpdate', card)?.addEventListener('click', act(async e => {
    e.target.disabled = true;
    e.target.textContent = 'Verificando…';
    const u = await api('POST', '/api/panel/update/check').finally(() => { e.target.disabled = false; });
    card.innerHTML = panelUpdateCard(u);
    wirePanelUpdateCard();
    showPanelUpdateNotice(u);
  }));
  $('#applyPanelUpdate', card)?.addEventListener('click', act(async e => {
    const ok = await confirmDialog('Todos os servidores de jogo serão parados e o painel ficará fora do ar por cerca de um minuto enquanto a nova versão é instalada. Continuar?', { okText: 'Atualizar' });
    if (!ok) return;
    e.target.disabled = true;
    e.target.textContent = 'Baixando e instalando…';
    try {
      await api('POST', '/api/panel/update/apply');
    } catch (err) {
      e.target.disabled = false;
      e.target.textContent = 'Atualizar';
      throw err;
    }
    toast('Instalando a nova versão. A página recarrega sozinha quando o painel voltar.', 'ok', 15000);
    waitForNewVersion();
  }));
}

// Polls until the panel answers with a different version, then reloads the page.
async function waitForNewVersion() {
  const before = state.version;
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const r = await fetch('/api/auth/state').then(res => res.json());
      if (r.version && r.version !== before) return location.reload();
    } catch { /* still restarting */ }
  }
  toast('O painel está demorando para voltar. Recarregue a página em alguns instantes.', 'error', 15000);
}

// Banner at the top of every page for admins.
export function showPanelUpdateNotice(u) {
  const el = $('#panelUpdateNotice');
  el.hidden = !u?.available;
  if (u?.available) el.innerHTML = `Nova versão do Host My Game disponível: <strong>v${esc(u.latest)}</strong>. <a href="#/settings">Ver em Configurações</a>`;
}

// ---------- my account ----------
export async function renderAccount() {
  title('Minha conta');
  const [me, keys] = await Promise.all([api('GET', '/api/auth/state').then(s => s.user), api('GET', '/api/auth/apikeys')]);
  main().innerHTML = `
    <div class="settings-grid">
      <form class="card form" id="changePw">
        <h3>Trocar senha</h3>
        <label>Senha atual <input name="current" type="password" required autocomplete="current-password"></label>
        <label>Nova senha <input name="next" type="password" required minlength="8" autocomplete="new-password"></label>
        <div><button class="primary">Trocar senha</button></div>
      </form>
      <div class="card form" id="totpBox">
        <h3>Verificação em duas etapas</h3>
        ${me.totp
          ? `<p style="margin:0"><span class="pill good">Ativa</span> Ao entrar, o painel pede o código do seu aplicativo autenticador.</p>
             <p class="muted" style="margin:0">Códigos de recuperação restantes: <b>${me.recoveryLeft}</b>. Use um deles no lugar do código se perder o celular.</p>
             <div><button type="button" id="newCodes">Gerar novos códigos de recuperação</button></div>
             <form id="totpOff" class="form"><label>Confirme sua senha para desativar<input name="password" type="password" required autocomplete="current-password"></label><div><button class="danger">Desativar</button></div></form>`
          : `<p class="muted">Proteja sua conta com um código do Google Authenticator, Microsoft Authenticator ou similar.</p><div><button class="primary" id="totpStart">Ativar</button></div>`}
      </div>
      <div class="card form" id="keysBox">
        <h3>Chaves de API</h3>
        <p class="muted" style="margin:0">Para bots e scripts controlarem o painel (ex.: um bot do Discord que liga o servidor). A chave tem as mesmas permissões que você e é enviada no cabeçalho <code>Authorization: Bearer hmg_…</code>.</p>
        ${keys.length ? `<table class="compact"><thead><tr><th>Nome</th><th>Chave</th><th>Último uso</th><th></th></tr></thead><tbody>
          ${keys.map(k => `<tr><td>${esc(k.name)}</td><td><code>${esc(k.prefix)}…</code></td><td>${k.lastUsed ? fmtDate(k.lastUsed) : 'nunca'}</td><td class="actions"><button class="small ghost" data-delkey="${esc(k.id)}" title="Apagar">Apagar</button></td></tr>`).join('')}
        </tbody></table>` : ''}
        <form id="newKey" style="display:flex;gap:8px"><input name="name" placeholder="Nome da chave, ex.: Bot do Discord" maxlength="40" required aria-label="Nome da chave"><button class="primary">Criar chave</button></form>
      </div>
    </div>`;
  const showCodes = codes => openModal(`
    <div class="modal-head"><h2>Códigos de recuperação</h2><button class="icon-btn" data-close aria-label="Fechar">✕</button></div>
    <p>Guarde estes códigos num lugar seguro. Cada um funciona <b>uma vez</b> no lugar do código do autenticador, se você perder o celular. Eles não serão mostrados de novo.</p>
    <pre class="code recovery">${codes.map(esc).join('\n')}</pre>
    <div class="modal-actions"><button id="copyCodes">Copiar</button><button class="primary" data-close>Já guardei</button></div>`, { onClose: () => renderAccount() });
  const wireCopy = codes => $('#copyCodes')?.addEventListener('click', act(async () => { await navigator.clipboard.writeText(codes.join('\n')); toast('Códigos copiados', 'ok'); }));
  $('#changePw').addEventListener('submit', act(async e => {
    e.preventDefault();
    await api('POST', '/api/auth/password', { current: e.target.current.value, next: e.target.next.value });
    e.target.reset();
    toast('Senha alterada', 'ok');
  }));
  $('#totpOff')?.addEventListener('submit', act(async e => {
    e.preventDefault();
    await api('POST', '/api/auth/totp/disable', { password: e.target.password.value });
    toast('Verificação em duas etapas desativada', 'ok');
    renderAccount();
  }));
  $('#newCodes')?.addEventListener('click', act(async () => {
    if (!(await confirmDialog('Gerar novos códigos? Os códigos antigos param de funcionar.'))) return;
    const { recoveryCodes } = await api('POST', '/api/auth/totp/recovery');
    showCodes(recoveryCodes);
    wireCopy(recoveryCodes);
  }));
  $('#totpStart')?.addEventListener('click', act(async () => {
    const { secret, qr } = await api('POST', '/api/auth/totp/setup');
    $('#totpBox').innerHTML = `
      <h3>Verificação em duas etapas</h3>
      <p>1. Escaneie o QR code no seu aplicativo autenticador:</p>
      <img src="${qr}" alt="QR code para o aplicativo autenticador" class="qr">
      <p class="muted small">Ou digite a chave manualmente: <code>${esc(secret)}</code></p>
      <form id="totpConfirm" class="form"><label>2. Digite o código de 6 dígitos que aparece no aplicativo<input name="code" inputmode="numeric" maxlength="6" required autocomplete="one-time-code"></label><div><button class="primary">Confirmar e ativar</button></div></form>`;
    $('#totpConfirm').addEventListener('submit', act(async e => {
      e.preventDefault();
      const { recoveryCodes } = await api('POST', '/api/auth/totp/confirm', { code: e.target.code.value });
      toast('Verificação em duas etapas ativada', 'ok');
      showCodes(recoveryCodes);
      wireCopy(recoveryCodes);
    }));
  }));
  $('#newKey').addEventListener('submit', act(async e => {
    e.preventDefault();
    const { token } = await api('POST', '/api/auth/apikeys', { name: e.target.name.value });
    openModal(`
      <div class="modal-head"><h2>Chave criada</h2><button class="icon-btn" data-close aria-label="Fechar">✕</button></div>
      <p>Copie a chave agora. Por segurança, ela <b>não será mostrada de novo</b>.</p>
      <pre class="code">${esc(token)}</pre>
      <p class="hint">Exemplo: <code>curl -H "Authorization: Bearer ${esc(token)}" ${esc(location.origin)}/api/instances</code></p>
      <div class="modal-actions"><button id="copyKey">Copiar</button><button class="primary" data-close>Pronto</button></div>`, { onClose: () => renderAccount() });
    $('#copyKey').addEventListener('click', act(async () => { await navigator.clipboard.writeText(token); toast('Chave copiada', 'ok'); }));
  }));
  $$('[data-delkey]').forEach(b => b.addEventListener('click', act(async () => {
    if (!(await confirmDialog('Apagar esta chave? Bots e scripts que a usam param de funcionar.', { danger: true, okText: 'Apagar' }))) return;
    await api('DELETE', `/api/auth/apikeys/${b.dataset.delkey}`);
    renderAccount();
  })));
}
