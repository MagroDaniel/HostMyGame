import {
  $, $$, STATE_LABELS, act, address, api, badge, confirmDialog, drawChart, esc, fmtBytes, fmtDate, fmtTime, fmtUptime, gameArt,
  icon, instApi, joinPath, openModal, playersText, promptDialog, readSettings, settingsFields, state, toast,
} from '../core.js';
import { renderMods } from './mods.js';
import { renderPlayers } from './players.js';
import { renderConfigEditor } from './configedit.js';
import { renderAccess, renderServerActivity } from './access.js';
import { scheduleForm, scheduleTable, wireScheduleForm, wireScheduleTable } from './schedules.js';

// [route key, label, icon, permission needed (null = anyone with access)]
const TABS = [
  ['console', 'Console', 'terminal', 'console'],
  ['players', 'Jogadores', 'users', 'console'],
  ['files', 'Arquivos', 'folder', 'files'],
  ['mods', 'Mods', 'puzzle', 'files'],
  ['backups', 'Backups', 'archive', 'backups'],
  ['schedule', 'Agendador', 'calendar', 'schedule'],
  ['network', 'Rede', 'network', null],
  ['startup', 'Inicialização', 'sliders', 'settings'],
  ['settings', 'Configurações', 'settings', 'settings'],
  ['advanced', 'Avançado', 'tool', 'settings'],
  ['access', 'Usuários', 'shield', 'admin'],
];
const CONSOLE_MODES = { stdin: 'Console direto', rcon: 'RCON', telnet: 'Telnet', log: 'Somente leitura (log)' };

let cur = null; // { id, tab, detail }
const main = () => $('#main');

// ---------- shell ----------
export async function renderInstance(id, tab) {
  if (tab === 'status') tab = 'console'; // old links
  const detail = await api('GET', instApi(id));
  const allowed = TABS.filter(([k, , , p]) => (!p || (p === 'admin' ? detail.isAdmin : detail.permissions[p])) && (k !== 'mods' || detail.mods) && (k !== 'players' || detail.players));
  if (!allowed.some(([k]) => k === tab)) tab = allowed[0][0];
  cur = { id, tab, detail };
  state.history[id] = detail.history;
  document.title = `${detail.name} · Host My Game`;
  $('#pageHead').hidden = true;
  const sub = $('#subnav');
  sub.hidden = false;
  sub.innerHTML = `<div class="subnav-inner">${allowed.map(([k, l, ic]) => `<a href="#/instance/${id}/${k}" class="${k === tab ? 'active' : ''}">${icon(ic)}${l}</a>`).join('')}</div>`;
  sub.querySelector('a.active')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  main().innerHTML = `<div class="server-head" id="instHeader"></div><div id="tabBody"></div>`;
  renderHeader(detail);
  const body = $('#tabBody');
  const renderers = {
    console: renderConsole, network: renderNetwork, startup: renderStartup, settings: renderSettings,
    files: renderFiles, mods: renderMods, players: renderPlayers, access: renderAccess, backups: renderBackups, schedule: renderSchedule, advanced: renderAdvanced,
  };
  await renderers[tab](body, detail);
}

function renderHeader(s) {
  const p = cur.detail.permissions;
  const running = ['Starting', 'Running'].includes(s.state);
  const idle = ['Stopped', 'Failed'].includes(s.state);
  const canInstall = cur.detail.provider !== 'generic';
  const version = [s.installedInfo?.version && `versão ${s.installedInfo.version}`, s.installedInfo?.build && `build ${s.installedInfo.build}`].filter(Boolean).join(' · ');
  $('#instHeader').innerHTML = `
    ${gameArt(s.image, s.game, 'thumb lg')}
    <div class="server-head-text">
      <h1>${esc(s.name)} ${badge(s.state)}${s.updateAvailable ? '<span class="pill update">Atualização disponível</span>' : ''}</h1>
      <p class="muted">${esc(s.description || s.game)}${version ? ` · ${esc(version)}` : ''}</p>
    </div>
    <div class="power">
      ${p.control ? `
      <button class="ok" data-power="start" ${idle && (s.installed || cur.detail.config.updateOnStart) ? '' : 'disabled'}>${icon('play')} Iniciar</button>
      <button data-power="restart" ${running ? '' : 'disabled'}>${icon('restart')} Reiniciar</button>
      ${running || s.state === 'Installing' || s.state === 'Stopping'
        ? `<button class="danger" data-power="${s.state === 'Stopping' || s.state === 'Installing' ? 'kill' : 'stop'}">${icon(s.state === 'Stopping' || s.state === 'Installing' ? 'kill' : 'stop')} ${s.state === 'Stopping' || s.state === 'Installing' ? 'Forçar' : 'Parar'}</button>`
        : `<button class="danger" data-power="stop" disabled>${icon('stop')} Parar</button>`}` : ''}
      ${p.update && canInstall ? `<button class="${s.updateAvailable ? 'primary' : ''}" data-power="install" ${idle ? '' : 'disabled'}>${icon('download')} ${s.installed ? 'Atualizar' : 'Instalar'}</button>` : ''}
    </div>`;
  $$('[data-power]', $('#instHeader')).forEach(b => b.addEventListener('click', act(async () => {
    const action = b.dataset.power;
    if (action === 'kill' && !(await confirmDialog('Forçar a parada encerra o processo na hora e pode perder dados não salvos. Continuar?', { danger: true, okText: 'Forçar parada' }))) return;
    b.disabled = true;
    await api('POST', instApi(cur.id, `/${action}`));
    if (action === 'install' || action === 'start') goConsole();
  })));
}

function goConsole() {
  if (cur.tab !== 'console' && cur.detail.permissions.console) location.hash = `#/instance/${cur.id}/console`;
}

export function onInstanceStatus(s) {
  if (!cur || !s || s.id !== cur.id || !$('#instHeader')) return;
  const prev = cur.detail;
  cur.detail = { ...prev, ...s };
  if (prev.state !== s.state || prev.updateAvailable !== s.updateAvailable || prev.installed !== s.installed || prev.name !== s.name) renderHeader(cur.detail);
  if (cur.tab === 'console') { updateConsoleHint(); updateDetails(); updateIssues(); }
  if (cur.tab === 'network') updatePlayers();
}

