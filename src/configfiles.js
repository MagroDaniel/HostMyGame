// Writes individual settings into game config files while leaving everything else in them untouched.
import fs from 'node:fs';
import path from 'node:path';

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isNum = v => typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(String(v));
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function setLine(text, re, line) {
  if (re.test(text)) return text.replace(re, () => line);
  return text + (text && !text.endsWith('\n') ? '\n' : '') + line + '\n';
}

const writers = {
  properties(text, values) {
    for (const [key, value] of Object.entries(values)) {
      text = setLine(text, new RegExp(`^${escRe(key)}\\s*=.*$`, 'm'), `${key}=${value}`);
    }
    return text;
  },

  spaced(text, values) {
    for (const [key, value] of Object.entries(values)) {
      if (value === '') continue;
      text = setLine(text, new RegExp(`^${escRe(key)}(\\s.*)?$`, 'mi'), `${key} ${value}`);
    }
    return text;
  },

  toml(text, values) {
    for (const [key, value] of Object.entries(values)) {
      const v = isNum(value) || value === 'true' || value === 'false' ? value : JSON.stringify(String(value));
      text = setLine(text, new RegExp(`^${escRe(key)}\\s*=.*$`, 'm'), `${key} = ${v}`);
    }
    return text;
  },

  cfg(text, values) {
    for (const [key, value] of Object.entries(values)) {
      const re = new RegExp(`^(\\s*${escRe(key)}\\s*=\\s*)(.*?);(.*)$`, 'mi');
      const existing = text.match(re);
      const quoted = existing ? existing[2].trim().startsWith('"') : !isNum(value);
      const v = quoted ? `"${String(value).replace(/"/g, '""')}"` : value;
      text = existing ? text.replace(re, (_, pre, __, post) => `${pre}${v};${post}`) : setLine(text, /$^/, `${key} = ${v};`);
    }
    return text;
  },

  // Keys look like "[Section]Key"; the separator style already used in the file is kept.
  ini(text, values) {
    const spaced = /^\s*[\w.]+ = /m.test(text);
    let lines = text.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    for (const [rawKey, value] of Object.entries(values)) {
      const m = rawKey.match(/^\[(.+)\](.+)$/);
      const [section, key] = m ? [m[1], m[2]] : [null, rawKey];
      let start = 0, end = lines.length;
      if (section) {
        const header = lines.findIndex(l => l.trim().toLowerCase() === `[${section}]`.toLowerCase());
        if (header < 0) {
          if (lines.length && lines.at(-1).trim() !== '') lines.push('');
          lines.push(`[${section}]`);
          start = lines.length;
          end = lines.length;
        } else {
          start = header + 1;
          const next = lines.findIndex((l, i) => i > header && /^\s*\[.*\]\s*$/.test(l));
          end = next < 0 ? lines.length : next;
        }
      }
      const entry = `${key}${spaced ? ' = ' : '='}${value}`;
      const idx = lines.slice(start, end).findIndex(l => new RegExp(`^\\s*${escRe(key)}\\s*=`, 'i').test(l));
      if (idx >= 0) lines[start + idx] = entry;
      else {
        let at = end;
        while (at > start && lines[at - 1].trim() === '') at--; // keep blank line before next section
        lines.splice(at, 0, entry);
      }
    }
    return lines.join('\n') + '\n';
  },

  // Palworld keeps every option on one line: OptionSettings=(Key=Value,Key="text",...)
  palworld(text, values) {
    const m = text.match(/OptionSettings=\((.*)\)/);
    if (!m) return text;
    const entries = [];
    let depth = 0, inQuote = false, cur = '';
    for (const ch of m[1]) {
      if (ch === '"') inQuote = !inQuote;
      if (!inQuote && ch === '(') depth++;
      if (!inQuote && ch === ')') depth--;
      if (ch === ',' && !inQuote && depth === 0) { entries.push(cur); cur = ''; } else cur += ch;
    }
    if (cur) entries.push(cur);
    const map = new Map(entries.map(e => { const i = e.indexOf('='); return [e.slice(0, i), e.slice(i + 1)]; }));
    for (const [k, v] of Object.entries(values)) map.set(k, v);
    const body = [...map].map(([k, v]) => `${k}=${v}`).join(',');
    return text.replace(/OptionSettings=\(.*\)/, () => `OptionSettings=(${body})`);
  },

  xmlprop(text, values) {
    for (const [key, value] of Object.entries(values)) {
      const re = new RegExp(`(<property\\s+name="${escRe(key)}"\\s+value=")[^"]*(")`, 'i');
      if (re.test(text)) text = text.replace(re, (_, a, b) => `${a}${xmlEsc(value)}${b}`);
      else text = text.replace(/(\s*<\/ServerSettings>)/i, `\n\t<property name="${key}" value="${xmlEsc(value)}" />$1`);
    }
    return text;
  },

  // Sets attributes on the root element (e.g. <serversettings name="..." port="...">).
  xmlattr(text, values) {
    const rootRe = /<(?![?!])([\w-]+)([^>]*)>/;
    const root = text.match(rootRe);
    if (!root) return text;
    let attrs = root[2];
    for (const [key, value] of Object.entries(values)) {
      const re = new RegExp(`(\\s${escRe(key)}=")[^"]*(")`, 'i');
      attrs = re.test(attrs) ? attrs.replace(re, (_, a, b) => `${a}${xmlEsc(value)}${b}`) : `${attrs.replace(/\s*\/?$/, '')} ${key}="${xmlEsc(value)}"${attrs.endsWith('/') ? ' /' : ''}`;
    }
    return text.replace(rootRe, `<${root[1]}${attrs}>`);
  },
};

function writeJson(file, values, create) {
  let data = {};
  if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  for (const [dotted, value] of Object.entries(values)) {
    const keys = dotted.split('.');
    let obj = data;
    for (const k of keys.slice(0, -1)) {
      if (typeof obj[k] !== 'object' || obj[k] === null) {
        if (!create) { obj = null; break; }
        obj[k] = {};
      }
      obj = obj[k];
    }
    const last = keys.at(-1);
    if (!obj || (!(last in obj) && !create)) continue;
    // Keep the type the game already uses for the key; otherwise use the setting's own type.
    const current = obj[last];
    if (typeof current === 'number' && isNum(value)) obj[last] = Number(value);
    else if (typeof current === 'boolean') obj[last] = value === true || /^(true|1)$/i.test(String(value));
    else obj[last] = value;
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function applyConfigWrite(dir, entry, values) {
  const file = path.join(dir, entry.path);
  if (!fs.existsSync(file) && entry.seed && fs.existsSync(path.join(dir, entry.seed))) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(dir, entry.seed), file);
  }
  const exists = fs.existsSync(file);
  if (!exists && !entry.create) return false; // the game creates it on first run; applied next start
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (entry.format === 'json') {
    writeJson(file, values, entry.create);
    return true;
  }
  const writer = writers[entry.format];
  if (!writer) throw new Error(`Formato de configuração desconhecido: ${entry.format}`);
  const text = exists ? fs.readFileSync(file, 'utf8') : '';
  const stringValues = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v ?? '')]));
  fs.writeFileSync(file, writer(text, stringValues));
  return true;
}
