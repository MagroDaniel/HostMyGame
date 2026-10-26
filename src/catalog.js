// Game catalog. Steam app IDs and launch executables were checked against SteamCMD's app_info.
//
// Template fields:
//   provider      steamcmd | minecraft | download | generic
//   exe / args    launch command; {{setting}} placeholders (also {{dir}}, {{java}}, {{x+1}})
//   settings      per-game options shown when creating/configuring an instance
//   configWrites  values pushed into the game's own config files before every start
//   console       stdin | rcon | telnet | log  (how commands reach the server)
//   stop          graceful stop commands; without it the process is ended
//   query         how to read players: a2s | minecraft | bedrock | rcon-palworld
//   logFile       file tailed into the console (for servers that don't write to stdout)

const img = appId => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;

// ---- reusable settings ----
const S = {
  serverName: (def = 'Meu servidor') => ({ key: 'serverName', label: 'Nome do servidor', type: 'text', default: def }),
  password: (extra = {}) => ({ key: 'password', label: 'Senha para entrar (vazio = sem senha)', type: 'password', default: '', ...extra }),
  adminPassword: () => ({ key: 'adminPassword', label: 'Senha de administrador', type: 'password', default: '$random' }),
  rconPassword: () => ({ key: 'rconPassword', label: 'Senha RCON', type: 'password', default: '$random', advanced: true }),
  port: (def, label = 'Porta do jogo') => ({ key: 'port', label, type: 'port', default: def }),
  queryPort: def => ({ key: 'queryPort', label: 'Porta de consulta (Steam)', type: 'port', default: def }),
  rconPort: def => ({ key: 'rconPort', label: 'Porta RCON', type: 'port', default: def, advanced: true }),
  maxPlayers: def => ({ key: 'maxPlayers', label: 'Máximo de jogadores', type: 'number', default: def, min: 1, max: 1000 }),
  world: (def = 'Mundo', label = 'Nome do mundo / save') => ({ key: 'world', label, type: 'text', default: def }),
  map: (def, options) => ({ key: 'map', label: 'Mapa', type: options ? 'select' : 'text', default: def, options }),
  memory: def => ({ key: 'memoryMb', label: 'Memória RAM (MB)', type: 'number', default: def, min: 512, max: 65536 }),
};

// ---- Minecraft ----
const MC_GAMEMODES = [['survival', 'Sobrevivência'], ['creative', 'Criativo'], ['adventure', 'Aventura'], ['spectator', 'Espectador']];
const MC_DIFFICULTIES = [['peaceful', 'Pacífico'], ['easy', 'Fácil'], ['normal', 'Normal'], ['hard', 'Difícil']];

const minecraftJava = (flavor, name, description) => ({
  id: `minecraft-${flavor}`, name, category: 'Minecraft', provider: 'minecraft', flavor, platforms: ['windows', 'linux'],
  description, eula: true,
  settings: [
    { key: 'version', label: 'Versão do Minecraft', type: 'text', default: 'latest', hint: '"latest" = sempre a mais recente; ou ex.: 1.21.4' },
    ...(['fabric', 'forge', 'neoforge'].includes(flavor)
      ? [{ key: 'loaderVersion', label: `Versão do ${{ fabric: 'Fabric Loader', forge: 'Forge', neoforge: 'NeoForge' }[flavor]}`, type: 'text', default: '', advanced: true, hint: 'Vazio = a recomendada. Os modpacks preenchem sozinhos (ex.: 47.2.0).' }]
      : []),
    S.memory(4096),
    S.port(25565),
    S.maxPlayers(20),
    { key: 'motd', label: 'Mensagem do servidor (MOTD)', type: 'text', default: 'Um servidor Minecraft' },
    { key: 'gamemode', label: 'Modo de jogo', type: 'select', default: 'survival', options: MC_GAMEMODES },
    { key: 'difficulty', label: 'Dificuldade', type: 'select', default: 'normal', options: MC_DIFFICULTIES },
    { key: 'pvp', label: 'PvP', type: 'bool', default: true, on: 'true', off: 'false' },
    { key: 'onlineMode', label: 'Modo online (só contas originais)', type: 'bool', default: true, on: 'true', off: 'false' },
    { key: 'whitelist', label: 'Lista branca (whitelist)', type: 'bool', default: false, on: 'true', off: 'false' },
    { key: 'levelSeed', label: 'Semente do mundo (opcional)', type: 'text', default: '' },
    { key: 'viewDistance', label: 'Distância de visão (chunks)', type: 'number', default: 10, min: 3, max: 32, advanced: true },
    { key: 'javaPath', label: 'Java ("auto" = o painel baixa a versão certa)', type: 'text', default: 'auto', advanced: true },
    { key: 'jvmArgs', label: 'Argumentos extras da JVM', type: 'text', default: '', advanced: true },
  ],
  configWrites: [{
    path: 'server.properties', format: 'properties', create: true,
    values: {
      'server-port': '{{port}}', 'max-players': '{{maxPlayers}}', motd: '{{motd}}', gamemode: '{{gamemode}}',
      difficulty: '{{difficulty}}', pvp: '{{pvp}}', 'online-mode': '{{onlineMode}}', 'white-list': '{{whitelist}}',
      'enforce-whitelist': '{{whitelist}}', 'level-seed': '{{levelSeed}}', 'view-distance': '{{viewDistance}}',
    },
  }],
  ports: [{ name: 'Jogo', port: '{{port}}', proto: 'tcp' }],
  console: 'stdin',
  stop: { commands: ['stop'] },
  ready: 'Done \\(',
  query: { type: 'minecraft', port: '{{port}}' },
  playerLog: { join: '\\]: (\\w{3,16}) joined the game', leave: '\\]: (\\w{3,16}) left the game' },
  backupPaths: '.',
  configFiles: ['server.properties', 'ops.json', 'whitelist.json', 'banned-players.json'],
});

const MINECRAFT = [
  minecraftJava('vanilla', 'Minecraft Java (Vanilla)', 'Servidor oficial da Mojang.'),
  minecraftJava('paper', 'Minecraft Java (Paper)', 'Servidor otimizado com suporte a plugins Bukkit/Spigot.'),
  minecraftJava('purpur', 'Minecraft Java (Purpur)', 'Baseado no Paper, com mais opções de configuração.'),
  minecraftJava('fabric', 'Minecraft Java (Fabric)', 'Servidor com mods Fabric. Coloque os mods na pasta mods/.'),
  minecraftJava('forge', 'Minecraft Java (Forge)', 'Servidor com mods Forge (Minecraft 1.17 ou mais novo). Coloque os mods na pasta mods/.'),
  minecraftJava('neoforge', 'Minecraft Java (NeoForge)', 'Servidor com mods NeoForge. Coloque os mods na pasta mods/.'),
  {
    id: 'minecraft-velocity', name: 'Minecraft Velocity (proxy)', category: 'Minecraft', provider: 'minecraft', flavor: 'velocity',
    platforms: ['windows', 'linux'], description: 'Proxy para ligar vários servidores Minecraft.',
    settings: [
      { key: 'version', label: 'Versão do Velocity ("latest" = mais recente)', type: 'text', default: 'latest' },
      S.memory(1024), S.port(25577),
      { key: 'javaPath', label: 'Java ("auto" = o painel baixa a versão certa)', type: 'text', default: 'auto', advanced: true },
      { key: 'jvmArgs', label: 'Argumentos extras da JVM', type: 'text', default: '', advanced: true },
    ],
    ports: [{ name: 'Proxy', port: '{{port}}', proto: 'tcp' }],
    console: 'stdin', stop: { commands: ['end'] }, ready: 'Done \\(',
    query: { type: 'minecraft', port: '{{port}}' },
    backupPaths: '.', configFiles: ['velocity.toml'],
  },
  {
    id: 'minecraft-bedrock', name: 'Minecraft Bedrock', category: 'Minecraft', provider: 'minecraft', flavor: 'bedrock',
    platforms: ['windows', 'linux'], description: 'Servidor oficial para celular, console e Windows (Bedrock).', eula: true,
    exe: 'bedrock_server.exe', args: '',
    settings: [
      S.serverName('Servidor Bedrock'),
      { key: 'gamemode', label: 'Modo de jogo', type: 'select', default: 'survival', options: MC_GAMEMODES.slice(0, 3) },
      { key: 'difficulty', label: 'Dificuldade', type: 'select', default: 'normal', options: MC_DIFFICULTIES },
      S.maxPlayers(10), S.port(19132, 'Porta IPv4'),
      { key: 'portv6', label: 'Porta IPv6', type: 'port', default: 19133, advanced: true },
      { key: 'levelName', label: 'Nome do mundo', type: 'text', default: 'Bedrock level' },
      { key: 'onlineMode', label: 'Exigir conta Xbox', type: 'bool', default: true, on: 'true', off: 'false' },
      { key: 'allowCheats', label: 'Permitir cheats', type: 'bool', default: false, on: 'true', off: 'false' },
      { key: 'transport', label: 'Protocolo de rede', type: 'select', default: 'nethernet', options: [['nethernet', 'NetherNet (padrão atual)'], ['raknet', 'RakNet (clássico, permite consultar o servidor)']], advanced: true },
    ],
    configWrites: [{
      path: 'server.properties', format: 'properties', create: true,
      values: {
        'server-name': '{{serverName}}', gamemode: '{{gamemode}}', difficulty: '{{difficulty}}', 'max-players': '{{maxPlayers}}',
        'server-port': '{{port}}', 'server-portv6': '{{portv6}}', 'level-name': '{{levelName}}',
        'online-mode': '{{onlineMode}}', 'allow-cheats': '{{allowCheats}}', transport: '{{transport}}',
      },
    }],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'both' }, { name: 'IPv6', port: '{{portv6}}', proto: 'udp' }],
    console: 'stdin', stop: { commands: ['stop'] }, ready: 'Server started',
    query: { type: 'bedrock', port: '{{port}}' },
    playerLog: { join: 'Player connected: ([^,]+)', leave: 'Player disconnected: ([^,]+)' },
    backupPaths: 'worlds,server.properties,permissions.json,allowlist.json',
    configFiles: ['server.properties', 'permissions.json', 'allowlist.json'],
  },
];