// ---------- console ----------
function lineEl(entry) {
  const d = document.createElement('div');
  d.className = `src-${entry.source}`;
  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = `[${fmtTime(entry.t)}] `;
  d.append(ts, entry.text);
  return d;
}

export function onInstanceConsole(id, entry) {
  const out = $('#consoleOut');
  if (!cur || cur.id !== id || cur.tab !== 'console' || !out) return;
  const nearBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 80;
  if (entry.replace && out.lastElementChild) out.lastElementChild.replaceWith(lineEl(entry));
  else out.append(lineEl(entry));
  while (out.childElementCount > 2000) out.firstElementChild.remove();
  if (nearBottom) out.scrollTop = out.scrollHeight;
}

function updateConsoleHint() {
  const d = cur.detail;
  const hint = $('#consoleHint');
  if (!hint) return;
  const input = $('#cmdForm')?.cmd;
  const installing = d.state === 'Installing';
  let text = CONSOLE_MODES[d.console] || d.console;
  if (installing) text = 'Instalando… Se o SteamCMD pedir um código (Steam Guard), digite-o abaixo.';
  else if (d.console === 'log') text += ' · este servidor não aceita comandos pelo painel';
  else if (['rcon', 'telnet'].includes(d.console) && d.state !== 'Stopped') text += d.consoleReady ? ' · conectado' : ' · aguardando o servidor…';
  hint.textContent = text;
  if (input) {
    input.disabled = !installing && d.console === 'log';
    input.placeholder = input.disabled ? 'Este servidor não aceita comandos' : 'Digite um comando…';
  }
}

const cmdHistory = [];
async function renderConsole(body, d) {
  body.innerHTML = `
    ${d.warnings.length ? `<div class="notice warn">${d.warnings.map(esc).join('<br>')}</div>` : ''}
    <div id="issues"></div>
    <div class="console-layout">
      <div class="console-wrap">
        <div class="console-bar"><span id="consoleHint"></span>
          <div><button class="small" id="clearConsole">Limpar</button> <button class="small" id="copyConsole">${icon('copy')} Copiar</button></div></div>
        <div class="console" id="consoleOut" tabindex="0"></div>
        <form class="cmd" id="cmdForm"><span class="prompt">${icon('terminal')}</span><input name="cmd" placeholder="Digite um comando…" autocomplete="off" spellcheck="false" aria-label="Comando"><button class="primary">Enviar</button></form>
      </div>
      <div class="details" id="details"></div>
    </div>
    <div class="charts">
      ${chartCard('cpu', 'CPU')}${chartCard('mem', 'Memória')}${chartCard('pl', 'Jogadores')}
    </div>`;
  const out = $('#consoleOut');
  const log = await api('GET', instApi(d.id, '/console'));
  out.replaceChildren(...log.map(lineEl));
  out.scrollTop = out.scrollHeight;
  updateConsoleHint();
  updateDetails();
  updateIssues();
  $('#clearConsole').addEventListener('click', () => out.replaceChildren());
  $('#copyConsole').addEventListener('click', act(async () => { await navigator.clipboard.writeText(out.innerText); toast('Console copiado', 'ok'); }));
  let pos = cmdHistory.length;
  const form = $('#cmdForm');
  if (!form.cmd.disabled && matchMedia('(min-width: 900px)').matches) form.cmd.focus();
  form.cmd.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp' && pos > 0) form.cmd.value = cmdHistory[--pos];
    else if (e.key === 'ArrowDown' && pos < cmdHistory.length) form.cmd.value = cmdHistory[++pos] ?? '';
    else return;
    e.preventDefault();
  });
  form.addEventListener('submit', act(async e => {
    e.preventDefault();
    const command = form.cmd.value.trim();
    if (!command) return;
    const installing = cur.detail.state === 'Installing';
    form.cmd.value = '';
    await api('POST', instApi(d.id, '/command'), { command });
    if (!installing && cmdHistory.at(-1) !== command) cmdHistory.push(command);
    pos = cmdHistory.length;
  }));
}

// Problems recognized in the console (EULA, Java version, port in use…), with a fix button when possible.
let issuesKey = '';
function updateIssues() {
  const box = $('#issues');
  if (!box) return;
  const list = cur.detail.issues || [];
  const key = cur.id + JSON.stringify(list.map(i => i.id));
  if (key === issuesKey && box.childElementCount === list.length) return;
  issuesKey = key;
  box.innerHTML = list.map(i => `
    <div class="issue" data-issue="${esc(i.id)}">
      <div class="issue-icon">${icon('shield')}</div>
      <div class="issue-text"><strong>${esc(i.title)}</strong><span>${esc(i.message)}</span></div>
      ${i.fix && cur.detail.permissions.control ? `<button class="primary small" data-fix="${esc(i.id)}">${esc(i.fix)}</button>` : ''}
      ${i.tab ? `<a class="button small" href="#/instance/${cur.id}/${i.tab}">Abrir ${esc(TABS.find(t => t[0] === i.tab)?.[1] || i.tab)}</a>` : ''}
    </div>`).join('');
  $$('[data-fix]', box).forEach(b => b.addEventListener('click', act(async () => {
    b.disabled = true;
    await api('POST', instApi(cur.id, `/issues/${b.dataset.fix}/fix`));
    toast('Corrigido — iniciando o servidor', 'ok');
  })));
}

const chartCard = (id, title) => `<div class="card chart"><div class="chart-head"><span>${title}</span><b id="${id}Now"></b></div><canvas id="${id}Chart" role="img" aria-label="${title} ao longo do tempo"></canvas></div>`;

function detailBox(ic, label, value, { cls = '', copy = '' } = {}) {
  return `<div class="detail ${cls} ${copy ? 'copy' : ''}" ${copy ? `data-copy="${esc(copy)}" title="Clique para copiar"` : ''}>
    <div class="detail-icon">${icon(ic)}</div><div class="detail-text"><div class="l">${label}</div><div class="v">${value}</div></div></div>`;
}

