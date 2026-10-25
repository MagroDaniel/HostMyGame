import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA_DIR = process.env.HMG_DATA_DIR ? path.resolve(process.env.HMG_DATA_DIR) : path.join(ROOT, 'data');
export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
export const TOOLS_DIR = path.join(DATA_DIR, 'tools');
export const DEFAULT_INSTANCES_DIR = path.join(DATA_DIR, 'instances');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const FILE = path.join(DATA_DIR, 'panel.json');
const defaults = () => ({
  host: '127.0.0.1',
  port: 8082,
  instancesDir: '',
  steamUser: '',
  curseforgeKey: '',
  users: [],
  instances: [],
});

fs.mkdirSync(DEFAULT_INSTANCES_DIR, { recursive: true });
fs.mkdirSync(BACKUPS_DIR, { recursive: true });

// Whole panel state lives in one JSON file; it is small and written rarely.
export const db = fs.existsSync(FILE)
  ? { ...defaults(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }
  : defaults();

export function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE);
}

export const instancesRoot = () => db.instancesDir || DEFAULT_INSTANCES_DIR;
export const newId = () => crypto.randomBytes(6).toString('hex');
