import { $, act, address, api, badge, confirmDialog, esc, fmtBytes, gameArt, icon, isAdmin, playersText, route, state, toast } from '../core.js';
import { openCreateDialog } from './create.js';

const main = () => $('#main');

export function renderInstances() {
  document.title = 'Servidores · Host My Game';
  $('#pageTitle').textContent = 'Seus servidores';
  $('#pageActions').innerHTML = isAdmin() ? `
    <button data-bulk="start" class="ghost">${icon('play')}<span>Iniciar todos</span></button>
    <button data-bulk="stop" class="ghost">${icon('stop')}<span>Parar todos</span></button>
    <button data-bulk="update" class="ghost">${icon('download')}<span>Atualizar todos</span></button>
    <button id="createBtn" class="primary">${icon('plus')} Criar servidor</button>` : '';
  main().innerHTML = `
    <div class="dash-tools">
      <div class="sysline" id="sysline"></div>
      <div style="display:flex;gap:8px;align-items:center">
        <span class="muted small" id="countLabel"></span>
        <div class="seg">
          <button data-view="list" title="Lista" aria-label="Lista">${icon('menu')}</button>
          <button data-view="grid" title="Cartões" aria-label="Cartões">${icon('server')}</button>
        </div>
      </div>
    </div>
    <div id="instancesBox"></div>`;
  $('#createBtn')?.addEventListener('click', () => openCreateDialog());
  document.querySelectorAll('#pageActions [data-bulk]').forEach(b => b.addEventListener('click', act(async () => {
    const labels = { start: 'iniciar todos os servidores', stop: 'parar todos os servidores', update: 'atualizar todos os servidores (os que estiverem rodando serão reiniciados)' };
    if (!(await confirmDialog(`Deseja ${labels[b.dataset.bulk]}?`))) return;
    const r = await api('POST', `/api/bulk/${b.dataset.bulk}`, {});
    toast(`Ação enviada para ${r.count} servidor(es)`, 'ok');
  })));
  main().querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
    state.view = b.dataset.view;
    try { localStorage.setItem('hmg.view2', state.view); } catch { /* private mode */ }
    updateInstancesView(true);
  }));
  try { state.view = localStorage.getItem('hmg.view2') || 'list'; } catch { state.view = 'list'; }
  updateInstancesView(true);
}

function sysline() {
  const info = state.sysinfo, sys = state.system;
  if (!info) return '';
  return [
    `<span>${icon('monitor')} ${esc(info.os)}</span>`,
    `<span title="${esc(info.cpuModel)}">${icon('cpu')} ${esc(info.cpuModel?.replace(/\s+\d+-Core Processor/i, '') || '')}${sys ? ` · ${sys.cpu.toFixed(0)}%` : ''}</span>`,
    `<span>${icon('memory')} ${sys ? `${fmtBytes(sys.memUsed)} / ` : ''}${fmtBytes(info.memTotal)}</span>`,
    `<span title="IP deste PC na sua rede">${icon('wifi')} ${esc(info.lanIp)}</span>`,
  ].join('');
}

function matches(i) {
  const q = state.search.trim().toLowerCase();
  return !q || `${i.name} ${i.game}`.toLowerCase().includes(q);
}

function quickButton(i) {
  if (i.state === 'Installing') return '<span class="sr-state">Instalando…</span>';
  if (['Stopped', 'Failed'].includes(i.state)) {
    return i.installed ? `<button class="small ok" data-quick="start" title="Iniciar">${icon('play')}</button>` : '<span class="sr-state">Não instalado</span>';
  }
  return `<button class="small danger" data-quick="stop" title="Parar">${icon('stop')}</button>`;
}

const memText = i => (i.state === 'Running' || i.mem ? fmtBytes(i.mem) : '—');