// ---- Other non-Steam games ----
const AC_PLAYER_CARS = [
  'srp_bcnr33_wangan', 'srp_toyota_supra_mkiv_interceptor', 'srp_mitsubishi_evo_5_wangan', 'srp_honda_s2000_legendary',
  'ddm_nissan_skyline_bnr32', 'ddm_nissan_silvia_s15', 'ddm_mazda_rx7_infini_fc3s', 'ddm_toyota_supra_ma70', 'ddm_honda_civic_fd2',
  'ddm_subaru_22b', 'ddm_toyota_mr2_sw20_shuto', 'ddm_nissan_skyline_hr31_house', 'hsrc_mazda_rx7_aspec', 'hsrc_honda_nsx_ss', 'hsrc_toyota_a80_creek',
].join(', ');
export const AC_TRAFFIC_CARS = [
  'traffic_aegis_airport_bus', 'traffic_aegis_daihatsu_copen', 'traffic_aegis_izuzu_npr', 'traffic_aegis_izuzu_npr_box', 'traffic_aegis_mazda_cx3',
  'traffic_aegis_subaru_levorg', 'traffic_aegis_suzuki_alto_works', 'traffic_aegis_toyota_markii_taxi', 'traffic_aegis_toyota_prius',
  'traffic_aegis_toyota_vellfire', 'traffic_aegis_ud_quon', 'traffic_audi_a4_jp', 'traffic_isuzu_flatbed', 'traffic_isuzu_hauler',
  'traffic_isuzu_haulerb', 'traffic_isuzu_npr', 'traffic_isuzu_tanker', 'traffic_nissan_leaf', 'traffic_toyota_camry', 'traffic_toyota_prius',
  'traffic_toyota_rav4', 'traffic_volvo_v70jp',
].join(', ');

const OTHER = [
  {
    id: 'assettoserver', name: 'Assetto Corsa — Tráfego (AssettoServer)', category: 'Corrida', provider: 'download', source: 'assettoserver',
    platforms: ['windows'], image: img(244210), prepare: 'assettoserver',
    description: 'Servidor com trânsito de IA e pontuação por ultrapassagens e cortes, no estilo dos servidores de tráfego. Usa as pistas e os carros do seu Assetto Corsa; os jogadores precisam de CSP e Content Manager.',
    notes: 'O conteúdo (pista e carros) vem da sua instalação do Assetto Corsa e é copiado antes de cada início. Os jogadores precisam ter a mesma pista e os mesmos carros instalados.',
    exe: 'AssettoServer.exe', args: '',
    settings: [
      S.serverName('Shutoko Traffic'), S.password(), S.adminPassword(), S.maxPlayers(16), S.port(9600),
      { key: 'httpPort', label: 'Porta HTTP (lista do jogo e script de pontuação)', type: 'port', default: 8091 },
      { key: 'track', label: 'Pista (pasta em content/tracks)', type: 'text', default: 'shutoko_revival_project_094_ptb1' },
      { key: 'layout', label: 'Layout da pista (vazio = sem layout)', type: 'text', default: 'main_layout' },
      { key: 'cars', label: 'Carros dos jogadores (pastas em content/cars, separadas por vírgula)', type: 'text', default: AC_PLAYER_CARS },
      { key: 'traffic', label: 'Trânsito de IA', type: 'bool', default: true },
      {
        key: 'trafficProfile', label: 'Carros do trânsito', type: 'select', default: 'leve',
        options: [['leve', 'Leve — 6 modelos (o jogo carrega menos e roda mais leve)'], ['normal', 'Normal — 10 modelos'], ['variado', 'Variado — 22 modelos'], ['personalizado', 'Personalizado (lista abaixo)']],
        hint: 'Cada modelo diferente é carregado no PC de cada jogador. Menos modelos com mais carros de cada = mesmo trânsito, jogo mais leve.',
      },
      { key: 'trafficCars', label: 'Carros do trânsito no modo Personalizado (separados por vírgula)', type: 'text', default: AC_TRAFFIC_CARS },
      {
        key: 'trafficBehavior', label: 'Comportamento do trânsito', type: 'select', default: 'realista',
        options: [['realista', 'Realista — mais espaço entre carros, caminhões e ônibus só na faixa lenta'], ['padrao', 'Padrão do AssettoServer']],
      },
      { key: 'trafficDensity', label: 'Densidade do trânsito (%)', type: 'number', default: 100, min: 10, max: 200, hint: '100 = normal. Mais de 100 nem sempre aumenta o trânsito; depende dos jogadores e dos carros.' },
      { key: 'trafficSpeed', label: 'Velocidade do trânsito (km/h)', type: 'number', default: 90, min: 40, max: 200 },
      { key: 'twoWay', label: 'Trânsito nos dois sentidos', type: 'bool', default: false },
      { key: 'scoring', label: 'Pontuação de tráfego (ultrapassagens e cortes)', type: 'bool', default: true },
      { key: 'timeOfDay', label: 'Horário (8 a 18)', type: 'number', default: 14, min: 8, max: 18 },
      { key: 'publicList', label: 'Aparecer na lista pública do Assetto Corsa', type: 'bool', default: true },
      { key: 'description', label: 'Descrição no Content Manager', type: 'text', default: 'Trânsito japonês e pontuação por ultrapassagens. Precisa de CSP.' },
      { key: 'acPath', label: 'Pasta do Assetto Corsa (vazio = detectar a da Steam)', type: 'text', default: '', advanced: true },
      { key: 'clientTrafficTest', label: 'Teste de trânsito no cliente (experimental)', type: 'bool', default: false, advanced: true, hint: 'Coloca um carro de teste desenhado pelo script à sua frente e mostra um diagnóstico na tela. Só para testes.' },
      { key: 'trackPhysicsFlag', label: 'Liberar física da pista pelo servidor (experimental)', type: 'bool', default: false, advanced: true, hint: 'Marca a pista com "física personalizada" para o CSP dos jogadores (opção CustomTrackPhysics). Teste para a colisão do trânsito no cliente; desligue se causar problemas.' },
    ],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'both' }, { name: 'HTTP', port: '{{httpPort}}', proto: 'tcp' }],
    console: 'stdin', query: { type: 'assettoserver', port: '{{httpPort}}' }, backupPaths: 'cfg',
    configFiles: ['cfg/server_cfg.ini', 'cfg/entry_list.ini', 'cfg/extra_cfg.yml', 'cfg/csp_extra_options.ini'],
  },
  {
    id: 'terraria', name: 'Terraria', category: 'Sandbox / Construção', provider: 'download', source: 'terraria',
    platforms: ['windows', 'linux'], image: img(105600), description: 'Servidor dedicado oficial (vanilla).',
    exe: 'TerrariaServer.exe', args: '-config serverconfig.txt', pty: true,
    settings: [
      { key: 'worldName', label: 'Nome do mundo', type: 'text', default: 'Mundo' },
      { key: 'worldSize', label: 'Tamanho do mundo (criado na primeira vez)', type: 'select', default: '2', options: [['1', 'Pequeno'], ['2', 'Médio'], ['3', 'Grande']] },
      { key: 'difficulty', label: 'Dificuldade', type: 'select', default: '0', options: [['0', 'Clássico'], ['1', 'Expert'], ['2', 'Mestre'], ['3', 'Jornada']] },
      S.maxPlayers(8), S.port(7777), S.password(),
      { key: 'motd', label: 'Mensagem do dia', type: 'text', default: 'Bem-vindo!' },
    ],
    configWrites: [{
      path: 'serverconfig.txt', format: 'properties', create: true,
      values: {
        world: '{{dir}}/worlds/{{worldName}}.wld', autocreate: '{{worldSize}}', worldname: '{{worldName}}',
        difficulty: '{{difficulty}}', maxplayers: '{{maxPlayers}}', port: '{{port}}', password: '{{password}}',
        motd: '{{motd}}', worldpath: '{{dir}}/worlds',
      },
    }],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'tcp' }],
    console: 'stdin', stop: { commands: ['exit'] }, ready: 'Server started',
    playerLog: { join: '^(.+) has joined\\.', leave: '^(.+) has left\\.' },
    backupPaths: 'worlds,serverconfig.txt', configFiles: ['serverconfig.txt'],
  },
  {
    id: 'mindustry', name: 'Mindustry', category: 'Estratégia', provider: 'download', source: 'mindustry',
    platforms: ['windows', 'linux'], image: img(1127400), description: 'Servidor oficial (server-release.jar).',
    exe: '{{java}}', args: '-jar server-release.jar', javaMajor: 17,
    settings: [S.port(6567), { key: 'javaPath', label: 'Java ("auto" = o painel baixa)', type: 'text', default: 'auto', advanced: true }],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'both' }],
    console: 'stdin', stop: { commands: ['exit'] }, ready: 'Server loaded',
    startupCommands: ['config port {{port}}', 'host'],
    backupPaths: 'config',
  },
];

// ---- Source engine (srcds) ----
// On Windows srcds writes to its own console, so output comes from -condebug's console.log and commands go over RCON.
function source({ id, name, appId, gameAppId, gameDir, map, maxPlayers = 16, exe = 'srcds.exe', extra = '', goldsrc = false }) {
  return {
    id, name, category: 'Source Engine', provider: 'steamcmd', steam: { appId }, image: img(gameAppId), platforms: ['windows', 'linux'],
    exe,
    args: `-console -game ${gameDir} -port {{port}} +maxplayers {{maxPlayers}} +map {{map}} +hostname "{{serverName}}" ${goldsrc ? '' : '+rcon_password "{{rconPassword}}" '}{{password}} -condebug ${extra}`.trim(),
    settings: [
      S.serverName(), S.password({ arg: '+sv_password "{value}"' }), S.port(27015), S.maxPlayers(maxPlayers), S.map(map),
      ...(goldsrc ? [] : [S.rconPassword()]),
    ],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'both' }],
    console: goldsrc ? 'log' : 'rcon',
    rcon: goldsrc ? undefined : { port: '{{port}}', password: '{{rconPassword}}' },
    stop: goldsrc ? undefined : { commands: ['quit'] },
    logFile: `${gameDir}/${goldsrc ? 'qconsole.log' : 'console.log'}`,
    query: { type: 'a2s', port: '{{port}}' },
    backupPaths: `${gameDir}/cfg`,
    configFiles: [`${gameDir}/cfg/server.cfg`],
  };
}

