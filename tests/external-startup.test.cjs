const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../candidate/littleZen.uc.js'), 'utf8');
const start = source.indexOf('  function bootstrapWindow(win) {');
const end = source.indexOf('\n  bootstrapWindow(window);', start);
assert(start >= 0 && end > start);
function run(originAvailable, openSucceeds) {
 const calls = {closed: 0, opened: [], retry: 0};
 const win = {
   gZenUIManager: {}, document: {documentElement: {}},
   close() { calls.closed++; }, setTimeout() { calls.retry++; },
 };
 const other = {};
 const context = {
  PATCH_FLAGS: {window: 'bootstrapped'},
  isBrowserWindow: () => true, isLittleWindow: () => false,
  canPromoteStartupWindowToLittleZen: () => false,
  isExternalStartupWindow: () => true,
  browserWindows: function*(){yield win; yield other},
  getLittleZenOriginSpace: () => originAvailable ? {containerTabId: 3} : null,
  getExternalStartupUrl: () => 'https://example.invalid/test',
  getLittleWindowUrl: () => null,
  LittleZen: {openLittleWindow: (_, options) => {calls.opened.push(options); return openSucceeds ? {} : null}},
  log() {}, whenStartupReady: (_, callback) => callback(),
 };
 for (const name of ['patchBrowserDOMWindow','patchOpenBrowserWindow','patchContentLinkShortcut',
  'attachMainTabShortcut','ensureFallbackShortcut','ensureCommand','patchZenUIManager',
  'patchCompactModeManager','patchVerticalTabsManager','patchUrlbar']) context[name] = () => {};
 vm.runInNewContext(source.slice(start,end) + '\nthis.bootstrap = bootstrapWindow;',context);
 context.bootstrap(win);
 return calls;
}
let result = run(true, true);
assert.equal(result.opened.length, 1);
assert.equal(result.opened[0].url, 'https://example.invalid/test');
assert.equal(result.closed, 0, 'never close startup window automatically');
result = run(true, false);
assert.equal(result.opened.length, 1);
assert.equal(result.closed, 0, 'keep startup window on failure');
result = run(false, true);
assert.equal(result.opened.length, 0);
assert.equal(result.retry, 1);
assert.equal(result.closed, 0);
console.log('External startup: waits for origin and preserves startup window on success or failure.');
