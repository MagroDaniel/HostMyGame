import fs from 'node:fs';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { IS_WIN, readLines } from './util.js';

// Windows has no /proc and wmic is gone, so one long-lived PowerShell answers "pid,pid" lines with JSON.
// Keeping it alive avoids paying PowerShell's startup cost on every sample. Usage is summed over each
// root's process tree (many servers are a small launcher plus the real game process); the tree itself
// is refreshed every 10s because the WMI query is the expensive part.
const PS_LOOP = `$cache = @{}
while ($null -ne ($l = [Console]::In.ReadLine())) {
  $roots = @($l -split ',' | Where-Object { $_ } | ForEach-Object { [int]$_ })
  $now = [DateTime]::UtcNow
  $all = $null
  $out = foreach ($r in $roots) {
    $c = $cache[$r]
    if (-not $c -or ($now - $c.t).TotalSeconds -gt 10) {
      if (-not $all) { $all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | Select-Object ProcessId,ParentProcessId) }
      $ids = New-Object System.Collections.Generic.List[int]
      $ids.Add($r)
      for ($i = 0; $i -lt $ids.Count -and $i -lt 64; $i++) {
        foreach ($p in $all) { if ($p.ParentProcessId -eq $ids[$i] -and $p.ProcessId -ne $ids[$i] -and -not $ids.Contains([int]$p.ProcessId)) { $ids.Add([int]$p.ProcessId) } }
      }
      $c = @{ t = $now; ids = $ids.ToArray() }
      $cache[$r] = $c
    }
    $cpu = 0.0; $mem = 0
    foreach ($p in (Get-Process -Id $c.ids -ErrorAction SilentlyContinue)) { $cpu += $p.CPU; $mem += $p.WorkingSet64 }
    @{ pid = $r; cpu = $cpu; mem = $mem }
  }
  [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @($out)))
  [Console]::Out.Flush()
}`;

let ps = null;
const waiting = [];

function powershell() {
  if (ps) return ps;
  ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_LOOP], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  readLines(ps.stdout, line => {
    const resolve = waiting.shift();
    if (!resolve) return;
    try { resolve(JSON.parse(line)); } catch { resolve([]); }
  });
  ps.on('exit', () => {
    ps = null;
    while (waiting.length) waiting.shift()([]);
  });
  return ps;
}

function sampleWindows(pids) {
  return new Promise(resolve => {
    waiting.push(rows => resolve(new Map(rows.map(r => [r.pid, { cpuSec: r.cpu || 0, mem: r.mem || 0 }]))));
    powershell().stdin.write(pids.join(',') + '\n');
  });
}

function sampleProc(pids) {
  const out = new Map();
  for (const pid of pids) {
    try {
      // Fields after the "(comm)" part; utime/stime are 14/15 and rss is 24 in the full stat line.
      const fields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
      out.set(pid, { cpuSec: (Number(fields[11]) + Number(fields[12])) / 100, mem: Number(fields[21]) * 4096 });
    } catch { /* process exited between listing and sampling */ }
  }
  return out;
}

export function sampleProcesses(pids) {
  if (!pids.length) return Promise.resolve(new Map());
  if (IS_WIN) return sampleWindows(pids);
  if (process.platform === 'linux') return Promise.resolve(sampleProc(pids));
  return Promise.resolve(new Map());
}

let prevCpu = null;
export function systemUsage() {
  const cpus = os.cpus();
  const totals = cpus.reduce((acc, c) => {
    const t = c.times;
    acc.idle += t.idle;
    acc.total += t.user + t.nice + t.sys + t.idle + t.irq;
    return acc;
  }, { idle: 0, total: 0 });
  let cpu = 0;
  if (prevCpu) {
    const total = totals.total - prevCpu.total;
    cpu = total > 0 ? (1 - (totals.idle - prevCpu.idle) / total) * 100 : 0;
  }
  prevCpu = totals;
  return { cpu, memUsed: os.totalmem() - os.freemem(), memTotal: os.totalmem(), cores: cpus.length };
}

let osName = null;
// The PC's address on the home network, skipping virtual adapters (VMware, Hyper-V, VPNs).
function lanIp() {
  const virtual = /vmware|virtualbox|vethernet|hyper-v|loopback|tailscale|zerotier|wsl|docker|vpn|radmin|hamachi/i;
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) candidates.push({ address: a.address, virtual: virtual.test(name) });
    }
  }
  return (candidates.find(c => !c.virtual) || candidates[0])?.address || '127.0.0.1';
}

export function systemInfo() {
  if (osName === null) {
    osName = os.type();
    if (IS_WIN) {
      try {
        const out = spawnSync('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_OperatingSystem).Caption'], { encoding: 'utf8', windowsHide: true });
        osName = out.stdout.trim().replace(/^Microsoft\s+/, '') || osName;
      } catch { /* keep generic name */ }
    }
  }
  const cpus = os.cpus();
  return {
    os: osName, hostname: os.hostname(), cpuModel: cpus[0]?.model.trim(), cores: cpus.length,
    memTotal: os.totalmem(), uptime: os.uptime(), node: process.version, lanIp: lanIp(),
  };
}

export function stopSampler() {
  ps?.kill();
}
