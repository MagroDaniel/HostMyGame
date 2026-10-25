import { $, $$, act, api, confirmDialog, esc, fmtBytes, icon, instApi, joinPath, openModal, toast } from '../core.js';

// Mods tab: Modrinth (Minecraft mods/plugins) or Steam Workshop (Project Zomboid).
let poll = null;

export async function renderMods(body, d) {
  clearTimeout(poll);
  const data = await api('GET', instApi(d.id, '/mods'));
  if (data.kind === 'modrinth') return renderModrinth(body, d, data);
  if (data.kind === 'workshop') return renderWorkshop(body, d, data);
  body.innerHTML = '<div class="empty-state"><h2>Sem suporte a mods</h2><p>Este servidor não usa mods pelo painel.</p></div>';
}

const fmtCount = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} mi` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} mil` : String(n));
const modIcon = url => (url ? `<img class="mod-icon" src="${esc(url)}" alt="" loading="lazy">` : `<div class="mod-icon">${icon('puzzle')}</div>`);
const stillHere = () => Boolean($('#modsRoot'));

// Re-renders while a background job runs, so progress and results show up without clicking.
function watchJob(body, d, job) {
  if (!job?.running) return;
  poll = setTimeout(() => { if (stillHere()) act(renderMods)(body, d); }, 2500);
}

function jobBanner(job) {
  if (!job) return '';
  if (job.running) return `<div class="notice"><span class="spinner"></span> ${esc(job.label || 'Processando')}…${job.pending > 1 ? ` (+${job.pending - 1} na fila)` : ''} Os detalhes aparecem na aba Console.</div>`;
  if (job.error) return `<div class="notice bad">${esc(job.error)}</div>`;
  return '';
}

// ---------- Minecraft (Modrinth, CurseForge and modpacks) ----------
let mrView = 'installed';
let mrSource = 'modrinth';
let mrSearch = { q: '', hits: [], total: 0, offset: 0 };
let mrUpdates = null;

const SOURCES = { modrinth: 'Modrinth', curseforge: 'CurseForge' };

function sourceSeg(data, current) {
  if (!data.curseforge.available && current === 'modrinth' && mrView !== 'modpacks') return '';
  return `<div class="seg">${Object.entries(SOURCES).map(([k, l]) => `<button type="button" data-src="${k}" class="${current === k ? 'active' : ''}">${l}</button>`).join('')}</div>`;
}

const needKey = () => `<div class="empty-state"><h2>Falta a chave do CurseForge</h2><p>O CurseForge só libera a busca com uma chave pessoal e gratuita. Configure em <a href="#/settings">Configurações → CurseForge</a> (leva um minuto).</p></div>`;

