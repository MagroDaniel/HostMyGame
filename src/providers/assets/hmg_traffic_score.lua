-- Host My Game — pontuação de tráfego (estilo "no hesi") para servidores AssettoServer.
-- Script online do CSP: o servidor envia este arquivo a cada jogador, que roda só no próprio PC.
-- Regras: acima da velocidade mínima, ultrapassar carros do trânsito dá pontos multiplicados pelo combo;
-- passar muito perto ("corte") dá bônus; bater zera a corrida atual. O recorde pessoal vale para o placar,
-- que é compartilhado entre os jogadores do servidor por eventos online.

local MIN_SPEED = 80          -- km/h para pontuar
local SLOW_GRACE = 3          -- segundos abaixo da velocidade mínima antes de perder o combo
local CLOSE_PASS = 1.8        -- metros: passagem a essa distância (ou menos) conta como corte
local NEAR_RADIUS = 12        -- metros: carros mais perto que isso são acompanhados
local COMBO_MAX = 10
local COMBO_IDLE = 6          -- segundos sem ultrapassar antes do combo começar a cair
local CRASH_DROP = 30         -- km/h perdidos em menos de 0,25 s contam como batida
local TRAFFIC_PREFIX = 'Traffic'

local storage = ac.storage({ best = 0 })

local score, combo = 0, 1
local slowTimer, idleTimer, publishTimer = 0, 0, 0
local recordAnnounced = false
local tracked = {}            -- índice do carro -> estado da passagem
local messages = {}           -- { text, color, age }
local speedHistory = {}       -- últimas velocidades para detectar batidas
local board = {}              -- nome -> melhor pontuação (de todos no servidor)
local myName = ac.getDriverName(0) or 'Você'

local scoreEvent
local function publishBest()
  board[myName] = storage.best
  scoreEvent({ best = storage.best })
end

-- Quem ainda não conhecíamos recebe o nosso recorde de volta uma vez, para quem entra depois ver o placar inteiro.
scoreEvent = ac.OnlineEvent({
  ac.StructItem.key('hmgTrafficScore'),
  best = ac.StructItem.int32(),
}, function(sender, data)
  if not sender or sender.index == 0 then return end
  local name = ac.getDriverName(sender.index) or '?'
  local isNew = board[name] == nil
  board[name] = data.best
  if isNew then publishBest() end
end)
publishBest()

local function message(text, color)
  table.insert(messages, 1, { text = text, color = color or rgbm(1, 1, 1, 1), age = 0 })
  if #messages > 5 then table.remove(messages) end
end

