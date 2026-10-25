import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { ROOT, VERSION, db, instancesRoot, save } from './store.js';
import * as auth from './auth.js';
import * as files from './files.js';
import * as manager from './manager.js';
import { catalogList } from './catalog.js';
import { ACTIONS, runTask, stepLabel } from './scheduler.js';
import { backupFile, createBackup, deleteBackup, listBackups, restoreBackup, setBackupLock } from './backups.js';
import { stopSampler, systemInfo, systemUsage } from './metrics.js';
import { readActivity, record } from './activity.js';
import { openFirewall } from './network.js';
import { checkUpdates, lastUpdateCheck } from './updates.js';
import { applyPanelUpdate, checkPanelUpdate, panelUpdateState } from './selfupdate.js';
import { OVERRIDABLE } from './instance.js';
import { login as steamLogin } from './providers/depotdownloader.js';
import { httpError } from './util.js';
import * as mods from './mods/index.js';
import { fixIssue } from './issues.js';
import { getPlayers, playerAction, playersKind } from './players.js';
import { editableFiles, readConfig, writeConfig } from './configeditor.js';

const HOST = process.env.HOST || db.host;
const PORT = Number(process.env.PORT || db.port);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(ROOT, 'public')));

// Lets async route handlers throw (including httpError) and reach the error middleware.
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Long operations run in the background; their progress and errors show up in the instance console.
const background = (inst, promise) => promise.catch(e => inst.print(`Erro: ${e.message}`, 'panel'));

const log = (req, action, target, detail) => record(req.viaApiKey ? `${req.user} (API)` : req.user, action, target, detail, req.inst?.cfg.id);

// ---------- authentication ----------
app.get('/api/auth/state', (req, res) => {
  const user = auth.sessionUser(req);
  res.json({ setup: auth.needsSetup(), user: user && auth.getUser(user), version: VERSION });
});

app.post('/api/auth/setup', h(async (req, res) => {
  if (!auth.needsSetup()) return res.status(403).json({ error: 'O painel já foi configurado' });
  await auth.createUser(req.body.username, req.body.password, 'admin');
  auth.setSessionCookie(res, await auth.login(req.body.username, req.body.password, req.ip));
  record(req.body.username, 'criou a conta de administrador');
  res.json({ ok: true });
}));

app.post('/api/auth/login', h(async (req, res) => {
  const username = String(req.body.username || '');
  try {
    auth.setSessionCookie(res, await auth.login(username, req.body.password, req.ip, req.body.code));
  } catch (e) {
    if (e.needCode) return res.status(401).json({ error: e.message, needCode: true });
    if (e.status === 401) record(username, 'falha de login', '', req.ip);
    throw e;
  }
  record(username, 'entrou', '', req.ip);
  res.json({ ok: true });
}));

app.post('/api/auth/recover/start', (req, res) => {
  if (auth.needsSetup()) return res.status(400).json({ error: 'O painel ainda não tem contas' });
  const file = auth.startRecovery();
  record('(recuperação)', 'pediu código de recuperação de senha', '', req.ip);
  res.json({ file });
});

app.post('/api/auth/recover/finish', h(async (req, res) => {
  const username = await auth.finishRecovery(req.body.username, req.body.code, req.body.password, Boolean(req.body.disableTotp));
  record(username, req.body.disableTotp ? 'redefiniu a senha e desativou a verificação em duas etapas pela recuperação' : 'redefiniu a senha pela recuperação', '', req.ip);
  res.json({ ok: true });
}));

app.post('/api/auth/logout', (req, res) => {
  const user = auth.sessionUser(req);
  if (user) record(user, 'saiu');
  auth.endSession(req, res);
  res.json({ ok: true });
});

const api = express.Router();
api.use(auth.requireAuth);
app.use('/api', api);
const admin = auth.requireAdmin;

