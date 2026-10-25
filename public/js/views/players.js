import { $, $$, act, api, confirmDialog, esc, icon, instApi, promptDialog, toast } from '../core.js';

// "Jogadores" tab: online players and admin actions (Minecraft lists, Project Zomboid commands).
const MC_ACTIONS = {
  kick: 'Expulsar', ban: 'Banir', pardon: 'Desbanir', op: 'Dar operador', deop: 'Tirar operador',
  'whitelist-add': 'Adicionar à whitelist', 'whitelist-remove': 'Tirar da whitelist', 'ban-ip': 'Banir IP', 'pardon-ip': 'Desbanir IP',
};
const PZ_ACTIONS = {
  kick: 'Expulsar', ban: 'Banir', pardon: 'Desbanir', op: 'Tornar admin', moderator: 'Tornar moderador', deop: 'Tirar cargo',
  'whitelist-add': 'Adicionar à whitelist', 'whitelist-remove': 'Tirar da whitelist',
};
const WITH_REASON = new Set(['kick', 'ban', 'ban-ip']);
const DANGER = new Set(['kick', 'ban', 'ban-ip']);

export async function renderPlayers(body, d) {
  const data = await api('GET', instApi(d.id, '/players'));
  const mc = data.kind === 'minecraft';
  const actions = mc ? MC_ACTIONS : PZ_ACTIONS;
  const reload = () => act(renderPlayers)(body, d);

  const run = act(async (action, target) => {
    let reason = '';
    if (WITH_REASON.has(action)) {
      reason = await promptDialog(`${actions[action]}: ${target}`, '', { label: 'Motivo (opcional)', okText: actions[action] });
      if (reason === null) return;
    } else if (DANGER.has(action) && !(await confirmDialog(`${actions[action]} ${target}?`, { danger: true }))) return;
    const r = await api('POST', instApi(d.id, '/players'), { action, target, reason });
    toast(r.applied === 'file' ? `${actions[action]}: ${target} (vale quando o servidor ligar)` : `${actions[action]}: ${target}`, 'ok');
    setTimeout(reload, r.applied === 'command' ? 1200 : 0); // the server rewrites its lists after the command
  });

  const onlineActions = mc ? ['kick', 'ban', 'op'] : ['kick', 'ban', 'op'];
  const status = !data.running
    ? `<div class="notice warn">Servidor desligado. ${mc ? 'As mudanças nas listas são gravadas nos arquivos e valem quando o servidor ligar. Expulsar só funciona com ele ligado.' : 'Os comandos de administrador do Project Zomboid só funcionam com o servidor ligado.'}</div>`
    : !data.canCommand ? '<div class="notice warn">O console do servidor ainda não está pronto para receber comandos. Aguarde alguns segundos.</div>' : '';

  body.innerHTML = `
    <div id="playersRoot">
      ${status}
      <div class="two-col">
        <div class="card flush">
          <h3>Online agora ${data.running ? `(${data.online.length}${!mc && !data.onlineKnown && data.players ? ` · ${data.players} pela consulta` : ''})` : ''}</h3>
          <div class="player-list">
            ${data.online.map(n => `
              <div class="player-row" data-name="${esc(n)}">
                <span class="player-name"><img class="player-head" src="${mc ? `https://mc-heads.net/avatar/${encodeURIComponent(n)}/32` : ''}" alt="" ${mc ? '' : 'hidden'} loading="lazy">${mc ? '' : icon('user')} ${esc(n)}</span>
                <span class="player-actions">${onlineActions.map(a => `<button class="small ${DANGER.has(a) ? 'ghost' : 'ghost'}" data-act="${a}">${esc(actions[a])}</button>`).join('')}</span>
              </div>`).join('') || `<p class="muted pad">${data.running ? 'Ninguém online.' : 'Servidor parado.'}</p>`}
          </div>
        </div>
        <form class="card form" id="playerForm">
          <h3>Gerenciar jogador</h3>
          <label>Nome do jogador${mc ? ' (ou IP para banir IP)' : ''}<input name="target" required autocomplete="off" spellcheck="false" placeholder="${mc ? 'ex.: Notch' : 'nome de usuário no servidor'}"></label>
          <div class="action-grid">${Object.entries(actions).map(([k, l]) => `<button type="button" class="small ${DANGER.has(k) ? 'danger' : ''}" data-formact="${k}">${esc(l)}</button>`).join('')}</div>
          <p class="hint" style="margin:0">${mc ? 'Com o servidor desligado, o painel procura a conta na Mojang para gravar o UUID certo.' : 'Usa os comandos de administrador do jogo (kickuser, banuser, setaccesslevel…).'}</p>
        </form>
      </div>
      ${mc ? mcLists(data.lists) : ''}
    </div>`;

  $$('.player-row [data-act]', body).forEach(b => b.addEventListener('click', () => run(b.dataset.act, b.closest('[data-name]').dataset.name)));
  const form = $('#playerForm');
  $$('[data-formact]', form).forEach(b => b.addEventListener('click', () => {
    const target = form.target.value.trim();
    if (!target) { form.target.focus(); return toast('Digite o nome do jogador', 'error'); }
    run(b.dataset.formact, target);
  }));
  $$('[data-listact]', body).forEach(b => b.addEventListener('click', () => run(b.dataset.listact, b.dataset.target)));
}

function mcLists(l) {
  const list = (title, items, removeAct, extra = '') => `
    <div class="card flush">
      <h3>${title} (${items.length})</h3>
      ${extra}
      <div class="player-list">${items.map(it => `
        <div class="player-row">
          <span class="player-name">${it.ip ? `${icon('network')} ${esc(it.ip)}` : `<img class="player-head" src="https://mc-heads.net/avatar/${encodeURIComponent(it.uuid || it.name)}/32" alt="" loading="lazy"> ${esc(it.name)}`}
            ${it.reason ? `<span class="muted small">— ${esc(it.reason)}</span>` : ''}${it.level ? `<span class="pill">nível ${it.level}</span>` : ''}</span>
          <button class="small ghost" data-listact="${removeAct(it)}" data-target="${esc(it.ip || it.name)}" title="Remover">${icon('trash')}</button>
        </div>`).join('') || '<p class="muted pad">Vazia.</p>'}</div>
    </div>`;
  return `
    <div class="players-grid">
      ${list('Whitelist', l.whitelist, () => 'whitelist-remove', `<p class="hint pad" style="margin:0;padding-bottom:0">${l.whitelistOn ? '<span class="pill good">Ativada</span> só quem está aqui pode entrar.' : '<span class="pill">Desativada</span> qualquer um pode entrar. Ative em Inicialização › "Lista branca".'}</p>`)}
      ${list('Operadores', l.ops, () => 'deop')}
      ${list('Banidos', [...l.bans, ...l.ipBans], it => (it.ip ? 'pardon-ip' : 'pardon'))}
    </div>`;
}
