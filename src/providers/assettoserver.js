// AssettoServer (github.com/compujuckel/AssettoServer): an Assetto Corsa server with AI traffic and CSP scripts.
// Content comes from the owner's own Assetto Corsa install: before each start the panel copies only what the
// server checks (track data, AI spline, car data.acd) and writes server_cfg.ini, entry_list.ini, extra_cfg.yml
// and csp_extra_options.ini from the settings. The traffic scoring script is served from wwwroot/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, TOOLS_DIR } from '../store.js';
import { AC_TRAFFIC_CARS } from '../catalog.js';
import { IS_WIN, copyOver, download, extract, fetchJson } from '../util.js';

const REPO = 'compujuckel/AssettoServer';
const ASSET = IS_WIN ? 'assetto-server-win-x64.zip' : 'assetto-server-linux-x64.tar.gz';
const SCRIPT = 'hmg_traffic_score.lua';
const PROBE_SCRIPT = 'hmg_traffic_probe.lua';

// Releases are rare and pre-releases weekly; the project recommends the newest pre-release.
async function newestRelease() {
  const list = await fetchJson(`https://api.github.com/repos/${REPO}/releases?per_page=10`);
  const rel = list.find(r => !r.draft && r.assets.some(a => a.name === ASSET));
  if (!rel) throw new Error('Nenhuma versão do AssettoServer encontrada no GitHub');
  return { tag: rel.tag_name, asset: rel.assets.find(a => a.name === ASSET) };
}