function updateDetails() {
  const s = cur.detail;
  const box = $('#details');
  if (!box) return;
  const running = s.state === 'Running';
  const stateCls = running ? 'ok' : ['Starting', 'Stopping', 'Installing'].includes(s.state) ? 'warn' : 'bad';
  const addr = address(s);
  const info = s.serverInfo;
  box.innerHTML = [
    detailBox('wifi', 'Endereço', esc(addr), { copy: addr !== '—' ? addr : '' }),
    detailBox('clock', 'Tempo ligado', esc(running || s.uptime ? fmtUptime(s.uptime) : STATE_LABELS[s.state]), { cls: stateCls }),
    detailBox('cpu', 'CPU', running ? `${s.cpu.toFixed(1)}%` : 'Desligado'),
    detailBox('memory', 'Memória', `${s.mem ? fmtBytes(s.mem) : 'Desligado'}${s.memLimit ? ` <small>/ ${fmtBytes(s.memLimit)}</small>` : ''}`),
    detailBox('disk', 'Disco', s.disk === null || s.disk === undefined ? 'Calculando…' : fmtBytes(s.disk)),
    detailBox('users', 'Jogadores', esc(playersText(s))),
    ...(info?.map ? [detailBox('monitor', 'Mapa', esc(info.map))] : []),
  ].join('');
  $$('[data-copy]', box).forEach(el => el.addEventListener('click', act(async () => {
    await navigator.clipboard.writeText(el.dataset.copy);
    toast(`Endereço copiado: ${el.dataset.copy}`, 'ok');
  })));
  const h = state.history[s.id] || [];
  $('#cpuNow').textContent = running ? `${s.cpu.toFixed(1)}%` : '';
  $('#memNow').textContent = s.mem ? fmtBytes(s.mem) : '';
  $('#plNow').textContent = s.players ?? '';
  drawChart($('#cpuChart'), h.map(p => p.cpu), { max: 100, fmt: v => `${v.toFixed(0)}%`, color: '#06b6d4' });
  drawChart($('#memChart'), h.map(p => p.mem), { max: Math.max(s.memLimit || 0, 1024 ** 3, ...h.map(p => (p.mem || 0) * 1.2)), fmt: fmtBytes, color: '#a78bfa' });
  drawChart($('#plChart'), h.map(p => p.players ?? 0), { fmt: v => v.toFixed(0), integer: true, color: '#22c55e' });
}

// ---------- network ----------
async function renderNetwork(body, d) {
  const lan = state.sysinfo?.lanIp || '127.0.0.1';
  body.innerHTML = `
    ${d.warnings.length ? `<div class="notice warn">${d.warnings.map(esc).join('<br>')}</div>` : ''}
    <div class="two-col">
      <div class="card flush">
        <h3>Portas do servidor</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Uso</th><th>Endereço</th><th>Protocolo</th></tr></thead>
          <tbody>${d.ports.map(p => `<tr><td>${esc(p.name)}</td><td><code>${esc(lan)}:${p.port}</code></td><td>${p.proto === 'both' ? 'TCP + UDP' : p.proto.toUpperCase()}</td></tr>`).join('')
            || '<tr><td colspan="3" class="muted">Sem portas definidas para este jogo.</td></tr>'}</tbody>
        </table></div>
      </div>
      <div class="card">
        <h3>Jogar de fora da sua rede</h3>
        <ol style="margin:0;padding-left:18px;display:grid;gap:8px">
          <li>Libere as portas no Firewall do Windows.${d.isAdmin ? ` <button class="small" id="fwBtn">${icon('shield')} Liberar no firewall</button>` : ''}</li>
          <li>No roteador, encaminhe as portas acima para o IP <code>${esc(lan)}</code> (protocolo indicado).</li>
          <li>Seus amigos conectam usando o seu IP público e a porta <code>${d.ports[0]?.port ?? '—'}</code>.</li>
        </ol>
        <p class="hint">Dica: reserve o IP ${esc(lan)} para este PC no DHCP do roteador para a regra não parar de funcionar.</p>
      </div>
    </div>
    <div class="card"><h3>Jogadores online</h3><div id="playerList"></div></div>`;
  $('#fwBtn')?.addEventListener('click', act(() => firewall(d.id)));
  updatePlayers();
}

function updatePlayers() {
  const s = cur.detail;
  const el = $('#playerList');
  if (!el) return;
  el.innerHTML = s.playerNames?.length
    ? s.playerNames.map(n => `<span class="chip">${icon('user')} ${esc(n)}</span>`).join('')
    : `<span class="muted">${s.state === 'Running'
      ? (s.players === null ? 'Este jogo não informa jogadores.' : s.players ? `${s.players} jogador(es) online (o jogo não informa os nomes).` : 'Ninguém online.')
      : 'Servidor parado.'}</span>`;
}

async function firewall(id) {
  const r = await api('POST', instApi(id, '/firewall'));
  if (r.ok) return toast(r.message, 'ok');
  openModal(`
    <div class="modal-head"><h2>Firewall</h2><button class="icon-btn" data-close aria-label="Fechar">✕</button></div>
    <p>${esc(r.message)}</p><pre class="code">${esc(r.commands.join('\n'))}</pre>
    <div class="modal-actions"><button id="copyFw">${icon('copy')} Copiar comandos</button><button data-close>Fechar</button></div>`);
  $('#copyFw').addEventListener('click', act(async () => { await navigator.clipboard.writeText(r.commands.join('\n')); toast('Comandos copiados', 'ok'); }));
}

// ---------- startup (game settings) ----------
async function renderStartup(body, d) {
  const c = d.config;
  const t = d.template;
  const e = d.effective;
  const cmd = [e.exe, e.args].filter(Boolean).join(' ');
  body.innerHTML = `
    ${t.notes ? `<div class="notice">${esc(t.notes)}</div>` : ''}
    <div class="card">
      <h3>Comando de inicialização</h3>
      <div class="startup-cmd">${esc(cmd || 'automático')}</div>
      <p class="hint">Os valores entre <code>{{ }}</code> vêm das configurações abaixo. Para mudar o comando, use a aba Avançado.</p>
    </div>
    <form class="card form" id="startupForm">
      <h3>Configurações do jogo</h3>
      ${t.settings.length ? settingsFields(t.settings, c.settings) : '<p class="muted" style="margin:0">Este jogo não tem configurações pré-definidas no painel. Use os arquivos de configuração (aba Configurações) ou a aba Avançado.</p>'}
      ${t.settings.length ? `<div class="form-foot"><span class="hint">As alterações valem no próximo início do servidor.</span><button class="primary">Salvar</button></div>` : ''}
    </form>
    <div id="cfgEditorBox"></div>`;
  act(renderConfigEditor)($('#cfgEditorBox'), d);
  const form = $('#startupForm');
  form.addEventListener('submit', act(async ev => {
    ev.preventDefault();
    await api('PATCH', instApi(d.id), { settings: readSettings(form, t.settings) });
    toast('Configurações salvas', 'ok');
    renderInstance(d.id, 'startup');
  }));
}

