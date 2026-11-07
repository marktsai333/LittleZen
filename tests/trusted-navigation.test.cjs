const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../candidate/littleZen.uc.js'), 'utf8');
const start = source.indexOf('  function patchLittleZenContainerNavigation(');
const end = source.indexOf('  function attachUrlbarDisableGuard(', start);
assert(start >= 0 && end > start);
const context = { isLittleWindow: win => win.little, getTabContainerId: tab => tab.context };
vm.runInNewContext(source.slice(start, end) + '\nthis.patch = patchLittleZenContainerNavigation;', context);
function scenario(target, current) {
  const calls = [], created = [];
  const win = { little: true, __littleZenTargetContainerId: target,
    gBrowser: { selectedTab: { context: current },
      getTabForBrowser: b => b.valid ? {context: b.context} : null,
      addTab(uri, options) { created.push({uri, options}); return {}; } },
    openTrustedLinkIn(...args) {
      calls.push(args);
      if (this.simulateTab) this.gBrowser.addTab(args[0], {userContextId: args[2].userContextId, postData: args[2].postData});
      if (this.simulateThrow) throw new Error('test navigation failure');
      return 'forwarded';
    } };
  context.patch(win);
  return { win, calls, created };
}
let x = scenario(3, 0);
x.win.simulateTab = true;
assert.equal(x.win.openTrustedLinkIn('https://example.invalid/', 'current', {postData: 'payload'}), 'forwarded');
assert.equal(x.calls[0][1], 'current');
assert.equal(x.calls[0][2].userContextId, 3);
assert.equal(x.calls[0][2].postData, 'payload');
assert.equal(x.created[0].options.skipRoute, true, 'site routing cannot override the identity');
assert.equal(x.created[0].options.userContextId, 3);
assert.equal(x.created[0].options.postData, 'payload');
x.win.gBrowser.addTab('about:blank', {userContextId: 8});
assert.equal(x.created[1].options.userContextId, 8, 'ordinary later tab creation is untouched');
assert.equal(x.created[1].options.skipRoute, undefined);
x = scenario(3, 3);
x.win.openTrustedLinkIn('https://example.invalid/', 'current', {});
assert.equal(x.calls[0][1], 'current');
assert.equal(x.calls[0][2].userContextId, 3, 'matched and empty tabs still receive explicit identity');
x = scenario(3, 0);
const pinnedTarget = {valid: true, context: 0};
x.win.openTrustedLinkIn('https://example.invalid/', 'current', {targetBrowser: pinnedTarget});
assert.equal(x.calls[0][2].targetBrowser, pinnedTarget, 'preserve asynchronously pinned browser');
x = scenario(3, 0);
assert.throws(() => x.win.openTrustedLinkIn('https://example.invalid/', 'current', {targetBrowser: {valid: false}}), /no valid target tab/);
assert.equal(x.calls.length, 0);
x = scenario(null, 0);
assert.throws(() => x.win.openTrustedLinkIn('https://example.invalid/', 'current', {}), /cannot determine/);
assert.equal(x.calls.length, 0);
x = scenario(3, 0);
x.win.openTrustedLinkIn('https://example.invalid/', 'tab', {userContextId: 8});
assert.equal(x.calls[0][2].userContextId, 8);
x = scenario(3, 0);
x.win.simulateThrow = true;
assert.throws(() => x.win.openTrustedLinkIn('https://example.invalid/', 'current', {}), /test navigation failure/);
x.win.gBrowser.addTab('about:blank', {userContextId: 8});
assert.equal(x.created[0].options.userContextId, 8, 'guard resets after error');
assert.equal(x.created[0].options.skipRoute, undefined);
console.log('Trusted navigation: explicit identity, route suppression, POST, pinned target and guard cleanup passed.');
