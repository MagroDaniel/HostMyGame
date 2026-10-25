import fs from 'node:fs';
import path from 'node:path';
import { httpError } from './util.js';

// Visual editor for game config files: every option becomes a field, the comments above it become its help text.
// Only changed lines are rewritten, so comments, order and unknown lines stay exactly as they were.
//   kv:  key=value files (server.properties, .ini, .cfg) with # or ; comments and optional [Section] headers
//   lua: Project Zomboid's SandboxVars.lua (nested tables of "Key = value,")

// server.properties has no comments of its own, so the common keys get Portuguese help.
const MC_HELP = {
  'motd': 'Mensagem que aparece na lista de servidores do jogo.',
  'max-players': 'Quantidade máxima de jogadores ao mesmo tempo.',
  'gamemode': 'Modo de jogo padrão: survival, creative, adventure ou spectator.',
  'difficulty': 'Dificuldade: peaceful, easy, normal ou hard.',
  'hardcore': 'Modo hardcore: ao morrer, o jogador vira espectador.',
  'pvp': 'Permite que jogadores ataquem uns aos outros.',
  'online-mode': 'Só aceita contas originais (verifica com a Mojang). Desligue apenas para jogar sem internet/contas piratas.',
  'white-list': 'Só jogadores da whitelist podem entrar.',
  'enforce-whitelist': 'Expulsa quem não está na whitelist quando ela é ativada.',
  'spawn-protection': 'Raio (em blocos) ao redor do spawn que só operadores podem alterar. 0 desativa.',
  'view-distance': 'Distância de visão em chunks. Valores altos usam mais CPU e RAM.',
  'simulation-distance': 'Distância (em chunks) em que o mundo funciona (plantas crescem, mobs andam).',
  'allow-flight': 'Permite voar no modo sobrevivência (necessário para alguns mods/plugins).',
  'allow-nether': 'Permite ir para o Nether.',
  'level-seed': 'Semente usada para gerar um mundo novo.',
  'level-name': 'Nome da pasta do mundo.',
  'level-type': 'Tipo de mundo: minecraft:normal, minecraft:flat, minecraft:large_biomes, minecraft:amplified.',
  'spawn-monsters': 'Monstros aparecem naturalmente.',
  'spawn-animals': 'Animais aparecem naturalmente.',
  'spawn-npcs': 'Aldeões aparecem naturalmente.',
  'generate-structures': 'Gera vilas, templos e outras estruturas em mundos novos.',
  'enable-command-block': 'Permite blocos de comando.',
  'force-gamemode': 'Força o modo de jogo padrão sempre que o jogador entra.',
  'player-idle-timeout': 'Expulsa jogadores parados após X minutos. 0 desativa.',
  'max-world-size': 'Tamanho máximo do mundo (raio em blocos).',
  'server-port': 'Porta do servidor.',
  'enable-rcon': 'Ativa o RCON (console remoto).',
  'rcon.port': 'Porta do RCON.',
  'rcon.password': 'Senha do RCON.',
  'enable-query': 'Responde consultas de status (GameSpy4).',
  'resource-pack': 'Link de um pacote de recursos que os jogadores baixam ao entrar.',
  'require-resource-pack': 'Expulsa quem recusar o pacote de recursos.',
  'op-permission-level': 'Nível de permissão dos operadores (1 a 4).',
  'sync-chunk-writes': 'Grava chunks de forma síncrona (mais seguro, um pouco mais lento).',
  'allow-cheats': 'Permite comandos de trapaça.',
};

const formatOf = file => (/\.lua$/i.test(file) ? 'lua' : 'kv');

function typed(raw) {
  const v = raw.trim();
  if (/^(true|false)$/i.test(v)) return { type: 'bool', value: v.toLowerCase() === 'true' };
  if (/^-?\d+(\.\d+)?$/.test(v)) return { type: 'number', value: v };
  return { type: 'text', value: v };
}

function parseKv(text, file) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  let comment = [], section = '';
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t) { comment = []; return; }
    if (/^[#;!]/.test(t)) { comment.push(t.replace(/^[#;!]+\s?/, '')); return; }
    const sec = t.match(/^\[(.+)\]$/);
    if (sec) { section = sec[1]; comment = []; return; }
    const m = line.match(/^\s*([^=:#;\s][^=]*?)\s*=(.*)$/);
    if (!m) { comment = []; return; }
    const key = m[1];
    // server.properties only has an auto-generated header ("Minecraft server properties" + date) as comments.
    const help = path.basename(file) === 'server.properties' ? MC_HELP[key] || '' : comment.join(' ');
    entries.push({ line: i, key, section, help, ...typed(m[2]) });
    comment = [];
  });
  return entries;
}

// "Padrão = Normal 1 = Louca 2 = Muito Alta 3 = Alta" -> options for a dropdown, plus the remaining help text.
function withOptions(entry) {
  if (entry.type !== 'number') return entry;
  const opts = [...entry.help.matchAll(/(?:^|\s)(\d+)\s*=\s*(.+?)(?=\s+\d+\s*=|$)/g)].map(m => [m[1], m[2].trim()]);
  if (opts.length < 2 || opts.some(([v], i) => i && Number(v) !== Number(opts[i - 1][0]) + 1)) return entry;
  if (!opts.some(([v]) => v === String(entry.value))) opts.push([String(entry.value), String(entry.value)]);
  const first = entry.help.search(/(?:^|\s)\d+\s*=/);
  return { ...entry, type: 'select', options: opts, help: entry.help.slice(0, first).trim() };
}

function parseLua(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  const stack = [];
  let comment = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t) { comment = []; return; }
    if (t.startsWith('--')) { comment.push(t.replace(/^--+\s?/, '')); return; }
    const open = t.match(/^(\w+)\s*=\s*\{\s*$/);
    if (open) { stack.push(open[1]); comment = []; return; }
    if (/^\}\s*,?\s*$/.test(t)) { stack.pop(); comment = []; return; }
    const m = line.match(/^\s*(\w+)\s*=\s*(.+?)\s*,?\s*(--.*)?$/);
    if (!m) { comment = []; return; }
    let raw = m[2], quoted = false;
    if (/^".*"$/.test(raw)) { raw = raw.slice(1, -1); quoted = true; }
    // The root table (SandboxVars) isn't useful as a section name.
    const section = stack.slice(1).join(' › ');
    const help = comment.join(' ').replace(/\\/g, '"');
    entries.push(withOptions({ line: i, key: m[1], section, help, quoted, ...(quoted ? { type: 'text', value: raw } : typed(raw)) }));
    comment = [];
  });
  return entries;
}