export async function installAssettoServer(inst, log) {
  const { tag, asset } = await newestRelease();
  log(`Baixando AssettoServer ${tag}...`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hmg-assettoserver-'));
  try {
    const archive = path.join(tmp, asset.name);
    const sha256 = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : undefined;
    await download(asset.browser_download_url, archive, { sha256 });
    await extract(archive, path.join(tmp, 'files'));
    // cfg/, content/ and the AI cache are the panel's and the server's own; updates leave them alone.
    copyOver(path.join(tmp, 'files'), inst.dir, ['cfg', 'content', 'cache']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { version: tag };
}

export async function latestAssettoServer() {
  return { version: (await newestRelease()).tag };
}

// ---- Assetto Corsa install ----
function steamLibraries() {
  const roots = IS_WIN ? ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'] : [path.join(os.homedir(), '.steam/steam'), path.join(os.homedir(), '.local/share/Steam')];
  const libs = new Set();
  for (const root of roots) {
    const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
    if (!fs.existsSync(vdf)) continue;
    libs.add(root);
    for (const m of fs.readFileSync(vdf, 'utf8').matchAll(/"path"\s+"(.+?)"/g)) libs.add(m[1].replace(/\\\\/g, '\\'));
  }
  return [...libs];
}

export function findAssettoCorsa(custom) {
  const candidates = custom ? [custom] : steamLibraries().map(l => path.join(l, 'steamapps', 'common', 'assettocorsa'));
  const found = candidates.find(p => fs.existsSync(path.join(p, 'content', 'cars')));
  if (!found) {
    throw new Error(custom
      ? `Não encontrei o Assetto Corsa em ${custom} (falta a pasta content/cars).`
      : 'Não encontrei o Assetto Corsa da Steam neste PC. Informe a pasta do jogo nas configurações do servidor (ex.: D:\\Steam\\steamapps\\common\\assettocorsa).');
  }
  return found;
}

// Lists what the install has, so the settings can be checked and offered.
export function listContent(acPath) {
  const ac = findAssettoCorsa(acPath);
  const dirs = p => (fs.existsSync(p) ? fs.readdirSync(p, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) : []);
  const tracks = dirs(path.join(ac, 'content', 'tracks')).map(name => {
    const base = path.join(ac, 'content', 'tracks', name);
    const layouts = dirs(base).filter(l => fs.existsSync(path.join(base, l, 'data')) || fs.existsSync(path.join(base, `models_${l}.ini`)));
    const hasAi = dir => fs.existsSync(dir) && fs.readdirSync(dir).some(f => /^fast_lane.*\.aip?$/i.test(f));
    return { name, layouts: layouts.map(l => ({ name: l, ai: hasAi(path.join(base, l, 'ai')) })), ai: hasAi(path.join(base, 'ai')) };
  });
  const cars = dirs(path.join(ac, 'content', 'cars'));
  return { path: ac, tracks, cars };
}

// ---- copying content ----
function copyFileIfChanged(src, dest) {
  if (!fs.existsSync(src)) return false;
  const s = fs.statSync(src);
  if (fs.existsSync(dest)) {
    const d = fs.statSync(dest);
    if (d.size === s.size && Math.abs(d.mtimeMs - s.mtimeMs) < 2000) return false;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  fs.utimesSync(dest, s.atime, s.mtime);
  return true;
}

function copyDirIfChanged(src, dest) {
  if (!fs.existsSync(src)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) n += copyDirIfChanged(path.join(src, e.name), path.join(dest, e.name));
    else if (copyFileIfChanged(path.join(src, e.name), path.join(dest, e.name))) n++;
  }
  return n;
}

const skinsOf = carDir => {
  const dir = path.join(carDir, 'skins');
  return fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) : [];
};

const listSetting = v => String(v || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);

// Traffic profiles: every distinct model is loaded on every player's PC, so fewer models with more slots each
// give the same amount of traffic for less memory and loading time.
const TRAFFIC_PROFILES = {
  leve: ['traffic_aegis_toyota_markii_taxi', 'traffic_aegis_toyota_prius', 'traffic_isuzu_npr', 'traffic_aegis_toyota_vellfire', 'traffic_aegis_suzuki_alto_works', 'traffic_toyota_camry'],
  normal: ['traffic_aegis_toyota_markii_taxi', 'traffic_aegis_toyota_prius', 'traffic_isuzu_npr', 'traffic_aegis_toyota_vellfire', 'traffic_aegis_suzuki_alto_works', 'traffic_toyota_camry',
    'traffic_aegis_ud_quon', 'traffic_aegis_subaru_levorg', 'traffic_nissan_leaf', 'traffic_aegis_izuzu_npr_box'],
};
const AI_SLOTS_TARGET = 60;

// Heavy vehicles of the bundled traffic packs: real length (so following cars keep a safe gap), slower
// acceleration, and only the slow lane (the left one on Japanese roads like Shutoko).
const HEAVY = {
  traffic_aegis_airport_bus: { pre: 6, post: 6 },
  traffic_aegis_ud_quon: { pre: 5.5, post: 5.5 },
  traffic_aegis_izuzu_npr: { pre: 3.2, post: 3 },
  traffic_aegis_izuzu_npr_box: { pre: 3.2, post: 3.2 },
  traffic_isuzu_npr: { pre: 3.2, post: 3 },
  traffic_isuzu_flatbed: { pre: 3.2, post: 3.4 },
  traffic_isuzu_hauler: { pre: 3.2, post: 3.4 },
  traffic_isuzu_haulerb: { pre: 3.2, post: 3.4 },
  traffic_isuzu_tanker: { pre: 3.2, post: 3.4 },
};

function trafficModels(s) {
  if (!s.traffic) return [];
  if (s.trafficProfile === 'personalizado') return listSetting(s.trafficCars);
  if (s.trafficProfile === 'variado') return listSetting(AC_TRAFFIC_CARS);
  return TRAFFIC_PROFILES[s.trafficProfile] || TRAFFIC_PROFILES.leve;
}

// AiParams lines for the "realista" preset, tuned for highways like Shutoko.
function realisticAi(traffic) {
  const lines = [
    '  MinAiSafetyDistanceMeters: 25',
    '  MaxAiSafetyDistanceMeters: 80',
    '  MinCollisionStopTimeSeconds: 2',
    '  MaxCollisionStopTimeSeconds: 4',
    '  IgnoreObstaclesAfterSeconds: 8',
    '  DefaultDeceleration: 7',
    '  CorneringSpeedFactor: 0.6',
    '  RightLaneOffsetKph: 15',
    '  MaxSpeedVariationPercent: 0.12',
  ];
  const heavy = traffic.filter(m => HEAVY[m]);
  if (heavy.length) {
    lines.push('  CarSpecificOverrides:');
    for (const m of heavy) {
      lines.push(`    - Model: ${m}`, '      Acceleration: 1.5', '      Deceleration: 6', `      VehicleLengthPreMeters: ${HEAVY[m].pre}`,
        `      VehicleLengthPostMeters: ${HEAVY[m].post}`, '      MinAiSafetyDistanceMeters: 30', '      AllowedLanes: [Left]');
    }
  }
  return lines;
}

// CSP reads options encoded in the track name: csp/<minimum CSP build>/../<flags letter>/../<track>, where the
// letter is 'A' + flags (1 custom car physics, 2 custom track physics, 4 hide pit crew). See AssettoServer's
// CSPTrackOptions. 2651 is CSP 0.2.0, the version the server already requires.
const CSP_MIN_BUILD = 2651;
const TRACK_FLAG_CUSTOM_PHYSICS = 2;
const trackName = s => (s.trackPhysicsFlag
  ? `csp/${CSP_MIN_BUILD}/../${String.fromCharCode(65 + TRACK_FLAG_CUSTOM_PHYSICS)}/../${s.track}`
  : s.track);

// ---- config files ----
const ini = sections => Object.entries(sections).map(([name, keys]) => `[${name}]\r\n${Object.entries(keys).map(([k, v]) => `${k}=${v ?? ''}`).join('\r\n')}\r\n`).join('\r\n');
const yamlString = s => JSON.stringify(String(s ?? ''));

// Steam's game server API looks for steamclient64.dll through the Steam install of the current Windows user.
// The installed panel runs as a service (SYSTEM), which has none, so the DLLs go next to the server instead.
const STEAM_DLLS = ['steamclient64.dll', 'tier0_s64.dll', 'vstdlib_s64.dll'];
function steamClientDlls(inst, log) {
  if (!IS_WIN || STEAM_DLLS.every(f => fs.existsSync(path.join(inst.dir, f)))) return;
  const sources = [...steamLibraries().slice(0, 1), path.join(TOOLS_DIR, 'steamcmd')];
  const from = sources.find(dir => STEAM_DLLS.every(f => fs.existsSync(path.join(dir, f))));
  if (!from) {
    log('Atenção: não encontrei o steamclient64.dll (Steam ou SteamCMD). Se o servidor reclamar do Steam, instale a Steam neste PC.');
    return;
  }
  for (const f of STEAM_DLLS) fs.copyFileSync(path.join(from, f), path.join(inst.dir, f));
  log(`Bibliotecas da Steam copiadas de ${from}.`);
}

export async function prepareAssettoServer(inst, log) {
  const s = inst.cfg.settings;
  steamClientDlls(inst, log);
  const content = listContent(s.acPath || '');
  const ac = content.path;
  const track = content.tracks.find(t => t.name === s.track);
  if (!track) throw new Error(`A pista "${s.track}" não está instalada no Assetto Corsa (${ac}\\content\\tracks).`);
  const layout = s.layout ? track.layouts.find(l => l.name === s.layout) : null;
  if (s.layout && !layout) throw new Error(`A pista ${s.track} não tem o layout "${s.layout}". Layouts: ${track.layouts.map(l => l.name).join(', ') || 'nenhum'}.`);

  const cars = listSetting(s.cars), traffic = trafficModels(s);
  if (!cars.length) throw new Error('Escolha pelo menos um carro para os jogadores.');
  const missing = [...cars, ...traffic].filter(c => !content.cars.includes(c));
  if (missing.length) throw new Error(`Carros que não estão instalados no Assetto Corsa: ${missing.join(', ')}.`);
  const hasAi = layout ? layout.ai || track.ai : track.ai;
  if (traffic.length && !hasAi) log(`Atenção: ${s.track}${s.layout ? `/${s.layout}` : ''} não tem traçado de IA (ai/fast_lane.ai); o servidor vai abrir sem trânsito.`);
  const useAi = traffic.length > 0 && hasAi;

  // Only what the server reads: track data, layouts' data and AI, car data.acd and collider. Models stay out.
  const srcTrack = path.join(ac, 'content', 'tracks', s.track), dstTrack = path.join(inst.dir, 'content', 'tracks', s.track);
  let copied = 0;
  for (const f of ['models.ini', s.layout && `models_${s.layout}.ini`].filter(Boolean)) copied += copyFileIfChanged(path.join(srcTrack, f), path.join(dstTrack, f)) ? 1 : 0;
  for (const d of ['data', 'ai', 'ui', s.layout && path.join(s.layout, 'data'), s.layout && path.join(s.layout, 'ai')].filter(Boolean)) copied += copyDirIfChanged(path.join(srcTrack, d), path.join(dstTrack, d));
  const skins = {};
  for (const car of new Set([...cars, ...traffic])) {
    const src = path.join(ac, 'content', 'cars', car), dst = path.join(inst.dir, 'content', 'cars', car);
    for (const f of ['data.acd', 'collider.kn5', path.join('ui', 'ui_car.json')]) copied += copyFileIfChanged(path.join(src, f), path.join(dst, f)) ? 1 : 0;
    skins[car] = skinsOf(src);
  }
  if (copied) log(`Conteúdo copiado do Assetto Corsa: ${copied} arquivo(s).`);

  // Entry list: enough player slots for every car, then about 60 AI slots spread over the traffic models.
  const maxPlayers = Math.max(1, Number(s.maxPlayers) || 16);
  const perCar = Math.max(1, Math.ceil(maxPlayers / cars.length));
  const perTraffic = traffic.length ? Math.max(2, Math.ceil(AI_SLOTS_TARGET / traffic.length)) : 0;
  const entries = [];
  for (const car of cars) for (let i = 0; i < perCar; i++) entries.push({ MODEL: car, SKIN: skins[car][i % Math.max(1, skins[car].length)] || '', SPECTATOR_MODE: 0, DRIVERNAME: '', TEAM: '', GUID: '', BALLAST: 0, RESTRICTOR: 0 });
  if (useAi) for (const car of traffic) for (let i = 0; i < perTraffic; i++) entries.push({ MODEL: car, SKIN: skins[car][i % Math.max(1, skins[car].length)] || '', SPECTATOR_MODE: 0, DRIVERNAME: '', TEAM: '', GUID: '', BALLAST: 0, RESTRICTOR: 0, AI: 'fixed' });
  if (entries.length > 255) throw new Error(`São ${entries.length} vagas (jogadores + trânsito); o máximo do Assetto Corsa é 255. Diminua os jogadores ou os carros de trânsito.`);

  const cfg = path.join(inst.dir, 'cfg');
  fs.mkdirSync(cfg, { recursive: true });
  const hour = Math.min(18, Math.max(8, Number(s.timeOfDay) || 14));
  fs.writeFileSync(path.join(cfg, 'server_cfg.ini'), ini({
    SERVER: {
      NAME: s.serverName, CARS: [...new Set([...cars, ...(useAi ? traffic : [])])].join(';'), TRACK: trackName(s), CONFIG_TRACK: s.layout || '',
      SUN_ANGLE: Math.round(16 * (hour - 13)), PASSWORD: s.password || '', ADMIN_PASSWORD: s.adminPassword || '',
      UDP_PORT: s.port, TCP_PORT: s.port, HTTP_PORT: s.httpPort, MAX_CLIENTS: entries.length,
      REGISTER_TO_LOBBY: s.publicList ? 1 : 0, PICKUP_MODE_ENABLED: 1, LOCKED_ENTRY_LIST: 0, LOOP_MODE: 1, SLEEP_TIME: 1,
      CLIENT_SEND_INTERVAL_HZ: 18, SEND_BUFFER_SIZE: 0, RECV_BUFFER_SIZE: 0, KICK_QUORUM: 85, VOTING_QUORUM: 80, VOTE_DURATION: 20,
      BLACKLIST_MODE: 1, FUEL_RATE: 0, DAMAGE_MULTIPLIER: 0, TYRE_WEAR_RATE: 0, ALLOWED_TYRES_OUT: -1, ABS_ALLOWED: 1, TC_ALLOWED: 1,
      STABILITY_ALLOWED: 1, AUTOCLUTCH_ALLOWED: 1, TYRE_BLANKETS_ALLOWED: 1, FORCE_VIRTUAL_MIRROR: 0, START_RULE: 2,
      RACE_GAS_PENALTY_DISABLED: 1, TIME_OF_DAY_MULT: 1, RESULT_SCREEN_TIME: 10, MAX_BALLAST_KG: 0, QUALIFY_MAX_WAIT_PERC: 120,
      RACE_PIT_WINDOW_START: 0, RACE_PIT_WINDOW_END: 0, REVERSED_GRID_RACE_POSITIONS: 0, RACE_OVER_TIME: 180, RACE_EXTRA_LAP: 0,
      WELCOME_MESSAGE: '',
    },
    PRACTICE: { NAME: 'Practice', TIME: 720, IS_OPEN: 1 },
    DYNAMIC_TRACK: { SESSION_START: 100, RANDOMNESS: 0, SESSION_TRANSFER: 100, LAP_GAIN: 0 },
    WEATHER_0: { GRAPHICS: '3_clear', BASE_TEMPERATURE_AMBIENT: 22, BASE_TEMPERATURE_ROAD: 8, VARIATION_AMBIENT: 0, VARIATION_ROAD: 0, WIND_BASE_SPEED_MIN: 0, WIND_BASE_SPEED_MAX: 0, WIND_BASE_DIRECTION: 0, WIND_VARIATION_DIRECTION: 0 },
  }));
  fs.writeFileSync(path.join(cfg, 'entry_list.ini'), ini(Object.fromEntries(entries.map((e, i) => [`CAR_${i}`, e]))));

  const density = Math.min(200, Math.max(10, Number(s.trafficDensity) || 100)) / 100;
  fs.writeFileSync(path.join(cfg, 'extra_cfg.yml'), [
    '# Gerado pelo Host My Game antes de cada início. Altere pelas configurações do servidor no painel.',
    'EnableServerDetails: true',
    `ServerDescription: ${yamlString(s.description)}`,
    'EnableClientMessages: true',
    'EnableWeatherFx: true',
    `EnableAi: ${useAi}`,
    'AiParams:',
    `  MaxPlayerCount: ${maxPlayers}`,
    `  TrafficDensity: ${density}`,
    `  MaxSpeedKph: ${Math.min(200, Math.max(40, Number(s.trafficSpeed) || 90))}`,
    `  TwoWayTraffic: ${Boolean(s.twoWay)}`,
    '  HideAiCars: true',
    '  NamePrefix: "Traffic"',
    ...(useAi && s.trafficBehavior !== 'padrao' ? realisticAi(traffic) : []),
    '',
  ].join('\n'));

  // The traffic scoring script; CSP fills in the server's address and HTTP port on each player's PC.
  const www = path.join(inst.dir, 'wwwroot');
  fs.mkdirSync(www, { recursive: true });
  const options = path.join(cfg, 'csp_extra_options.ini');
  const scripts = [s.scoring && SCRIPT, s.clientTrafficTest && PROBE_SCRIPT].filter(Boolean);
  for (const f of scripts) fs.copyFileSync(path.join(ROOT, 'src', 'providers', 'assets', f), path.join(www, f));
  if (scripts.length) {
    fs.writeFileSync(options, scripts.map((f, i) => `[SCRIPT_${i + 1}-${f.replace(/\.lua$/, '')}]\r\nSCRIPT = 'http://{ServerIP}:{ServerHTTPPort}/static/${f}'\r\n`).join('\r\n'));
  } else {
    fs.rmSync(options, { force: true });
  }
  log(`Servidor: ${s.track}${s.layout ? `/${s.layout}` : ''}, ${cars.length} carro(s) para até ${maxPlayers} jogadores${useAi ? `, trânsito com ${traffic.length} modelo(s) × ${perTraffic} vagas (${s.trafficBehavior === 'padrao' ? 'comportamento padrão' : 'comportamento realista'})` : ', sem trânsito'}${s.scoring ? ', pontuação de tráfego ligada' : ''}.`);
}
