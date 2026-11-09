-- Little Zen system-wide shortcut bridge.
-- This module does not observe or modify the clipboard or Finder shortcuts.
local M = {}
local zenBundle = 'app.zen-browser.zen'
local fixedTargetPID = nil
local hotkey, launchTimer
local launching = false
local debugEnabled = false
local focusSession, focusPoll, focusWatcher
local shortcutWatcher, shortcutReloadTimer
local shortcutConfigPath, shortcutConfigDirectory
local started = false
local currentGlobalModifiers, currentGlobalKey = {}, nil

local function clearFocusSession()
  if focusPoll then focusPoll:stop(); focusPoll = nil end
  if focusWatcher then focusWatcher:stop(); focusWatcher = nil end
  if focusSession then
    os.remove(focusSession.requestPath)
    os.remove(focusSession.closedPath)
    if focusSession.claimedPath then os.remove(focusSession.claimedPath) end
  end
  focusSession = nil
end

local function prepareFocusReturn(zen, previous)
  if not previous or previous:bundleID() == zenBundle or not hs.spaces or not hs.application.watcher then return end
  clearFocusSession()
  local current = hs.application.frontmostApplication()
  if not current or (current:pid() ~= previous:pid() and current:pid() ~= zen:pid()) then return end
  local ok, space = pcall(hs.spaces.focusedSpace)
  if not ok or not space then return end
  local pid = zen:pid()
  local token = string.format('%x%x', math.floor(hs.timer.secondsSinceEpoch() * 1000), math.random(0, 0x7fffffff))
  local prefix = '/private/tmp/littlezen-focus-' .. tostring(pid)
  local requestPath, closedPath, claimedPath = prefix .. '.request', prefix .. '.closed', prefix .. '.claimed'
  os.remove(closedPath)
  os.remove(claimedPath)
  local f = io.open(requestPath, 'w')
  if not f then return end
  f:write(token, '\n', tostring(math.floor(hs.timer.secondsSinceEpoch())), '\n'); f:close()
  focusSession = {token=token, previousPID=previous:pid(), previousBundle=previous:bundleID(), space=space, requestPath=requestPath, closedPath=closedPath, claimedPath=claimedPath, zenPID=pid, zenSeen=current:pid()==pid, switched=false}
  focusWatcher = hs.application.watcher.new(function(_, event, app)
    local s = focusSession
    if not s or event ~= hs.application.watcher.activated or not app then return end
    if app:pid() == s.zenPID then s.zenSeen = true
    elseif s.zenSeen then s.switched = true end
  end):start()
  local deadline = hs.timer.secondsSinceEpoch() + 1800
  focusPoll = hs.timer.doEvery(0.2, function()
    local s = focusSession
    if not s then return end
    local file = io.open(s.closedPath, 'r')
    local closed = file and file:read('*l')
    if file then file:close() end
    if closed == s.token then
      local front = hs.application.frontmostApplication()
      local okSpace, nowSpace = pcall(hs.spaces.focusedSpace)
      local restore = not s.switched and front and front:pid() == s.zenPID and okSpace and nowSpace == s.space
      local target = hs.application.applicationForPID(s.previousPID)
      clearFocusSession()
      if restore and target and target:bundleID() == s.previousBundle then target:activate() end
    elseif hs.timer.secondsSinceEpoch() > deadline then
      clearFocusSession()
    end
  end)
end

local function trace(message)
  if debugEnabled then print('Little Zen bridge: ' .. message) end
end

