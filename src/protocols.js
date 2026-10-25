// Network clients used to talk to running game servers: Source RCON, 7 Days to Die telnet,
// Steam A2S_INFO, Minecraft Java server-list ping and Minecraft Bedrock (RakNet) ping.
import net from 'node:net';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const HOST = '127.0.0.1';

// ---------- Source RCON (TCP) ----------
export class Rcon {
  constructor(port, password) {
    this.port = Number(port);
    this.password = password;
    this.socket = null;
    this.nextId = 1;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map(); // id -> { chunks, resolve, timer }
  }

  connect(timeout = 4000) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.port, HOST);
      const fail = err => { socket.destroy(); reject(err); };
      const timer = setTimeout(() => fail(new Error('RCON: tempo esgotado')), timeout);
      socket.on('error', err => { clearTimeout(timer); this.close(); reject(err); });
      socket.on('close', () => this.close());
      socket.on('data', data => this.onData(data));
      socket.once('connect', async () => {
        this.socket = socket;
        try {
          await this.request(this.password, 3, true);
          clearTimeout(timer);
          resolve(this);
        } catch (e) {
          clearTimeout(timer);
          fail(e);
        }
      });
    });
  }

  get connected() { return Boolean(this.socket && !this.socket.destroyed); }

  onData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readInt32LE(0);
      if (this.buffer.length < size + 4) break;
      const id = this.buffer.readInt32LE(4);
      const type = this.buffer.readInt32LE(8);
      const body = this.buffer.toString('utf8', 12, size + 2).replace(/\0+$/, '');
      this.buffer = this.buffer.subarray(size + 4);
      if (type === 2 && id === -1) { // auth rejected
        for (const p of this.pending.values()) p.reject(new Error('RCON: senha recusada'));
        this.pending.clear();
        continue;
      }
      const p = this.pending.get(id);
      if (!p) continue;
      if (p.auth) {
        if (type === 2) { this.pending.delete(id); clearTimeout(p.timer); p.resolve(''); }
        continue;
      }
      p.chunks.push(body);
      // Responses can span several packets; settle shortly after the last one arrives.
      clearTimeout(p.timer);
      p.timer = setTimeout(() => this.settle(id), 150);
    }
  }

  settle(id) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.resolve(p.chunks.join(''));
  }

  request(body, type = 2, auth = false) {
    if (!this.connected) return Promise.reject(new Error('RCON não conectado'));
    const id = this.nextId++;
    const payload = Buffer.from(body, 'utf8');
    const packet = Buffer.alloc(14 + payload.length);
    packet.writeInt32LE(10 + payload.length, 0);
    packet.writeInt32LE(id, 4);
    packet.writeInt32LE(type, 8);
    payload.copy(packet, 12);
    return new Promise((resolve, reject) => {
      // Some servers never answer certain commands; give up quietly instead of hanging.
      const timer = setTimeout(() => (auth ? (this.pending.delete(id), reject(new Error('RCON: sem resposta'))) : this.settle(id)), auth ? 4000 : 3000);
      this.pending.set(id, { chunks: [], resolve, reject, timer, auth });
      this.socket.write(packet);
    });
  }

  send(command) { return this.request(command, 2); }

  close() {
    this.socket?.destroy();
    this.socket = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve?.(''); }
    this.pending.clear();
  }
}

// ---------- Telnet console (7 Days to Die) ----------
export class TelnetConsole extends EventEmitter {
  constructor(port, password) {
    super();
    this.port = Number(port);
    this.password = password;
    this.socket = null;
  }

  connect(timeout = 4000) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.port, HOST);
      let buf = '', authed = false;
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Telnet: tempo esgotado')); }, timeout);
      socket.setEncoding('utf8');
      socket.on('error', err => { clearTimeout(timer); reject(err); });
      socket.on('close', () => { this.socket = null; this.emit('close'); });
      socket.on('data', chunk => {
        buf += chunk;
        if (!authed && /password:/i.test(buf)) { socket.write(this.password + '\r\n'); buf = ''; return; }
        if (!authed && /Logon successful|Press 'help'/i.test(buf)) { authed = true; clearTimeout(timer); this.socket = socket; resolve(this); }
        if (!authed && /Password incorrect/i.test(buf)) { clearTimeout(timer); socket.destroy(); reject(new Error('Telnet: senha recusada')); return; }
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        if (authed) for (const l of lines) if (l.trim()) this.emit('line', l);
      });
    });
  }

  get connected() { return Boolean(this.socket && !this.socket.destroyed); }
  send(command) {
    if (!this.connected) throw new Error('Telnet não conectado');
    this.socket.write(command + '\r\n');
  }
  close() { this.socket?.destroy(); }
}

