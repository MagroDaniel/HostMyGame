import { $, $$, act, api, esc, icon, instApi, toast } from '../core.js';

// Visual editor for the game's own config files (server.properties, servertest.ini, SandboxVars.lua…).
let current = { id: null, path: null };

export async function renderConfigEditor(box, d) {
  const files = d.editableConfigs || [];
  if (!files.length) { box.innerHTML = ''; return; }
  if (current.id !== d.id || !files.some(f => f.path === current.path)) current = { id: d.id, path: (files.find(f => f.exists) || files[0]).path };
  box.innerHTML = `
    <div class="card cfg-editor">
      <h3>Opções do jogo (arquivos de configuração)</h3>
      <div class="cfg-top">
        <div class="seg">${files.map(f => `<button data-file="${esc(f.path)}" class="${f.path === current.path ? 'active' : ''}" ${f.exists ? '' : 'disabled title="Ainda não existe — inicie o servidor uma vez"'}>${icon('file')} ${esc(f.path.split('/').pop())}</button>`).join('')}</div>
        <input type="search" id="cfgFilter" placeholder="Filtrar opções…" autocomplete="off">
      </div>
      <div id="cfgBody"><p class="muted"><span class="spinner"></span> Carregando…</p></div>
    </div>`;
  $$('[data-file]', box).forEach(b => b.addEventListener('click', () => { current.path = b.dataset.file; act(renderConfigEditor)(box, d); }));
  if (!files.find(f => f.path === current.path)?.exists) {
    $('#cfgBody').innerHTML = '<p class="muted">Este arquivo ainda não existe. Inicie o servidor uma vez para o jogo criá-lo.</p>';
    return;
  }
  const cfg = await api('GET', instApi(d.id, `/config?path=${encodeURIComponent(current.path)}`));
  drawEditor(box, d, cfg);
}

function field(e) {
  const id = `cfg_${e.line}`;
  const dis = e.managed ? 'disabled' : '';
  let input;
  if (e.type === 'bool') input = `<label class="switch"><input type="checkbox" id="${id}" data-line="${e.line}" ${e.value ? 'checked' : ''} ${dis}><span></span></label>`;
  else if (e.type === 'select') input = `<select id="${id}" data-line="${e.line}" ${dis}>${e.options.map(([v, l]) => `<option value="${esc(v)}" ${String(e.value) === v ? 'selected' : ''}>${esc(v)} — ${esc(l)}</option>`).join('')}</select>`;
  else input = `<input id="${id}" data-line="${e.line}" value="${esc(e.value)}" ${e.type === 'number' ? 'inputmode="decimal"' : ''} autocomplete="off" spellcheck="false" ${dis}>`;
  return `
    <div class="cfg-row" data-search="${esc(`${e.key} ${e.help} ${e.section}`.toLowerCase())}">
      <div class="cfg-label"><label for="${id}"><code>${esc(e.key)}</code></label>
        ${e.managed ? `<span class="pill">pela aba ${esc(e.managed)}</span>` : ''}
        ${e.help ? `<div class="hint">${esc(e.help)}</div>` : ''}</div>
      <div class="cfg-input">${input}</div>
    </div>`;
}

function drawEditor(box, d, cfg) {
  const sections = new Map();
  for (const e of cfg.entries) {
    if (!sections.has(e.section)) sections.set(e.section, []);
    sections.get(e.section).push(e);
  }
  const original = new Map(cfg.entries.map(e => [String(e.line), e]));
  $('#cfgBody', box).innerHTML = `
    <form id="cfgForm">
      ${[...sections].map(([name, list]) => `
        <details class="cfg-section" ${sections.size === 1 || !name ? 'open' : ''}>
          <summary>${esc(name || 'Geral')} <span class="muted small">(${list.length})</span></summary>
          ${list.map(field).join('')}
        </details>`).join('')}
      <div class="cfg-save">
        <span class="hint" id="cfgChanged">Nenhuma alteração.</span>
        <button type="button" id="cfgReset" class="ghost" hidden>Desfazer</button>
        <button class="primary" id="cfgSaveBtn" disabled>Salvar alterações</button>
      </div>
    </form>
    <p class="hint">As mudanças valem no próximo início do servidor. Comentários e opções que o painel não reconhece ficam como estão no arquivo.</p>`;
  const form = $('#cfgForm', box);
  const changes = () => {
    const out = {};
    for (const el of $$('[data-line]', form)) {
      const e = original.get(el.dataset.line);
      const v = el.type === 'checkbox' ? el.checked : el.value;
      if (e.type === 'bool' ? v !== e.value : String(v) !== String(e.value)) out[el.dataset.line] = v;
    }
    return out;
  };
  const refresh = () => {
    const c = changes();
    const n = Object.keys(c).length;
    $$('.cfg-row', form).forEach(r => r.classList.toggle('changed', Boolean(r.querySelector('[data-line]') && c[r.querySelector('[data-line]').dataset.line] !== undefined)));
    $('#cfgChanged', box).textContent = n ? `${n} alteração(ões) não salva(s).` : 'Nenhuma alteração.';
    $('#cfgSaveBtn', box).disabled = !n;
    $('#cfgReset', box).hidden = !n;
  };
  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);
  $('#cfgReset', box).addEventListener('click', () => drawEditor(box, d, cfg));
  form.addEventListener('submit', act(async ev => {
    ev.preventDefault();
    const r = await api('PUT', instApi(d.id, `/config?path=${encodeURIComponent(cfg.path)}`), { version: cfg.version, changes: changes() });
    toast(`${r.count} opção(ões) salva(s)`, 'ok');
    act(renderConfigEditor)(box.closest('#cfgEditorBox') || box, d);
  }));
  const filter = $('#cfgFilter', box);
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    $$('.cfg-row', form).forEach(r => { r.hidden = Boolean(q) && !r.dataset.search.includes(q); });
    $$('.cfg-section', form).forEach(s => {
      const any = $$('.cfg-row', s).some(r => !r.hidden);
      s.hidden = !any;
      if (q && any) s.open = true;
    });
  });
}
