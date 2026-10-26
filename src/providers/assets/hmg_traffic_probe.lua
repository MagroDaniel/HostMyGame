-- Host My Game — teste de trânsito no cliente (prova de conceito).
-- Verifica, dentro do jogo, se um script online do CSP consegue: carregar o modelo de um carro de trânsito,
-- movê-lo pelo traçado de IA da pista e simular a batida (detecta o encosto e muda a velocidade do carro do
-- jogador como num impacto). Um único carro anda à frente do jogador; um painel no canto mostra o que
-- funcionou. Usa só a API pública do CSP.

local CAR = 'traffic_aegis_toyota_prius'
local MODEL = 'traffic_aegis_toyota_prius_lod_c.kn5'
local MAIN_MODEL = 'traffic_aegis_toyota_prius.kn5' -- o LOD não tem texturas próprias; elas vêm do modelo principal
local SKIN = 'Classic Silver Metallic'
-- Texturas que o modelo pega da pasta da skin em vez de trazer consigo (sem elas ele fica rosa).
local SKIN_TEXTURES = { 'metal_detail.dds', 'Plate_D.dds', 'Plate_NM.dds' }
local SPEED_KMH = 70
local AHEAD_M = 60          -- distância à frente do jogador onde o carro aparece
local RESPAWN_M = 400       -- longe assim, o carro reaparece à frente
local MASS = 1300

local checks = {}           -- { name, ok, detail }
local function check(name, fn)
  local ok, result = pcall(fn)
  local good = ok and result ~= nil and result ~= false
  table.insert(checks, { name = name, ok = good, detail = ok and (good and 'ok' or 'retornou ' .. tostring(result)) or tostring(result) })
  return good and result or nil
end

local sim = ac.getSim()
local carDir = ac.getFolder(ac.FolderID.ContentCars) .. '/' .. CAR
local up = vec3(0, 1, 0)

local hasSpline = check('Traçado de IA da pista', function() return ac.hasTrackSpline() end)
local root = check('Raiz da cena (dynamicRoot)', function() return ac.findNodes('dynamicRoot:yes') end)
local model = root and check('Carregar modelo 3D (' .. MODEL .. ')', function() return root:loadKN5LOD(carDir .. '/' .. MODEL, carDir .. '/' .. MAIN_MODEL) end)
if model then
  check('Aplicar textura da skin (' .. SKIN .. ')', function()
    local skin = {}
    for _, f in ipairs(SKIN_TEXTURES) do skin[f] = carDir .. '/skins/' .. SKIN .. '/' .. f end
    model:applySkin(skin)
    return true
  end)
end
-- Tamanho: mede o modelo carregado e corrige a escala se o comprimento fugir muito do de um Prius real.
local REAL_LENGTH = 4.5
local modelScale, modelSize = 1, nil
if model then
  check('Medir o tamanho do modelo', function()
    local mn, mx = model:getLocalAABB()
    modelSize = mx - mn
    local length = math.max(modelSize.x, modelSize.z)
    if length > 0.5 and (length > REAL_LENGTH * 1.25 or length < REAL_LENGTH * 0.75) then modelScale = REAL_LENGTH / length end
    return true
  end)
end

-- Colisão: corpos físicos de script exigem que a pista libere a física por script (o SRP não libera). Então o
-- script detecta o encosto sozinho (duas caixas vistas de cima), muda a velocidade do carro do jogador com
-- physics.setCarVelocity e dá ao carro do trânsito uma física simples: ele leva a parte dele do impacto,
-- desliza perdendo velocidade e depois volta para a faixa aos poucos.
local TRAFFIC_HALF = vec2(0.88, 2.25)   -- meia largura, meio comprimento (Prius: 1,76 m × 4,5 m)
local PLAYER_HALF = vec2(0.95, 2.3)
local RESTITUTION = 0.3                 -- 0 = os carros grudam, 1 = quique perfeito
local FRICTION = 3                      -- m/s² de desaceleração do carro do trânsito deslizando
local IMPACT_SPEED = 1                  -- m/s: aproximação acima disso é batida; abaixo é só encostar/empurrar
local STOP_S = 3                        -- tempo mínimo deslizando/parado antes de voltar a andar
local REJOIN_S = 3                      -- tempo para voltar ao centro da faixa