// ---------- Steam A2S_INFO (UDP) ----------
export function a2sInfo(port, timeout = 1500) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const base = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]), Buffer.from('Source Engine Query\0')]);
    const timer = setTimeout(() => { sock.close(); reject(new Error('A2S: sem resposta')); }, timeout);
    const done = (err, val) => { clearTimeout(timer); sock.close(); err ? reject(err) : resolve(val); };
    sock.on('error', err => done(err));
    sock.on('message', msg => {
      const kind = msg[4];
      if (kind === 0x41) { // challenge: repeat the query with it appended
        sock.send(Buffer.concat([base, msg.subarray(5, 9)]), Number(port), HOST);
        return;
      }
      if (kind !== 0x49) return;
      let o = 6;
      const str = () => { const end = msg.indexOf(0, o); const s = msg.toString('utf8', o, end); o = end + 1; return s; };
      const name = str(), map = str(); str(); const game = str();
      o += 2; // app id
      const players = msg[o], maxPlayers = msg[o + 1], bots = msg[o + 2];
      done(null, { name, map, game, players, maxPlayers, bots });
    });
    sock.send(base, Number(port), HOST);
  });
}

// ---------- Minecraft Java server list ping (TCP) ----------
const varint = n => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); };
const packet = (...parts) => { const body = Buffer.concat(parts); return Buffer.concat([varint(body.length), body]); };

export function minecraftPing(port, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(port), HOST);
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('Ping: sem resposta')); }, timeout);
    sock.on('error', err => { clearTimeout(timer); reject(err); });
    sock.on('connect', () => {
      const host = Buffer.from(HOST);
      const portBuf = Buffer.alloc(2); portBuf.writeUInt16BE(Number(port));
      sock.write(packet(varint(0), varint(767), varint(host.length), host, portBuf, varint(1)));
      sock.write(packet(varint(0)));
    });
    sock.on('data', data => {
      buf = Buffer.concat([buf, data]);
      const readVar = offset => { let n = 0, shift = 0, b; do { if (offset >= buf.length) return null; b = buf[offset++]; n |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80); return [n, offset]; };
      const len = readVar(0); if (!len) return;
      if (buf.length < len[1] + len[0]) return;
      const id = readVar(len[1]); const strLen = readVar(id[1]);
      const json = JSON.parse(buf.toString('utf8', strLen[1], strLen[1] + strLen[0]));
      clearTimeout(timer);
      sock.destroy();
      const motd = typeof json.description === 'string' ? json.description : (json.description?.text ?? '');
      resolve({
        name: motd, players: json.players?.online ?? 0, maxPlayers: json.players?.max ?? 0,
        playerNames: (json.players?.sample || []).map(p => p.name), version: json.version?.name,
      });
    });
  });
}

// ---------- Minecraft Bedrock unconnected ping (UDP) ----------
const RAKNET_MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');

export function bedrockPing(port, timeout = 1500) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => { sock.close(); reject(new Error('Ping: sem resposta')); }, timeout);
    sock.on('error', err => { clearTimeout(timer); sock.close(); reject(err); });
    sock.on('message', msg => {
      if (msg[0] !== 0x1c) return;
      clearTimeout(timer);
      sock.close();
      const len = msg.readUInt16BE(33);
      const parts = msg.toString('utf8', 35, 35 + len).split(';');
      resolve({ name: parts[1], version: parts[3], players: Number(parts[4]) || 0, maxPlayers: Number(parts[5]) || 0, map: parts[7] });
    });
    const req = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(8), RAKNET_MAGIC, crypto.randomBytes(8)]);
    req.writeBigInt64BE(BigInt(Date.now()), 1);
    sock.send(req, Number(port), HOST);
  });
}