local function runningZenCandidates()
  local running = {}
  for _, app in ipairs(hs.application.applicationsForBundleID(zenBundle)) do
    -- Launch Services may return an app record with PID -1 even when no process exists.
    if app:pid() > 0 then running[#running + 1] = app end
  end
  return running
end

local function zenWindowsInCurrentSpace()
  if not hs.window or not hs.window.filter then
    return nil, 'Little Zen：無法確認目前桌面的 Zen 視窗'
  end

  local ok, filter = pcall(function()
    return hs.window.filter.new(function(window)
      local app = window:application()
      return app and app:pid() > 0 and app:bundleID() == zenBundle
    end):setOverrideFilter({ currentSpace = true, visible = true })
  end)
  if not ok or not filter then
    return nil, 'Little Zen：無法確認目前桌面的 Zen 視窗'
  end

  local windowsOK, windows = pcall(function() return filter:getWindows() end)
  if not windowsOK or type(windows) ~= 'table' then
    return nil, 'Little Zen：無法確認目前桌面的 Zen 視窗'
  end

  local pids = {}
  for _, window in ipairs(windows) do
    local appOK, app = pcall(function() return window:application() end)
    if appOK and app and app:pid() > 0 and app:bundleID() == zenBundle then
      pids[app:pid()] = app
    end
  end
  return pids
end

local function pickZen()
  -- A pinned PID is available only for isolated, in-memory diagnostics. It
  -- fails closed if the target exits and must never launch the default profile.
  if fixedTargetPID then
    local target = hs.application.applicationForPID(fixedTargetPID)
    if target and target:pid() > 0 and target:bundleID() == zenBundle then
      return target
    end
    return nil, 'Little Zen：隔離測試版已關閉，請重試'
  end
  local candidates = runningZenCandidates()
  local front = hs.application.frontmostApplication()
  if front and front:pid() > 0 and front:bundleID() == zenBundle then
    return front
  end

  local visibleByPID, spaceError = zenWindowsInCurrentSpace()
  if not visibleByPID then return nil, spaceError end
  local visibleCount, visiblePID = 0, nil
  for pid in pairs(visibleByPID) do
    visibleCount = visibleCount + 1
    visiblePID = pid
  end
  if visibleCount == 1 then
    for _, app in ipairs(candidates) do
      if app:pid() == visiblePID then return app end
    end
  elseif visibleCount > 1 then
    return nil, 'Little Zen：目前桌面有多個 Zen 設定檔，請先關閉或切換到要使用的視窗'
  end

  -- If no Zen window is visible in this macOS Space, only a single running
  -- profile can be selected safely. Multiple hidden/off-Space profiles are
  -- ambiguous; never fall back to whichever Zen happened to be activated last.
  if #candidates == 1 then return candidates[1] end
  if #candidates == 0 then
    return nil, 'Little Zen：Zen 尚未啟動'
  end
  return nil, 'Little Zen：目前桌面沒有可辨識的 Zen 視窗，請先開啟要使用的設定檔'
end

local function sendInternalShortcut(zen)
  trace('sending private F18 signal to pid ' .. tostring(zen:pid()))
  hs.eventtap.keyStroke({}, 'f18', 0, zen)
end

local function safelyPrepareFocusReturn(zen, previous)
  local ok, err = pcall(prepareFocusReturn, zen, previous)
  if not ok then
    clearFocusSession()
    trace('focus return unavailable: ' .. tostring(err))
  end
end

local function startupWindowClaimed(zen)
  local s = focusSession
  if not s or not zen or s.zenPID ~= zen:pid() or not s.claimedPath then return false end
  local file = io.open(s.claimedPath, 'r')
  local claimed = file and file:read('*l')
  if file then file:close() end
  return claimed == s.token
end

-- A cold start opens the user's default Zen profile. Wait for its first window;
-- browser-level readiness and same-Space presentation still need live tests.
local function startZenAndOpen(previous, runningWithoutWindow)
  if launching then
    trace('coalescing shortcut while Zen is starting')
    return
  end
  launching = true
  -- When Zen is already running with no browser window, write the focus token
  -- before asking macOS to reopen it. The startup script can then turn its
  -- blank first window directly into Little Zen instead of leaving a main one.
  if runningWithoutWindow then
    safelyPrepareFocusReturn(runningWithoutWindow, previous)
  end
  trace('asking Zen to open or restore a window')
  if not hs.application.launchOrFocusByBundleID(zenBundle) then
    launching = false
    trace('Zen launch or focus failed')
    if runningWithoutWindow then clearFocusSession() end
    hs.alert.show('Little Zen：無法啟動 Zen')
    return
  end
  local attempts = 0
  local function waitForWindow()
    if not launching then return end
    attempts = attempts + 1
    local zen, err = pickZen()
    if zen and zen:mainWindow() then
      local selectedPID = zen:pid()
      trace('Zen window is ready; waiting before sending F18')
      launchTimer = hs.timer.doAfter(1, function()
        if not launching then return end
        launching = false
        launchTimer = nil
        local selected = hs.application.applicationForPID(selectedPID)
        if selected and selected:bundleID() == zenBundle then
          if startupWindowClaimed(selected) then
            trace('blank startup window was converted directly into Little Zen')
            return
          end
          safelyPrepareFocusReturn(selected, previous)
          sendInternalShortcut(selected)
        else
          hs.alert.show('Little Zen：Zen 已關閉，請重試')
        end
      end)
    elseif attempts < 40 and (not err or err:find('尚未啟動', 1, true)) then
      trace('waiting for Zen window, attempt ' .. attempts)
      launchTimer = hs.timer.doAfter(0.5, waitForWindow)
    else
      launching = false
      launchTimer = nil
      if runningWithoutWindow then clearFocusSession() end
      trace('could not find a usable Zen window')
      hs.alert.show(err or 'Little Zen：Zen 啟動逾時，請重試')
    end
  end
  launchTimer = hs.timer.doAfter(0.5, waitForWindow)
end

local function openFromGlobalShortcut()
    trace('global shortcut received')
    local previous = hs.application.frontmostApplication()
    local zen, err = pickZen()
    if zen and zen:mainWindow() then
      safelyPrepareFocusReturn(zen, previous)
      sendInternalShortcut(zen)
    elseif zen then
      trace('Zen is running without a browser window; reopening into Little Zen')
      startZenAndOpen(previous, zen)
    elseif #runningZenCandidates() == 0 then
      startZenAndOpen(previous)
    else
      hs.alert.show(err)
    end
end

local function keyNameFromCode(keycode)
  local names = {
    VK_RETURN='return', VK_ENTER='return', VK_ESCAPE='escape', VK_BACK='delete',
    VK_DELETE='forwarddelete', VK_TAB='tab', VK_SPACE='space',
    VK_UP='up', VK_DOWN='down', VK_LEFT='left', VK_RIGHT='right',
    VK_HOME='home', VK_END='end', VK_PAGE_UP='pageup', VK_PAGE_DOWN='pagedown',
    VK_SEMICOLON=';', VK_EQUALS='=', VK_COMMA=',', VK_PERIOD='.', VK_SLASH='/',
    VK_BACK_QUOTE='`', VK_OPEN_BRACKET='[', VK_BACK_SLASH='\\',
    VK_CLOSE_BRACKET=']', VK_QUOTE="'", VK_SUBTRACT='-', VK_ADD='+',
  }
  local upper = tostring(keycode or ''):upper()
  if names[upper] then return names[upper] end
  local fn = upper:match('^VK_F(%d+)$')
  if fn and tonumber(fn) <= 24 then return 'f' .. fn end
  local simple = upper:match('^VK_([A-Z0-9])$')
  if simple then return simple:lower() end
  return nil
end

local function readShortcutConfig()
  if not shortcutConfigPath then return nil end
  local file = io.open(shortcutConfigPath, 'r')
  if not file then return nil end
  local content = file:read('*a')
  file:close()
  local ok, config = pcall(function() return hs.json.decode(content) end)
  if not ok or type(config) ~= 'table' or config.version ~= 1 then return nil end
  if config.enabled == false then return {disabled=true} end
  if type(config.modifiers) ~= 'table' then return nil end
  local modifiers, seen = {}, {}
  local allowed = {cmd=true, alt=true, ctrl=true, shift=true}
  for _, modifier in ipairs(config.modifiers or {}) do
    if not allowed[modifier] or seen[modifier] then return nil end
    seen[modifier] = true
    modifiers[#modifiers + 1] = modifier
  end
  if #modifiers == 0 then return nil end
  local key = config.key and tostring(config.key):lower() or keyNameFromCode(config.keycode)
  if not key or key == '' then return nil end
  return {modifiers=modifiers, key=key}
end

local function sameHotkey(modifiers, key)
  if currentGlobalKey ~= key then return false end
  if #currentGlobalModifiers ~= #modifiers then return false end
  local left, right = {}, {}
  for _, value in ipairs(currentGlobalModifiers) do left[value] = true end
  for _, value in ipairs(modifiers) do right[value] = true end
  for value in pairs(left) do if not right[value] then return false end end
  return true
end

local function bindGlobalHotkey(modifiers, key)
  if sameHotkey(modifiers or {}, key) then return true end
  if hotkey then hotkey:delete(); hotkey = nil end
  currentGlobalModifiers, currentGlobalKey = modifiers or {}, key
  if not key then
    trace('global shortcut disabled in Zen Keyboard Shortcuts')
    return true
  end
  hotkey = hs.hotkey.bind(modifiers, key, openFromGlobalShortcut)
  if not hotkey then
    hs.alert.show('Little Zen：全域快捷鍵無法使用，請檢查是否與其他 App 衝突')
    trace('could not bind configured global shortcut')
    currentGlobalKey = nil
    return false
  end
  trace('global shortcut bound to ' .. table.concat(modifiers, '+') .. '+' .. key)
  return true
end

local function reloadGlobalHotkey()
  shortcutReloadTimer = nil
  local config = readShortcutConfig()
  if not config then return end
  if config.disabled then
    bindGlobalHotkey({}, nil)
  else
    bindGlobalHotkey(config.modifiers, config.key)
  end
end

local function watchGlobalShortcutConfig()
  if not hs.pathwatcher or not shortcutConfigDirectory then return end
  -- Watch the already-existing Application Support directory. The Little Zen
  -- subdirectory is created only when the user edits the global shortcut.
  local watchRoot = shortcutConfigDirectory:match('^(.*)/[^/]+$') or shortcutConfigDirectory
  shortcutWatcher = hs.pathwatcher.new(watchRoot, function(paths)
    for _, changed in ipairs(paths or {}) do
      if type(changed) == 'string' and
        (changed == shortcutConfigPath or changed == shortcutConfigDirectory or
          changed:find(shortcutConfigDirectory .. '/', 1, true) == 1) then
        if shortcutReloadTimer then shortcutReloadTimer:stop() end
        shortcutReloadTimer = hs.timer.doAfter(0.25, reloadGlobalHotkey)
        break
      end
    end
  end):start()
end

function M.start(options)
  if started then return true end
  options = options or {}
  zenBundle = options.bundleID or 'app.zen-browser.zen'
  fixedTargetPID = options.targetPID
  debugEnabled = options.debug == true
  shortcutConfigPath = options.shortcutConfigPath or ((os.getenv('HOME') or '') .. '/Library/Application Support/Little Zen/global-shortcut.json')
  shortcutConfigDirectory = shortcutConfigPath:match('^(.*)/[^/]+$')

  local configured = readShortcutConfig()
  local modifiers = options.modifiers or {'cmd', 'alt', 'shift'}
  local key = options.key or 'n'
  if configured then
    if configured.disabled then
      modifiers, key = {}, nil
    else
      modifiers, key = configured.modifiers, configured.key
    end
  end
  -- Finder reserves ⌘⌥N. The default global shortcut is ⌘⌥⇧N, and Zen's
  -- local shortcut is configured independently in Zen Keyboard Shortcuts.
  local bound = bindGlobalHotkey(modifiers, key)
  started = true
  watchGlobalShortcutConfig()
  return bound
end

function M.stop()
  clearFocusSession()
  launching = false
  if launchTimer then launchTimer:stop(); launchTimer = nil end
  if hotkey then hotkey:delete(); hotkey = nil end
  if shortcutWatcher then shortcutWatcher:stop(); shortcutWatcher = nil end
  if shortcutReloadTimer then shortcutReloadTimer:stop(); shortcutReloadTimer = nil end
  fixedTargetPID = nil
  currentGlobalModifiers, currentGlobalKey = {}, nil
  shortcutConfigPath, shortcutConfigDirectory = nil, nil
  started = false
end

return M