local hits, progress = 0, nil
local direction = 1         -- +1 segue o sentido do traçado, -1 vai contra ele (o sentido em que o jogador está)
local trafficSpeed = SPEED_KMH / 3.6
local carPos, carLook, carVel = nil, nil, vec3()
local free, freeSince = false, 0        -- free: depois de uma batida, o carro anda pela física simples
local drift = vec3()                    -- desvio do centro da faixa, que some aos poucos
local pushStatus = 'ainda sem batida'   -- se o physics.setCarVelocity foi aceito
local frameError = nil

local function placeModel()
  if modelScale ~= 1 then
    model:getTransformationRaw():set(mat4x4.scaling(vec3(modelScale, modelScale, modelScale)):mul(mat4x4.look(carPos, carLook, up)))
  else
    model:setPosition(carPos)
    model:setOrientation(carLook, up)
  end
end

-- Coloca o carro à frente do jogador, andando no mesmo sentido em que ele está virado.
local function placeAhead(player, len)
  local p = ac.worldCoordinateToTrackProgress(player.position)
  local splineDir = ac.trackProgressToWorldCoordinate((p + 5 / len) % 1) - ac.trackProgressToWorldCoordinate(p)
  direction = splineDir:dot(player.look) >= 0 and 1 or -1
  progress = (p + direction * AHEAD_M / len) % 1
end

-- Sobreposição de duas caixas no plano do chão (teste do eixo separador). Devolve a profundidade e a direção do
-- empurrão da caixa B para a caixa A, ou nil quando não se tocam.
local function boxOverlap(posA, lookA, halfA, posB, lookB, halfB)
  local fA, fB = vec2(lookA.x, lookA.z):normalize(), vec2(lookB.x, lookB.z):normalize()
  local rA, rB = vec2(-fA.y, fA.x), vec2(-fB.y, fB.x)
  local d = vec2(posA.x - posB.x, posA.z - posB.z)
  local best, bestAxis = math.huge, nil
  for _, axis in ipairs({ fA, rA, fB, rB }) do
    local radA = halfA.x * math.abs(rA:dot(axis)) + halfA.y * math.abs(fA:dot(axis))
    local radB = halfB.x * math.abs(rB:dot(axis)) + halfB.y * math.abs(fB:dot(axis))
    local depth = radA + radB - math.abs(d:dot(axis))
    if depth <= 0 then return nil end
    if depth < best then best, bestAxis = depth, (d:dot(axis) >= 0 and axis or vec2(-axis.x, -axis.y)) end
  end
  return best, vec3(bestAxis.x, 0, bestAxis.y)
end

local function carMass(car)
  local ok, m = pcall(function() return car.mass end)
  return ok and m and m > 100 and m or 1400
end