const session = auth.requireSession;
api.post('/auth/password', session, h(async (req, res) => {
  await auth.changePassword(req.user, req.body.current, req.body.next);
  log(req, 'trocou a própria senha');
  res.json({ ok: true });
}));
api.post('/auth/totp/setup', session, h(async (req, res) => res.json(await auth.beginTotp(req.user))));
api.post('/auth/totp/confirm', session, (req, res) => {
  const recoveryCodes = auth.confirmTotp(req.user, req.body.code);
  log(req, 'ativou a verificação em duas etapas');
  res.json({ ok: true, recoveryCodes });
});
api.post('/auth/totp/recovery', session, (req, res) => {
  const recoveryCodes = auth.regenerateRecoveryCodes(req.user);
  log(req, 'gerou novos códigos de recuperação');
  res.json({ recoveryCodes });
});
api.get('/auth/apikeys', session, (req, res) => res.json(auth.listApiKeys(req.user)));
api.post('/auth/apikeys', session, (req, res) => {
  const key = auth.createApiKey(req.user, req.body.name);
  log(req, 'criou chave de API', req.body.name);
  res.json(key);
});
api.delete('/auth/apikeys/:id', session, (req, res) => {
  auth.deleteApiKey(req.user, req.params.id);
  log(req, 'apagou chave de API', req.params.id);
  res.json({ ok: true });
});
api.post('/auth/totp/disable', session, h(async (req, res) => {
  await auth.disableTotp(req.user, req.body.password);
  log(req, 'desativou a verificação em duas etapas');
  res.json({ ok: true });
}));

// ---------- users ----------
api.get('/users', admin, (req, res) => res.json({ users: auth.listUsers(), permissions: auth.PERMISSIONS }));
api.post('/users', admin, h(async (req, res) => {
  await auth.createUser(req.body.username, req.body.password, req.body.role, req.body.access);
  log(req, 'criou usuário', req.body.username, req.body.role);
  res.json({ ok: true });
}));
api.patch('/users/:name', admin, h(async (req, res) => {
  const { name } = req.params;
  if (req.body.role || req.body.access) auth.updateUser(name, req.body);
  if (req.body.password) await auth.resetPassword(name, req.body.password);
  if (req.body.disableTotp) auth.adminDisableTotp(name);
  log(req, 'alterou usuário', name, Object.keys(req.body).join(', '));
  res.json({ ok: true });
}));
api.delete('/users/:name', admin, (req, res) => {
  if (req.params.name === req.user) return res.status(400).json({ error: 'Você não pode excluir a si mesmo' });
  auth.deleteUser(req.params.name);
  log(req, 'excluiu usuário', req.params.name);
  res.json({ ok: true });
});

// ---------- panel ----------
api.get('/system', (req, res) => res.json({ ...systemInfo(), ...systemUsage() }));

api.get('/panel', admin, (req, res) => res.json({
  host: db.host, port: db.port, instancesDir: instancesRoot(), steamUser: db.steamUser, version: VERSION,
  lastUpdateCheck: lastUpdateCheck(), system: systemInfo(),
}));
api.patch('/panel', admin, (req, res) => {
  const { host, port, instancesDir } = req.body;
  if (host !== undefined) {
    if (!['127.0.0.1', '0.0.0.0'].includes(host) && !/^[\d.]+$/.test(host)) throw httpError(400, 'Endereço inválido');
    db.host = host;
  }
  if (port !== undefined) {
    const p = Number(port);
    if (!(p >= 1 && p <= 65535)) throw httpError(400, 'Porta inválida');
    db.port = p;
  }
  if (instancesDir !== undefined) {
    if (instancesDir && !path.isAbsolute(instancesDir)) throw httpError(400, 'Use um caminho completo');
    db.instancesDir = instancesDir;
  }
  save();
  log(req, 'alterou configurações do painel', '', JSON.stringify(req.body));
  res.json({ ok: true, restartNeeded: host !== undefined || port !== undefined });
});

api.get('/activity', admin, (req, res) => res.json(readActivity({
  limit: Math.min(Number(req.query.limit) || 300, 2000), user: req.query.user || undefined, search: req.query.search || undefined,
})));

// ---------- Steam account (DepotDownloader login: QR code or password + Steam Guard) ----------
const steam = { proc: null, log: [], running: false, qr: null };
const toAdmins = message => broadcast(message, u => auth.isAdmin(u));
const steamPrint = text => {
  steam.log.push({ t: Date.now(), text });
  if (steam.log.length > 300) steam.log.shift();
  toAdmins({ type: 'steam', entry: { t: Date.now(), text } });
};
const setSteamQr = qr => { steam.qr = qr; toAdmins({ type: 'steamqr', qr }); };

