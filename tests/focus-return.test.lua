local callback, poll, watch, front, switched, selected = nil, nil, nil, nil, 0, 1
local function app(pid, bundle)
  return {pid=function() return pid end, bundleID=function() return bundle end,
    mainWindow=function() return {} end, activate=function() switched=switched+1 end}
end
local origin=app(881234,'com.apple.finder')
local zen=app(881235,'app.zen-browser.zen')
front=origin
hs={
 application={frontmostApplication=function() return front end,
  applicationsForBundleID=function() return {zen} end,
  applicationForPID=function(pid) if pid==origin:pid() then return origin elseif pid==zen:pid() then return zen end end,
  watcher={activated=1, new=function(fn) watch=fn; return {start=function(self) return self end,stop=function() end} end}},
 spaces={focusedSpace=function() return selected end},
 window={filter={new=function() return {setOverrideFilter=function(self) return self end,getWindows=function() return {{application=function() return zen end}} end} end}},
 hotkey={bind=function(_,_,fn) callback=fn; return {delete=function() end} end},
 timer={secondsSinceEpoch=function() return 1794050000 end, doEvery=function(_,fn) poll=fn; return {stop=function() end} end},
 eventtap={keyStroke=function() end}, alert={show=function(msg) error(msg) end},
}
local bridge=dofile('candidate/little-zen-bridge.lua')
local function closeSignal()
  local path='/private/tmp/littlezen-focus-'..zen:pid()
  local f=assert(io.open(path..'.request','r')); local token=f:read('*l'); f:close()
  local out=assert(io.open(path..'.closed','w')); out:write(token,'\n'); out:close()
end
assert(bridge.start())
callback(); front=zen; watch(nil,1,zen); closeSignal(); poll(); assert(switched==1,'closing must restore the original app')
front=origin; callback(); front=zen; watch(nil,1,zen)
local other=app(881236,'com.apple.Notes'); front=other; watch(nil,1,other); front=zen; watch(nil,1,zen)
closeSignal(); poll(); assert(switched==1,'do not steal focus after a deliberate app switch')
front=origin; callback(); front=zen; watch(nil,1,zen); selected=2; closeSignal(); poll(); assert(switched==1,'do not switch macOS desktops')
bridge.stop()