// ---------- Minecraft: switch loader / version ----------
const MC_JAVA = {
  vanilla: ['Vanilla', 'Oficial da Mojang, sem mods nem plugins'],
  paper: ['Paper', 'Otimizado, aceita plugins (Bukkit/Spigot)'],
  purpur: ['Purpur', 'Paper com mais opções, aceita plugins'],
  fabric: ['Fabric', 'Mods Fabric (leve, atualiza rápido)'],
  forge: ['Forge', 'Mods Forge (modpacks clássicos)'],
  neoforge: ['NeoForge', 'Mods NeoForge (sucessor do Forge)'],
};
const ADDONS = { paper: 'plugins', purpur: 'plugins', fabric: 'mods', forge: 'mods', neoforge: 'mods' };
const mcFlavor = d => (d.template.id.startsWith('minecraft-') ? d.template.id.slice('minecraft-'.length) : null);

function mcSwitchCard(d) {
  const flavor = mcFlavor(d);
  if (!MC_JAVA[flavor] || !d.permissions.update || !d.permissions.settings) return '';
  const current = d.installedInfo?.version || d.config.settings.version || 'latest';
  return `
    <div class="card" id="mcSwitch">
      <h3>Tipo e versão do Minecraft</h3>
      <p class="muted" style="margin-top:0">Agora: <b>${esc(MC_JAVA[flavor][0])} ${esc(current)}</b></p>
      <div class="form">
        <label>Tipo de servidor<select name="flavor">${Object.entries(MC_JAVA).map(([k, [n, desc]]) => `<option value="${k}" ${k === flavor ? 'selected' : ''}>${n} — ${desc}</option>`).join('')}</select></label>
        <label>Versão do Minecraft<input name="version" value="${esc(current)}" placeholder="latest ou ex.: 1.21.4" autocomplete="off" spellcheck="false"><span class="hint">"latest" = a mais recente disponível para o tipo escolhido.</span></label>
        <div class="notice warn" style="margin:0">O servidor será <b>reinstalado</b>. Antes, o painel faz um backup completo. O mundo, as configurações e as pastas mods/ e plugins/ são mantidos.</div>
        <div><button class="primary" id="mcSwitchBtn" ${['Stopped', 'Failed'].includes(d.state) ? '' : 'disabled title="Pare o servidor primeiro"'}>${icon('restart')} Trocar e reinstalar</button></div>
      </div>
    </div>`;
}

