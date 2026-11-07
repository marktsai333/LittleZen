const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const s = fs.readFileSync(path.join(__dirname, '../candidate/littleZen.uc.js'), 'utf8');
const begin = s.indexOf('  function getLittleZenOriginSpace(');
const end = s.indexOf('  const LittleZen = {', begin);
assert(begin >= 0 && end > begin);
const workspace = id => ({containerTabId: id});
const windowFor = (id, opts={}) => ({...opts, gZenWorkspaces: {getActiveWorkspace: () => workspace(id)}});
const normal = windowFor(3), other = windowFor(9), privateWindow=windowFor(8,{private:true});
let orderedWindows = [privateWindow, other, normal];
const context = {
 isLittleWindow: w => !!w.little,
 isExternalStartupWindow: w => !!w.external,
 isBrowserWindow: w => !!w,
 log() {},
 ChromeUtils: {importESModule: uri => uri.includes('BrowserWindowTracker')
   ? {BrowserWindowTracker: {get orderedWindows(){return orderedWindows;}}}
   : {PrivateBrowsingUtils: {isWindowPrivate: w => !!w.private}}},
};
vm.runInNewContext(s.slice(begin,end)+'\nthis.resolve = getLittleZenOriginSpace;',context);
assert.equal(context.resolve(normal).containerTabId, 3);
const external = windowFor(0,{external:true});
assert.equal(context.resolve(external).containerTabId, 9);
const privateExternal = windowFor(0,{external:true,private:true});
assert.equal(context.resolve(privateExternal).containerTabId, 8);
orderedWindows = [external];
assert.equal(context.resolve(external).containerTabId, 0);
external.gZenWorkspaces.getActiveWorkspace = () => null;
assert.equal(context.resolve(external), null);
console.log('Origin Space: normal opener, recent window, private isolation and unknown origin passed.');
