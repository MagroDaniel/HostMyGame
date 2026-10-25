import fs from 'node:fs';

// Follows a log file the way `tail -F` does: only new content, and it survives the file being
// rotated or recreated (Unreal and Unity servers do this on every start).
export class LogTail {
  constructor(file, onLine) {
    this.file = file;
    this.onLine = onLine;
    this.pos = null;
    this.partial = '';
    this.timer = setInterval(() => this.poll(), 1000);
    this.poll(true);
  }

  poll(initial = false) {
    let st;
    try { st = fs.statSync(this.file, { bigint: true }); } catch { this.pos = 0; return; }
    const size = Number(st.size);
    if (this.pos === null) this.pos = initial ? size : 0;
    if (this.ino !== undefined && st.ino !== this.ino) this.pos = 0; // replaced by a new file
    this.ino = st.ino;
    if (size < this.pos) { this.pos = 0; this.partial = ''; } // truncated
    st = { size };
    if (st.size === this.pos) return;
    const len = Math.min(st.size - this.pos, 4 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
      fs.readSync(fd, buf, 0, len, this.pos);
    } catch { return; } finally { if (fd !== undefined) fs.closeSync(fd); }
    this.pos += len;
    const lines = (this.partial + buf.toString('utf8')).split(/\r?\n/);
    this.partial = lines.pop();
    for (const line of lines) if (line.trim()) this.onLine(line);
  }

  close() {
    clearInterval(this.timer);
  }
}