function row(i) {
  const memHot = i.memLimit && i.mem > i.memLimit * 0.9;
  return `
    <article class="server-row s-${i.state}" data-id="${i.id}" data-href="#/instance/${i.id}">
      <div class="sr-name">
        ${gameArt(i.image, i.game, 'mini')}
        <div class="sr-title">
          <strong>${esc(i.name)}</strong>
          <span class="muted small">${esc(i.description || i.game)}</span>
          <div class="sr-tags">${badge(i.state)}${i.updateAvailable ? '<span class="pill update">Atualização</span>' : ''}</div>
        </div>
      </div>
      <div class="sr-addr" title="Endereço na sua rede">${icon('network')} ${esc(address(i))}</div>
      <div class="sr-stats">
        <div class="sr-stat ${i.cpu > 90 ? 'hot' : ''}"><span class="v">${icon('cpu')} ${i.state === 'Running' ? `${i.cpu.toFixed(0)}%` : '—'}</span><span class="l">CPU</span></div>
        <div class="sr-stat ${memHot ? 'hot' : ''}"><span class="v">${icon('memory')} ${memText(i)}</span><span class="l">${i.memLimit ? `de ${fmtBytes(i.memLimit)}` : 'Memória'}</span></div>
        <div class="sr-stat"><span class="v">${icon('disk')} ${i.disk === null ? '…' : fmtBytes(i.disk)}</span><span class="l">Disco</span></div>
        <div class="sr-stat"><span class="v">${icon('users')} ${playersText(i)}</span><span class="l">Jogadores</span></div>
      </div>
      <div class="sr-actions">${quickButton(i)}</div>
    </article>`;
}

function card(i) {
  return `
    <article class="inst-card" data-id="${i.id}">
      <a href="#/instance/${i.id}" class="inst-art">${gameArt(i.image, i.game)}${i.updateAvailable ? '<span class="pill update">Atualização disponível</span>' : ''}</a>
      <div class="inst-body">
        <div class="inst-title"><a href="#/instance/${i.id}"><strong>${esc(i.name)}</strong></a>${badge(i.state)}</div>
        <div class="muted small">${esc(i.game)} · <span style="font-family:var(--mono)">${esc(address(i))}</span></div>
        <div class="inst-stats">
          <span>CPU ${i.cpu.toFixed(0)}%</span>
          <span>RAM ${fmtBytes(i.mem)}</span>
          <span>${playersText(i)} jog.</span>
        </div>
        <div class="inst-actions">${quickButton(i)}<a class="button small" href="#/instance/${i.id}">Gerenciar</a></div>
      </div>
    </article>`;
}

let lastKey = '';
export function updateInstancesView(force = false) {
  const box = $('#instancesBox');
  if (!box || route().view !== '') return;
  const sl = $('#sysline');
  if (sl) sl.innerHTML = sysline();
  const list = state.instances.filter(matches);
  // Avoid rebuilding the DOM (and dropping hover/focus) when nothing visible changed.
  const key = JSON.stringify([state.view, list.map(i => [i.id, i.name, i.description, i.state, i.cpu.toFixed(0), Math.round(i.mem / 1e6), i.disk, i.players, i.updateAvailable, i.installed])]);
  if (!force && key === lastKey) return;
  lastKey = key;
  main().querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  $('#countLabel').textContent = `${state.instances.length} servidor(es)`;
  if (!state.instances.length) {
    box.innerHTML = `
      <div class="empty-state">
        <h2>${isAdmin() ? 'Nenhum servidor ainda' : 'Nenhum servidor disponível'}</h2>
        <p>${isAdmin() ? 'Crie seu primeiro servidor escolhendo um jogo da lista. Depois é só instalar e iniciar.' : 'Peça a um administrador para liberar acesso a um servidor.'}</p>
        ${isAdmin() ? `<button class="primary" id="createTile">${icon('plus')} Criar servidor</button>` : ''}
      </div>`;
    $('#createTile')?.addEventListener('click', () => openCreateDialog());
    return;
  }
  box.innerHTML = state.view === 'grid'
    ? `<div class="inst-grid">${list.map(card).join('')}</div>`
    : `<div class="server-list">${list.map(row).join('')}</div>`;
  box.querySelectorAll('.server-row').forEach(r => r.addEventListener('click', e => {
    if (!e.target.closest('button')) location.hash = r.dataset.href;
  }));
  box.querySelectorAll('[data-quick]').forEach(b => b.addEventListener('click', act(async e => {
    e.preventDefault();
    e.stopPropagation();
    const id = b.closest('[data-id]').dataset.id;
    b.disabled = true;
    await api('POST', `/api/instances/${id}/${b.dataset.quick}`);
  })));
}
