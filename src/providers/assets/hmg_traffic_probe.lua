-- Host My Game — teste de trânsito no cliente (prova de conceito).
-- Verifica, dentro do jogo, se um script online do CSP consegue: carregar o modelo de um carro de trânsito,
-- movê-lo pelo traçado de IA da pista e dar colisão física a ele. Um único carro anda à frente do jogador;
-- um painel no canto mostra o que funcionou. Usa só a API pública do CSP.

local CAR = 'traffic_aegis_toyota_prius'
local MODEL = 'traffic_aegis_toyota_prius_lod_c.kn5'
local MAIN_MODEL = 'traffic_aegis_toyota_prius.kn5' -- LODs carry no textures; they come from the main KN5
local SKIN = 'Classic Silver Metallic'
-- Textures the model takes from the skin folder instead of carrying them itself (without them it renders pink).
local SKIN_TEXTURES = { 'metal_detail.dds', 'Plate_D.dds', 'Plate_NM.dds' }
local SPEED_KMH = 70
local AHEAD_M = 60          -- distância à frente do jogador onde o carro aparece
local RESPAWN_M = 400       -- longe assim, o carro reaparece à frente
local RECOVER_S = 8         -- depois de uma batida, volta a andar depois disso
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
local body = check('Colisor físico (RigidBody)', function() return physics.RigidBody(carDir .. '/collider.kn5', MASS, nil, true, true) end)

local hits, progress, crashedAt = 0, nil, nil
local direction = 1         -- +1 follows the spline's direction, -1 goes against it (matches the player's heading)
if body then pcall(function() body:onCollision(function() hits = hits + 1 end) end) end
local frameError = nil

-- Spawns the car ahead of the player, driving the same way the player faces.
local function placeAhead(player, len)
  local p = ac.worldCoordinateToTrackProgress(player.position)
  local splineDir = ac.trackProgressToWorldCoordinate((p + 5 / len) % 1) - ac.trackProgressToWorldCoordinate(p)
  direction = splineDir:dot(player.look) >= 0 and 1 or -1
  progress = (p + direction * AHEAD_M / len) % 1
end

function script.update(dt)
  if not model or not hasSpline then return end
  local player = ac.getCar(0)
  if not player then return end
  local ok, err = pcall(function()
    local len = sim.trackLengthM > 0 and sim.trackLengthM or 10000
    if not progress then placeAhead(player, len) end

    -- Hit by someone: physics moves the car until it recovers.
    if body and not body:isSemiDynamic() then
      crashedAt = crashedAt or os.clock()
      model:setTransformationFrom(body)
      if os.clock() - crashedAt < RECOVER_S then return end
      body:setSemiDynamic(true, true)
      crashedAt = nil
      placeAhead(player, len)
    end

    progress = (progress + direction * SPEED_KMH / 3.6 * dt / len) % 1
    local pos = ac.trackProgressToWorldCoordinate(progress)
    if pos:distance(player.position) > RESPAWN_M then
      placeAhead(player, len)
      pos = ac.trackProgressToWorldCoordinate(progress)
    end
    local look = (ac.trackProgressToWorldCoordinate((progress + direction * 3 / len) % 1) - pos):normalize()
    model:setPosition(pos)
    model:setOrientation(look, up)
    if body then body:setTransformation(mat4x4.look(pos, look, up), true) end
  end)
  if not ok then frameError = tostring(err) end
end

function script.drawUI()
  local x, y, w = 20, 120, 430
  local h = 94 + 20 * #checks + (frameError and 40 or 0)
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
  local dist = (model and player and progress) and ac.trackProgressToWorldCoordinate(progress):distance(player.position) or -1
  ui.setCursor(vec2(10, line + 4))
  ui.text(string.format('Distância até o carro: %.0f m   Batidas: %d   %s', dist, hits, crashedAt and 'física ATIVA' or 'seguindo o traçado'))
  if body then
    local okWorld, inWorld = pcall(function() return body:isInWorld() end)
    local okEnabled, enabled = pcall(function() return body:isEnabled() end)
    ui.setCursor(vec2(10, line + 24))
    ui.text(string.format('Colisor no mundo físico: %s   ativo: %s', okWorld and tostring(inWorld) or 'erro', okEnabled and tostring(enabled) or 'erro'))
  end
  if frameError then
    ui.setCursor(vec2(10, line + 48))
    ui.textColored('Erro no update: ' .. frameError:sub(1, 70), rgbm(1, 0.4, 0.4, 1))
  end
  ui.endTransparentWindow()
end
