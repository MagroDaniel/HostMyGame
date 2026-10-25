import { $, $$, act, api, confirmDialog, esc, fmtDate, icon, state, toast } from '../core.js';

// Scheduled tasks: a cron time plus a list of steps (e.g. warn → wait 60s → backup → restart).
const CRON_PRESETS = [
  ['0 4 * * *', 'Todo dia às 04:00'],
  ['0 */6 * * *', 'A cada 6 horas'],
  ['0 * * * *', 'A cada hora'],
  ['*/30 * * * *', 'A cada 30 minutos'],
  ['0 5 * * 1', 'Toda segunda às 05:00'],
];

// Ready-made step lists for common jobs.
const RECIPES = [
  ['', 'Começar do zero'],
  ['restart-warn', 'Reinício com aviso (aviso → 60s → aviso → 10s → reiniciar)'],
  ['backup-restart', 'Backup e reinício (aviso → 30s → backup → reiniciar)'],
  ['update', 'Atualizar com aviso (aviso → 60s → atualizar)'],
];
const recipeSteps = {
  'restart-warn': [{ action: 'command', payload: 'say O servidor vai reiniciar em 1 minuto!' }, { action: 'wait', payload: '50' }, { action: 'command', payload: 'say Reiniciando em 10 segundos...' }, { action: 'wait', payload: '10' }, { action: 'restart', payload: '' }],
  'backup-restart': [{ action: 'command', payload: 'say Backup e reinício em 30 segundos!' }, { action: 'wait', payload: '30' }, { action: 'backup', payload: '' }, { action: 'restart', payload: '' }],
  update: [{ action: 'command', payload: 'say Atualização em 1 minuto!' }, { action: 'wait', payload: '60' }, { action: 'update', payload: '' }],
};

export const cronLabel = c => CRON_PRESETS.find(p => p[0] === c)?.[1] || c;
const ACTION_HINT = {
  command: 'Comando do console (ex.: say Olá!)', wait: 'Segundos (1 a 3600)', restart: 'Aviso enviado antes (opcional)',
};
const stepText = st => `${state.actions[st.action] || st.action}${st.payload ? (st.action === 'wait' ? ` ${st.payload}s` : `: ${st.payload}`) : ''}`;
const stepsOf = t => (t.steps?.length ? t.steps : t.action ? [{ action: t.action, payload: t.payload }] : []);