// Config files this instance's template lists, that the editor understands and that exist.
export function editableFiles(inst) {
  return inst.template.configFiles
    .map(f => inst.expand(f))
    .filter(f => /\.(properties|ini|cfg|lua)$/i.test(f))
    .map(f => ({ path: f, exists: fs.existsSync(path.join(inst.dir, f)) }));
}

function resolve(inst, rel) {
  const allowed = editableFiles(inst).map(f => f.path);
  if (!allowed.includes(rel)) throw httpError(400, 'Este arquivo não pode ser editado pelo editor visual');
  const full = path.join(inst.dir, rel);
  if (!fs.existsSync(full)) throw httpError(404, 'O arquivo ainda não existe. Inicie o servidor uma vez para o jogo criá-lo.');
  return full;
}

const versionOf = full => { const st = fs.statSync(full); return `${st.size}-${Math.floor(st.mtimeMs)}`; };

// Keys other parts of the panel control can't be edited here: key -> tab that controls it.
//   game settings (rewritten before every start) -> Inicialização; Workshop mod lists -> Mods
function managedKeys(inst, rel) {
  const keys = new Map();
  for (const w of inst.template.configWrites || []) {
    if (inst.expand(w.path) !== rel) continue;
    for (const k of Object.keys(w.values)) keys.set(k.includes(']') ? k.slice(k.indexOf(']') + 1) : k, 'Inicialização');
  }
  if (inst.template.mods?.ini && inst.expand(inst.template.mods.ini) === rel) {
    for (const k of ['Mods', 'WorkshopItems', 'Map']) keys.set(k, 'Mods');
  }
  return keys;
}

export function readConfig(inst, rel) {
  const full = resolve(inst, rel);
  const text = fs.readFileSync(full, 'utf8');
  const format = formatOf(rel);
  const managed = managedKeys(inst, rel);
  const entries = (format === 'lua' ? parseLua(text) : parseKv(text, rel)).map(e => ({ ...e, managed: managed.get(e.key) || null }));
  return { path: rel, format, version: versionOf(full), entries };
}

const luaValue = (entry, v) => {
  if (entry.quoted) return `"${String(v).replace(/["\\\r\n]/g, '')}"`;
  if (entry.type === 'bool') return v ? 'true' : 'false';
  if (entry.type === 'number' || entry.type === 'select') { if (!/^-?\d+(\.\d+)?$/.test(String(v))) throw httpError(400, `${entry.key}: valor numérico inválido`); return String(v); }
  return String(v);
};

// changes: { [line]: newValue }
export function writeConfig(inst, rel, version, changes) {
  const full = resolve(inst, rel);
  if (versionOf(full) !== version) throw httpError(409, 'O arquivo foi alterado (talvez pelo próprio jogo). Recarregue a página e faça as mudanças de novo.');
  const text = fs.readFileSync(full, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const format = formatOf(rel);
  const entries = new Map((format === 'lua' ? parseLua(text) : parseKv(text, rel)).map(e => [e.line, e]));
  const managed = managedKeys(inst, rel);
  let count = 0;
  for (const [lineStr, value] of Object.entries(changes || {})) {
    const entry = entries.get(Number(lineStr));
    if (!entry) throw httpError(400, 'Opção não encontrada no arquivo');
    if (managed.has(entry.key)) throw httpError(400, `${entry.key} é controlado pela aba ${managed.get(entry.key)}`);
    if (format === 'lua') {
      lines[entry.line] = lines[entry.line].replace(/^(\s*\w+\s*=\s*)(.+?)(\s*,?\s*(--.*)?)$/, (_, a, _old, c) => a + luaValue(entry, value) + c);
    } else {
      const v = entry.type === 'bool' ? (value ? 'true' : 'false') : String(value).replace(/[\r\n]/g, ' ');
      if ((entry.type === 'number' || entry.type === 'select') && !/^-?\d+(\.\d+)?$/.test(v)) throw httpError(400, `${entry.key}: valor numérico inválido`);
      lines[entry.line] = lines[entry.line].replace(/^(\s*[^=]*?\s*=).*$/, (_, a) => a + v);
    }
    count++;
  }
  fs.writeFileSync(full, lines.join(eol));
  return { count, version: versionOf(full) };
}
