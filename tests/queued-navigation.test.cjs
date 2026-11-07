const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../candidate/littleZen.uc.js'), 'utf8');
const start = source.indexOf('  function discardFreshExternalBlankTab(');
const end = source.indexOf('  function schedulePendingNavigationFlush(', start);
assert(start >= 0 && end > start, 'navigation function exists');
const code = source.slice(start, end) + '\nthis.flush = flushPendingNavigation;';
function scenario(target, current, { fresh = false, empty = true, pinned = false, spec = 'about:blank' } = {}) {
  const calls = { newTabs: [], directLoads: [], removals: [], errors: [] };
  const selectedTab = { context: current, parentNode: {}, closing: false, isEmpty: empty, pinned, linkedBrowser: { currentURI: { spec } } };
  const selectedBrowser = { browsingContext: { loadURI: (...args) => calls.directLoads.push(args) } };
  const browser = {
    selectedTab, selectedBrowser, tabs: [selectedTab],
    addTab(url, options) {
      calls.newTabs.push({ url, options });
      return { linkedBrowser: { browsingContext: {} } };
    },
    removeTab(tab) { calls.removals.push(tab); },
  };
  const win = {
    gBrowser: browser, __littleZenStartupReady: true,
    __littleZenFreshExternalStart: fresh,
    __littleZenTargetContainerId: target,
    __littleZenPendingURL: 'https://example.invalid/path',
    __littleZenPendingURLMeta: { source: 'test' },
    setTimeout(fn) { fn(); },
  };
  const context = {
    isBrowserWindow: () => true, isLittleWindow: () => true, setLittleWindowLoading() {}, closeLittleWindowUrlbar() {},
    routeLog() {}, scheduleLeaveEmptyTabMode() {}, syncLittleWindowTransparentBrowsers() {},
    updateLittleZenBlendedTheme() {}, expandLittleWindow() {}, logLittleWindowState() {},
    getTabContainerId: tab => tab?.context ?? 0,
    log: (...args) => calls.errors.push(args),
    Services: { scriptSecurityManager: { getSystemPrincipal: () => 'principal' },
      io: { newURI: uri => uri } },
    Ci: { nsIWebNavigation: { LOAD_FLAGS_ALLOW_THIRD_PARTY_FIXUP: 1 } },
  };
  vm.runInNewContext(code, context);
  calls.result = context.flush(win, 'test');
  calls.pending = win.__littleZenPendingURL;
  return calls;
}
const changed = scenario(7, 0);
assert.equal(changed.result, true);
assert.equal(changed.newTabs.length, 1);
assert.equal(changed.newTabs[0].options.userContextId, 7);
assert.equal(changed.directLoads.length, 0);
assert.equal(changed.removals.length, 0);
const freshBlank = scenario(7, 0, { fresh: true });
assert.equal(freshBlank.removals.length, 1, 'remove only a newly-created external startup blank tab');
assert.equal(scenario(7, 0, { fresh: true, empty: false }).removals.length, 0);
assert.equal(scenario(7, 0, { fresh: true, pinned: true }).removals.length, 0);
assert.equal(scenario(7, 0, { fresh: true, spec: 'https://existing.invalid/' }).removals.length, 0);
const unchanged = scenario(7, 7);
assert.equal(unchanged.result, true);
assert.equal(unchanged.newTabs.length, 0);
assert.equal(unchanged.directLoads.length, 1);
const unknown = scenario(null, 0);
assert.equal(unknown.result, false);
assert.equal(unknown.newTabs.length, 0);
assert.equal(unknown.directLoads.length, 0);
assert.equal(unknown.pending, 'https://example.invalid/path');
console.log('Queued navigation: target container, existing container and unknown-container guard passed.');