const SOURCE = [
  source({ id: 'tf2', name: 'Team Fortress 2', appId: '232250', gameAppId: 440, gameDir: 'tf', map: 'ctf_2fort', maxPlayers: 24 }),
  source({ id: 'css', name: 'Counter-Strike: Source', appId: '232330', gameAppId: 240, gameDir: 'cstrike', map: 'de_dust2', maxPlayers: 24 }),
  source({ id: 'dods', name: 'Day of Defeat: Source', appId: '232290', gameAppId: 300, gameDir: 'dod', map: 'dod_anzio', maxPlayers: 24 }),
  source({ id: 'hl2dm', name: 'Half-Life 2: Deathmatch', appId: '232370', gameAppId: 320, gameDir: 'hl2mp', map: 'dm_lockdown' }),
  source({ id: 'gmod', name: "Garry's Mod", appId: '4020', gameAppId: 4000, gameDir: 'garrysmod', map: 'gm_construct', extra: '+gamemode sandbox' }),
  source({ id: 'l4d2', name: 'Left 4 Dead 2', appId: '222860', gameAppId: 550, gameDir: 'left4dead2', map: 'c1m1_hotel', maxPlayers: 8 }),
  source({ id: 'l4d', name: 'Left 4 Dead', appId: '222840', gameAppId: 500, gameDir: 'left4dead', map: 'l4d_hospital01_apartment', maxPlayers: 8 }),
  source({ id: 'nmrih', name: 'No More Room in Hell', appId: '317670', gameAppId: 224260, gameDir: 'nmrih', map: 'nmo_broadway', maxPlayers: 8 }),
  source({ id: 'insurgency2014', name: 'Insurgency (2014)', appId: '237410', gameAppId: 222880, gameDir: 'insurgency', map: 'ministry checkpoint' }),
  source({ id: 'doi', name: 'Day of Infamy', appId: '462310', gameAppId: 447820, gameDir: 'doi', map: 'bastogne stronghold', maxPlayers: 24 }),
  source({ id: 'pvkii', name: 'Pirates, Vikings, & Knights II', appId: '17575', gameAppId: 17570, gameDir: 'pvkii', map: 'bt_island', maxPlayers: 24 }),
  source({ id: 'fof', name: 'Fistful of Frags', appId: '295230', gameAppId: 265630, gameDir: 'fof', map: 'fof_fistful' }),
  source({ id: 'blackmesa', name: 'Black Mesa: Deathmatch', appId: '346680', gameAppId: 362890, gameDir: 'bms', map: 'dm_bounce' }),
  source({ id: 'zps', name: 'Zombie Panic! Source', appId: '17505', gameAppId: 17500, gameDir: 'zps', map: 'zps_cinema' }),
  source({ id: 'brainbread2', name: 'BrainBread 2', appId: '475370', gameAppId: 346330, gameDir: 'brainbread2', map: 'bba_barracks' }),
  source({ id: 'nucleardawn', name: 'Nuclear Dawn', appId: '111710', gameAppId: 17710, gameDir: 'nucleardawn', map: 'hydro', exe: 'ndsrv.exe', maxPlayers: 32 }),
  source({ id: 'dystopia', name: 'Dystopia', appId: '17585', gameAppId: 17580, gameDir: 'dystopia', map: 'dys_vaccine' }),
  source({ id: 'svencoop', name: 'Sven Co-op', appId: '276060', gameAppId: 225840, gameDir: 'svencoop', map: 'svencoop1', exe: 'svends.exe', maxPlayers: 12, goldsrc: true }),
];

// ---- Steam games with dedicated templates ----
const unrealLog = project => `${project}/Saved/Logs/${project}.log`;