api.get('/steam', admin, (req, res) => res.json({ user: db.steamUser, running: steam.running, log: steam.log, qr: steam.qr }));
api.post('/steam/login', admin, (req, res) => {
  const qr = Boolean(req.body.qr);
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!qr && (!username || !password)) throw httpError(400, 'Informe usuário e senha da Steam, ou entre com o QR code');
  if (steam.running) throw httpError(409, 'Já existe um login em andamento');
  steam.running = true;
  steam.log = [];
  setSteamQr(null);
  steamPrint(qr ? 'Gerando o QR code...' : `Entrando como ${username}... Se a Steam pedir, aprove no app do celular ou digite o código do Steam Guard abaixo.`);
  steamLogin({
    username: qr ? null : username, password: qr ? null : password,
    log: steamPrint, onQr: setSteamQr, onSpawn: child => { steam.proc = child; },
  }).then(account => {
    db.steamUser = account;
    save();
    steamPrint(`Conectado como ${account}. A sessão fica salva neste PC para os próximos downloads.`);
    record(req.user, 'conectou conta Steam', account);
  }).catch(e => steamPrint(`Erro: ${e.message}`)).finally(() => {
    steam.running = false;
    steam.proc = null;
    setSteamQr(null);
    toAdmins({ type: 'steamdone', user: db.steamUser });
  });
  res.json({ ok: true });
});
api.post('/steam/cancel', admin, (req, res) => {
  steam.proc?.kill();
  res.json({ ok: true });
});
api.post('/steam/input', admin, (req, res) => {
  if (!steam.proc) throw httpError(409, 'Nenhum login em andamento');
  steam.proc.stdin.write(String(req.body.text || '') + '\n');
  steamPrint('> (código enviado)');
  res.json({ ok: true });
});
api.post('/steam/logout', admin, (req, res) => {
  db.steamUser = '';
  save();
  log(req, 'desconectou conta Steam');
  res.json({ ok: true });
});

// ---------- catalog ----------
api.get('/catalog', (req, res) => res.json({ games: catalogList(), actions: ACTIONS }));

// ---------- instances ----------
const visible = req => [...manager.instances.values()].filter(i => auth.can(req.account, i.cfg.id));

api.get('/instances', (req, res) => res.json(visible(req).map(i => i.status())));

api.post('/instances', admin, (req, res) => {
  const inst = manager.createInstance(req.body);
  log(req, 'criou instância', inst.cfg.name, inst.template.name);
  const after = req.body.afterCreate || 'none';
  if (after === 'installStartAlways') { inst.cfg.updateOnStart = true; save(); }
  if (after !== 'none' && inst.template.provider !== 'generic') {
    background(inst, (async () => {
      await inst.install();
      if (after !== 'install') await inst.start({ skipUpdate: true });
    })());
  }
  res.json(inst.status());
});

api.param('id', (req, res, next, id) => {
  try {
    req.inst = manager.getInstance(id);
    if (!auth.can(req.account, id)) throw httpError(404, 'Instância não encontrada');
    next();
  } catch (e) { next(e); }
});
const perm = p => (req, res, next) => (auth.can(req.account, req.inst.cfg.id, p) ? next() : res.status(403).json({ error: 'Você não tem permissão para isso' }));

api.get('/instances/:id', h(async (req, res) => {
  const inst = req.inst;
  const t = inst.template;
  res.json({
    ...inst.status(),
    config: inst.cfg,
    template: { id: t.id, name: t.name, provider: t.provider, custom: Boolean(t.custom), notes: t.notes, description: t.description, settings: t.settings, configFiles: t.configFiles.map(f => inst.expand(f)), steam: t.steam },
    effective: Object.fromEntries(OVERRIDABLE.map(k => [k, inst.effective(k)])),
    warnings: await manager.portWarnings(inst),
    history: inst.history,
    permissions: Object.fromEntries(Object.keys(auth.PERMISSIONS).map(p => [p, auth.can(req.account, inst.cfg.id, p)])),
    isAdmin: auth.isAdmin(req.account),
    mods: mods.modKind(inst),
    players: playersKind(inst),
    editableConfigs: editableFiles(inst),
  });
}));

