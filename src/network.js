import net from 'node:net';
import dgram from 'node:dgram';
import { IS_WIN, run } from './util.js';

// True when nothing on this machine is listening on the port.
export function portFree(port, proto) {
  return new Promise(resolve => {
    if (proto === 'udp') {
      const sock = dgram.createSocket('udp4');
      sock.once('error', () => resolve(false));
      sock.bind(port, () => sock.close(() => resolve(true)));
      return;
    }
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, () => srv.close(() => resolve(true)));
  });
}

const ruleName = (inst, p, proto) => `Host My Game - ${inst.cfg.name} (${p.name}) ${proto.toUpperCase()} ${p.port}`;

// Adds inbound allow rules to Windows Firewall. Requires the panel to run as administrator;
// otherwise returns the commands so the user can run them in an elevated terminal.
export async function openFirewall(inst) {
  if (!IS_WIN) throw new Error('A liberação automática de firewall só funciona no Windows');
  const commands = [];
  for (const p of inst.ports()) {
    for (const proto of p.proto === 'both' ? ['tcp', 'udp'] : [p.proto]) {
      commands.push(['advfirewall', 'firewall', 'add', 'rule', `name=${ruleName(inst, p, proto)}`, 'dir=in', 'action=allow', `protocol=${proto.toUpperCase()}`, `localport=${p.port}`]);
    }
  }
  if (!commands.length) throw new Error('Este servidor não tem portas definidas');
  const output = [];
  let denied = false;
  for (const args of commands) {
    // Remove an older rule with the same name first so repeated clicks don't pile up duplicates.
    await run('netsh', ['advfirewall', 'firewall', 'delete', 'rule', args[4]], {});
    const code = await run('netsh', args, { onLine: l => output.push(l) });
    if (code !== 0) denied = true;
  }
  const quote = x => { const m = x.match(/^(\w+)=(.*\s.*)$/); return m ? `${m[1]}="${m[2]}"` : x; };
  const manual = commands.map(a => `netsh ${a.map(quote).join(' ')}`);
  if (denied) return { ok: false, message: 'O Windows recusou (o painel precisa rodar como administrador). Execute os comandos abaixo em um terminal de administrador:', commands: manual };
  return { ok: true, message: `${commands.length} regra(s) criada(s) no Firewall do Windows.`, commands: manual };
}
