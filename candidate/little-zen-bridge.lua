-- Little Zen system-wide shortcut bridge.
-- This module does not observe or modify the clipboard or Finder shortcuts.
local M = {}
local zenBundle = 'app.zen-browser.zen'
local fixedTargetPID = nil
local hotkey, launchTimer
local launching = false
local debugEnabled = false
local focusSession, focusPoll, focusWatcher

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
  trace('sending Zen-local ⌘⌥N to pid ' .. tostring(zen:pid()))
  hs.eventtap.keyStroke({'cmd', 'alt'}, 'n', 0, zen)
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

function M.start(options)
  if hotkey then return true end
  options = options or {}
  zenBundle = options.bundleID or 'app.zen-browser.zen'
  fixedTargetPID = options.targetPID
  debugEnabled = options.debug == true
  -- Finder owns ⌘⌥N for New Smart Folder. Keep that native shortcut intact;
  -- use ⌘⌥⇧N for the system-wide Little Zen action.
  hotkey = hs.hotkey.bind(options.modifiers or {'cmd', 'alt', 'shift'}, options.key or 'n', function()
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
  end)
  if not hotkey then
    hs.alert.show('Little Zen：⌘⌥N 已被其他程式使用')
    return false
  end
  return true
end

function M.stop()
  clearFocusSession()
  launching = false
  if launchTimer then launchTimer:stop(); launchTimer = nil end
  if hotkey then hotkey:delete(); hotkey = nil end
  fixedTargetPID = nil
end

return M