api.patch('/instances/:id', perm('settings'), (req, res) => {
  manager.updateInstance(req.inst, req.body);
  log(req, 'alterou configurações', req.inst.cfg.name);
  res.json({ ok: true });
});
api.delete('/instances/:id', admin, (req, res) => {
  manager.deleteInstance(req.inst, req.query.files === '1');
  log(req, 'excluiu instância', req.inst.cfg.name, req.query.files === '1' ? 'com arquivos' : 'manteve arquivos');
  res.json({ ok: true });
});

api.post('/instances/:id/start', perm('control'), (req, res) => {
  const inst = req.inst;
  if (inst.busy) throw httpError(409, 'O servidor já está em execução');
  if (!inst.cfg.updateOnStart && !inst.isInstalled()) throw httpError(400, 'Servidor não instalado. Clique em "Instalar".');
  log(req, 'iniciou', inst.cfg.name);
  background(inst, inst.start());
  res.json({ ok: true });
});
api.post('/instances/:id/stop', perm('control'), (req, res) => {
  log(req, 'parou', req.inst.cfg.name);
  background(req.inst, req.inst.stop());
  res.json({ ok: true });
});
api.post('/instances/:id/restart', perm('control'), (req, res) => {
  log(req, 'reiniciou', req.inst.cfg.name);
  background(req.inst, req.inst.restart());
  res.json({ ok: true });
});
api.post('/instances/:id/kill', perm('control'), (req, res) => {
  log(req, 'forçou a parada', req.inst.cfg.name);
  req.inst.kill();
  res.json({ ok: true });
});
api.post('/instances/:id/install', perm('update'), (req, res) => {
  if (req.inst.busy) throw httpError(409, 'Pare o servidor antes de instalar ou atualizar');
  log(req, 'instalou/atualizou', req.inst.cfg.name);
  background(req.inst, req.inst.install());
  res.json({ ok: true });
});
// Reinstall: full backup, then a clean install of the same game/version (worlds and configs stay).
api.post('/instances/:id/reinstall', perm('update'), (req, res) => {
  const inst = req.inst;
  if (inst.busy) throw httpError(409, 'Pare o servidor antes de reinstalar');
  const t = inst.template;
  if (t.provider === 'generic') throw httpError(400, 'Programas personalizados não têm instalação automática');
  log(req, 'reinstalou', inst.cfg.name);
  if (t.provider === 'minecraft' && manager.MC_JAVA.includes(t.flavor)) {
    background(inst, manager.switchMinecraft(inst, { templateId: t.id, version: inst.cfg.settings.version || 'latest' }));
  } else {
    background(inst, (async () => {
      inst.print('Fazendo backup antes de reinstalar...', 'panel');
      await createBackup(inst, { note: 'antes de reinstalar' });
      await inst.install(); // SteamCMD "validate" re-downloads anything missing or changed
    })());
  }
  res.json({ ok: true });
});
api.get('/instances/:id/activity', (req, res) => res.json(readActivity({ limit: 200, instance: { id: req.inst.cfg.id, name: req.inst.cfg.name } })));
api.post('/instances/:id/firewall', admin, h(async (req, res) => {
  const result = await openFirewall(req.inst);
  log(req, 'liberou portas no firewall', req.inst.cfg.name, result.ok ? 'ok' : 'sem permissão');
  res.json(result);
}));

api.post('/instances/:id/minecraft/switch', perm('update'), perm('settings'), (req, res) => {
  const inst = req.inst;
  const from = `${inst.template.name} ${inst.cfg.installed?.version || ''}`.trim();
  const job = manager.switchMinecraft(inst, req.body);
  background(inst, job);
  log(req, 'trocou tipo/versão do Minecraft', inst.cfg.name, `${from} → ${req.body.templateId} ${req.body.version || 'latest'}`);
  res.json({ ok: true });
});
api.get('/instances/:id/console', perm('console'), (req, res) => res.json(req.inst.log));
api.post('/instances/:id/command', perm('console'), h(async (req, res) => {
  const command = String(req.body.command || '').trim();
  if (!command) throw httpError(400, 'Comando vazio');
  // Steam Guard codes typed during installation shouldn't land in the audit log.
  log(req, 'enviou comando', req.inst.cfg.name, req.inst.state === 'Installing' ? '(entrada do SteamCMD)' : command);
  await req.inst.sendCommand(command);
  res.json({ ok: true });
}));

