import { $, act, api, esc, gameArt, openModal, readSettings, settingsFields, state } from '../core.js';

const AFTER_CREATE = [
  ['installStart', 'Instalar e iniciar'],
  ['installStartAlways', 'Instalar e iniciar (atualizar sempre ao iniciar)'],
  ['install', 'Apenas instalar'],
  ['none', 'Não fazer nada'],
];
const PLATFORM_ICONS = { windows: '<span class="plat" title="Windows">⊞ Windows</span>', linux: '<span class="plat" title="Linux">🐧 Linux</span>' };

export function openCreateDialog() {
  if (location.hash === '#/new') history.replaceState(null, '', '#/');
  let selected = state.games.find(g => g.id === 'minecraft-paper') || state.games[0];
  const categories = [...new Set(state.games.map(g => g.category))].sort((a, b) => a.localeCompare(b, 'pt-BR'));

  const { el, close } = openModal(`
    <div class="modal-head"><h2>Criar nova instância</h2><button class="icon-btn" data-close aria-label="Fechar">✕</button></div>
    <form id="createForm" class="create-layout">
      <div class="create-left">
        <label>Aplicação
          <input id="gameSearch" placeholder="Buscar entre ${state.games.length} jogos…" autocomplete="off">
        </label>
        <div class="cat-filter">
          <select id="catFilter"><option value="">Todas as categorias</option>${categories.map(c => `<option>${esc(c)}</option>`).join('')}</select>
        </div>
        <div class="game-list" id="gameList" role="listbox" tabindex="0"></div>
      </div>
      <div class="create-right">
        <div id="gameInfo"></div>
        <div class="form-grid">
          <label>Nome da instância <input name="name" id="nameInput" autocomplete="off" required></label>
          <label>Após criar
            <select name="afterCreate">${AFTER_CREATE.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
          </label>
        </div>
        <label class="check"><input type="checkbox" name="autoStart"> Iniciar automaticamente junto com o painel</label>
        <div id="customFields"></div>
        <div id="gameSettings"></div>
        <details class="advanced"><summary>Pasta de instalação</summary>
          <label>Caminho completo (vazio = pasta padrão do painel)<input name="dir" placeholder="ex.: D:\\Servidores\\MeuServidor" autocomplete="off"></label>
        </details>
        <label class="check" id="eulaRow" hidden><input type="checkbox" name="eula"> Li e aceito o <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noopener">EULA do Minecraft</a></label>
        <div class="modal-actions"><button type="button" data-close>Cancelar</button><button class="primary" id="createSubmit">Criar instância</button></div>
      </div>
    </form>`, { wide: true });

  const form = $('#createForm', el);
  const list = $('#gameList', el);
  let nameTouched = false;
  form.name.addEventListener('input', () => { nameTouched = true; });

  const filtered = () => {
    const q = $('#gameSearch', el).value.trim().toLowerCase();
    const cat = $('#catFilter', el).value;
    return state.games.filter(g => (!cat || g.category === cat) && (!q || g.name.toLowerCase().includes(q) || g.category.toLowerCase().includes(q)));
  };

  const renderList = () => {
    const games = filtered();
    list.innerHTML = games.map(g => `
      <div class="game-item ${g.id === selected?.id ? 'selected' : ''}" data-id="${g.id}" role="option" aria-selected="${g.id === selected?.id}">
        ${gameArt(g.image, g.name, 'thumb')}<span>${esc(g.name)}${g.account ? ' <span class="pill">conta Steam</span>' : ''}</span>
      </div>`).join('') || '<p class="muted pad">Nenhum jogo encontrado.</p>';
    list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  };

  const select = game => {
    selected = game;
    if (!nameTouched) form.name.value = game.name;
    $('#gameInfo', el).innerHTML = `
      ${gameArt(game.image, game.name, 'hero')}
      <div class="game-meta">
        <div><strong>${esc(game.name)}</strong> <span class="muted small">· ${esc(game.category)}</span></div>
        <div class="plats">${(game.platforms || []).map(p => PLATFORM_ICONS[p] || '').join('')}</div>
      </div>
      ${game.description ? `<p class="muted small">${esc(game.description)}</p>` : ''}
      ${game.account ? '<p class="notice">Este jogo exige uma conta Steam que possua o jogo. Faça login em Configurações → Conta Steam antes de instalar.</p>' : ''}
      ${game.notes ? `<p class="notice">${esc(game.notes)}</p>` : ''}`;
    $('#customFields', el).innerHTML = game.id === 'steam-custom'
      ? '<div class="form-grid"><label>Steam App ID do servidor dedicado<input name="steamAppId" inputmode="numeric" required placeholder="ex.: 896660"></label></div><p class="hint">Procure o App ID em steamdb.info (servidores dedicados geralmente são do tipo "Tool").</p>'
      : game.id === 'generic'
        ? '<div class="form-grid"><label>Executável<input name="exe" required placeholder="ex.: C:\\Jogos\\Servidor\\server.exe"></label><label>Argumentos<input name="args" placeholder="opcional"></label></div><p class="hint">Use "Pasta de instalação" abaixo para apontar a pasta onde o programa roda.</p>'
        : '';
    $('#gameSettings', el).innerHTML = game.settings.length ? `<h3>Configurações do jogo</h3>${settingsFields(game.settings)}` : '';
    $('#eulaRow', el).hidden = !game.eula;
    form.afterCreate.value = game.id === 'generic' ? 'none' : form.afterCreate.value;
    renderList();
  };

  list.addEventListener('click', e => {
    const item = e.target.closest('.game-item');
    if (item) select(state.games.find(g => g.id === item.dataset.id));
  });
  list.addEventListener('keydown', e => {
    if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const games = filtered();
    const idx = games.findIndex(g => g.id === selected?.id);
    const next = games[Math.max(0, Math.min(games.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) select(next);
  });
  $('#gameSearch', el).addEventListener('input', () => {
    const games = filtered();
    if (games.length && !games.includes(selected)) select(games[0]); else renderList();
  });
  $('#catFilter', el).addEventListener('change', () => {
    const games = filtered();
    if (games.length && !games.includes(selected)) select(games[0]); else renderList();
  });

  form.addEventListener('submit', act(async e => {
    e.preventDefault();
    if (selected.eula && !form.eula.checked) throw new Error('É preciso aceitar o EULA do Minecraft');
    const body = {
      templateId: selected.id,
      name: form.name.value.trim(),
      autoStart: form.autoStart.checked,
      afterCreate: form.afterCreate.value,
      dir: form.dir.value.trim(),
      eula: form.eula.checked,
      settings: readSettings(form, selected.settings),
    };
    if (selected.id === 'steam-custom') body.steamAppId = form.steamAppId.value.trim();
    if (selected.id === 'generic') body.overrides = { exe: form.exe.value.trim(), args: form.args.value.trim() };
    $('#createSubmit', el).disabled = true;
    try {
      const inst = await api('POST', '/api/instances', body);
      state.instances = await api('GET', '/api/instances');
      close();
      location.hash = `#/instance/${inst.id}/console`;
    } finally {
      $('#createSubmit', el)?.removeAttribute('disabled');
    }
  }));

  select(selected);
  $('#gameSearch', el).focus();
}
