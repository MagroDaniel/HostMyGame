import fs from 'node:fs';
import path from 'node:path';
import { save } from './store.js';
import { httpError } from './util.js';

// Known problems recognized in console output. Each one becomes a card above the console with an
// explanation and, when the panel can fix it, a button. Problems are cleared when the server starts again.
//   match(line, inst) -> details object (truthy) when the line shows the problem
//   build(details, inst) -> { title, message, fix?: label, tab?: tab to open }
const RULES = [
  {
    id: 'eula',
    match: line => /You need to agree to the EULA|agree to the EULA in order to run the server/i.test(line),
    build: () => ({
      title: 'É preciso aceitar o EULA do Minecraft',
      message: 'O servidor só roda depois de aceitar o contrato de uso da Mojang (minecraft.net/eula).',
      fix: 'Aceitar o EULA e iniciar',
    }),
  },
  {
    id: 'java',
    // "class file version 65.0" -> Java 21 (class version - 44)
    match: line => {
      // Fabric: "requires version 16 or later of 'OpenJDK 64-Bit Server VM' (java)" / "(java) 8 with version 16 or later"
      const m = line.match(/class file version (\d+)(?:\.\d+)?/i) || line.match(/requires (?:at least )?Java (\d+)/i)
        || line.match(/requires version (\d+) or later of .*\(java\)/i) || line.match(/\(java\) \d+ with version (\d+) or later/i);
      if (!m) return null;
      const v = Number(m[1]);
      return { java: v > 44 ? v - 44 : v };
    },
    build: d => ({
      title: `Este servidor precisa do Java ${d.java}`,
      message: `O Java usado agora é antigo demais. O painel pode baixar e usar o Java ${d.java} automaticamente.`,
      fix: `Usar Java ${d.java} e iniciar`,
    }),
  },
  {
    id: 'port',
    match: line => /FAILED TO BIND TO PORT|Address already in use|BindException|Perhaps a server is already running on that port|port is already in use|EADDRINUSE/i.test(line),
    build: () => ({
      title: 'A porta do servidor já está em uso',
      message: 'Outro programa (ou outro servidor do painel) já usa esta porta. Feche o outro programa ou mude a porta do jogo.',
      tab: 'startup',
    }),
  },
  {
    id: 'memory',
    match: line => /java\.lang\.OutOfMemoryError|Could not reserve enough space for object heap|Out of memory|insufficient memory/i.test(line),
    build: () => ({
      title: 'O servidor ficou sem memória',
      message: 'Aumente a memória RAM do servidor nas configurações do jogo (ou diminua, se o PC não tiver RAM livre suficiente).',
      tab: 'startup',
    }),
  },
  {
    id: 'disk',
    match: line => /Not enough disk space|disk write failure|No space left on device|0x202\b/i.test(line),
    build: () => ({
      title: 'Falta espaço em disco',
      message: 'O download ou o servidor precisa de mais espaço livre no disco. Libere espaço e tente de novo.',
    }),
  },
  {
    id: 'gslt',
    match: line => /Game Server Login Token|GSLT|sv_setsteamaccount|Invalid or missing login token/i.test(line) && /missing|invalid|required|not set|no |inválid/i.test(line),
    build: () => ({
      title: 'Falta o token de servidor da Steam (GSLT)',
      message: 'Para aparecer na lista pública, este jogo exige um token gratuito. Gere em steamcommunity.com/dev/managegameservers (App ID do jogo) e coloque nos argumentos (aba Avançado) com +sv_setsteamaccount SEU_TOKEN.',
      tab: 'advanced',
    }),
  },
  {
    id: 'mods',
    match: line => /Incompatible mods? found|Mod resolution failed|requires (?:any version of )?[\w-]+ .*which is missing|Missing or unsupported mandatory dependencies|Mod .* requires .* but/i.test(line),
    build: () => ({
      title: 'Problema com os mods',
      message: 'Algum mod está faltando, é de outra versão do jogo ou é incompatível. Veja os detalhes no console logo acima e ajuste na aba Mods.',
      tab: 'mods',
    }),
  },
  {
    id: 'steam-account',
    match: line => /No subscription|exige uma conta Steam/i.test(line),
    build: () => ({
      title: 'Este jogo exige uma conta Steam',
      message: 'O servidor só pode ser baixado com uma conta Steam que tenha o jogo. Faça login em Configurações do painel > Conta Steam.',
    }),
  },
];

export function detectIssues(inst, line) {
  for (const rule of RULES) {
    if (inst.issues.has(rule.id)) continue;
    let details;
    try { details = rule.match(line, inst); } catch { details = null; }
    if (!details) continue;
    const info = rule.build(typeof details === 'object' ? details : {}, inst);
    inst.issues.set(rule.id, { id: rule.id, ...info, details: typeof details === 'object' ? details : null, at: Date.now() });
    inst.emit('issues');
  }
}

// Runs the automatic fix for an issue; returns true when the server should be started afterwards.
export function fixIssue(inst, id) {
  const issue = inst.issues.get(id);
  if (!issue) throw httpError(404, 'Este problema já foi resolvido');
  if (!issue.fix) throw httpError(400, 'Este problema precisa ser resolvido manualmente');
  if (id === 'eula') {
    fs.writeFileSync(path.join(inst.dir, 'eula.txt'), 'eula=true\n');
    inst.print('EULA aceito (eula.txt).', 'panel');
  } else if (id === 'java') {
    const v = issue.details?.java;
    if (!v || v < 8 || v > 40) throw httpError(400, 'Versão do Java desconhecida');
    inst.cfg.installed = { ...(inst.cfg.installed || {}), requiredJava: v };
    if (inst.cfg.settings.javaPath && inst.cfg.settings.javaPath !== 'auto') inst.cfg.settings.javaPath = 'auto';
    save();
    inst.print(`O servidor vai usar o Java ${v}.`, 'panel');
  }
  inst.issues.delete(id);
  inst.emit('issues');
  return true;
}

export const listIssues = inst => [...inst.issues.values()];