const CURATED = [
  {
    id: 'cs2', name: 'Counter-Strike 2', category: 'FPS / Tiro', steam: { appId: '730' }, image: img(730),
    exe: 'game/bin/win64/cs2.exe',
    args: '-dedicated -console -usercon -port {{port}} -maxplayers {{maxPlayers}} {{mode}} +map {{map}} +hostname "{{serverName}}" +rcon_password "{{rconPassword}}" {{password}} {{gslt}} -condebug',
    settings: [
      S.serverName(), S.password({ arg: '+sv_password "{value}"' }), S.port(27015), S.maxPlayers(10),
      S.map('de_dust2', [['de_dust2', 'Dust II'], ['de_mirage', 'Mirage'], ['de_inferno', 'Inferno'], ['de_nuke', 'Nuke'], ['de_ancient', 'Ancient'], ['de_anubis', 'Anubis'], ['de_overpass', 'Overpass'], ['de_vertigo', 'Vertigo'], ['cs_office', 'Office'], ['cs_italy', 'Italy']]),
      { key: 'mode', label: 'Modo de jogo', type: 'select', default: '+game_type 0 +game_mode 1', options: [['+game_type 0 +game_mode 0', 'Casual'], ['+game_type 0 +game_mode 1', 'Competitivo'], ['+game_type 0 +game_mode 2', 'Wingman'], ['+game_type 1 +game_mode 2', 'Deathmatch'], ['+game_type 1 +game_mode 0', 'Corrida armamentista']] },
      { key: 'gslt', label: 'Token GSLT (para aparecer na lista pública)', type: 'text', default: '', arg: '+sv_setsteamaccount {value}', hint: 'Gere em steamcommunity.com/dev/managegameservers' },
      S.rconPassword(),
    ],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'both' }],
    console: 'rcon', rcon: { port: '{{port}}', password: '{{rconPassword}}' }, stop: { commands: ['quit'] },
    logFile: 'game/csgo/console.log', query: { type: 'a2s', port: '{{port}}' },
    backupPaths: 'game/csgo/cfg', configFiles: ['game/csgo/cfg/server.cfg'],
  },
  {
    id: 'valheim', name: 'Valheim', category: 'Sobrevivência', steam: { appId: '896660' }, image: img(892970),
    exe: 'valheim_server.exe', env: { SteamAppId: '892970' },
    args: '-nographics -batchmode -name "{{serverName}}" -port {{port}} -world "{{world}}" -password "{{password}}" -public {{public}} {{crossplay}} -savedir "{{dir}}/saves" -logFile "{{dir}}/logs/server.log"',
    settings: [
      S.serverName(), S.world('Dedicated'), S.password({ default: '$random', hint: 'Mínimo de 5 caracteres e não pode estar contida no nome' }),
      S.port(2456), { key: 'public', label: 'Aparecer na lista pública', type: 'bool', default: true },
      { key: 'crossplay', label: 'Crossplay (Xbox / Game Pass)', type: 'bool', default: false, arg: '-crossplay' },
    ],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }, { name: 'Consulta', port: '{{port+1}}', proto: 'udp' }],
    console: 'log', logFile: 'logs/server.log', ready: 'Game server connected',
    query: { type: 'a2s', port: '{{port+1}}' }, playerCountLog: 'Connections (\\d+) ZDOS',
    backupPaths: 'saves', configFiles: ['saves/adminlist.txt', 'saves/bannedlist.txt', 'saves/permittedlist.txt'],
    notes: 'O Valheim salva o mundo automaticamente a cada 20 minutos. Ao parar pelo painel, o progresso desde o último salvamento pode ser perdido.',
  },
  {
    id: 'palworld', name: 'Palworld', category: 'Sobrevivência', steam: { appId: '2394010' }, image: img(1623730),
    exe: 'PalServer.exe',
    args: '-port={{port}} -players={{maxPlayers}} {{publicLobby}} -useperfthreads -NoAsyncLoadingThread -UseMultithreadForDS',
    settings: [
      S.serverName(), S.password(), S.adminPassword(), S.port(8211), S.maxPlayers(32),
      { key: 'publicLobby', label: 'Aparecer na lista de servidores da comunidade', type: 'bool', default: false, arg: '-publiclobby' },
      S.rconPort(25575),
    ],
    configWrites: [{
      path: 'Pal/Saved/Config/WindowsServer/PalWorldSettings.ini', seed: 'DefaultPalWorldSettings.ini', format: 'palworld',
      values: {
        ServerName: '"{{serverName}}"', ServerPassword: '"{{password}}"', AdminPassword: '"{{adminPassword}}"',
        ServerPlayerMaxNum: '{{maxPlayers}}', PublicPort: '{{port}}', RCONEnabled: 'True', RCONPort: '{{rconPort}}',
      },
    }],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }, { name: 'RCON', port: '{{rconPort}}', proto: 'tcp' }],
    console: 'rcon', rcon: { port: '{{rconPort}}', password: '{{adminPassword}}' }, stop: { commands: ['Save', 'DoExit'] },
    query: { type: 'rcon-palworld' },
    backupPaths: 'Pal/Saved', configFiles: ['Pal/Saved/Config/WindowsServer/PalWorldSettings.ini'],
  },
  {
    id: 'enshrouded', name: 'Enshrouded', category: 'Sobrevivência', steam: { appId: '2278520' }, image: img(1203620),
    exe: 'enshrouded_server.exe', args: '',
    settings: [S.serverName(), S.maxPlayers(16), S.queryPort(15637)],
    configWrites: [{ path: 'enshrouded_server.json', format: 'json', values: { name: '{{serverName}}', slotCount: '{{maxPlayers}}', queryPort: '{{queryPort}}' } }],
    ports: [{ name: 'Jogo', port: '{{queryPort-1}}', proto: 'udp' }, { name: 'Consulta', port: '{{queryPort}}', proto: 'udp' }],
    console: 'log', logFile: 'logs/enshrouded_server.log', query: { type: 'a2s', port: '{{queryPort}}' },
    backupPaths: 'savegame,enshrouded_server.json', configFiles: ['enshrouded_server.json'],
    notes: 'O arquivo enshrouded_server.json é criado na primeira execução. Senhas e grupos de usuários são configurados nele.',
  },
  {
    id: '7dtd', name: '7 Days to Die', category: 'Sobrevivência', steam: { appId: '294420' }, image: img(251570),
    exe: '7DaysToDieServer.exe', args: '-quit -batchmode -nographics -configfile=serverconfig.xml -dedicated -logfile "{{dir}}/logs/server.log"',
    settings: [
      S.serverName(), S.password(), S.port(26900), S.maxPlayers(8),
      { key: 'telnetPort', label: 'Porta Telnet (console)', type: 'port', default: 8091, advanced: true },
      { key: 'telnetPassword', label: 'Senha Telnet', type: 'password', default: '$random', advanced: true },
    ],
    configWrites: [{
      path: 'serverconfig.xml', format: 'xmlprop',
      values: {
        ServerName: '{{serverName}}', ServerPassword: '{{password}}', ServerPort: '{{port}}', ServerMaxPlayerCount: '{{maxPlayers}}',
        TelnetEnabled: 'true', TelnetPort: '{{telnetPort}}', TelnetPassword: '{{telnetPassword}}', WebDashboardEnabled: 'false',
      },
    }],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'both' }, { name: 'Jogo 2', port: '{{port+1}}', proto: 'udp' }, { name: 'Jogo 3', port: '{{port+2}}', proto: 'udp' }],
    console: 'telnet', telnet: { port: '{{telnetPort}}', password: '{{telnetPassword}}' }, stop: { commands: ['saveworld', 'shutdown'] },
    logFile: 'logs/server.log', ready: 'GameServer.LogOn successful',
    query: { type: 'a2s', port: '{{port}}' }, backupPaths: 'serverconfig.xml', configFiles: ['serverconfig.xml'],
    notes: 'Os saves ficam em %APPDATA%\\7DaysToDie por padrão.',
  },
  {
    id: 'projectzomboid', name: 'Project Zomboid', category: 'Sobrevivência', steam: { appId: '380870' }, image: img(108600),
    exe: 'hmg-start.bat', prepare: 'pz-wrapper',
    args: '-servername {{serverName}} -adminpassword "{{adminPassword}}" "-cachedir={{dir}}/Zomboid"',
    settings: [
      { key: 'serverName', label: 'Nome interno do servidor (sem espaços)', type: 'text', default: 'servertest' },
      { key: 'publicName', label: 'Nome público', type: 'text', default: 'Meu servidor' },
      S.password(), S.adminPassword(), S.port(16261), S.maxPlayers(16), S.memory(4096),
      { key: 'public', label: 'Aparecer na lista pública', type: 'bool', default: false, on: 'true', off: 'false' },
    ],
    configWrites: [{
      path: 'Zomboid/Server/{{serverName}}.ini', format: 'properties',
      values: { PublicName: '{{publicName}}', Password: '{{password}}', MaxPlayers: '{{maxPlayers}}', DefaultPort: '{{port}}', Public: '{{public}}' },
    }],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }, { name: 'Jogo 2', port: '{{port+1}}', proto: 'udp' }],
    console: 'stdin', stop: { commands: ['save', 'quit'] }, ready: 'SERVER STARTED', query: { type: 'a2s', port: '{{port}}' },
    backupPaths: 'Zomboid/Saves,Zomboid/Server,Zomboid/db', configFiles: ['Zomboid/Server/{{serverName}}.ini', 'Zomboid/Server/{{serverName}}_SandboxVars.lua'],
    mods: { type: 'pz-workshop', appId: '108600', ini: 'Zomboid/Server/{{serverName}}.ini' },
  },
  {
    id: 'rust', name: 'Rust', category: 'Sobrevivência', steam: { appId: '258550' }, image: img(252490),
    exe: 'RustDedicated.exe',
    args: '-batchmode -nographics -logfile "{{dir}}/logs/server.log" +server.port {{port}} +server.queryport {{queryPort}} +server.hostname "{{serverName}}" +server.description "{{description}}" +server.maxplayers {{maxPlayers}} +server.worldsize {{worldSize}} +server.seed {{seed}} +server.identity "main" +rcon.port {{rconPort}} +rcon.password "{{rconPassword}}" +rcon.web 0',
    settings: [
      S.serverName(), { key: 'description', label: 'Descrição', type: 'text', default: 'Servidor Rust' },
      S.port(28015), S.queryPort(28017), S.maxPlayers(50),
      { key: 'worldSize', label: 'Tamanho do mapa', type: 'number', default: 3000, min: 1000, max: 6000 },
      { key: 'seed', label: 'Semente do mapa', type: 'number', default: 12345 },
      S.rconPort(28016), S.rconPassword(),
    ],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }, { name: 'Consulta', port: '{{queryPort}}', proto: 'udp' }, { name: 'RCON', port: '{{rconPort}}', proto: 'tcp' }],
    console: 'rcon', rcon: { port: '{{rconPort}}', password: '{{rconPassword}}' }, stop: { commands: ['server.save', 'quit'] },
    logFile: 'logs/server.log', ready: 'Server startup complete',
    query: { type: 'a2s', port: '{{queryPort}}' }, backupPaths: 'server/main', configFiles: ['server/main/cfg/server.cfg', 'server/main/cfg/users.cfg'],
  },
  {
    id: 'ark', name: 'ARK: Survival Evolved', category: 'Sobrevivência', steam: { appId: '376030' }, image: img(346110),
    exe: 'ShooterGame/Binaries/Win64/ShooterGameServer.exe',
    args: '"{{map}}?listen?SessionName={{serverName}}?ServerPassword={{password}}?ServerAdminPassword={{adminPassword}}?Port={{port}}?QueryPort={{queryPort}}?MaxPlayers={{maxPlayers}}?RCONEnabled=True?RCONPort={{rconPort}}" -server -log -NoBattlEye',
    settings: [
      S.serverName(), S.password(), S.adminPassword(), S.port(7777), S.queryPort(27015), S.maxPlayers(20),
      S.map('TheIsland', [['TheIsland', 'The Island'], ['TheCenter', 'The Center'], ['ScorchedEarth_P', 'Scorched Earth'], ['Ragnarok', 'Ragnarok'], ['Aberration_P', 'Aberration'], ['Extinction', 'Extinction'], ['Valguero_P', 'Valguero'], ['Genesis', 'Genesis'], ['CrystalIsles', 'Crystal Isles'], ['Gen2', 'Genesis 2'], ['LostIsland', 'Lost Island'], ['Fjordur', 'Fjordur']]),
      S.rconPort(27020),
    ],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }, { name: 'Jogo (raw)', port: '{{port+1}}', proto: 'udp' }, { name: 'Consulta', port: '{{queryPort}}', proto: 'udp' }, { name: 'RCON', port: '{{rconPort}}', proto: 'tcp' }],
    console: 'rcon', rcon: { port: '{{rconPort}}', password: '{{adminPassword}}' }, stop: { commands: ['SaveWorld', 'DoExit'] },
    logFile: unrealLog('ShooterGame'), query: { type: 'a2s', port: '{{queryPort}}' },
    backupPaths: 'ShooterGame/Saved', configFiles: ['ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini', 'ShooterGame/Saved/Config/WindowsServer/Game.ini'],
  },
  {
    id: 'ark-ascended', name: 'ARK: Survival Ascended', category: 'Sobrevivência', steam: { appId: '2430930' }, image: img(2399830), platforms: ['windows'],
    exe: 'ShooterGame/Binaries/Win64/ArkAscendedServer.exe',
    args: '"{{map}}?listen?SessionName={{serverName}}?ServerPassword={{password}}?ServerAdminPassword={{adminPassword}}?Port={{port}}?RCONEnabled=True?RCONPort={{rconPort}}" -WinLiveMaxPlayers={{maxPlayers}} -NoBattlEye -log',
    settings: [
      S.serverName(), S.password(), S.adminPassword(), S.port(7777), S.maxPlayers(20),
      S.map('TheIsland_WP', [['TheIsland_WP', 'The Island'], ['ScorchedEarth_WP', 'Scorched Earth'], ['TheCenter_WP', 'The Center'], ['Aberration_WP', 'Aberration'], ['Extinction_WP', 'Extinction'], ['Ragnarok_WP', 'Ragnarok'], ['Astraeos_WP', 'Astraeos']]),
      S.rconPort(27020),
    ],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }, { name: 'RCON', port: '{{rconPort}}', proto: 'tcp' }],
    console: 'rcon', rcon: { port: '{{rconPort}}', password: '{{adminPassword}}' }, stop: { commands: ['SaveWorld', 'DoExit'] },
    logFile: unrealLog('ShooterGame'), backupPaths: 'ShooterGame/Saved',
    configFiles: ['ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini', 'ShooterGame/Saved/Config/WindowsServer/Game.ini'],
  },
  {
    id: 'conan', name: 'Conan Exiles', category: 'Sobrevivência', steam: { appId: '443030' }, image: img(440900),
    exe: 'ConanSandboxServer.exe', args: '-log -MaxPlayers={{maxPlayers}} -Port={{port}} -QueryPort={{queryPort}}',
    settings: [S.serverName(), S.password(), S.adminPassword(), S.port(7777), S.queryPort(27015), S.maxPlayers(40), S.rconPort(25575), S.rconPassword()],
    configWrites: [
      { path: 'ConanSandbox/Saved/Config/WindowsServer/Engine.ini', format: 'ini', create: true, values: { '[OnlineSubsystem]ServerName': '{{serverName}}', '[OnlineSubsystem]ServerPassword': '{{password}}' } },
      { path: 'ConanSandbox/Saved/Config/WindowsServer/ServerSettings.ini', format: 'ini', create: true, values: { '[ServerSettings]AdminPassword': '{{adminPassword}}', '[ServerSettings]MaxPlayers': '{{maxPlayers}}' } },
      { path: 'ConanSandbox/Saved/Config/WindowsServer/Game.ini', format: 'ini', create: true, values: { '[RconPlugin]RconEnabled': '1', '[RconPlugin]RconPassword': '{{rconPassword}}', '[RconPlugin]RconPort': '{{rconPort}}' } },
    ],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }, { name: 'Jogo (raw)', port: '{{port+1}}', proto: 'udp' }, { name: 'Consulta', port: '{{queryPort}}', proto: 'udp' }, { name: 'RCON', port: '{{rconPort}}', proto: 'tcp' }],
    console: 'rcon', rcon: { port: '{{rconPort}}', password: '{{rconPassword}}' },
    logFile: unrealLog('ConanSandbox'), query: { type: 'a2s', port: '{{queryPort}}' },
    backupPaths: 'ConanSandbox/Saved', configFiles: ['ConanSandbox/Saved/Config/WindowsServer/ServerSettings.ini', 'ConanSandbox/Saved/Config/WindowsServer/Engine.ini'],
  },
  {
    id: 'satisfactory', name: 'Satisfactory', category: 'Sandbox / Construção', steam: { appId: '1690800' }, image: img(526870),
    exe: 'FactoryServer.exe', args: '-log -unattended -Port={{port}} -ReliablePort={{reliablePort}}',
    settings: [S.port(7777), { key: 'reliablePort', label: 'Porta confiável (TCP)', type: 'port', default: 8888 }],
    ports: [{ name: 'Jogo / API', port: '{{port}}', proto: 'both' }, { name: 'Confiável', port: '{{reliablePort}}', proto: 'tcp' }],
    console: 'log', logFile: unrealLog('FactoryGame'),
    backupPaths: 'FactoryGame/Saved',
    notes: 'Nome, senha e administrador são definidos pelo próprio jogo ao se conectar pela primeira vez (Gerenciador de servidores).',
  },
  {
    id: 'vrising', name: 'V Rising', category: 'Sobrevivência', steam: { appId: '1829350' }, image: img(1604030), platforms: ['windows'],
    exe: 'VRisingServer.exe',
    args: '-persistentDataPath "{{dir}}/save-data" -serverName "{{serverName}}" -saveName "{{world}}" -logFile "{{dir}}/logs/VRisingServer.log"',
    settings: [S.serverName(), S.world('world1'), S.password(), S.port(9876), S.queryPort(9877), S.maxPlayers(40)],
    configWrites: [{
      path: 'save-data/Settings/ServerHostSettings.json', seed: 'VRisingServer_Data/StreamingAssets/Settings/ServerHostSettings.json', format: 'json',
      values: { Name: '{{serverName}}', SaveName: '{{world}}', Password: '{{password}}', Port: '{{port}}', QueryPort: '{{queryPort}}', MaxConnectedUsers: '{{maxPlayers}}' },
    }],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }, { name: 'Consulta', port: '{{queryPort}}', proto: 'udp' }],
    console: 'log', logFile: 'logs/VRisingServer.log', query: { type: 'a2s', port: '{{queryPort}}' },
    backupPaths: 'save-data', configFiles: ['save-data/Settings/ServerHostSettings.json', 'save-data/Settings/ServerGameSettings.json'],
  },
  {
    id: 'corekeeper', name: 'Core Keeper', category: 'Sobrevivência', steam: { appId: '1963720' }, image: img(1621690),
    exe: 'CoreKeeperServer.exe', args: '-batchmode -logfile "{{dir}}/logs/server.log" -worldname "{{world}}" -maxplayers {{maxPlayers}}',
    settings: [S.world('Mundo'), S.maxPlayers(8)],
    console: 'log', logFile: 'logs/server.log', backupPaths: '.', configFiles: ['GameID.txt'],
    notes: 'O código para entrar no servidor (Game ID) aparece no console e no arquivo GameID.txt.',
  },
  {
    id: 'sotf', name: 'Sons of the Forest', category: 'Sobrevivência', steam: { appId: '2465200' }, image: img(1326470), platforms: ['windows'],
    exe: 'SonsOfTheForestDS.exe', args: '-userdatapath "{{dir}}/userdata"',
    settings: [S.serverName(), S.password(), S.maxPlayers(8), S.port(8766), S.queryPort(27016), { key: 'blobPort', label: 'Porta BlobSync', type: 'port', default: 9700, advanced: true }],
    configWrites: [{ path: 'userdata/dedicatedserver.cfg', format: 'json', values: { ServerName: '{{serverName}}', Password: '{{password}}', MaxPlayers: '{{maxPlayers}}', GamePort: '{{port}}', QueryPort: '{{queryPort}}', BlobSyncPort: '{{blobPort}}' } }],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }, { name: 'Consulta', port: '{{queryPort}}', proto: 'udp' }, { name: 'BlobSync', port: '{{blobPort}}', proto: 'udp' }],
    console: 'stdin', query: { type: 'a2s', port: '{{queryPort}}' },
    backupPaths: 'userdata', configFiles: ['userdata/dedicatedserver.cfg'],
  },
  {
    id: 'theforest', name: 'The Forest', category: 'Sobrevivência', steam: { appId: '556450' }, image: img(242760), platforms: ['windows'],
    exe: 'TheForestDedicatedServer.exe',
    args: '-batchmode -nographics -serverip 0.0.0.0 -serversteamport 8766 -servergameport {{port}} -serverqueryport {{queryPort}} -servername "{{serverName}}" -serverplayers {{maxPlayers}} -serverpassword "{{password}}" -serverautosaveinterval 15 -difficulty {{difficulty}} -inittype Continue -slot 1 -configfilepath "{{dir}}/config.cfg"',
    settings: [S.serverName(), S.password(), S.port(27015), S.queryPort(27016), S.maxPlayers(8), { key: 'difficulty', label: 'Dificuldade', type: 'select', default: 'Normal', options: [['Peaceful', 'Pacífico'], ['Normal', 'Normal'], ['Hard', 'Difícil']] }],
    ports: [{ name: 'Steam', port: '8766', proto: 'udp' }, { name: 'Jogo', port: '{{port}}', proto: 'udp' }, { name: 'Consulta', port: '{{queryPort}}', proto: 'udp' }],
    console: 'stdin', query: { type: 'a2s', port: '{{queryPort}}' }, backupPaths: '.',
  },
  {
    id: 'unturned', name: 'Unturned', category: 'Sobrevivência', steam: { appId: '1110390' }, image: img(304930),
    exe: 'Unturned.exe', args: '-batchmode -nographics -logfile "{{dir}}/logs/server.log" +InternetServer/{{serverId}}',
    settings: [
      { key: 'serverId', label: 'ID do servidor (pasta, sem espaços)', type: 'text', default: 'MeuServidor' },
      S.serverName(), S.password(), S.port(27015), S.maxPlayers(24),
    ],
    configWrites: [{ path: 'Servers/{{serverId}}/Server/Commands.dat', format: 'spaced', create: true, values: { Name: '{{serverName}}', Port: '{{port}}', MaxPlayers: '{{maxPlayers}}', Password: '{{password}}' } }],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }, { name: 'Consulta', port: '{{port+1}}', proto: 'udp' }],
    console: 'stdin', stop: { commands: ['shutdown'] }, logFile: 'logs/server.log', query: { type: 'a2s', port: '{{port+1}}' },
    backupPaths: 'Servers', configFiles: ['Servers/{{serverId}}/Server/Commands.dat', 'Servers/{{serverId}}/Config.json'],
  },
  {
    id: 'armareforger', name: 'Arma Reforger', category: 'FPS / Tiro', steam: { appId: '1874900' }, image: img(1874880),
    exe: 'ArmaReforgerServer.exe', args: '-config "{{dir}}/config.json" -profile "{{dir}}/profile" -maxFPS 60',
    settings: [
      S.serverName(), S.password(), S.adminPassword(), S.port(2001), S.queryPort(17777), S.maxPlayers(32),
      { key: 'scenario', label: 'Cenário', type: 'select', default: '{ECC61978EDCC2B5A}Missions/23_Campaign.conf', options: [['{ECC61978EDCC2B5A}Missions/23_Campaign.conf', 'Conflict - Everon'], ['{59AD59368755F41A}Missions/21_GM_Eden.conf', 'Game Master - Everon'], ['{C700DB41F0C546E1}Missions/23_Campaign_NorthCentral.conf', 'Conflict - Northern Everon'], ['{28802845ADA64D52}Missions/23_Campaign_SWCoast.conf', 'Conflict - Southern Everon'], ['{2BBBE828037C6F4B}Missions/22_GM_Arland.conf', 'Game Master - Arland']] },
    ],
    initialFiles: [{
      path: 'config.json',
      content: JSON.stringify({
        bindAddress: '', bindPort: 2001, publicAddress: '', publicPort: 2001,
        a2s: { address: '0.0.0.0', port: 17777 },
        game: { name: '', password: '', passwordAdmin: '', scenarioId: '', maxPlayers: 32, visible: true, crossPlatform: true, gameProperties: { serverMaxViewDistance: 2500, networkViewDistance: 1500, disableThirdPerson: false, fastValidation: true, battlEye: true }, mods: [] },
      }, null, 2),
    }],
    configWrites: [{
      path: 'config.json', format: 'json', create: true,
      values: { bindPort: '{{port}}', publicPort: '{{port}}', 'a2s.port': '{{queryPort}}', 'game.name': '{{serverName}}', 'game.password': '{{password}}', 'game.passwordAdmin': '{{adminPassword}}', 'game.maxPlayers': '{{maxPlayers}}', 'game.scenarioId': '{{scenario}}' },
    }],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }, { name: 'Consulta', port: '{{queryPort}}', proto: 'udp' }],
    console: 'stdin', query: { type: 'a2s', port: '{{queryPort}}' }, backupPaths: 'config.json,profile', configFiles: ['config.json'],
  },
  {
    id: 'squad', name: 'Squad', category: 'FPS / Tiro', steam: { appId: '403240' }, image: img(393380),
    exe: 'SquadServer.exe', args: 'Port={{port}} QueryPort={{queryPort}} FIXEDMAXPLAYERS={{maxPlayers}} RANDOM=NONE -log',
    settings: [S.serverName(), S.port(7787), S.queryPort(27165), S.maxPlayers(100), S.rconPort(21114), S.rconPassword()],
    configWrites: [
      { path: 'SquadGame/ServerConfig/Server.cfg', format: 'properties', values: { ServerName: '"{{serverName}}"', MaxPlayers: '{{maxPlayers}}' } },
      { path: 'SquadGame/ServerConfig/Rcon.cfg', format: 'properties', values: { Port: '{{rconPort}}', Password: '{{rconPassword}}' } },
    ],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }, { name: 'Consulta', port: '{{queryPort}}', proto: 'udp' }, { name: 'RCON', port: '{{rconPort}}', proto: 'tcp' }],
    console: 'rcon', rcon: { port: '{{rconPort}}', password: '{{rconPassword}}' },
    logFile: unrealLog('SquadGame'), query: { type: 'a2s', port: '{{queryPort}}' },
    backupPaths: 'SquadGame/ServerConfig', configFiles: ['SquadGame/ServerConfig/Server.cfg', 'SquadGame/ServerConfig/Admins.cfg'],
  },
  {
    id: 'sandstorm', name: 'Insurgency: Sandstorm', category: 'FPS / Tiro', steam: { appId: '581330' }, image: img(581320),
    exe: 'InsurgencyServer.exe',
    args: '{{map}}?Scenario={{scenario}}?MaxPlayers={{maxPlayers}} -Port={{port}} -QueryPort={{queryPort}} -log -hostname="{{serverName}}" -Rcon -RconPassword={{rconPassword}} -RconListenPort={{rconPort}}',
    settings: [S.serverName(), S.port(27102), S.queryPort(27131), S.maxPlayers(28), S.map('Farmhouse'), { key: 'scenario', label: 'Cenário', type: 'text', default: 'Scenario_Farmhouse_Checkpoint_Security' }, S.rconPort(27015), S.rconPassword()],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }, { name: 'Consulta', port: '{{queryPort}}', proto: 'udp' }, { name: 'RCON', port: '{{rconPort}}', proto: 'tcp' }],
    console: 'rcon', rcon: { port: '{{rconPort}}', password: '{{rconPassword}}' }, logFile: unrealLog('Insurgency'),
    query: { type: 'a2s', port: '{{queryPort}}' }, backupPaths: 'Insurgency/Saved/Config',
    notes: 'Servidores online exigem um token GSLT (adicione -GSLTToken=... nos argumentos avançados).',
  },
  {
    id: 'mordhau', name: 'MORDHAU', category: 'FPS / Tiro', steam: { appId: '629800' }, image: img(629760),
    exe: 'MordhauServer.exe', args: '-log -Port={{port}} -QueryPort={{queryPort}} -BeaconPort={{beaconPort}}',
    settings: [S.serverName(), S.password(), S.adminPassword(), S.port(7777), S.queryPort(27015), { key: 'beaconPort', label: 'Porta Beacon', type: 'port', default: 15000, advanced: true }, S.maxPlayers(48)],
    configWrites: [{ path: 'Mordhau/Saved/Config/WindowsServer/Game.ini', format: 'ini', create: true, values: { '[/Script/Mordhau.MordhauGameSession]ServerName': '{{serverName}}', '[/Script/Mordhau.MordhauGameSession]MaxSlots': '{{maxPlayers}}', '[/Script/Mordhau.MordhauGameSession]ServerPassword': '{{password}}', '[/Script/Mordhau.MordhauGameSession]AdminPassword': '{{adminPassword}}' } }],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }, { name: 'Consulta', port: '{{queryPort}}', proto: 'udp' }, { name: 'Beacon', port: '{{beaconPort}}', proto: 'udp' }],
    console: 'log', logFile: unrealLog('Mordhau'), query: { type: 'a2s', port: '{{queryPort}}' }, backupPaths: 'Mordhau/Saved/Config',
  },
  {
    id: 'kf2', name: 'Killing Floor 2', category: 'FPS / Tiro', steam: { appId: '232130' }, image: img(232090),
    exe: 'Binaries/Win64/KFServer.exe', args: '{{map}}?MaxPlayers={{maxPlayers}}?AdminPassword={{adminPassword}}?GamePassword={{password}} -Port={{port}} -QueryPort={{queryPort}}',
    settings: [S.password(), S.adminPassword(), S.port(7777), S.queryPort(27015), S.maxPlayers(6), S.map('KF-BioticsLab')],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }, { name: 'Consulta', port: '{{queryPort}}', proto: 'udp' }, { name: 'WebAdmin', port: '8080', proto: 'tcp' }],
    console: 'log', logFile: 'KFGame/Logs/Launch.log', query: { type: 'a2s', port: '{{queryPort}}' },
    backupPaths: 'KFGame/Config', configFiles: ['KFGame/Config/PCServer-KFGame.ini', 'KFGame/Config/PCServer-KFEngine.ini'],
  },
  {
    id: 'abioticfactor', name: 'Abiotic Factor', category: 'Sobrevivência', steam: { appId: '2857200' }, image: img(427410), platforms: ['windows'],
    exe: 'AbioticFactorServer.exe',
    args: '-log -useperfthreads -NoAsyncLoadingThread -MaxServerPlayers={{maxPlayers}} -PORT={{port}} -QueryPort={{queryPort}} -ServerPassword={{password}} -SteamServerName="{{serverName}}" -WorldSaveName="{{world}}"',
    settings: [S.serverName(), S.password(), S.world('Cascade'), S.port(7777), S.queryPort(27015), S.maxPlayers(6)],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }, { name: 'Consulta', port: '{{queryPort}}', proto: 'udp' }],
    console: 'log', logFile: unrealLog('AbioticFactor'), query: { type: 'a2s', port: '{{queryPort}}' }, backupPaths: 'AbioticFactor/Saved',
  },
  {
    id: 'soulmask', name: 'Soulmask', category: 'Sobrevivência', steam: { appId: '3017310' }, image: img(2646460), platforms: ['windows'],
    exe: 'WSServer.exe',
    args: 'Level01_Main -server -log -UTF8Output -MULTIHOME=0.0.0.0 -Port={{port}} -QueryPort={{queryPort}} -EchoPort={{echoPort}} -SteamServerName="{{serverName}}" -MaxPlayers={{maxPlayers}} -PSW="{{password}}" -adminpsw="{{adminPassword}}" -saving=600 -backup=900 {{pvp}}',
    settings: [S.serverName(), S.password(), S.adminPassword(), S.port(8777), S.queryPort(27015), { key: 'echoPort', label: 'Porta Echo (Telnet)', type: 'port', default: 18888, advanced: true }, S.maxPlayers(20), { key: 'pvp', label: 'Modo', type: 'select', default: '-pve', options: [['-pve', 'PvE'], ['-pvp', 'PvP']] }],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }, { name: 'Consulta', port: '{{queryPort}}', proto: 'udp' }],
    console: 'log', logFile: unrealLog('WS'), query: { type: 'a2s', port: '{{queryPort}}' }, backupPaths: 'WS/Saved',
  },
  {
    id: 'icarus', name: 'Icarus', category: 'Sobrevivência', steam: { appId: '2089300' }, image: img(1149460), platforms: ['windows'],
    exe: 'IcarusServer.exe', args: '-SteamServerName="{{serverName}}" -PORT={{port}} -QueryPort={{queryPort}} -log',
    settings: [S.serverName(), S.port(17777), S.queryPort(27015)],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }, { name: 'Consulta', port: '{{queryPort}}', proto: 'udp' }],
    console: 'log', logFile: unrealLog('Icarus'), query: { type: 'a2s', port: '{{queryPort}}' }, backupPaths: 'Icarus/Saved',
    configFiles: ['Icarus/Saved/Config/WindowsServer/ServerSettings.ini'],
  },
  {
    id: 'dst', name: "Don't Starve Together", category: 'Sobrevivência', steam: { appId: '343050' }, image: img(322330),
    exe: 'bin64/dontstarve_dedicated_server_nullrenderer_x64.exe', cwd: 'bin64',
    args: '-console -persistent_storage_root "{{dir}}/data" -conf_dir DoNotStarveTogether -cluster Cluster_1 -shard Master',
    settings: [S.serverName(), S.password(), S.maxPlayers(6), S.port(10999), { key: 'gameMode', label: 'Modo de jogo', type: 'select', default: 'survival', options: [['survival', 'Sobrevivência'], ['endless', 'Infinito'], ['wilderness', 'Selvagem']] }],
    initialFiles: [
      { path: 'data/DoNotStarveTogether/Cluster_1/cluster.ini', content: '[GAMEPLAY]\ngame_mode = survival\nmax_players = 6\npvp = false\npause_when_empty = true\n\n[NETWORK]\ncluster_name = Meu servidor\ncluster_password =\ncluster_description =\n\n[MISC]\nconsole_enabled = true\n\n[SHARD]\nshard_enabled = false\n' },
      { path: 'data/DoNotStarveTogether/Cluster_1/Master/server.ini', content: '[NETWORK]\nserver_port = 10999\n\n[SHARD]\nis_master = true\n' },
      { path: 'data/DoNotStarveTogether/Cluster_1/cluster_token.txt', content: '' },
    ],
    configWrites: [
      { path: 'data/DoNotStarveTogether/Cluster_1/cluster.ini', format: 'ini', values: { '[NETWORK]cluster_name': '{{serverName}}', '[NETWORK]cluster_password': '{{password}}', '[GAMEPLAY]max_players': '{{maxPlayers}}', '[GAMEPLAY]game_mode': '{{gameMode}}' } },
      { path: 'data/DoNotStarveTogether/Cluster_1/Master/server.ini', format: 'ini', values: { '[NETWORK]server_port': '{{port}}' } },
    ],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }],
    console: 'stdin', stop: { commands: ['c_shutdown(true)'] },
    backupPaths: 'data', configFiles: ['data/DoNotStarveTogether/Cluster_1/cluster_token.txt', 'data/DoNotStarveTogether/Cluster_1/cluster.ini'],
    notes: 'Coloque o token do servidor (gerado no site da Klei) no arquivo cluster_token.txt antes de iniciar.',
  },
  {
    id: 'dayz', name: 'DayZ', category: 'Sobrevivência', steam: { appId: '223350', login: 'account' }, image: img(221100), platforms: ['windows'],
    exe: 'DayZServer_x64.exe', args: '-config=serverDZ.cfg -port={{port}} -profiles=profiles -dologs -adminlog -netlog -freezecheck',
    settings: [S.serverName(), S.password(), S.adminPassword(), S.port(2302), S.maxPlayers(60)],
    configWrites: [{ path: 'serverDZ.cfg', format: 'cfg', values: { hostname: '{{serverName}}', password: '{{password}}', passwordAdmin: '{{adminPassword}}', maxPlayers: '{{maxPlayers}}' } }],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }, { name: 'Jogo 2', port: '{{port+1}}', proto: 'udp' }, { name: 'Consulta', port: '27016', proto: 'udp' }],
    console: 'log', logFile: 'profiles/server_console.log', query: { type: 'a2s', port: '27016' },
    backupPaths: 'mpmissions,profiles,serverDZ.cfg', configFiles: ['serverDZ.cfg'],
  },
  {
    id: 'arma3', name: 'Arma 3', category: 'FPS / Tiro', steam: { appId: '233780', login: 'account' }, image: img(107410),
    exe: 'arma3server_x64.exe', args: '-port={{port}} -config=server.cfg -profiles=profiles -name=server',
    settings: [S.serverName(), S.password(), S.adminPassword(), S.port(2302), S.maxPlayers(32)],
    initialFiles: [{ path: 'server.cfg', content: 'hostname = "Meu servidor";\npassword = "";\npasswordAdmin = "";\nmaxPlayers = 32;\npersistent = 1;\n' }],
    configWrites: [{ path: 'server.cfg', format: 'cfg', values: { hostname: '{{serverName}}', password: '{{password}}', passwordAdmin: '{{adminPassword}}', maxPlayers: '{{maxPlayers}}' } }],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }, { name: 'Consulta', port: '{{port+1}}', proto: 'udp' }, { name: 'Steam', port: '{{port+2}}', proto: 'udp' }],
    console: 'stdin', query: { type: 'a2s', port: '{{port+1}}' }, backupPaths: 'server.cfg,profiles,mpmissions', configFiles: ['server.cfg'],
  },
  {
    id: 'empyrion', name: 'Empyrion - Galactic Survival', category: 'Sandbox / Construção', steam: { appId: '530870' }, image: img(383120), platforms: ['windows'],
    exe: 'DedicatedServer/EmpyrionDedicated.exe', args: '-batchmode -nographics -dedicated dedicated.yaml -logFile "{{dir}}/logs/server.log"',
    settings: [], console: 'log', logFile: 'logs/server.log',
    ports: [{ name: 'Jogo', port: '30000', proto: 'udp' }, { name: 'Jogo 2', port: '30001', proto: 'udp' }],
    backupPaths: 'Saves,dedicated.yaml', configFiles: ['dedicated.yaml'],
  },
  {
    id: 'barotrauma', name: 'Barotrauma', category: 'Sobrevivência', steam: { appId: '1026340' }, image: img(602960),
    exe: 'DedicatedServer.exe', args: '',
    settings: [S.serverName(), S.password(), S.port(27015), S.queryPort(27016), S.maxPlayers(16)],
    configWrites: [{ path: 'serversettings.xml', format: 'xmlattr', values: { name: '{{serverName}}', password: '{{password}}', port: '{{port}}', queryport: '{{queryPort}}', maxplayers: '{{maxPlayers}}' } }],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }, { name: 'Consulta', port: '{{queryPort}}', proto: 'udp' }],
    console: 'stdin', query: { type: 'a2s', port: '{{queryPort}}' }, backupPaths: 'serversettings.xml,Multiplayer', configFiles: ['serversettings.xml'],
  },
  {
    id: 'avorion', name: 'Avorion', category: 'Sandbox / Construção', steam: { appId: '565060' }, image: img(445220),
    exe: 'bin/AvorionServer.exe', args: '--galaxy-name "{{world}}" --datapath "{{dir}}/galaxies" --port {{port}} --max-players {{maxPlayers}} --server-name "{{serverName}}"',
    settings: [S.serverName(), S.world('galaxia'), S.port(27000), S.maxPlayers(10)],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'both' }, { name: 'Steam', port: '27003', proto: 'udp' }, { name: 'Steam 2', port: '27020', proto: 'udp' }, { name: 'Steam 3', port: '27021', proto: 'udp' }],
    console: 'stdin', stop: { commands: ['/save', '/stop'] }, backupPaths: 'galaxies',
  },
  {
    id: 'hurtworld', name: 'Hurtworld', category: 'Sobrevivência', steam: { appId: '405100' }, image: img(393420),
    exe: 'hurtworld.exe', args: '-batchmode -nographics -exec "host {{port}};queryport {{queryPort}};servername {{serverName}};maxplayers {{maxPlayers}}" -logfile "{{dir}}/logs/server.log"',
    settings: [S.serverName(), S.port(12871), S.queryPort(12881), S.maxPlayers(60)],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }, { name: 'Consulta', port: '{{queryPort}}', proto: 'udp' }],
    console: 'log', logFile: 'logs/server.log', query: { type: 'a2s', port: '{{queryPort}}' }, backupPaths: '.',
  },
  {
    id: 'wreckfest', name: 'Wreckfest', category: 'Corrida', steam: { appId: '361580' }, image: img(228380), platforms: ['windows'],
    exe: 'Wreckfest_x64.exe', args: '-s server_config=server_config.cfg',
    settings: [S.serverName(), S.password(), S.maxPlayers(24), S.port(33540), S.queryPort(27016)],
    configWrites: [{ path: 'server_config.cfg', format: 'properties', values: { server_name: '{{serverName}}', password: '{{password}}', max_players: '{{maxPlayers}}', game_port: '{{port}}', query_port: '{{queryPort}}' } }],
    ports: [{ name: 'Steam', port: '27015', proto: 'udp' }, { name: 'Jogo', port: '{{port}}', proto: 'udp' }, { name: 'Consulta', port: '{{queryPort}}', proto: 'udp' }],
    console: 'stdin', query: { type: 'a2s', port: '{{queryPort}}' }, backupPaths: 'server_config.cfg', configFiles: ['server_config.cfg'],
  },
  {
    id: 'assettocorsa', name: 'Assetto Corsa', category: 'Corrida', steam: { appId: '302550', login: 'account' }, image: img(244210), platforms: ['windows'],
    exe: 'acServer.exe', args: '',
    settings: [S.serverName(), S.password(), S.adminPassword(), S.maxPlayers(18), S.port(9600), { key: 'httpPort', label: 'Porta HTTP', type: 'port', default: 8091 }],
    configWrites: [{ path: 'cfg/server_cfg.ini', format: 'ini', values: { '[SERVER]NAME': '{{serverName}}', '[SERVER]PASSWORD': '{{password}}', '[SERVER]ADMIN_PASSWORD': '{{adminPassword}}', '[SERVER]MAX_CLIENTS': '{{maxPlayers}}', '[SERVER]UDP_PORT': '{{port}}', '[SERVER]TCP_PORT': '{{port}}', '[SERVER]HTTP_PORT': '{{httpPort}}' } }],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'both' }, { name: 'HTTP', port: '{{httpPort}}', proto: 'tcp' }],
    console: 'stdin', backupPaths: 'cfg', configFiles: ['cfg/server_cfg.ini', 'cfg/entry_list.ini'],
  },
  {
    id: 'quakelive', name: 'Quake Live', category: 'FPS / Tiro', steam: { appId: '349090' }, image: img(282440),
    exe: 'qzeroded.exe', args: '+set net_port {{port}} +set sv_hostname "{{serverName}}" +set sv_maxClients {{maxPlayers}} +set g_password "{{password}}"',
    settings: [S.serverName(), S.password(), S.port(27960), S.maxPlayers(16)],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'both' }],
    console: 'stdin', query: { type: 'a2s', port: '{{port}}' }, backupPaths: 'baseq3',
  },
  {
    id: 'ns2', name: 'Natural Selection 2', category: 'FPS / Tiro', steam: { appId: '4940' }, image: img(4920),
    exe: 'x64/Server.exe', args: '-name "{{serverName}}" -port {{port}} -map {{map}} -limit {{maxPlayers}} -password "{{password}}"',
    settings: [S.serverName(), S.password(), S.port(27015), S.maxPlayers(16), S.map('ns2_summit')],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }, { name: 'Consulta', port: '{{port+1}}', proto: 'udp' }],
    console: 'stdin', query: { type: 'a2s', port: '{{port+1}}' }, backupPaths: '.',
  },
  {
    id: 'necesse', name: 'Necesse', category: 'Sobrevivência', steam: { appId: '1169370' }, image: img(1169040),
    exe: 'jre/bin/java.exe', args: '-jar Server.jar -nogui -world "{{world}}"',
    settings: [S.world('Mundo')], ports: [{ name: 'Jogo', port: '14159', proto: 'udp' }],
    console: 'stdin', stop: { commands: ['stop'] }, backupPaths: '.',
  },
  {
    id: 'scpsl', name: 'SCP: Secret Laboratory', category: 'FPS / Tiro', steam: { appId: '996560' }, image: img(700330),
    exe: 'LocalAdmin.exe', args: '{{port}} --acceptEULA',
    settings: [S.port(7777)], ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }],
    console: 'stdin', stop: { commands: ['exit'] }, backupPaths: '.',
  },
  {
    id: 'pavlov', name: 'Pavlov VR', category: 'FPS / Tiro', steam: { appId: '622970' }, image: img(555160),
    exe: 'PavlovServer.exe', args: '-PORT={{port}}', settings: [S.port(7777)],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }, { name: 'Jogo 2', port: '{{port+400}}', proto: 'udp' }],
    console: 'log', logFile: unrealLog('Pavlov'), backupPaths: 'Pavlov/Saved/Config', configFiles: ['Pavlov/Saved/Config/WindowsServer/Game.ini'],
  },
  {
    id: 'starbound', name: 'Starbound', category: 'Sandbox / Construção', steam: { appId: '211820', login: 'account' }, image: img(211820),
    exe: 'win64/starbound_server.exe', cwd: 'win64', args: '', settings: [],
    ports: [{ name: 'Jogo', port: '21025', proto: 'tcp' }], console: 'stdin', backupPaths: 'storage', configFiles: ['storage/starbound_server.config'],
  },
  {
    id: 'factorio', name: 'Factorio', category: 'Estratégia', steam: { appId: '427520', login: 'account' }, image: img(427520),
    exe: 'bin/x64/factorio.exe', args: '--start-server-load-latest --port {{port}}', settings: [S.port(34197)],
    ports: [{ name: 'Jogo', port: '{{port}}', proto: 'udp' }], console: 'stdin', backupPaths: 'saves',
    notes: 'Precisa de um save existente na pasta saves/ (crie pelo jogo ou com factorio.exe --create saves/mundo.zip).',
  },
];