// "1.21.4" > "1.20.1"? (null when either side isn't a plain version number)
function compareVersions(a, b) {
  const plain = /^\d+(\.\d+)*$/;
  const pa = plain.test(a) && a.split('.').map(Number), pb = plain.test(b) && b.split('.').map(Number);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

function wireMcSwitch(d) {
  const box = $('#mcSwitch');
  if (!box) return;
  $('#mcSwitchBtn').addEventListener('click', act(async () => {
    const from = mcFlavor(d), to = box.querySelector('[name=flavor]').value;
    const version = box.querySelector('[name=version]').value.trim() || 'latest';
    const current = d.installedInfo?.version || '';
    if (to === from && version === current) return toast('Esse já é o tipo e a versão atuais', 'error');
    const warnings = [`O servidor será reinstalado como ${MC_JAVA[to][0]} ${version}. Um backup completo é feito antes; o mundo e as configurações são mantidos.`];
    if (ADDONS[from] === 'plugins' && ADDONS[to] !== 'plugins') warnings.push(`O Nether e o End criados no ${MC_JAVA[from][0]} ficam nas pastas world_nether e world_the_end, que o ${MC_JAVA[to][0]} não lê (o mundo principal continua). Eles voltam se você trocar de novo para Paper/Purpur.`);
    if (ADDONS[from] && ADDONS[from] !== ADDONS[to]) warnings.push(`Os ${ADDONS[from]} instalados não funcionam no ${MC_JAVA[to][0]} (a pasta ${ADDONS[from]}/ fica guardada).`);
    else if (ADDONS[from] === 'mods' && from !== to) warnings.push(`Mods de ${MC_JAVA[from][0]} geralmente não funcionam no ${MC_JAVA[to][0]}.`);
    if (ADDONS[from] && ADDONS[from] === ADDONS[to] && version !== current) warnings.push(`Confira na aba Mods se os ${ADDONS[to]} têm versão para o ${version}.`);
    const cmp = compareVersions(version, current);
    if (cmp !== null && cmp < 0) warnings.push(`ATENÇÃO: voltar de ${current} para ${version} pode corromper o mundo. Se der problema, restaure o backup.`);
    if (!(await confirmDialog(warnings.join('\n\n'), { okText: 'Trocar e reinstalar', danger: cmp !== null && cmp < 0 }))) return;
    await api('POST', instApi(d.id, '/minecraft/switch'), { templateId: `minecraft-${to}`, version });
    toast('Troca iniciada — acompanhe no console', 'ok');
    location.hash = `#/instance/${d.id}/console`;
  }));
}

// ---------- settings (general) ----------
async function renderSettings(body, d) {
  const c = d.config;
  const t = d.template;
  body.innerHTML = `
    <div class="settings-grid">
      <form class="card form" id="settingsForm">
        <h3>Geral</h3>
        <label>Nome do servidor<input name="name" value="${esc(c.name)}" required maxlength="60"></label>
        <label>Descrição<input name="description" value="${esc(c.description || '')}" maxlength="200" placeholder="Opcional — aparece na lista de servidores"></label>
        <label>Tempo limite para parar (segundos)<input name="stopTimeoutSec" type="number" min="5" max="600" value="${c.stopTimeoutSec}"></label>
        <label class="check"><input type="checkbox" name="autoStart" ${c.autoStart ? 'checked' : ''}> Iniciar automaticamente junto com o painel</label>
        <label class="check"><input type="checkbox" name="autoRestart" ${c.autoRestart ? 'checked' : ''}> Reiniciar automaticamente se o servidor travar</label>
        ${t.provider !== 'generic' ? `<label class="check"><input type="checkbox" name="updateOnStart" ${c.updateOnStart ? 'checked' : ''}> Atualizar sempre antes de iniciar</label>` : ''}
        <div class="form-foot"><button class="primary">Salvar</button></div>
      </form>
      <div>
        <div class="card">
          <h3>Informações</h3>
          <table class="compact"><tbody>
            <tr><td class="muted">Jogo</td><td>${esc(t.name)}</td></tr>
            <tr><td class="muted">ID</td><td><code>${esc(d.id)}</code></td></tr>
            <tr><td class="muted">Pasta</td><td><code>${esc(c.dir)}</code></td></tr>
            ${d.installedInfo?.version ? `<tr><td class="muted">Versão</td><td>${esc(d.installedInfo.version)}${d.installedInfo.build ? ` (build ${esc(d.installedInfo.build)})` : ''}</td></tr>` : ''}
          </tbody></table>
        </div>
        ${mcSwitchCard(d)}
        ${t.configFiles.length && d.permissions.files ? `
        <div class="card"><h3>Arquivos de configuração do jogo</h3>
          <div class="file-shortcuts">${t.configFiles.map(f => `<button class="small" data-open-file="${esc(f)}">${icon('file')} ${esc(f)}</button>`).join('')}</div>
          <p class="hint">Alguns arquivos só existem depois que o servidor é iniciado pela primeira vez.</p></div>` : ''}
        ${d.permissions.update && t.provider !== 'generic' ? `
        <div class="card">
          <h3>Reinstalar</h3>
          <p class="muted" style="margin-top:0">Baixa de novo os arquivos do servidor, para corrigir instalações quebradas. Antes, o painel faz um backup completo. Mundos e configurações são mantidos.</p>
          <button id="reinstallBtn" ${['Stopped', 'Failed'].includes(d.state) ? '' : 'disabled title="Pare o servidor primeiro"'}>${icon('restart')} Reinstalar servidor</button>
        </div>` : ''}
        ${d.isAdmin ? `
        <div class="card danger-zone">
          <h3>Excluir servidor</h3>
          <p class="muted" style="margin-top:0">Remove o servidor do painel. Os arquivos só são apagados se você marcar a opção abaixo.</p>
          <label class="check"><input type="checkbox" id="delFiles"> Apagar também os arquivos (mundos, configurações)</label>
          <div style="margin-top:14px"><button class="danger" id="delInst">${icon('trash')} Excluir servidor</button></div>
        </div>` : ''}
      </div>
    </div>
    <div id="srvActivity"></div>`;
  wireMcSwitch(d);
  act(renderServerActivity)($('#srvActivity'), d);
  $('#reinstallBtn')?.addEventListener('click', act(async () => {
    if (!(await confirmDialog('O servidor será reinstalado. Um backup completo é feito antes; mundos e configurações são mantidos. Continuar?', { okText: 'Reinstalar' }))) return;
    await api('POST', instApi(d.id, '/reinstall'));
    toast('Reinstalação iniciada — acompanhe no console', 'ok');
    location.hash = `#/instance/${d.id}/console`;
  }));
  const form = $('#settingsForm');
  form.addEventListener('submit', act(async e => {
    e.preventDefault();
    await api('PATCH', instApi(d.id), {
      name: form.name.value, description: form.description.value, stopTimeoutSec: form.stopTimeoutSec.value, autoStart: form.autoStart.checked,
      autoRestart: form.autoRestart.checked, updateOnStart: form.updateOnStart?.checked ?? false,
    });
    toast('Configurações salvas', 'ok');
    state.instances = await api('GET', '/api/instances');
    renderInstance(d.id, 'settings');
  }));
  $$('[data-open-file]', body).forEach(b => b.addEventListener('click', () => {
    pendingFile = b.dataset.openFile;
    location.hash = `#/instance/${d.id}/files`;
  }));
  $('#delInst')?.addEventListener('click', act(async () => {
    const withFiles = $('#delFiles').checked;
    if (!(await confirmDialog(`Excluir "${c.name}"${withFiles ? ' e TODOS os arquivos do servidor' : ''}?`, { danger: true, okText: 'Excluir' }))) return;
    await api('DELETE', instApi(d.id, `?files=${withFiles ? 1 : 0}`));
    state.instances = await api('GET', '/api/instances');
    location.hash = '#/';
  }));
}

// ---------- advanced ----------
async function renderAdvanced(body, d) {
  const c = d.config;
  const o = c.overrides || {};
  const e = d.effective;
  const t = d.template;
  const javaAuto = t.provider === 'minecraft' && t.id !== 'minecraft-bedrock';
  const field = (key, label, { textarea = false, hint = '' } = {}) => {
    const val = o[key] ?? '';
    let ph = esc(e[key] && !o[key] ? `padrão: ${e[key]}` : '');
    if (javaAuto && key === 'exe') ph = 'automático (Java gerenciado pelo painel)';
    if (javaAuto && key === 'args') ph = 'automático (memória + server.jar nogui; Forge/NeoForge usam o arquivo de argumentos)';
    return textarea
      ? `<label>${label}<textarea name="o_${key}" rows="3" placeholder="${ph}">${esc(val)}</textarea>${hint ? `<span class="hint">${hint}</span>` : ''}</label>`
      : `<label>${label}<input name="o_${key}" value="${esc(val)}" placeholder="${ph}" autocomplete="off" spellcheck="false">${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
  };
  body.innerHTML = `
    <form class="card form" id="advForm">
      <p class="hint">Deixe em branco para usar o padrão do modelo. Use <code>{{nome}}</code> para inserir configurações (ex.: <code>{{port}}</code>, <code>{{serverName}}</code>, <code>{{dir}}</code>).</p>
      <h3>Inicialização</h3>
      <div class="form-grid one">
        ${field('exe', 'Executável (relativo à pasta da instância)')}
        ${field('args', 'Argumentos', { textarea: true })}
      </div>
      <div class="form-grid">
        <label>Modo do console<select name="o_console"><option value="">padrão (${esc(CONSOLE_MODES[e.console] || e.console)})</option>${Object.entries(CONSOLE_MODES).map(([k, l]) => `<option value="${k}" ${o.console === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Pseudoconsole (PTY)<select name="o_pty"><option value="">padrão (${e.pty ? 'ligado' : 'desligado'})</option><option value="true" ${o.pty === 'true' ? 'selected' : ''}>Ligado</option><option value="false" ${o.pty === 'false' ? 'selected' : ''}>Desligado</option></select><span class="hint">Ligue se o servidor ignorar os comandos digitados no console.</span></label>
        ${field('ready', 'Texto que indica "pronto" (regex)')}
        ${field('logFile', 'Arquivo de log para exibir no console')}
        ${field('stopCommands', 'Comandos para parar (um por linha)', { textarea: true, hint: 'Sem comandos, o processo é encerrado.' })}
      </div>
      <h3>RCON e consulta de jogadores</h3>
      <div class="form-grid">
        ${field('rconPort', 'Porta RCON')}
        ${field('rconPassword', 'Senha RCON')}
        <label>Consulta de jogadores<select name="o_queryType"><option value="">padrão (${esc(e.queryType || 'nenhuma')})</option>${['a2s', 'minecraft', 'bedrock', 'rcon-palworld'].map(k => `<option ${o.queryType === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
        ${field('queryPort', 'Porta de consulta')}
      </div>
      ${t.provider === 'steamcmd' ? `
      <h3>Steam</h3>
      <div class="form-grid">
        ${t.custom ? `<label>Steam App ID<input name="steamAppId" value="${esc(c.steamAppId || '')}"></label>` : `<label>Steam App ID<input value="${esc(t.steam?.appId || '')}" disabled></label>`}
        <label>Branch (beta)<input name="steamBranch" value="${esc(c.steamBranch || '')}" placeholder="public"></label>
        <label>Senha da branch<input name="steamBetaPassword" value="${esc(c.steamBetaPassword || '')}" autocomplete="off"></label>
      </div>` : ''}
      <p class="hint">Pasta da instância: <code>${esc(c.dir)}</code></p>
      <div><button class="primary">Salvar</button></div>
    </form>`;
  const form = $('#advForm');
  form.addEventListener('submit', act(async ev => {
    ev.preventDefault();
    const overrides = {};
    for (const key of Object.keys(e)) if (form.elements[`o_${key}`]) overrides[key] = form.elements[`o_${key}`].value.trim();
    const payload = { overrides };
    for (const k of ['steamAppId', 'steamBranch', 'steamBetaPassword']) if (form.elements[k]) payload[k] = form.elements[k].value.trim();
    await api('PATCH', instApi(d.id), payload);
    toast('Configurações avançadas salvas', 'ok');
    renderInstance(d.id, 'advanced');
  }));
}

// ---------- files ----------
let pendingFile = null;
let filesState = { id: null, path: '' };

async function renderFiles(body, d) {
  if (filesState.id !== d.id) filesState = { id: d.id, path: '' };
  if (pendingFile) {
    const f = pendingFile;
    pendingFile = null;
    filesState.path = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    try { return await openEditor(body, d, f); } catch (e) { toast(e.message, 'error'); }
  }
  const cwd = filesState.path;
  let entries;
  try {
    entries = await api('GET', instApi(d.id, `/files?path=${encodeURIComponent(cwd)}`));
  } catch (e) {
    if (!cwd) throw e;
    filesState.path = '';
    return renderFiles(body, d);
  }
  const parts = cwd ? cwd.split('/') : [];
  const isArchive = n => /\.(zip|tar\.gz|tgz|tar\.bz2|tar\.xz|tar|7z|rar)$/i.test(n);
  body.innerHTML = `
    <div class="toolbar files-toolbar">
      <div class="crumbs">${icon('folder')} <a href="#" data-go="">raiz</a>${parts.map((p, i) => ` / <a href="#" data-go="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</a>`).join('')}</div>
      <button id="newFolder">Nova pasta</button>
      <button id="newFile">Novo arquivo</button>
      <button id="pullBtn" type="button">${icon('download')} Baixar de um link</button>
      <button id="uploadBtn" class="primary" type="button">${icon('upload')} Enviar arquivos</button>
      <input id="uploadInput" type="file" multiple hidden>
    </div>
    <div class="mass-bar" id="massBar" hidden>
      <span id="selCount"></span>
      <button class="small" data-mass="move">Mover</button>
      <button class="small" data-mass="copy">${icon('copy')} Copiar</button>
      <button class="small" data-mass="compress">${icon('archive')} Compactar</button>
      <button class="small danger" data-mass="delete">${icon('trash')} Excluir</button>
      <button class="small ghost" data-mass="clear">Limpar seleção</button>
    </div>
    <div class="card table-wrap flush" id="dropZone">
      <table class="files-table">
        <thead><tr><th class="sel"><input type="checkbox" id="selAll" aria-label="Selecionar tudo" ${entries.length ? '' : 'disabled'}></th><th>Nome</th><th>Tamanho</th><th>Modificado</th><th></th></tr></thead>
        <tbody>
          ${cwd ? `<tr class="clickable" data-up="1"><td></td><td><span class="file-name dir">${icon('folder')} ..</span></td><td></td><td></td><td></td></tr>` : ''}
          ${entries.map(e => `
            <tr class="clickable" data-name="${esc(e.name)}" data-dir="${e.dir ? 1 : ''}">
              <td class="sel"><input type="checkbox" data-sel aria-label="Selecionar ${esc(e.name)}"></td>
              <td><span class="file-name ${e.dir ? 'dir' : ''}">${icon(e.dir ? 'folder' : isArchive(e.name) ? 'archive' : 'file')} ${esc(e.name)}</span></td>
              <td>${e.dir ? '' : fmtBytes(e.size)}</td>
              <td>${fmtDate(e.mtime)}</td>
              <td class="actions">
                ${!e.dir && isArchive(e.name) ? '<button class="small" data-act="extract">Descompactar</button>' : ''}
                ${e.dir ? '' : `<button class="small ghost" data-act="download" title="Baixar">${icon('download')}</button>`}
                <button class="small ghost" data-act="rename" title="Renomear">${icon('edit')}</button>
                <button class="small ghost" data-act="delete" title="Excluir">${icon('trash')}</button>
              </td>
            </tr>`).join('')}
          ${entries.length ? '' : '<tr><td></td><td colspan="4" class="muted">Pasta vazia</td></tr>'}
        </tbody>
      </table>
    </div>
    <p class="hint">Dicas: arraste arquivos para a lista para enviá-los a esta pasta. Marque vários itens para mover, copiar, compactar ou excluir de uma vez.</p>`;

  const reload = () => act(renderFiles)(body, d);
  const selected = () => $$('tr[data-name]', body).filter(tr => tr.querySelector('[data-sel]').checked).map(tr => joinPath(cwd, tr.dataset.name));
  const syncSelection = () => {
    const n = selected().length;
    $('#massBar').hidden = !n;
    $('#selCount').textContent = `${n} selecionado(s)`;
    $$('tr[data-name]', body).forEach(tr => tr.classList.toggle('selected', tr.querySelector('[data-sel]').checked));
    const all = $('#selAll');
    all.checked = n > 0 && n === entries.length;
    all.indeterminate = n > 0 && n < entries.length;
  };
  $('#selAll').addEventListener('change', e => { $$('[data-sel]', body).forEach(c => { c.checked = e.target.checked; }); syncSelection(); });
  $$('[data-sel]', body).forEach(c => c.addEventListener('change', syncSelection));
  const askFolder = (title, okText) => promptDialog(title, cwd, { label: 'Pasta de destino (caminho a partir da raiz; vazio = raiz)', okText });
  $('#massBar').addEventListener('click', act(async e => {
    const action = e.target.closest('[data-mass]')?.dataset.mass;
    if (!action) return;
    const paths = selected();
    if (action === 'clear') { $$('[data-sel]', body).forEach(c => { c.checked = false; }); return syncSelection(); }
    if (action === 'delete') {
      if (!(await confirmDialog(`Excluir ${paths.length} item(ns)? Pastas são apagadas com todo o conteúdo.`, { danger: true, okText: 'Excluir' }))) return;
      await api('POST', instApi(d.id, '/files/delete'), { paths });
      toast('Excluído', 'ok');
    }
    if (action === 'move' || action === 'copy') {
      const to = await askFolder(action === 'move' ? 'Mover para…' : 'Copiar para…', action === 'move' ? 'Mover' : 'Copiar');
      if (to === null) return;
      await api('POST', instApi(d.id, `/files/${action}`), { paths, to: to.replace(/^\/+|\/+$/g, '') });
      toast(action === 'move' ? 'Movido' : 'Copiado', 'ok');
    }
    if (action === 'compress') {
      const name = await promptDialog('Compactar', paths.length === 1 ? `${paths[0].split('/').pop()}.zip` : 'arquivos.zip', { label: 'Nome do arquivo (.zip ou .tar.gz)', okText: 'Compactar' });
      if (name === null) return;
      toast('Compactando…');
      const r = await api('POST', instApi(d.id, '/files/compress'), { paths, cwd, name });
      toast(`Criado: ${r.file}`, 'ok');
    }
    reload();
  }));
  $$('[data-go]', body).forEach(a => a.addEventListener('click', e => { e.preventDefault(); filesState.path = a.dataset.go; reload(); }));
  $('[data-up]', body)?.addEventListener('click', () => { filesState.path = parts.slice(0, -1).join('/'); reload(); });
  $$('tr[data-name]', body).forEach(tr => tr.addEventListener('click', act(async e => {
    if (e.target.closest('.sel')) return; // the checkbox cell only selects
    const rel = joinPath(cwd, tr.dataset.name);
    const action = e.target.closest('[data-act]')?.dataset.act;
    if (action === 'download') return void (location.href = instApi(d.id, `/files/download?path=${encodeURIComponent(rel)}`));
    if (action === 'rename') {
      const name = await promptDialog('Renomear', tr.dataset.name, { label: 'Novo nome' });
      if (!name || name === tr.dataset.name) return;
      await api('POST', instApi(d.id, '/files/rename'), { from: rel, to: joinPath(cwd, name) });
      return reload();
    }
    if (action === 'delete') {
      if (!(await confirmDialog(`Excluir "${tr.dataset.name}"${tr.dataset.dir ? ' e todo o conteúdo' : ''}?`, { danger: true, okText: 'Excluir' }))) return;
      await api('DELETE', instApi(d.id, `/files?path=${encodeURIComponent(rel)}`));
      return reload();
    }
    if (action === 'extract') {
      toast('Descompactando…');
      const r = await api('POST', instApi(d.id, '/files/extract'), { path: rel });
      toast(`Descompactado em ${r.dir}`, 'ok');
      return reload();
    }
    if (tr.dataset.dir) { filesState.path = rel; return reload(); }
    await openEditor(body, d, rel);
  })));
  $('#newFolder').addEventListener('click', act(async () => {
    const name = await promptDialog('Nova pasta', '', { label: 'Nome da pasta', okText: 'Criar' });
    if (!name) return;
    await api('POST', instApi(d.id, '/files/mkdir'), { path: joinPath(cwd, name) });
    reload();
  }));
  $('#newFile').addEventListener('click', act(async () => {
    const name = await promptDialog('Novo arquivo', '', { label: 'Nome do arquivo', okText: 'Criar' });
    if (!name) return;
    await api('PUT', instApi(d.id, `/files/content?path=${encodeURIComponent(joinPath(cwd, name))}`), { content: '' });
    await openEditor(body, d, joinPath(cwd, name));
  }));
  $('#pullBtn').addEventListener('click', act(async () => {
    const url = await promptDialog('Baixar de um link', '', { label: `Link do arquivo (http/https). Será salvo em: ${cwd || 'raiz'}`, okText: 'Baixar' });
    if (!url) return;
    await api('POST', instApi(d.id, '/files/pull'), { url, dir: cwd });
    toast('Download iniciado — acompanhe na aba Console. Atualize esta pasta quando terminar.', 'ok', 7000);
  }));
  const upload = act(async fileList => {
    for (const file of fileList) {
      toast(`Enviando ${file.name}…`);
      const res = await fetch(instApi(d.id, `/files/upload?path=${encodeURIComponent(joinPath(cwd, file.name))}`), {
        method: 'PUT', body: file, headers: { 'Content-Type': 'application/octet-stream' },
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `Falha ao enviar ${file.name}`);
    }
    toast('Envio concluído', 'ok');
    reload();
  });
  $('#uploadBtn').addEventListener('click', () => $('#uploadInput').click());
  $('#uploadInput').addEventListener('change', e => upload([...e.target.files]));
  const zone = $('#dropZone');
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag'); upload([...e.dataTransfer.files]); });
}

async function openEditor(body, d, rel) {
  const { content } = await api('GET', instApi(d.id, `/files/content?path=${encodeURIComponent(rel)}`));
  body.innerHTML = `
    <div class="toolbar">
      <div class="crumbs">${icon('file')} ${esc(rel)}</div>
      <button id="closeEditor">Fechar</button>
      <button id="saveFile" class="primary">Salvar (Ctrl+S)</button>
    </div>
    <textarea class="editor" id="editor" spellcheck="false"></textarea>`;
  const editor = $('#editor');
  editor.value = content;
  const saveFile = act(async () => {
    await api('PUT', instApi(d.id, `/files/content?path=${encodeURIComponent(rel)}`), { content: editor.value });
    toast('Arquivo salvo', 'ok');
  });
  $('#saveFile').addEventListener('click', saveFile);
  $('#closeEditor').addEventListener('click', () => act(renderFiles)(body, d));
  editor.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveFile(); }
    if (e.key === 'Tab') { e.preventDefault(); editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end'); }
  });
}

// ---------- backups ----------
async function renderBackups(body, d) {
  const backups = await api('GET', instApi(d.id, '/backups'));
  const total = backups.reduce((n, b) => n + b.size, 0);
  const canEdit = d.permissions.settings;
  body.innerHTML = `
    <div class="toolbar"><span class="muted" style="margin-right:auto">${backups.length} backup(s) · ${fmtBytes(total)} · mantém os ${d.config.backupKeep} mais recentes (os travados não contam)</span>
      <button id="makeBackup" class="primary">${icon('archive')} Criar backup</button></div>
    <div class="card table-wrap flush">
      <table>
        <thead><tr><th>Backup</th><th>Tamanho</th><th>Criado em</th><th></th></tr></thead>
        <tbody>
          ${backups.map(b => `
            <tr data-name="${esc(b.name)}" class="${b.locked ? 'locked' : ''}">
              <td><span class="file-name">${icon(b.locked ? 'shield' : 'archive')} ${esc(b.note || b.name)}</span>${b.note ? `<div class="hint">${esc(b.name)}</div>` : ''}${b.locked ? '<span class="pill good">travado</span>' : ''}</td>
              <td>${fmtBytes(b.size)}</td><td>${fmtDate(b.created)}</td>
              <td class="actions">
                <button class="small ghost" data-act="lock" title="${b.locked ? 'Destravar' : 'Travar (não é apagado automaticamente nem por engano)'}">${b.locked ? 'Destravar' : 'Travar'}</button>
                <button class="small ghost" data-act="download" title="Baixar">${icon('download')}</button>
                <button class="small" data-act="restore">Restaurar</button>
                <button class="small ghost" data-act="delete" title="Excluir" ${b.locked ? 'disabled' : ''}>${icon('trash')}</button>
              </td>
            </tr>`).join('') || '<tr><td colspan="4" class="muted">Nenhum backup ainda. Dica: agende backups automáticos na aba Agendador.</td></tr>'}
        </tbody>
      </table>
    </div>
    ${canEdit ? `
    <form class="card form" id="backupCfg">
      <h3>O que entra no backup</h3>
      <div class="form-grid">
        <label>Pastas incluídas<input name="backupPaths" value="${esc(d.config.backupPaths)}"><span class="hint">Separadas por vírgula; "." = a pasta inteira do servidor.</span></label>
        <label>Quantidade de backups mantidos<input name="backupKeep" type="number" min="1" max="100" value="${d.config.backupKeep}"></label>
      </div>
      <label>Ignorar (um padrão por linha)<textarea name="backupExclude" rows="4" placeholder="logs&#10;*.log&#10;cache" spellcheck="false">${esc(d.config.backupExclude || '')}</textarea>
        <span class="hint">Arquivos e pastas que não entram no backup, como logs e caches. Aceita * como curinga.</span></label>
      <div class="form-foot"><button class="primary">Salvar</button></div>
    </form>` : ''}`;
  const reload = () => act(renderBackups)(body, d);
  $('#makeBackup').addEventListener('click', act(async e => {
    const note = await promptDialog('Criar backup', '', { label: 'Descrição (opcional), ex.: "antes de instalar mods"', okText: 'Criar backup' });
    if (note === null) return;
    const b = e.target.closest('button');
    b.disabled = true;
    b.textContent = 'Criando…';
    try { await api('POST', instApi(d.id, '/backups'), { note }); toast('Backup criado', 'ok'); } finally { reload(); }
  }));
  $('#backupCfg')?.addEventListener('submit', act(async e => {
    e.preventDefault();
    const f = e.target;
    await api('PATCH', instApi(d.id), { backupPaths: f.backupPaths.value, backupKeep: f.backupKeep.value, backupExclude: f.backupExclude.value });
    toast('Configurações de backup salvas', 'ok');
    renderInstance(d.id, 'backups');
  }));
  $$('tr[data-name]', body).forEach(tr => tr.addEventListener('click', act(async e => {
    const action = e.target.closest('[data-act]')?.dataset.act;
    const url = instApi(d.id, `/backups/${encodeURIComponent(tr.dataset.name)}`);
    if (action === 'download') location.href = url;
    if (action === 'lock') { await api('POST', `${url}/lock`, { locked: !tr.classList.contains('locked') }); reload(); }
    if (action === 'restore' && await confirmDialog('Restaurar sobrescreve os arquivos atuais incluídos no backup. O servidor precisa estar parado. Continuar?', { okText: 'Restaurar' })) {
      await api('POST', `${url}/restore`);
      toast('Backup restaurado', 'ok');
    }
    if (action === 'delete' && await confirmDialog('Excluir este backup?', { danger: true, okText: 'Excluir' })) { await api('DELETE', url); reload(); }
  })));
}

// ---------- scheduler ----------
async function renderSchedule(body, d) {
  const tasks = await api('GET', instApi(d.id, '/schedules'));
  body.innerHTML = `${scheduleTable(tasks)}${scheduleForm()}`;
  const reload = () => act(renderSchedule)(body, d);
  wireScheduleForm($('#taskForm'), async payload => {
    await api('POST', instApi(d.id, '/schedules'), payload);
    toast('Tarefa criada', 'ok');
    reload();
  });
  wireScheduleTable(body, d.id, reload);
}