function script.update(dt)
  if not model or not hasSpline then return end
  local player = ac.getCar(0)
  if not player then return end
  local ok, err = pcall(function()
    local len = sim.trackLengthM > 0 and sim.trackLengthM or 10000
    if not progress then placeAhead(player, len) end
    local now = os.clock()

    if free then
      -- Depois da batida: desliza perdendo velocidade pelo atrito.
      local speed = carVel:length()
      local slower = math.max(0, speed - FRICTION * dt)
      carVel = speed > 0.01 and carVel * (slower / speed) or vec3()
      carPos = carPos + carVel * dt
      if now - freeSince > STOP_S and slower < 0.5 then
        -- Volta a andar a partir do ponto do traçado mais próximo; o desvio da faixa some aos poucos.
        progress = ac.worldCoordinateToTrackProgress(carPos)
        drift = carPos - ac.trackProgressToWorldCoordinate(progress)
        drift.y = 0
        trafficSpeed = 0
        free = false
      end
    else
      trafficSpeed = math.min(SPEED_KMH / 3.6, trafficSpeed + 2.5 * dt)
      progress = (progress + direction * trafficSpeed * dt / len) % 1
      local base = ac.trackProgressToWorldCoordinate(progress)
      if base:distance(player.position) > RESPAWN_M then
        placeAhead(player, len)
        base = ac.trackProgressToWorldCoordinate(progress)
        drift = vec3()
      end
      carLook = (ac.trackProgressToWorldCoordinate((progress + direction * 3 / len) % 1) - base):normalize()
      drift = drift * math.max(0, 1 - dt / REJOIN_S)
      carPos = base + drift
      carVel = carLook * trafficSpeed
    end

    -- Batida com o carro do jogador.
    local depth, normal = boxOverlap(player.position, player.look, PLAYER_HALF, carPos, carLook, TRAFFIC_HALF)
    if depth then
      local approach = (player.velocity - carVel):dot(normal)
      -- Separação com antecipação: além da sobreposição atual, o quanto o jogador ainda avança até o próximo
      -- quadro, para os carros não ficarem um dentro do outro.
      carPos = carPos - normal * (depth + math.max(0, -approach) * dt + 0.02)
      if not free then free, freeSince = true, now end
      if approach < 0 then
        -- Impulso clássico entre duas massas, dividido entre os dois carros. Encostar devagar não quica.
        local impact = approach < -IMPACT_SPEED
        if impact then hits = hits + 1 end
        freeSince = now
        local mp, mt = carMass(player), MASS
        local impulse = (1 + (impact and RESTITUTION or 0)) * approach / (1 / mp + 1 / mt)
        carVel = carVel + normal * (impulse / mt)
        local pushed, pushErr = pcall(function() physics.setCarVelocity(0, player.velocity - normal * (impulse / mp)) end)
        pushStatus = pushed and 'aceito' or ('recusado: ' .. tostring(pushErr))
      end
    end
    placeModel()
  end)
  if not ok then frameError = tostring(err) end
end

function script.drawUI()
  local x, y, w = 20, 120, 430
  local h = 116 + 20 * #checks + (frameError and 40 or 0)
  ui.beginTransparentWindow('hmgTrafficProbe', vec2(x, y), vec2(w, h))
  ui.drawRectFilled(vec2(0, 0), vec2(w, h), rgbm(0, 0, 0, 0.55), 6)
  ui.setCursor(vec2(10, 8))
  ui.textColored('Teste de trânsito no cliente (Host My Game)', rgbm(1, 0.85, 0.2, 1))
  local line = 30
  for _, c in ipairs(checks) do
    ui.setCursor(vec2(10, line))
    ui.textColored((c.ok and 'OK   ' or 'FALHA ') .. c.name .. (c.ok and '' or (': ' .. c.detail)), c.ok and rgbm(0.5, 1, 0.6, 1) or rgbm(1, 0.4, 0.4, 1))
    line = line + 20
  end
  local player = ac.getCar(0)
  local dist = (player and carPos) and carPos:distance(player.position) or -1
  ui.setCursor(vec2(10, line + 4))
  ui.text(string.format('Distância até o carro: %.0f m   Batidas: %d   %s', dist, hits, free and 'deslizando (batida)' or 'andando'))
  if modelSize then
    ui.setCursor(vec2(10, line + 44))
    ui.text(string.format('Tamanho do modelo: %.1f × %.1f × %.1f m   escala aplicada: %.2f', modelSize.x, modelSize.y, modelSize.z, modelScale))
  end
  ui.setCursor(vec2(10, line + 24))
  ui.textColored('Empurrão no seu carro: ' .. pushStatus:sub(1, 60), pushStatus == 'aceito' and rgbm(0.5, 1, 0.6, 1)
    or pushStatus:find('recusado') and rgbm(1, 0.4, 0.4, 1) or rgbm(1, 1, 1, 1))
  if frameError then
    ui.setCursor(vec2(10, line + 66))
    ui.textColored('Erro no update: ' .. frameError:sub(1, 70), rgbm(1, 0.4, 0.4, 1))
  end
  ui.endTransparentWindow()
end