local function isTraffic(index)
  local name = ac.getDriverName(index) or ''
  return name:sub(1, #TRAFFIC_PREFIX) == TRAFFIC_PREFIX
end

local function crash()
  if score > 0 then message(string.format('Batida! -%d pontos', score), rgbm(1, 0.3, 0.3, 1)) end
  score, combo, idleTimer = 0, 1, 0
  recordAnnounced = false
end

local function award(points, text, color, comboGain)
  local gained = math.floor(points * combo)
  score = score + gained
  combo = math.min(COMBO_MAX, combo + comboGain)
  idleTimer = 0
  message(string.format('%s +%d', text, gained), color)
  if score > storage.best then
    if storage.best > 0 and not recordAnnounced then message('Novo recorde!', rgbm(1, 0.85, 0.2, 1)) end
    recordAnnounced = true
    storage.best = score
  end
end

function script.update(dt)
  local player = ac.getCar(0)
  if not player then return end
  local sim = ac.getSim()
  local speed = player.speedKmh

  -- batida: queda brusca de velocidade
  table.insert(speedHistory, { t = os.preciseClock(), v = speed })
  while #speedHistory > 1 and os.preciseClock() - speedHistory[1].t > 0.25 do table.remove(speedHistory, 1) end
  if speedHistory[1].v - speed > CRASH_DROP and speedHistory[1].v > MIN_SPEED * 0.5 then
    crash()
    speedHistory = {}
  end

  -- velocidade mínima e queda do combo
  if speed < MIN_SPEED then
    slowTimer = slowTimer + dt
    if slowTimer > SLOW_GRACE and combo > 1 then
      combo = 1
      message('Devagar demais: combo perdido', rgbm(1, 0.6, 0.2, 1))
    end
  else
    slowTimer = 0
  end
  idleTimer = idleTimer + dt
  if idleTimer > COMBO_IDLE then combo = math.max(1, combo - dt * 0.25) end

  -- ultrapassagens e cortes
  for i = 1, sim.carsCount - 1 do
    local car = ac.getCar(i)
    if car and car.isConnected and isTraffic(i) then
      local st = tracked[i]
      local distance = car.position:distance(player.position)
      if distance < NEAR_RADIUS then
        if not st then
          st = { minDistance = distance, wasBehind = nil, sameWay = car.look:dot(player.look) > 0.3 }
          tracked[i] = st
        end
        st.minDistance = math.min(st.minDistance, distance)
        -- lado do carro do trânsito em relação ao jogador, ao longo da direção dele
        local ahead = (car.position - player.position):dot(player.look) > 0
        if st.wasBehind == nil then st.wasBehind = not ahead end
        if st.sameWay and not st.done and not st.wasBehind and not ahead and speed >= MIN_SPEED then
          st.done = true
          if st.minDistance <= CLOSE_PASS then award(20, 'Corte!', rgbm(0.3, 1, 0.6, 1), 1)
          else award(10, 'Ultrapassagem', rgbm(1, 1, 1, 1), 0.5) end
        end
        if not st.sameWay and not st.done and st.minDistance <= CLOSE_PASS + 1 and not ahead and speed >= MIN_SPEED then
          st.done = true
          award(15, 'Na contramão!', rgbm(0.5, 0.8, 1, 1), 1)
        end
      elseif st then
        tracked[i] = nil
      end
    end
  end

  -- recorde pessoal publicado no máximo a cada 5 segundos, para não inundar a rede
  publishTimer = publishTimer + dt
  if publishTimer > 5 and storage.best ~= board[myName] then
    publishTimer = 0
    publishBest()
  end

  for _, m in ipairs(messages) do m.age = m.age + dt end
  while #messages > 0 and messages[#messages].age > 4 do table.remove(messages) end
end

local function sortedBoard()
  local list = {}
  for name, best in pairs(board) do if best and best > 0 then table.insert(list, { name = name, best = best }) end end
  table.sort(list, function(a, b) return a.best > b.best end)
  return list
end

function script.drawUI()
  local win = ui.windowSize()
  local w, h = 360, 230
  local x = (win.x - w) / 2
  ui.beginTransparentWindow('hmgTrafficScore', vec2(x, 30), vec2(w, h))
  ui.drawRectFilled(vec2(0, 0), vec2(w, 96), rgbm(0, 0, 0, 0.45), 8)

  ui.pushFont(ui.Font.Huge)
  ui.setCursor(vec2(16, 8))
  ui.text(string.format('%d', score))
  ui.popFont()

  ui.pushFont(ui.Font.Title)
  ui.setCursor(vec2(w - 110, 14))
  ui.textColored(string.format('x%.1f', combo), combo >= 5 and rgbm(1, 0.5, 0.2, 1) or rgbm(1, 1, 1, 1))
  ui.popFont()

  ui.setCursor(vec2(16, 70))
  local speed = ac.getCar(0) and ac.getCar(0).speedKmh or 0
  ui.textColored(string.format('Recorde: %d   %s', storage.best, speed < MIN_SPEED and string.format('acima de %d km/h para pontuar', MIN_SPEED) or ''),
    speed < MIN_SPEED and rgbm(1, 0.7, 0.3, 1) or rgbm(0.8, 0.8, 0.8, 1))

  local y = 104
  for _, m in ipairs(messages) do
    local c = m.color
    ui.setCursor(vec2(16, y))
    ui.textColored(m.text, rgbm(c.r, c.g, c.b, math.max(0, 1 - m.age / 4)))
    y = y + 18
  end
  ui.endTransparentWindow()

  -- placar dos 5 melhores no canto direito
  local list = sortedBoard()
  if #list > 0 then
    local bw = 220
    ui.beginTransparentWindow('hmgTrafficBoard', vec2(win.x - bw - 20, 140), vec2(bw, 40 + 20 * math.min(5, #list)))
    ui.drawRectFilled(vec2(0, 0), vec2(bw, 40 + 20 * math.min(5, #list)), rgbm(0, 0, 0, 0.4), 8)
    ui.setCursor(vec2(12, 8))
    ui.textColored('Melhores do servidor', rgbm(1, 0.85, 0.2, 1))
    for n = 1, math.min(5, #list) do
      ui.setCursor(vec2(12, 12 + 20 * n))
      ui.text(string.format('%d. %s', n, list[n].name))
      ui.setCursor(vec2(bw - 70, 12 + 20 * n))
      ui.text(string.format('%d', list[n].best))
    end
    ui.endTransparentWindow()
  end
end