function stepRow(st, i) {
  return `
    <div class="step-row" data-step="${i}">
      <span class="step-n">${i + 1}</span>
      <select name="action">${Object.entries(state.actions).map(([k, l]) => `<option value="${k}" ${st.action === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <input name="payload" value="${esc(st.payload || '')}" placeholder="${esc(ACTION_HINT[st.action] || 'sem parâmetro')}" ${['command', 'wait', 'restart'].includes(st.action) ? '' : 'disabled'} autocomplete="off">
      <span class="step-btns">
        <button type="button" class="small ghost" data-stepmove="-1" aria-label="Subir">▲</button>
        <button type="button" class="small ghost" data-stepmove="1" aria-label="Descer">▼</button>
        <button type="button" class="small ghost" data-stepdel aria-label="Remover passo">${icon('trash')}</button>
      </span>
    </div>`;
}

export function scheduleForm(instanceSelect = '') {
  return `
    <form class="card form" id="taskForm">
      <h3>Nova tarefa</h3>
      ${instanceSelect}
      <div class="form-grid">
        <label>Nome (opcional)<input name="name" maxlength="60" placeholder="ex.: Reinício diário"></label>
        <label>Quando
          <select name="preset">${CRON_PRESETS.map(([c, l]) => `<option value="${c}">${l}</option>`).join('')}<option value="custom">Personalizado (cron)…</option></select>
        </label>
        <label>Expressão cron <input name="cron" value="${CRON_PRESETS[0][0]}" readonly></label>
        <label>Modelo<select name="recipe">${RECIPES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
      </div>
      <div><div class="steps-title">Passos (executados em ordem)</div><div class="steps" id="steps"></div>
        <button type="button" class="small" id="addStep">${icon('plus')} Adicionar passo</button></div>
      <label class="check"><input type="checkbox" name="onlyOnline"> Só executar se o servidor estiver ligado</label>
      <p class="hint" style="margin:0">Formato cron: minuto hora dia mês dia-da-semana. Ex.: <code>30 3 * * *</code> = todo dia às 03:30. Se um passo falhar, os seguintes não são executados.</p>
      <div class="form-foot"><button class="primary">Adicionar tarefa</button></div>
    </form>`;
}

export function wireScheduleForm(form, onSubmit) {
  let steps = [{ action: 'restart', payload: '' }];
  const box = $('#steps', form);
  const draw = () => { box.innerHTML = steps.map(stepRow).join(''); };
  const read = () => { steps = $$('.step-row', box).map(r => ({ action: r.querySelector('[name=action]').value, payload: r.querySelector('[name=payload]').value })); };
  draw();
  box.addEventListener('change', e => { if (e.target.name === 'action') { read(); draw(); } });
  box.addEventListener('click', e => {
    const row = e.target.closest('.step-row');
    if (!row) return;
    read();
    const i = Number(row.dataset.step);
    const mv = e.target.closest('[data-stepmove]');
    if (mv) {
      const j = i + Number(mv.dataset.stepmove);
      if (j < 0 || j >= steps.length) return;
      [steps[i], steps[j]] = [steps[j], steps[i]];
    } else if (e.target.closest('[data-stepdel]')) {
      steps.splice(i, 1);
    } else return;
    draw();
  });
  $('#addStep', form).addEventListener('click', () => { read(); steps.push({ action: 'command', payload: '' }); draw(); });
  form.recipe.addEventListener('change', () => {
    if (!form.recipe.value) return;
    steps = structuredClone(recipeSteps[form.recipe.value]);
    draw();
  });
  form.preset.addEventListener('change', () => {
    const custom = form.preset.value === 'custom';
    form.cron.readOnly = !custom;
    if (!custom) form.cron.value = form.preset.value;
    else form.cron.focus();
  });
  form.addEventListener('submit', act(async e => {
    e.preventDefault();
    read();
    await onSubmit({ name: form.name.value, cron: form.cron.value, steps, onlyOnline: form.onlyOnline.checked });
  }));
}

// Table of tasks; with showInstance it also lists which server each task belongs to (global page).
export function scheduleTable(tasks, { showInstance = false } = {}) {
  return `
    <div class="card table-wrap flush" style="margin-bottom:16px">
      <table>
        <thead><tr>${showInstance ? '<th>Servidor</th>' : ''}<th>Quando</th><th>Tarefa</th><th>Ativa</th><th>Última execução</th><th></th></tr></thead>
        <tbody>
          ${tasks.map(t => `
            <tr data-id="${t.id}" data-inst="${t.instanceId || ''}">
              ${showInstance ? `<td><a href="#/instance/${t.instanceId}/schedule">${esc(t.instanceName)}</a></td>` : ''}
              <td>${esc(cronLabel(t.cron))}<div class="hint">${esc(t.cron)}</div></td>
              <td>${t.name ? `<strong>${esc(t.name)}</strong>` : ''}<ol class="step-list">${stepsOf(t).map(st => `<li>${esc(stepText(st))}</li>`).join('')}</ol>${t.onlyOnline ? '<span class="pill">só com servidor ligado</span>' : ''}</td>
              <td><label class="switch"><input type="checkbox" data-act="toggle" ${t.enabled ? 'checked' : ''} aria-label="Ativa"><span></span></label></td>
              <td>${fmtDate(t.lastRun)}${t.lastResult && t.lastResult !== 'ok' ? `<div class="hint ${t.lastResult.startsWith('pulada') ? '' : 'err'}">${esc(t.lastResult)}</div>` : ''}</td>
              <td class="actions"><button class="small" data-act="run">${icon('play')} Executar agora</button><button class="small ghost" data-act="delete" title="Excluir">${icon('trash')}</button></td>
            </tr>`).join('') || `<tr><td colspan="${showInstance ? 6 : 5}" class="muted">Nenhuma tarefa agendada.</td></tr>`}
        </tbody>
      </table>
    </div>`;
}

export function wireScheduleTable(root, instanceId, reload) {
  $$('tr[data-id]', root).forEach(tr => tr.addEventListener('click', act(async e => {
    const action = e.target.closest('[data-act]')?.dataset.act;
    const url = `/api/instances/${tr.dataset.inst || instanceId}/schedules/${tr.dataset.id}`;
    if (action === 'toggle') return api('PATCH', url, { enabled: e.target.checked });
    if (action === 'run') { await api('POST', `${url}/run`); return toast('Tarefa iniciada — acompanhe no console'); }
    if (action === 'delete' && await confirmDialog('Excluir esta tarefa?', { danger: true, okText: 'Excluir' })) { await api('DELETE', url); reload(); }
  })));
}