// ---------- files ----------
const fperm = perm('files');
api.get('/instances/:id/files', fperm, (req, res) => res.json(files.list(req.inst.dir, req.query.path)));
api.get('/instances/:id/files/content', fperm, (req, res) => res.json({ content: files.readText(req.inst.dir, req.query.path) }));
api.put('/instances/:id/files/content', fperm, (req, res) => {
  files.writeText(req.inst.dir, req.query.path, req.body.content);
  log(req, 'editou arquivo', req.inst.cfg.name, req.query.path);
  res.json({ ok: true });
});
api.put('/instances/:id/files/upload', fperm, h(async (req, res) => {
  await files.upload(req.inst.dir, req.query.path, req);
  log(req, 'enviou arquivo', req.inst.cfg.name, req.query.path);
  res.json({ ok: true });
}));
api.get('/instances/:id/files/download', fperm, (req, res) => res.download(files.downloadPath(req.inst.dir, req.query.path)));
api.post('/instances/:id/files/mkdir', fperm, (req, res) => { files.mkdir(req.inst.dir, req.body.path); res.json({ ok: true }); });
api.post('/instances/:id/files/rename', fperm, (req, res) => {
  files.rename(req.inst.dir, req.body.from, req.body.to);
  log(req, 'renomeou arquivo', req.inst.cfg.name, `${req.body.from} → ${req.body.to}`);
  res.json({ ok: true });
});
api.delete('/instances/:id/files', fperm, (req, res) => {
  files.remove(req.inst.dir, req.query.path);
  log(req, 'excluiu arquivo', req.inst.cfg.name, req.query.path);
  res.json({ ok: true });
});
const listed = paths => (Array.isArray(paths) ? paths.slice(0, 5).join(', ') + (paths.length > 5 ? ` e mais ${paths.length - 5}` : '') : '');
api.post('/instances/:id/files/delete', fperm, (req, res) => {
  files.removeMany(req.inst.dir, req.body.paths);
  log(req, 'excluiu arquivos', req.inst.cfg.name, listed(req.body.paths));
  res.json({ ok: true });
});
api.post('/instances/:id/files/move', fperm, (req, res) => {
  files.move(req.inst.dir, req.body.paths, req.body.to);
  log(req, 'moveu arquivos', req.inst.cfg.name, `${listed(req.body.paths)} → ${req.body.to || 'raiz'}`);
  res.json({ ok: true });
});
api.post('/instances/:id/files/copy', fperm, (req, res) => {
  files.copy(req.inst.dir, req.body.paths, req.body.to);
  log(req, 'copiou arquivos', req.inst.cfg.name, `${listed(req.body.paths)} → ${req.body.to || 'raiz'}`);
  res.json({ ok: true });
});
api.post('/instances/:id/files/compress', fperm, h(async (req, res) => {
  const file = await files.compress(req.inst.dir, req.body.paths, req.body.cwd, req.body.name);
  log(req, 'compactou arquivos', req.inst.cfg.name, file);
  res.json({ file });
}));
api.post('/instances/:id/files/extract', fperm, h(async (req, res) => {
  const dir = await files.extract(req.inst.dir, req.body.path, req.body.to);
  log(req, 'descompactou arquivo', req.inst.cfg.name, req.body.path);
  res.json({ dir });
}));
// Downloads run in the background (big modpacks/maps); progress shows in the console.
api.post('/instances/:id/files/pull', fperm, (req, res) => {
  const inst = req.inst;
  const { url, dir, name } = req.body;
  if (!/^https?:\/\//i.test(String(url || ''))) throw httpError(400, 'Use um link http(s)');
  inst.print(`Baixando ${url}...`, 'panel');
  const progress = (r, t) => inst.print(`Download: ${Math.round(r / t * 100)}%`, 'panel');
  background(inst, files.pull(inst.dir, url, dir, name, progress).then(file => inst.print(`Download concluído: ${dir ? `${dir}/` : ''}${file}`, 'panel')));
  log(req, 'baixou arquivo de um link', inst.cfg.name, String(url).slice(0, 200));
  res.json({ ok: true });
});

// ---------- backups ----------
// ---------- console problems ----------
api.post('/instances/:id/issues/:issue/fix', perm('control'), (req, res) => {
  const inst = req.inst;
  fixIssue(inst, req.params.issue);
  log(req, 'corrigiu problema', inst.cfg.name, req.params.issue);
  if (!inst.busy) background(inst, inst.start());
  res.json({ ok: true });
});

// ---------- players ----------
api.get('/instances/:id/players', perm('console'), h(async (req, res) => res.json(await getPlayers(req.inst))));
api.post('/instances/:id/players', perm('console'), h(async (req, res) => {
  const r = await playerAction(req.inst, req.body);
  log(req, 'jogadores', req.inst.cfg.name, `${req.body.action} ${req.body.target}`);
  res.json(r);
}));

// ---------- visual config editor ----------
api.get('/instances/:id/config', perm('settings'), (req, res) => res.json(readConfig(req.inst, String(req.query.path || ''))));
api.put('/instances/:id/config', perm('settings'), (req, res) => {
  const r = writeConfig(req.inst, String(req.query.path || ''), String(req.body.version || ''), req.body.changes);
  log(req, 'editou configuração', req.inst.cfg.name, `${req.query.path} (${r.count})`);
  res.json(r);
});

// ---------- mods ----------
const mperm = perm('files');
function needMods(kind) {
  return (req, res, next) => (mods.modKind(req.inst) === kind ? next() : next(httpError(400, 'Este servidor não suporta esse tipo de mod')));
}
api.get('/instances/:id/mods', mperm, h(async (req, res) => {
  const inst = req.inst;
  const kind = mods.modKind(inst);
  if (kind === 'modrinth') return res.json({ kind, ...mods.modrinth.info(inst), installed: await mods.modrinth.listInstalled(inst), job: mods.jobStatus(inst) });
  if (kind === 'workshop') {
    const job = mods.jobStatus(inst);
    if (!job?.running) mods.clearJobError(inst); // show a failure once
    return res.json({ kind, ...(await mods.workshop.list(inst)), job });
  }
  res.json({ kind: null });
}));
// Minecraft (Modrinth)
const mr = [mperm, needMods('modrinth')];
api.get('/instances/:id/mods/search', mr, h(async (req, res) => res.json(await mods.modrinth.search(req.inst, String(req.query.q || ''), req.query.offset))));
api.get('/instances/:id/mods/updates', mr, h(async (req, res) => res.json(await mods.modrinth.checkUpdates(req.inst))));
api.post('/instances/:id/mods/install', mr, h(async (req, res) => {
  const added = await mods.modrinth.install(req.inst, String(req.body.projectId || ''), line => req.inst.print(line, 'panel'));
  log(req, 'instalou mod', req.inst.cfg.name, added.join(', '));
  res.json({ added });
}));
api.post('/instances/:id/mods/toggle', mr, (req, res) => {
  const file = mods.modrinth.toggle(req.inst, req.body.file);
  log(req, file.endsWith('.disabled') ? 'desativou mod' : 'ativou mod', req.inst.cfg.name, req.body.file);
  res.json({ file });
});
api.post('/instances/:id/mods/update', mr, h(async (req, res) => {
  const count = await mods.modrinth.update(req.inst, req.body.file || null, line => req.inst.print(line, 'panel'));
  log(req, 'atualizou mods', req.inst.cfg.name, String(count));
  res.json({ count });
}));
api.delete('/instances/:id/mods', mr, (req, res) => {
  mods.modrinth.remove(req.inst, req.query.file);
  log(req, 'removeu mod', req.inst.cfg.name, req.query.file);
  res.json({ ok: true });
});
// Steam Workshop
const ws = [mperm, needMods('workshop')];
api.get('/instances/:id/mods/workshop/search', ws, h(async (req, res) => {
  const { q = '', sort, build, page } = req.query;
  res.json(await mods.workshop.search(req.inst, { q: String(q), sort: String(sort || 'popular'), build: String(build || 'auto'), page }));
}));
api.post('/instances/:id/mods/workshop', ws, (req, res) => {
  const input = String(req.body.input || '');
  if (!mods.workshop.parseInput(input).length) throw httpError(400, 'Cole um link da Oficina Steam ou o número do item');
  mods.startJob(req.inst, 'Adicionando mods da Oficina', l => mods.workshop.add(req.inst, input, l));
  log(req, 'adicionou mods da Oficina', req.inst.cfg.name, input.slice(0, 200));
  res.json({ ok: true });
});
api.post('/instances/:id/mods/workshop/update', ws, (req, res) => {
  mods.startJob(req.inst, 'Atualizando mods da Oficina', l => mods.workshop.updateAll(req.inst, l));
  log(req, 'atualizou mods da Oficina', req.inst.cfg.name);
  res.json({ ok: true });
});
api.put('/instances/:id/mods/workshop', ws, (req, res) => {
  mods.workshop.setActive(req.inst, req.body);
  log(req, 'alterou mods ativos', req.inst.cfg.name);
  res.json({ ok: true });
});
api.delete('/instances/:id/mods/workshop/:wid', ws, (req, res) => {
  mods.workshop.remove(req.inst, req.params.wid, req.query.files === '1');
  log(req, 'removeu mod da Oficina', req.inst.cfg.name, req.params.wid);
  res.json({ ok: true });
});

const bperm = perm('backups');
api.get('/instances/:id/backups', bperm, (req, res) => res.json(listBackups(req.inst)));
api.post('/instances/:id/backups', bperm, h(async (req, res) => {
  const name = await createBackup(req.inst, { note: String(req.body?.note || '').trim() });
  log(req, 'criou backup', req.inst.cfg.name, name);
  res.json({ name });
}));
api.post('/instances/:id/backups/:name/lock', bperm, (req, res) => {
  setBackupLock(req.inst, req.params.name, req.body.locked);
  log(req, req.body.locked ? 'travou backup' : 'destravou backup', req.inst.cfg.name, req.params.name);
  res.json({ ok: true });
});
api.get('/instances/:id/backups/:name', bperm, (req, res) => res.download(backupFile(req.inst, req.params.name)));
api.post('/instances/:id/backups/:name/restore', bperm, h(async (req, res) => {
  await restoreBackup(req.inst, req.params.name);
  log(req, 'restaurou backup', req.inst.cfg.name, req.params.name);
  res.json({ ok: true });
}));
api.delete('/instances/:id/backups/:name', bperm, (req, res) => {
  deleteBackup(req.inst, req.params.name);
  log(req, 'excluiu backup', req.inst.cfg.name, req.params.name);
  res.json({ ok: true });
});

// ---------- scheduler ----------
const sperm = perm('schedule');
api.get('/schedules', (req, res) => res.json(visible(req)
  .filter(i => auth.can(req.account, i.cfg.id, 'schedule'))
  .flatMap(i => i.cfg.schedules.map(s => ({ ...s, instanceId: i.cfg.id, instanceName: i.cfg.name })))));
api.get('/instances/:id/schedules', sperm, (req, res) => res.json(req.inst.cfg.schedules));
api.post('/instances/:id/schedules', sperm, (req, res) => {
  const s = manager.addSchedule(req.inst, req.body);
  log(req, 'criou tarefa agendada', req.inst.cfg.name, `${s.cron} ${s.name || s.steps.map(stepLabel).join(' → ')}`);
  res.json(s);
});
api.patch('/instances/:id/schedules/:sid', sperm, (req, res) => {
  const s = manager.getSchedule(req.inst, req.params.sid);
  manager.updateSchedule(req.inst, s, req.body);
  res.json(s);
});
api.delete('/instances/:id/schedules/:sid', sperm, (req, res) => {
  manager.deleteSchedule(req.inst, manager.getSchedule(req.inst, req.params.sid));
  log(req, 'excluiu tarefa agendada', req.inst.cfg.name);
  res.json({ ok: true });
});
api.post('/instances/:id/schedules/:sid/run', sperm, (req, res) => {
  background(req.inst, runTask(req.inst, manager.getSchedule(req.inst, req.params.sid), req.user));
  res.json({ ok: true });
});

// ---------- bulk actions / updates ----------
api.post('/bulk/:action', admin, (req, res) => {
  const { action } = req.params;
  const targets = [...manager.instances.values()].filter(i => !req.body.ids || req.body.ids.includes(i.cfg.id));
  log(req, `ação em massa: ${action}`, '', `${targets.length} instância(s)`);
  for (const inst of targets) {
    if (action === 'start' && !inst.busy && inst.isInstalled()) background(inst, inst.start());
    else if (action === 'stop' && inst.running) background(inst, inst.stop());
    else if (action === 'restart' && inst.running) background(inst, inst.restart());
    else if (action === 'update' && inst.template.provider !== 'generic') {
      background(inst, (async () => {
        const wasRunning = inst.running;
        await inst.stop();
        await inst.install();
        if (wasRunning) await inst.start({ skipUpdate: true });
      })());
    }
  }
  res.json({ ok: true, count: targets.length });
});
api.post('/updates/check', admin, h(async (req, res) => {
  await checkUpdates(manager.instances.values());
  res.json({ ok: true, lastCheck: lastUpdateCheck() });
}));

// ---------- updates of the panel itself ----------
api.get('/panel/update', admin, (req, res) => res.json(panelUpdateState()));
api.post('/panel/update/check', admin, h(async (req, res) => res.json(await checkPanelUpdate())));
api.post('/panel/update/apply', admin, h(async (req, res) => {
  const { latest } = panelUpdateState();
  log(req, 'atualizou o painel', '', `${VERSION} → ${latest}`);
  await applyPanelUpdate(() => manager.stopAll());
  res.json({ ok: true });
}));

api.use((req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message || 'Erro interno' });
});

