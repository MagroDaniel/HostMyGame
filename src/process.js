// Starts a game server either with plain pipes or inside a pseudo console (ConPTY on Windows).
// Some Windows servers (e.g. Terraria) ignore redirected stdin and only accept commands from a real
// console; the PTY gives them one. Both variants expose the same small handle:
//   handle.pid, handle.write(line), handle.signal(sig), events 'line' (text) and 'exit' (code)
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { IS_WIN, readLines } from './util.js';

const quoteWin = a => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

// Terminal control sequences (cursor moves, colors, window titles) that ConPTY mixes into the output.
const VT = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78NOM]/g;

function spawnPiped(cmd, args, { cwd, env }) {
  const h = new EventEmitter();
  const isBatch = IS_WIN && /\.(bat|cmd)$/i.test(cmd);
  const child = isBatch
    ? spawn('cmd.exe', ['/d', '/s', '/c', `"${[cmd, ...args].map(quoteWin).join(' ')}"`], { cwd, env, windowsHide: true, windowsVerbatimArguments: true })
    : spawn(cmd, args, { cwd, env, windowsHide: true });
  h.pid = child.pid;
  child.stdin.on('error', () => {}); // writes after the process died would otherwise crash the panel
  readLines(child.stdout, l => h.emit('line', l));
  readLines(child.stderr, l => h.emit('line', l));
  let exited = false;
  const exit = code => { if (!exited) { exited = true; h.emit('exit', code); } };
  child.on('error', err => { h.emit('line', `Falha ao executar: ${err.message}`); exit(null); });
  child.on('close', exit);
  h.write = text => child.stdin.write(text + '\n');
  h.signal = sig => child.kill(sig);
  return h;
}

async function spawnPty(cmd, args, { cwd, env }) {
  const pty = (await import('@lydell/node-pty')).default;
  const h = new EventEmitter();
  const isBatch = IS_WIN && /\.(bat|cmd)$/i.test(cmd);
  const p = isBatch
    ? pty.spawn('cmd.exe', ['/d', '/c', cmd, ...args], { cwd, env, cols: 400, rows: 50 })
    : pty.spawn(cmd, args, { cwd, env, cols: 400, rows: 50 });
  // ConPTY reports the child's PID a moment after spawning.
  Object.defineProperty(h, 'pid', { get: () => p.pid });
  for (let i = 0; i < 60 && !p.pid; i++) await new Promise(r => setTimeout(r, 50));
  let buf = '';
  p.onData(chunk => {
    buf += chunk.replace(VT, '');
    const lines = buf.split(/\r\n|\n|\r/);
    buf = lines.pop();
    for (const l of lines) if (l.trim()) h.emit('line', l.replace(/\s+$/, ''));
  });
  p.onExit(({ exitCode }) => {
    if (buf.trim()) h.emit('line', buf);
    h.emit('exit', exitCode);
  });
  h.write = text => p.write(text + '\r');
  h.signal = () => p.kill();
  return h;
}

export function startProcess(cmd, args, opts) {
  return opts.pty ? spawnPty(cmd, args, opts) : Promise.resolve(spawnPiped(cmd, args, opts));
}