function renderModrinth(body, d, data) {
  const plugins = data.type === 'plugins';
  const vanilla = data.type === 'none';
  const noun = plugins ? 'plugins' : 'mods';
  if (vanilla) mrView = 'modpacks';
  if (mrView === 'browse' && mrSource === 'curseforge' && !data.curseforge.available) mrSource = 'modrinth';
  const installedIds = new Set(data.installed.map(m => m.projectId || (m.cfModId && `cf:${m.cfModId}`)).filter(Boolean));
  const updates = mrUpdates?.id === d.id ? mrUpdates.list : null;
  const updCount = updates ? Object.keys(updates).length : 0;
  body.innerHTML = `
    <div id="modsRoot">
      ${jobBanner(data.job)}
      <div class="mods-head">
        <div>
          <div class="seg big">
            ${vanilla ? '' : `<button data-mview="installed" class="${mrView === 'installed' ? 'active' : ''}">Instalados (${data.installed.length})</button>
            <button data-mview="browse" class="${mrView === 'browse' ? 'active' : ''}">${icon('search')} Procurar ${noun}</button>`}
            ${plugins ? '' : `<button data-mview="modpacks" class="${mrView === 'modpacks' ? 'active' : ''}">${icon('archive')} Modpacks</button>`}
          </div>
          <div class="hint" style="margin-top:6px">${vanilla ? 'O Vanilla não usa mods. Instalar um modpack troca o servidor para o loader do pack (Forge, NeoForge ou Fabric), com backup antes.'
            : `${plugins ? 'Plugins' : 'Mods'} para ${esc(data.loaders[0])}${data.gameVersion ? ` ${esc(data.gameVersion)}` : ''} · pasta <code>${esc(data.folder)}/</code>`}${data.modpack ? ` · modpack: <b>${esc(data.modpack.name)} ${esc(data.modpack.version)}</b>` : ''}</div>
        </div>
        ${vanilla || mrView === 'modpacks' ? '' : `<div class="page-actions">
          <button id="checkUpd">${icon('restart')} Verificar atualizações</button>
          ${updCount ? `<button class="primary" id="updAll">${icon('download')} Atualizar ${updCount}</button>` : ''}
          <button id="uploadJar">${icon('upload')} Enviar .jar</button>
          <input type="file" id="jarInput" accept=".jar" multiple hidden>
        </div>`}
      </div>
      ${vanilla || mrView === 'modpacks' ? '' : `<div class="notice">Instalar, remover ou ativar ${noun} só vale depois de <b>reiniciar o servidor</b>.</div>`}
      <div id="mrBody"></div>
    </div>`;
  const reload = () => act(renderMods)(body, d);
  watchJob(body, d, data.job);
  $$('[data-mview]', body).forEach(b => b.addEventListener('click', () => { mrView = b.dataset.mview; mrSearch.forId = null; reload(); }));
  const box = $('#mrBody');
  if (mrView === 'modpacks') return renderModpacks(box, d, data, reload);
  $('#checkUpd').addEventListener('click', act(async e => {
    e.target.disabled = true;
    const list = await api('GET', instApi(d.id, '/mods/updates'));
    mrUpdates = { id: d.id, list };
    toast(Object.keys(list).length ? `${Object.keys(list).length} atualização(ões) disponível(is)` : 'Tudo atualizado', 'ok');
    reload();
  }));
  $('#updAll')?.addEventListener('click', act(async e => {
    e.target.disabled = true;
    e.target.textContent = 'Atualizando…';
    const r = await api('POST', instApi(d.id, '/mods/update'), {});
    mrUpdates = null;
    toast(`${r.count} atualizado(s)`, 'ok');
    reload();
  }));
  $('#uploadJar').addEventListener('click', () => $('#jarInput').click());
  $('#jarInput').addEventListener('change', act(async e => {
    for (const file of e.target.files) {
      const res = await fetch(instApi(d.id, `/files/upload?path=${encodeURIComponent(joinPath(data.folder, file.name))}`), {
        method: 'PUT', body: file, headers: { 'Content-Type': 'application/octet-stream' },
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `Falha ao enviar ${file.name}`);
    }
    toast('Arquivo(s) enviado(s)', 'ok');
    mrView = 'installed';
    reload();
  }));
  if (mrView === 'installed') renderInstalled(box, d, data, updates, reload);
  else renderBrowse(box, d, data, installedIds, reload);
}

function renderInstalled(box, d, data, updates, reload) {
  if (!data.installed.length) {
    box.innerHTML = `<div class="empty-state"><h2>Nenhum ${data.type === 'plugins' ? 'plugin' : 'mod'} instalado</h2><p>Use "Procurar" para encontrar e instalar com um clique — as dependências vêm junto.</p></div>`;
    return;
  }
  box.innerHTML = `<div class="mod-list">${data.installed.map(m => `
    <div class="mod-row ${m.enabled ? '' : 'off'}" data-file="${esc(m.file)}">
      ${modIcon(m.icon)}
      <div class="mod-text">
        <strong>${m.slug ? `<a href="https://modrinth.com/project/${esc(m.slug)}" target="_blank" rel="noopener">${esc(m.title)}</a>` : m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.title)}</a>` : esc(m.title)}</strong>
        <span class="muted small">${m.version ? `${esc(m.version)} · ` : ''}${esc(m.file)} · ${fmtBytes(m.size)}${m.projectId ? '' : m.source === 'curseforge' ? ' · CurseForge' : data.modpack ? ' · do modpack' : ' · enviado manualmente'}</span>
      </div>
      ${updates?.[m.file] ? `<button class="small primary" data-act="update" title="Atualizar para ${esc(updates[m.file].version)}">${icon('download')} ${esc(updates[m.file].version)}</button>` : ''}
      <label class="switch" title="${m.enabled ? 'Desativar' : 'Ativar'}"><input type="checkbox" data-act="toggle" ${m.enabled ? 'checked' : ''}><span></span></label>
      <button class="small ghost" data-act="remove" title="Remover">${icon('trash')}</button>
    </div>`).join('')}</div>`;
  $$('.mod-row', box).forEach(row => row.addEventListener('click', act(async e => {
    const action = e.target.closest('[data-act]')?.dataset.act;
    const file = row.dataset.file;
    if (action === 'toggle') { await api('POST', instApi(d.id, '/mods/toggle'), { file }); return reload(); }
    if (action === 'update') {
      e.target.closest('button').disabled = true;
      await api('POST', instApi(d.id, '/mods/update'), { file });
      if (mrUpdates) delete mrUpdates.list[file];
      toast('Atualizado', 'ok');
      return reload();
    }
    if (action === 'remove' && await confirmDialog(`Remover ${file}?`, { danger: true, okText: 'Remover' })) {
      await api('DELETE', instApi(d.id, `/mods?file=${encodeURIComponent(file)}`));
      reload();
    }
  })));
}

// Search grid shared by mods and modpacks. `endpoint` returns { hits, total }; `button(hit)` renders the action.
function searchGrid(box, d, { key, placeholder, endpoint, button, onButton, reload, data }) {
  box.innerHTML = `
    <form class="mods-search" id="mrForm">${sourceSeg(data, mrSource)}<input name="q" value="${esc(mrSearch.q)}" placeholder="${esc(placeholder)}" autocomplete="off"><button class="primary">${icon('search')} Buscar</button></form>
    <div class="mod-grid" id="mrHits"></div>
    <div style="text-align:center;margin-top:14px"><button id="mrMore" hidden>Carregar mais</button></div>`;
  $$('[data-src]', box).forEach(b => b.addEventListener('click', () => { mrSource = b.dataset.src; mrSearch.forId = null; reload(); }));
  if (mrSource === 'curseforge' && !data.curseforge.hasKey) { $('#mrHits').outerHTML = needKey(); return; }
  const draw = () => {
    $('#mrHits').innerHTML = mrSearch.hits.map(h => `
      <div class="mod-card">
        <div class="mod-card-head">${modIcon(h.icon)}<div class="mod-text"><strong><a href="${esc(h.url || `https://modrinth.com/project/${h.slug}`)}" target="_blank" rel="noopener">${esc(h.title)}</a></strong><span class="muted small">por ${esc(h.author)} · ${icon('download')} ${fmtCount(h.downloads)}</span></div></div>
        <p>${esc(h.description)}</p>
        ${button(h)}
      </div>`).join('') || '<p class="muted">Nada encontrado.</p>';
    $('#mrMore').hidden = mrSearch.hits.length >= mrSearch.total;
    $$('[data-pick]', box).forEach(b => b.addEventListener('click', act(() => onButton(b, mrSearch.hits.find(h => h.id === b.dataset.pick)))));
  };
  const run = act(async (more = false) => {
    const offset = more ? mrSearch.hits.length : 0;
    const r = await api('GET', instApi(d.id, `${endpoint}?source=${mrSource}&q=${encodeURIComponent(mrSearch.q)}&offset=${offset}`));
    mrSearch = { ...mrSearch, hits: more ? [...mrSearch.hits, ...r.hits] : r.hits, total: r.total };
    draw();
  });
  $('#mrForm').addEventListener('submit', e => { e.preventDefault(); mrSearch.q = e.target.q.value.trim(); run(); });
  $('#mrMore').addEventListener('click', () => run(true));
  const forId = `${d.id}|${key}|${mrSource}`;
  if (mrSearch.forId !== forId) { mrSearch = { q: '', hits: [], total: 0, forId }; run(); } else draw();
}

function renderBrowse(box, d, data, installedIds, reload) {
  const plugins = data.type === 'plugins';
  searchGrid(box, d, {
    key: 'mods', data, reload, endpoint: '/mods/search',
    placeholder: `Buscar ${plugins ? 'plugins' : 'mods'} no ${SOURCES[mrSource]} (vazio = mais populares)…`,
    button: h => (installedIds.has(mrSource === 'curseforge' ? `cf:${h.id}` : h.id)
      ? '<button class="small" disabled>Instalado</button>'
      : `<button class="small primary" data-pick="${esc(h.id)}">${icon('plus')} Instalar</button>`),
    onButton: async b => {
      b.disabled = true;
      b.textContent = 'Instalando…';
      try {
        const r = await api('POST', instApi(d.id, `/mods/install?source=${mrSource}`), { projectId: b.dataset.pick });
        toast(`Instalado: ${r.added.join(', ')}`, 'ok', 7000);
        installedIds.add(mrSource === 'curseforge' ? `cf:${b.dataset.pick}` : b.dataset.pick);
        b.textContent = 'Instalado';
      } catch (e) { b.disabled = false; b.innerHTML = `${icon('plus')} Instalar`; throw e; }
    },
  });
}

// ---------- modpacks ----------
const LOADER_LABEL = { forge: 'Forge', neoforge: 'NeoForge', fabric: 'Fabric', quilt: 'Quilt' };

function renderModpacks(box, d, data, reload) {
  const current = data.modpack;
  box.innerHTML = `
    ${current ? `<div class="card modpack-current">
      ${modIcon(current.icon)}
      <div class="mod-text"><strong>${current.url ? `<a href="${esc(current.url)}" target="_blank" rel="noopener">${esc(current.name)}</a>` : esc(current.name)}</strong>
        <span class="muted small">Versão instalada: ${esc(current.version)} · ${SOURCES[current.source]}</span></div>
      <span id="packUpd"><button class="small" id="packCheck">${icon('restart')} Verificar atualização</button></span>
    </div>` : ''}
    <div class="notice warn">Instalar um modpack <b>substitui a pasta mods/</b> e troca o loader e a versão do Minecraft para os do pack. Antes disso o painel faz um backup completo; o mundo é mantido.</div>
    <div id="packSearch"></div>`;
  $('#packCheck')?.addEventListener('click', act(async e => {
    e.target.disabled = true;
    const { next } = await api('GET', instApi(d.id, `/modpacks/update?source=${current.source}`));
    $('#packUpd').innerHTML = next
      ? `<button class="small primary" id="packUpdate">${icon('download')} Atualizar para ${esc(next.name)}</button>`
      : '<span class="muted small">Está na versão mais recente.</span>';
    $('#packUpdate')?.addEventListener('click', act(() => confirmPack(d, { source: current.source, id: current.projectId, title: current.name }, next, reload)));
  }));
  searchGrid($('#packSearch'), d, {
    key: 'packs', data, reload, endpoint: '/modpacks/search',
    placeholder: `Buscar modpacks no ${SOURCES[mrSource]} (vazio = mais populares)…`,
    button: h => `<button class="small primary" data-pick="${esc(h.id)}">${icon('download')} Instalar modpack</button>`,
    onButton: (b, hit) => choosePackVersion(d, { ...hit, source: mrSource }, reload),
  });
}

async function choosePackVersion(d, pack, reload) {
  const list = await api('GET', instApi(d.id, `/modpacks/versions?source=${pack.source}&project=${encodeURIComponent(pack.id)}`));
  const usable = list.filter(v => v.loader !== 'quilt');
  if (!usable.length) throw new Error('Este modpack não tem versões que o painel consiga instalar');
  const { el, close } = openModal(`
    <div class="modal-head"><h2>${esc(pack.title)}</h2><button class="icon-btn" data-close aria-label="Fechar">✕</button></div>
    <label>Versão do modpack
      <select id="packVer">${usable.map(v => `<option value="${esc(v.id)}">${esc(v.name)}${v.gameVersion ? ` · MC ${esc(v.gameVersion)}` : ''}${v.loader ? ` · ${esc(LOADER_LABEL[v.loader] || v.loader)}` : ''}${v.serverPack ? ' · server pack' : ''}</option>`).join('')}</select>
    </label>
    <p class="hint">A mais recente vem primeiro. "server pack" = o autor publicou uma versão própria para servidor (mais confiável).</p>
    <div class="modal-actions"><button data-close>Cancelar</button><button class="primary" id="packGo">Continuar</button></div>`);
  $('#packGo', el).addEventListener('click', act(async () => {
    const v = usable.find(x => x.id === $('#packVer', el).value);
    close();
    await confirmPack(d, pack, v, reload);
  }));
}

async function confirmPack(d, pack, version, reload) {
  const ok = await confirmDialog(`Instalar ${pack.title} (${version.name})? O servidor vai virar ${LOADER_LABEL[version.loader] || 'o loader do pack'}${version.gameVersion ? ` ${version.gameVersion}` : ''}, a pasta mods/ será substituída e um backup completo é feito antes. Pode levar vários minutos.`, { okText: 'Instalar modpack' });
  if (!ok) return;
  await api('POST', instApi(d.id, `/modpacks/install?source=${pack.source}`), { projectId: pack.id, versionId: version.id, name: pack.title, versionName: version.name });
  toast('Instalando o modpack. O progresso aparece na aba Console.', 'ok', 8000);
  reload();
}

// ---------- Steam Workshop (Project Zomboid) ----------
let wsView = 'browse';
let wsSearch = { forId: null, q: '', sort: 'popular', build: 'auto', page: 1, hits: [], total: 0, tag: '' };
const wsQueued = new Set(); // items the user clicked "Instalar" on that aren't in the server list yet

const WS_SORTS = [['popular', 'Mais inscritos'], ['trend', 'Em alta'], ['recent', 'Mais recentes'], ['updated', 'Atualizados recentemente']];
const WS_BUILDS = [['auto', 'Build do servidor'], ['Build 42', 'Build 42'], ['Build 41', 'Build 41'], ['all', 'Todos os builds']];

function renderWorkshop(body, d, data) {
  if (wsSearch.forId !== d.id) { wsSearch = { forId: d.id, q: '', sort: 'popular', build: 'auto', page: 1, hits: [], total: 0, tag: '' }; wsQueued.clear(); }
  const installedIds = new Set(data.items.map(i => i.id));
  for (const id of [...wsQueued]) if (installedIds.has(id)) wsQueued.delete(id);
  if (!data.job?.running) wsQueued.clear();
  if (!data.iniExists) wsView = 'installed';
  body.innerHTML = `
    <div id="modsRoot">
      <div class="mods-head">
        <div>
          <div class="seg big">
            <button data-wview="installed" class="${wsView === 'installed' ? 'active' : ''}">Instalados (${data.items.length})</button>
            <button data-wview="browse" class="${wsView === 'browse' ? 'active' : ''}" ${data.iniExists ? '' : 'disabled'}>${icon('search')} Procurar na Oficina</button>
          </div>
          <div class="hint" style="margin-top:6px">Oficina Steam do Project Zomboid · servidor ${data.b42 ? 'Build 42' : 'Build 41'}</div>
        </div>
        <div class="page-actions">
          ${data.items.length ? `<button id="wsUpdate" ${data.job?.running ? 'disabled' : ''}>${icon('restart')} Baixar atualizações</button>` : ''}
          <a class="button" href="https://steamcommunity.com/app/108600/workshop/" target="_blank" rel="noopener">${icon('network')} Abrir no Steam</a>
        </div>
      </div>
      <div id="wsJob">${jobBanner(data.job)}</div>
      ${!data.iniExists ? '<div class="notice warn">O arquivo de configuração do servidor ainda não existe. <b>Inicie o servidor uma vez</b> (pode parar logo depois do "SERVER STARTED") e volte aqui para adicionar mods.</div>' : ''}
      <div id="wsBody"></div>
    </div>`;
  const reload = () => act(renderMods)(body, d);
  $$('[data-wview]', body).forEach(b => b.addEventListener('click', () => { wsView = b.dataset.wview; reload(); }));
  $('#wsUpdate')?.addEventListener('click', act(async () => {
    await api('POST', instApi(d.id, '/mods/workshop/update'));
    reload();
  }));
  const box = $('#wsBody');
  if (wsView === 'browse') renderWorkshopBrowse(box, body, d, data, installedIds);
  else renderWorkshopInstalled(box, d, data, reload);
}

// While downloads run, refresh just the banner and buttons in the search view (no new search).
function watchBrowse(body, d) {
  clearTimeout(poll);
  poll = setTimeout(act(async () => {
    if (!stillHere() || wsView !== 'browse') return;
    const data = await api('GET', instApi(d.id, '/mods'));
    if (!stillHere() || wsView !== 'browse') return;
    const installedIds = new Set(data.items.map(i => i.id));
    for (const id of [...wsQueued]) if (installedIds.has(id)) wsQueued.delete(id);
    if (!data.job?.running) wsQueued.clear();
    $('#wsJob').innerHTML = jobBanner(data.job);
    const tab = $('[data-wview=installed]');
    if (tab) tab.textContent = `Instalados (${data.items.length})`;
    drawWorkshopHits(d, installedIds);
    if (data.job?.running) watchBrowse(body, d);
  }), 2500);
}

function wsButton(h, installedIds) {
  if (installedIds.has(h.id)) return `<button class="small" disabled>${icon('puzzle')} Instalado</button>`;
  if (wsQueued.has(h.id)) return '<button class="small" disabled><span class="spinner"></span> Baixando…</button>';
  return `<button class="small primary" data-wsinstall="${esc(h.id)}">${icon('plus')} Instalar</button>`;
}

function drawWorkshopHits(d, installedIds) {
  const grid = $('#wsHits');
  if (!grid) return;
  const serverBuild = wsSearch.tag || '';
  grid.innerHTML = wsSearch.hits.map(h => {
    const builds = h.tags.filter(t => /^Build \d+/.test(t));
    return `
      <div class="mod-card ws-card">
        <div class="mod-card-head">
          ${h.preview ? `<img class="ws-preview" src="${esc(h.preview)}" alt="" loading="lazy">` : `<div class="ws-preview">${icon('puzzle')}</div>`}
          <div class="mod-text">
            <strong title="${esc(h.title)}"><a href="https://steamcommunity.com/sharedfiles/filedetails/?id=${esc(h.id)}" target="_blank" rel="noopener">${esc(h.title)}</a></strong>
            <span class="muted small">${icon('users')} ${fmtCount(h.subscriptions)} inscritos${h.size ? ` · ${fmtBytes(h.size)}` : ''}</span>
            <div class="ws-tags">${builds.map(b => `<span class="pill ${!serverBuild || b === serverBuild ? 'good' : 'warn'}">${esc(b)}</span>`).join('')}</div>
          </div>
        </div>
        <p>${esc(h.description) || '<span class="muted">Sem descrição.</span>'}</p>
        ${wsButton(h, installedIds)}
      </div>`;
  }).join('') || '<p class="muted">Nada encontrado. Tente outro nome ou mude o filtro de build.</p>';
  $('#wsPager').innerHTML = wsSearch.total > 30 ? `
    <button data-page="-1" ${wsSearch.page <= 1 ? 'disabled' : ''}>‹ Anterior</button>
    <span class="muted small">Página ${wsSearch.page} de ${Math.ceil(wsSearch.total / 30)} · ${wsSearch.total.toLocaleString('pt-BR')} itens</span>
    <button data-page="1" ${wsSearch.page * 30 >= wsSearch.total ? 'disabled' : ''}>Próxima ›</button>` : '';
}

function renderWorkshopBrowse(box, body, d, data, installedIds) {
  box.innerHTML = `
    <form class="mods-search ws-search" id="wsSearchForm">
      <input name="q" value="${esc(wsSearch.q)}" placeholder="Buscar mods por nome…" autocomplete="off">
      <select name="sort" aria-label="Ordenar">${WS_SORTS.map(([k, l]) => `<option value="${k}" ${wsSearch.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select name="build" aria-label="Build">${WS_BUILDS.map(([k, l]) => `<option value="${k}" ${wsSearch.build === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="primary">${icon('search')} Buscar</button>
    </form>
    <div class="mod-grid" id="wsHits"><p class="muted"><span class="spinner"></span> Carregando a Oficina…</p></div>
    <div class="pager" id="wsPager"></div>
    <p class="hint">Resultados da Oficina Steam. Ao clicar em Instalar, o painel baixa o mod e já o ativa na configuração do servidor. Coleções podem ser adicionadas por link na aba Instalados.</p>`;
  const run = act(async () => {
    $('#wsHits').innerHTML = '<p class="muted"><span class="spinner"></span> Carregando a Oficina…</p>';
    const qs = new URLSearchParams({ q: wsSearch.q, sort: wsSearch.sort, build: wsSearch.build, page: wsSearch.page });
    const r = await api('GET', instApi(d.id, `/mods/workshop/search?${qs}`));
    Object.assign(wsSearch, { hits: r.hits, total: r.total, tag: r.tag });
    for (const h of r.hits) if (h.installed) installedIds.add(h.id);
    drawWorkshopHits(d, installedIds);
  });
  const form = $('#wsSearchForm');
  form.addEventListener('submit', e => {
    e.preventDefault();
    Object.assign(wsSearch, { q: form.q.value.trim(), sort: form.sort.value, build: form.build.value, page: 1 });
    run();
  });
  form.sort.addEventListener('change', () => form.requestSubmit());
  form.build.addEventListener('change', () => form.requestSubmit());
  $('#wsPager').addEventListener('click', e => {
    const b = e.target.closest('[data-page]');
    if (!b) return;
    wsSearch.page = Math.max(1, wsSearch.page + Number(b.dataset.page));
    run();
    $('#wsSearchForm').scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  $('#wsHits').addEventListener('click', act(async e => {
    const b = e.target.closest('[data-wsinstall]');
    if (!b) return;
    const id = b.dataset.wsinstall;
    wsQueued.add(id);
    b.outerHTML = '<button class="small" disabled><span class="spinner"></span> Baixando…</button>';
    try {
      await api('POST', instApi(d.id, '/mods/workshop'), { input: id });
    } catch (err) {
      wsQueued.delete(id);
      drawWorkshopHits(d, installedIds);
      throw err;
    }
    $('#wsJob').innerHTML = jobBanner({ running: true, label: 'Adicionando mods da Oficina', pending: wsQueued.size });
    watchBrowse(body, d);
  }));
  if (wsSearch.hits.length) drawWorkshopHits(d, installedIds); else run();
  if (data.job?.running) watchBrowse(body, d);
}

function renderWorkshopInstalled(box, d, data, reload) {
  const busy = data.job?.running;
  const enabled = data.mods.map(m => m.id);
  const buildTag = data.b42 ? 'Build 42' : 'Build 41';
  box.innerHTML = `
    ${data.items.length ? `
    <div class="notice">Mudanças nos mods só valem depois de <b>reiniciar o servidor</b>. Ao iniciar, o servidor também confere se há versões novas na Oficina.</div>
    <div class="ws-layout">
      <div class="mod-list">${data.items.map(it => workshopItem(it, buildTag)).join('')}</div>
      <div class="card load-order">
        <h3>Ordem de carregamento</h3>
        ${enabled.length ? `<ol>${data.mods.map((m, i) => `
          <li data-mod="${esc(m.id)}"><span class="${m.known ? '' : 'muted'}" title="${m.known ? '' : 'Não pertence a nenhum item da lista'}">${esc(m.id)}</span>
            <span class="order-btns"><button class="small ghost" data-move="-1" ${i === 0 ? 'disabled' : ''} aria-label="Subir">▲</button><button class="small ghost" data-move="1" ${i === enabled.length - 1 ? 'disabled' : ''} aria-label="Descer">▼</button></span></li>`).join('')}</ol>`
          : '<p class="muted">Nenhum mod ativo.</p>'}
        <p class="hint">Bibliotecas e frameworks devem vir antes dos mods que dependem delas.</p>
        ${data.maps.length ? `<h3 style="margin-top:16px">Mapas</h3><ol>${data.maps.map(m => `<li>${esc(m)}</li>`).join('')}<li class="muted">Muldraugh, KY (padrão)</li></ol>` : ''}
      </div>
    </div>` : (data.iniExists ? '<div class="empty-state"><h2>Nenhum mod ainda</h2><p>Use "Procurar na Oficina" para encontrar mods e instalar com um clique, ou cole links abaixo.</p></div>' : '')}
    <details class="card advanced-add" ${data.items.length ? '' : 'open'}>
      <summary>${icon('plus')}<span>Adicionar por link (itens ou coleções inteiras)</span></summary>
      <form id="wsForm" class="form" style="margin-top:12px">
        <textarea name="input" rows="3" aria-label="Links da Oficina" placeholder="Cole aqui links de itens ou de coleções da Oficina, um por linha" ${data.iniExists && !busy ? '' : 'disabled'}></textarea>
        <div style="display:flex;justify-content:flex-end"><button class="primary" ${data.iniExists && !busy ? '' : 'disabled'}>${icon('plus')} Adicionar</button></div>
      </form>
    </details>`;
  watchJob(box.closest('#tabBody') || box, d, data.job);
  $('#wsForm').addEventListener('submit', act(async e => {
    e.preventDefault();
    await api('POST', instApi(d.id, '/mods/workshop'), { input: e.target.input.value });
    toast('Baixando os itens… isso pode levar alguns minutos.', 'ok');
    reload();
  }));
  const saveActive = async (mods, maps) => {
    await api('PUT', instApi(d.id, '/mods/workshop'), { mods, maps });
    reload();
  };
  $$('[data-modtoggle]', box).forEach(cb => cb.addEventListener('change', act(async () => {
    const id = cb.dataset.modtoggle;
    await saveActive(cb.checked ? [...enabled, id] : enabled.filter(m => m !== id));
  })));
  $$('[data-maptoggle]', box).forEach(cb => cb.addEventListener('change', act(async () => {
    const m = cb.dataset.maptoggle;
    await saveActive(undefined, cb.checked ? [m, ...data.maps] : data.maps.filter(x => x !== m));
  })));
  $$('[data-move]', box).forEach(b => b.addEventListener('click', act(async () => {
    const id = b.closest('[data-mod]').dataset.mod;
    const i = enabled.indexOf(id), j = i + Number(b.dataset.move);
    const next = [...enabled];
    [next[i], next[j]] = [next[j], next[i]];
    await saveActive(next);
  })));
  $$('[data-wsremove]', box).forEach(b => b.addEventListener('click', act(async () => {
    const it = data.items.find(x => x.id === b.dataset.wsremove);
    if (!(await confirmDialog(`Remover "${it.title}" do servidor? Os Mod IDs e mapas dele também saem da configuração.`, { danger: true, okText: 'Remover' }))) return;
    await api('DELETE', instApi(d.id, `/mods/workshop/${it.id}?files=1`));
    reload();
  })));
}

function workshopItem(it, buildTag) {
  const builds = it.tags.filter(t => /^Build \d+/.test(t));
  const wrongBuild = builds.length && !builds.includes(buildTag);
  return `
    <div class="ws-item">
      <div class="ws-item-head">
        ${it.preview ? `<img class="ws-preview" src="${esc(it.preview)}" alt="" loading="lazy">` : `<div class="ws-preview">${icon('puzzle')}</div>`}
        <div class="mod-text">
          <strong><a href="https://steamcommunity.com/sharedfiles/filedetails/?id=${esc(it.id)}" target="_blank" rel="noopener">${esc(it.title)}</a></strong>
          <span class="muted small">ID ${esc(it.id)}${it.size ? ` · ${fmtBytes(it.size)}` : ''}${it.downloaded ? '' : ' · ainda não baixado'}</span>
          <div class="ws-tags">${builds.map(b => `<span class="pill ${wrongBuild ? 'warn' : 'good'}">${esc(b)}</span>`).join('')}${wrongBuild ? `<span class="hint err">Feito para ${esc(builds.join('/'))} — pode não funcionar no seu servidor (${esc(buildTag)})</span>` : ''}</div>
        </div>
        <button class="small ghost" data-wsremove="${esc(it.id)}" title="Remover">${icon('trash')}</button>
      </div>
      ${it.mods.length || it.maps.length ? `<div class="ws-mods">
        ${it.mods.map(m => `
          <label class="check"><input type="checkbox" data-modtoggle="${esc(m.id)}" ${m.enabled ? 'checked' : ''}> <span><b>${esc(m.id)}</b>${m.name !== m.id ? ` <span class="muted">— ${esc(m.name)}</span>` : ''}
          ${m.enabled && m.missing.length ? `<br><span class="hint err">Precisa de: ${m.missing.map(esc).join(', ')} (adicione o item que fornece esse mod)</span>` : ''}</span></label>`).join('')}
        ${it.maps.map(m => `<label class="check"><input type="checkbox" data-maptoggle="${esc(m.name)}" ${m.enabled ? 'checked' : ''}> <span>${icon('network')} Mapa <b>${esc(m.name)}</b></span></label>`).join('')}
      </div>` : `<div class="ws-mods muted small">${it.downloaded ? 'Nenhum mod.info encontrado neste item.' : 'Os Mod IDs aparecem depois do download.'}</div>`}
    </div>`;
}
