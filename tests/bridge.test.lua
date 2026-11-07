local alerts, sent, callback = {}, {}, nil
local apps, front, launchOK, launches, timers, spacePIDs = {}, nil, false, 0, {}, {}
local boundModifiers, boundKey
local function application(pid, initiallyHasWindow)
  local hasWindow = initiallyHasWindow ~= false
  return { pid=function() return pid end, bundleID=function() return 'app.zen-browser.zen' end,
    mainWindow=function() if hasWindow then return {} end end,
    setMainWindow=function(value) hasWindow=value end }
end
local function windowFor(app)
  return { application=function() return app end }
end
local function appForPID(pid)
  for _, app in ipairs(apps) do if app:pid() == pid then return app end end
end
local function runTimer()
  local timer = table.remove(timers, 1)
  assert(timer, 'expected a scheduled timer')
  if not timer.stopped then timer.fn() end
end
hs = {
  application = {
    frontmostApplication=function() return front end,
    applicationsForBundleID=function() return apps end,
    applicationForPID=appForPID,
    launchOrFocusByBundleID=function() launches=launches+1; return launchOK end,
  },
  window = { filter = { new=function(predicate)
    local filter={}
    function filter:setOverrideFilter(value) self.override=value; return self end
    function filter:getWindows()
      assert(self.override.currentSpace == true and self.override.visible == true, 'bridge must query visible current-Space windows through supported Hammerspoon filters')
      local windows={}
      for _, pid in ipairs(spacePIDs) do
        local app=appForPID(pid)
        if app then
          local window=windowFor(app)
          if predicate(window) then windows[#windows+1]=window end
        end
      end
      return windows
    end
    return filter
  end } },
  hotkey={bind=function(modifiers,key,fn) boundModifiers=modifiers; boundKey=key; callback=fn; return {delete=function() end} end},
  timer={doAfter=function(_,fn)
    local timer={fn=fn, stopped=false}; function timer:stop() self.stopped=true end
    timers[#timers+1]=timer; return timer
  end},
  eventtap={keyStroke=function(modifiers,key,_,app) sent[#sent+1]={key=key,modifiers=modifiers,pid=app:pid()} end},
  alert={show=function(msg) alerts[#alerts+1]=msg end},
}
local bridge = dofile('candidate/little-zen-bridge.lua')
assert(bridge.start())
assert(boundKey == 'n' and table.concat(boundModifiers, '+') == 'cmd+alt+shift', 'global shortcut must avoid Finder New Smart Folder')
callback()
assert(#sent == 0 and #alerts == 1 and launches == 1, 'failed launch must not send keys')
apps = {application(1), application(2)}
callback()
assert(#sent == 0 and #alerts == 2, 'multiple off-Space profiles must not receive a key')
spacePIDs = {2}; callback()
assert(#sent == 1 and sent[1].pid == 2 and sent[1].key == 'n' and table.concat(sent[1].modifiers, '+') == 'cmd+alt', 'send Zen-local ⌘⌥N to the profile with a visible window in the current macOS Space')
front = apps[1]; callback()
assert(#sent == 2 and sent[2].pid == 1 and sent[2].key == 'n', 'prefer the frontmost Zen profile')
front, spacePIDs = nil, {1, 2}; callback()
assert(#sent == 2 and #alerts == 3, 'multiple Zen profiles on the current Space must fail closed')
bridge.stop()
apps, front, launchOK, spacePIDs = {}, nil, true, {}
assert(bridge.start())
callback(); callback()
assert(launches == 2 and #timers == 1, 'coalesce repeated cold-start shortcuts')
apps = {application(3)}
runTimer(); runTimer()
assert(#sent == 3 and sent[3].pid == 3 and sent[3].key == 'n', 'send once after cold-start window exists')
bridge.stop()
local sleeping = application(4, false)
apps, front = {sleeping}, nil
assert(bridge.start())
callback()
assert(launches == 3 and #timers == 1, 'restore a running Zen with no window')
runTimer()
assert(#timers == 1 and #sent == 3, 'keep waiting while the restored window is absent')
sleeping.setMainWindow(true)
runTimer(); runTimer()
assert(#sent == 4 and sent[4].pid == 4 and sent[4].key == 'n', 'send after an existing Zen window is restored')
bridge.stop()
apps, front, launchOK, spacePIDs = {application(-1)}, nil, false, {}
assert(bridge.start())
callback()
assert(launches == 4 and #alerts == 4 and #sent == 4, 'ignore stale Launch Services records without a running process')
bridge.stop()
apps, front, spacePIDs = {application(5), application(6)}, nil, {}
assert(bridge.start({targetPID=5}))
callback()
assert(#sent == 5 and sent[5].pid == 5 and sent[5].key == 'n', 'pinned test target must win over other Zen profiles')
bridge.stop()
apps, spacePIDs = {application(6)}, {}
assert(bridge.start({targetPID=5}))
callback()
assert(#sent == 5 and launches == 4 and #alerts == 5, 'a missing pinned test target must fail closed')
bridge.stop()
print('Bridge: visible current-Space profile selection, ambiguity guard, launches, restore, and pinned target passed.')