// ---------- live updates over WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  // The session cookie authenticates; the Origin check stops other sites from opening the socket with it.
  const sameOrigin = !req.headers.origin || new URL(req.headers.origin).host === req.headers.host;
  const user = auth.sessionUser(req);
  if (req.url !== '/ws' || !sameOrigin || !user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, ws => {
    ws.username = user;
    wss.emit('connection', ws, req);
  });
});

const accountOf = ws => db.users.find(u => u.username === ws.username);

function broadcast(message, filter = () => true) {
  const data = JSON.stringify(message);
  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    const account = accountOf(ws);
    if (!account) { ws.close(); continue; }
    if (filter(account)) ws.send(data);
  }
}

function broadcastStatus() {
  const all = [...manager.instances.values()].map(i => i.status());
  const system = systemUsage();
  const t = Date.now();
  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    const account = accountOf(ws);
    if (!account) { ws.close(); continue; }
    ws.send(JSON.stringify({ type: 'status', t, system, instances: all.filter(s => auth.can(account, s.id)) }));
  }
}

manager.bus.on('console', (id, entry) => broadcast({ type: 'console', id, entry }, a => auth.can(a, id, 'console')));
manager.bus.on('state', () => broadcastStatus());

setInterval(async () => {
  await manager.sampleMetrics();
  broadcastStatus();
}, 2000);
setInterval(() => manager.queryAll(), 10_000);
setInterval(() => manager.refreshDiskUsage(), 5 * 60 * 1000);
setTimeout(() => manager.refreshDiskUsage(), 5000);
// New instances and finished installs get measured soon instead of waiting for the 5-minute pass.
setInterval(() => manager.refreshDiskUsage({ onlyUnknown: true }), 15_000);
setInterval(() => checkUpdates(manager.instances.values()), 30 * 60 * 1000);
setTimeout(() => checkUpdates(manager.instances.values()), 60 * 1000);
setInterval(checkPanelUpdate, 6 * 60 * 60 * 1000);
setTimeout(checkPanelUpdate, 30 * 1000);

// ---------- startup / shutdown ----------
manager.loadInstances();
for (const inst of manager.instances.values()) {
  if (inst.cfg.autoStart) inst.start().catch(e => inst.print(`Início automático falhou: ${e.message}`, 'panel'));
}

server.listen(PORT, HOST, () => {
  console.log(`Host My Game ${VERSION} rodando em http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return process.exit(1);
  shuttingDown = true;
  console.log('Parando servidores de jogo...');
  await manager.stopAll();
  stopSampler();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// The Windows service wrapper stops the panel with Ctrl+Break when Ctrl+C is unavailable.
process.on('SIGBREAK', shutdown);