// ---- Steam games launched with the executable Steam itself declares ----
const g = (id, name, appId, gameAppId, category, exe, args = '', extra = {}) => ({
  id, name, category, steam: { appId }, image: img(gameAppId), exe, args, settings: [], ports: [], console: 'stdin', backupPaths: '.', ...extra,
});

const GENERIC_STEAM = [
  g('astroneer', 'ASTRONEER', '728470', 361420, 'Sobrevivência', 'AstroServer.exe', '', { configFiles: ['Astro/Saved/Config/WindowsServer/AstroServerSettings.ini', 'Astro/Saved/Config/WindowsServer/Engine.ini'] }),
  g('eco', 'Eco', '739590', 382310, 'Simulação', 'EcoServer.exe', '', { configFiles: ['Configs/Network.eco'] }),
  g('spaceengineers', 'Space Engineers', '298740', 244850, 'Sandbox / Construção', 'DedicatedServer64/SpaceEngineersDedicated.exe', '-console', { platforms: ['windows'] }),
  g('medievalengineers', 'Medieval Engineers', '367970', 333950, 'Sandbox / Construção', 'DedicatedServer64/MedievalEngineersDedicated.exe', '-console', { platforms: ['windows'] }),
  g('stationeers', 'Stationeers', '600760', 544550, 'Sandbox / Construção', 'rocketstation_DedicatedServer.exe', '-batchmode -nographics'),
  g('theisle', 'The Isle', '412680', 376210, 'Sobrevivência', 'TheIsleServer.exe', '-log', { console: 'log', logFile: unrealLog('TheIsle') }),
  g('tmodloader', 'Terraria (tModLoader)', '1281930', 1281930, 'Sandbox / Construção', 'start-tModLoaderServer.bat', '-nosteam', { pty: true }),
  g('chivalry', 'Chivalry: Medieval Warfare', '220070', 219640, 'FPS / Tiro', 'Binaries/Win32/UDK.exe', 'AOCTO-Battlegrounds_V3_P?steamsockets -SEEKFREELOADINGSERVER'),
  g('dnl', 'Dark and Light', '630230', 529180, 'Sobrevivência', 'DNL/Binaries/Win64/DNLServer.exe', '-log', { platforms: ['windows'] }),
  g('lastoasis', 'Last Oasis', '920720', 903950, 'Sobrevivência', 'MistServer.exe', '-log', { notes: 'Requer uma chave de cliente obtida no site do Last Oasis (argumentos -identifier e -CustomerKey).' }),
  g('memoriesofmars', 'Memories of Mars', '897590', 644290, 'Sobrevivência', 'Game/Binaries/Win64/MemoriesOfMarsServer.exe', '-log'),
  g('miscreated', 'Miscreated', '302200', 299740, 'Sobrevivência', 'Bin64_dedicated/MiscreatedServer.exe', '-sv_port 64090 +sv_maxplayers 50 +map islands -mis_gameserverid 100'),
  g('pixark', 'PixARK', '824360', 593600, 'Sobrevivência', 'ShooterGame/Binaries/Win64/PixARKServer.exe', 'CubeWorld_Light?listen -log', { platforms: ['windows'] }),
  g('squad44', 'Squad 44', '746200', 736220, 'FPS / Tiro', 'PostScriptumServer.exe', '-log'),
  g('rs2', 'Rising Storm 2: Vietnam', '418480', 418460, 'FPS / Tiro', 'Binaries/Win64/VNGame.exe', 'VNTE-CuChi?MaxPlayers=64', { platforms: ['windows'] }),
  g('craftopia', 'Craftopia', '1670340', 1307550, 'Sobrevivência', 'Craftopia.exe', '-batchmode -nographics'),
  g('mythofempires', 'Myth of Empires', '1794810', 1371580, 'Sobrevivência', 'MOE/Binaries/Win64/MOEServer.exe', '-log', { platforms: ['windows'] }),
  g('nightofthedead', 'Night of the Dead', '1420710', 1377380, 'Sobrevivência', 'StartServer.bat', '', { platforms: ['windows'] }),
  g('moria', 'The Lord of the Rings: Return to Moria', '3349480', 684410, 'Sobrevivência', 'MoriaServer.exe', '', { platforms: ['windows'], configFiles: ['MoriaServerConfig.ini'] }),
  g('smalland', 'Smalland: Survive the Wilds', '808040', 768200, 'Sobrevivência', 'start-server.bat'),
  g('aska', 'ASKA', '3246670', 1898300, 'Sobrevivência', 'AskaServer.exe', '', { platforms: ['windows'] }),
  g('beastsofbermuda', 'Beasts of Bermuda', '882430', 719890, 'Sobrevivência', 'WindowsServer/BeastsOfBermudaServer.exe', '-log -NoVerifyGC', { platforms: ['windows'] }),
  g('groundbranch', 'GROUND BRANCH', '476400', 16900, 'FPS / Tiro', 'GroundBranch/Binaries/Win64/GroundBranchServer-Win64-Shipping.exe', '-log', { platforms: ['windows'] }),
  g('harshdoorstop', 'Operation: Harsh Doorstop', '950900', 736590, 'FPS / Tiro', 'HarshDoorstopServer.bat'),
  g('ets2', 'Euro Truck Simulator 2', '1948160', 227300, 'Simulação', 'bin/win_x64/eurotrucks2_server.exe', '', { notes: 'Gere os arquivos server_packages pelo jogo (comando export_server_packages) e copie para a pasta indicada no manual.' }),
  g('ats', 'American Truck Simulator', '2239530', 270880, 'Simulação', 'bin/win_x64/amtrucks_server.exe', '', { notes: 'Gere os arquivos server_packages pelo jogo (comando export_server_packages).' }),
  g('stormworks', 'Stormworks: Build and Rescue', '1247090', 573090, 'Simulação', 'server64.exe', '', { platforms: ['windows'] }),
  g('colonysurvival', 'Colony Survival', '748090', 366090, 'Estratégia', 'colonyserver.exe'),
  g('wurm', 'Wurm Unlimited', '402370', 366220, 'Sobrevivência', 'WurmServerLauncher.exe'),
  g('lif', 'Life is Feudal: Your Own', '320850', 290080, 'Sobrevivência', 'ddctd_cm_yo_server.exe', '', { platforms: ['windows'] }),
  g('reignofkings', 'Reign of Kings', '381690', 344760, 'Sobrevivência', 'Server.exe', '-batchmode -nographics', { platforms: ['windows'] }),
  g('bannerlord', 'Mount & Blade II: Bannerlord', '1863440', 261550, 'Estratégia', 'bin/Win64_Shipping_Server/DedicatedCustomServer.Starter.exe', '', { notes: 'Requer um token de servidor gerado no jogo (comando customserver.gettoken).' }),
  g('vein', 'VEIN', '2131400', 1857950, 'Sobrevivência', 'VeinServer.exe', '-log'),
  g('motortown', 'Motor Town: Behind The Wheel', '2223650', 1369670, 'Simulação', 'MotorTown/Binaries/Win64/MotorTownServer-Win64-Shipping.exe', 'Jeju_World?listen? -server -log -useperfthreads', { platforms: ['windows'] }),
  g('rfactor2', 'rFactor 2', '400300', 365960, 'Corrida', 'Bin64/rFactor2 Dedicated.exe', '', { platforms: ['windows'] }),
  g('scum', 'SCUM', '3792580', 513710, 'Sobrevivência', 'SCUM/Binaries/Win64/SCUMServer.exe', '-log', { platforms: ['windows'] }),
  g('atlas', 'ATLAS', '1006030', 834910, 'Sobrevivência', 'ShooterGame/Binaries/Win64/ShooterGameServer.exe', 'TestMapArea?listen -log'),
  g('risingworld', 'Rising World', '339010', 324080, 'Sandbox / Construção', 'RisingWorldServer.exe'),
  g('frozenflame', 'Frozen Flame', '1348640', 1094780, 'Sobrevivência', 'FrozenFlameServer.exe', '-log'),
  g('battalion', 'BATTALION: Legacy', '805140', 489940, 'FPS / Tiro', 'BattalionServer.exe', '-log'),
  g('onset', 'Onset', '1204170', 1105810, 'Sandbox / Construção', 'OnsetServer.exe'),
  g('wreckfest2', 'Wreckfest 2', '3519390', 1203190, 'Corrida', 'start_community_server.bat'),
  g('survivethenights', 'Survive the Nights', '1502300', 1194810, 'Sobrevivência', 'STN_Dedicated_Server.exe', '-nographics'),
  g('acc', 'Assetto Corsa Competizione', '1430110', 805550, 'Corrida', 'server/accServer.exe', '', { steam: { appId: '1430110', login: 'account' }, platforms: ['windows'], configFiles: ['server/cfg/configuration.json', 'server/cfg/settings.json'] }),
];

