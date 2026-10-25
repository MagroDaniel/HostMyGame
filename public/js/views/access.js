import { $, $$, act, api, confirmDialog, esc, fmtDate, icon, instApi, toast } from '../core.js';

const SHORT = { console: 'Console', control: 'Ligar/desligar', update: 'Atualizar', files: 'Arquivos', backups: 'Backups', schedule: 'Agendador', settings: 'Configurações' };

// "Usuários" tab (admins only): who can access this server and what each person may do here.
// Uses the panel-wide user list; access is stored per user as { [serverId]: [permissions] }.
export async function renderAccess(body, d) {
  const { users, permissions } = await api('GET', '/api/users');
  const id = d.id;
  const admins = users.filter(u => u.role === 'admin');
  const members = users.filter(u => u.role !== 'admin' && u.access?.[id]);
  const others = users.filter(u => u.role !== 'admin' && !u.access?.[id]);
  const perms = Object.entries(permissions);
  const reload = () => act(renderAccess)(body, d);

  body.innerHTML = `
    <div class="card flush">
      <h3>Quem pode acessar este servidor</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Usuário</th>${perms.map(([k, l]) => `<th class="perm-col" title="${esc(l)}">${esc(SHORT[k] || l)}</th>`).join('')}<th></th></tr></thead>
        <tbody>
          ${members.map(u => `
            <tr data-user="${esc(u.username)}">
              <td><span class="file-name">${icon('user')} ${esc(u.username)}</span>${u.totp ? ' <span class="pill good">2FA</span>' : ''}</td>
              ${perms.map(([k]) => `<td class="perm-col"><input type="checkbox" data-perm="${k}" ${u.access[id].includes(k) ? 'checked' : ''} aria-label="${esc(k)}"></td>`).join('')}
              <td class="actions"><button class="small ghost" data-remove title="Tirar acesso">${icon('trash')}</button></td>
            </tr>`).join('') || `<tr><td colspan="${perms.length + 2}" class="muted">Nenhum usuário comum tem acesso a este servidor ainda.</td></tr>`}
        </tbody>
      </table></div>
      <p class="hint pad" style="margin:0">Administradores (${admins.map(u => esc(u.username)).join(', ')}) têm acesso total a todos os servidores. Sem nenhuma permissão marcada, o usuário só vê o servidor e o status.</p>
    </div>
    <form class="card form" id="addAccess">
      <h3>Dar acesso a alguém</h3>
      <div class="form-grid">
        <label>Usuário<select name="who">
          ${others.map(u => `<option value="${esc(u.username)}">${esc(u.username)}</option>`).join('')}
          <option value="__new">+ Criar um usuário novo…</option>
        </select></label>
        <label class="new-only">Nome do novo usuário<input name="username" autocomplete="off" spellcheck="false"></label>
        <label class="new-only">Senha (mínimo 8 caracteres)<input name="password" type="password" autocomplete="new-password"></label>
      </div>
      <div class="perm-checks">${perms.map(([k, l]) => `<label class="check"><input type="checkbox" name="perm" value="${k}" ${['console', 'control'].includes(k) ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div>
      <div class="form-foot"><button class="primary">${icon('plus')} Dar acesso</button></div>
    </form>`;

  const form = $('#addAccess');
  const syncNew = () => $$('.new-only', form).forEach(l => { l.hidden = form.who.value !== '__new'; });
  form.who.addEventListener('change', syncNew);
  syncNew();
  form.addEventListener('submit', act(async e => {
    e.preventDefault();
    const chosen = $$('[name=perm]:checked', form).map(c => c.value);
    if (form.who.value === '__new') {
      await api('POST', '/api/users', { username: form.username.value.trim(), password: form.password.value, role: 'user', access: { [id]: chosen } });
    } else {
      const u = others.find(x => x.username === form.who.value);
      await api('PATCH', `/api/users/${encodeURIComponent(u.username)}`, { access: { ...u.access, [id]: chosen } });
    }
    toast('Acesso concedido', 'ok');
    reload();
  }));

  $$('tr[data-user]', body).forEach(tr => {
    const u = members.find(x => x.username === tr.dataset.user);
    tr.addEventListener('change', act(async () => {
      const chosen = $$('[data-perm]', tr).filter(c => c.checked).map(c => c.dataset.perm);
      await api('PATCH', `/api/users/${encodeURIComponent(u.username)}`, { access: { ...u.access, [id]: chosen } });
      u.access[id] = chosen;
      toast('Permissões salvas', 'ok');
    }));
    $('[data-remove]', tr).addEventListener('click', act(async () => {
      if (!(await confirmDialog(`Tirar o acesso de ${u.username} a este servidor?`, { danger: true, okText: 'Tirar acesso' }))) return;
      const access = { ...u.access };
      delete access[id];
      await api('PATCH', `/api/users/${encodeURIComponent(u.username)}`, { access });
      reload();
    }));
  });
}

// Recent activity on this server (shown in the Configurações tab).
export async function renderServerActivity(box, d) {
  const entries = await api('GET', instApi(d.id, '/activity'));
  box.innerHTML = `
    <div class="card flush">
      <h3>Atividade recente neste servidor</h3>
      <div class="table-wrap activity-box"><table class="compact">
        <tbody>${entries.slice(0, 50).map(e => `
          <tr><td class="nowrap muted">${fmtDate(e.t)}</td><td><b>${esc(e.user)}</b> ${esc(e.action)}${e.detail ? ` <span class="muted">— ${esc(e.detail)}</span>` : ''}</td></tr>`).join('')
          || '<tr><td class="muted">Nada registrado ainda.</td></tr>'}</tbody>
      </table></div>
    </div>`;
}