// ---- Custom entries ----
const CUSTOM = [
  {
    id: 'steam-custom', name: 'Outro jogo da Steam (App ID)', category: 'Personalizado', provider: 'steamcmd', custom: true,
    description: 'Qualquer servidor dedicado da Steam. O executável é detectado automaticamente após a instalação.',
    steam: { appId: '' }, exe: '', args: '', settings: [], ports: [], console: 'stdin', backupPaths: '.',
  },
  {
    id: 'generic', name: 'Programa personalizado', category: 'Personalizado', provider: 'generic', custom: true,
    description: 'Gerencie qualquer programa ou servidor que você já tenha (informe o executável e a pasta).',
    exe: '', args: '', settings: [], ports: [], console: 'stdin', backupPaths: '.',
  },
];

const ALL = [
  ...MINECRAFT, ...OTHER,
  ...[...CURATED, ...SOURCE, ...GENERIC_STEAM].map(t => ({ provider: 'steamcmd', platforms: ['windows', 'linux'], ...t, steam: { login: 'anonymous', ...t.steam } })),
  ...CUSTOM,
].map(t => ({ settings: [], ports: [], configWrites: [], initialFiles: [], configFiles: [], console: 'stdin', backupPaths: '.', ...t }));

const byId = new Map(ALL.map(t => [t.id, t]));

export const getTemplate = id => byId.get(id);

export function catalogList() {
  return ALL
    .map(t => ({
      id: t.id, name: t.name, category: t.category, image: t.image, provider: t.provider, platforms: t.platforms,
      description: t.description, notes: t.notes, account: t.steam?.login === 'account', custom: Boolean(t.custom), eula: Boolean(t.eula),
      settings: t.settings,
    }))
    .sort((a, b) => (a.custom - b.custom) || a.name.localeCompare(b.name, 'pt-BR'));
}
