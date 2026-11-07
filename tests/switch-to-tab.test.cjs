const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('candidate/littleZen.uc.js', 'utf8');
const start = source.indexOf('  function finishLittleZenTabSwitch(');
const end = source.indexOf('  function attachAutoClose(', start);
assert.ok(start >= 0 && end > start);

const patchStart = source.indexOf('  function patchUrlbar(win) {');
const patchEnd = source.indexOf('  // Candidate: route trusted', patchStart);
assert.ok(patchStart >= 0 && patchEnd > patchStart);
const sent = [];
const controller = { switchToTab(data) { sent.push(data); return 'sent'; } };
const urlbar = { parentController: controller };
const littleWindow = { gURLBar: urlbar, __littleZenGlobalFocusToken: 'previous-app' };
const mainWindow = { gBrowser: { selectedTab: {} } };
const patchContext = { PATCH_FLAGS: { urlbar: 'patched' }, LITTLE_WINDOW_ATTR: 'little',
  isLittleWindow: w => w === littleWindow, browserWindows: function* () { yield mainWindow; },
  getActiveWorkspaceId: () => 'space-a', formatLittleZenUrlbarValue: x => x, log() {} };
vm.runInNewContext(source.slice(patchStart, patchEnd) + '\nthis.runPatch = patchUrlbar;', patchContext);
patchContext.runPatch(littleWindow);
assert.equal(controller.switchToTab({ url: 'https://example.invalid/', userContextId: 4 }), 'sent');
assert.equal(sent.length, 1);
assert.equal(littleWindow.__littleZenSwitchToTab.url, 'https://example.invalid/');
assert.equal(littleWindow.__littleZenSwitchToTab.focusToken, 'previous-app');
assert.equal(littleWindow.__littleZenGlobalFocusToken, undefined);

async function run({ found, otherSpace, duplicate = false, privateTarget = false }) {
  const pending = [];
  const calls = [];
  const tab = { closing: false, linkedBrowser: { currentURI: { spec: 'https://example.invalid/' } }, getAttribute: () => 'space-b' };
  const target = { private: privateTarget, closed: false, gBrowser: { selectedTab: tab, tabs: duplicate ? [tab, { ...tab }] : [tab] }, gZenWorkspaces: { async changeWorkspaceWithID(id) { calls.push(['workspace', id]); } }, focus() { calls.push(['focus']); } };
  const little = { closed: false, setTimeout(fn) { pending.push(fn); }, close() { this.closed = true; calls.push(['close']); } };
  const context = { browserWindows: function* () { if (found) yield target; }, isLittleWindow: w => w === little,
    ChromeUtils: { importESModule: () => ({ PrivateBrowsingUtils: { isWindowPrivate: w => !!w.private } }) },
    getTabContainerId: () => 4, getActiveWorkspaceId: () => otherSpace ? 'space-a' : 'space-b',
    closeEmptyLittleWindow(w) { calls.push(['fallback', w.__littleZenGlobalFocusToken]); w.close(); }, log() {} };
  vm.runInNewContext(source.slice(start, end) + '\nthis.run = finishLittleZenTabSwitch;', context);
  context.run(little, { url: 'https://example.invalid/', userContextId: 4, focusToken: 'previous-app' });
  while (pending.length) await pending.shift()();
  return calls;
}

(async () => {
  assert.deepEqual(await run({ found: true, otherSpace: true }), [['workspace', 'space-b'], ['close'], ['focus']]);
  assert.deepEqual(await run({ found: true, otherSpace: false }), [['close'], ['focus']]);
  assert.deepEqual(await run({ found: true, duplicate: true }), [['fallback', 'previous-app'], ['close']]);
  assert.deepEqual(await run({ found: true, privateTarget: true }), [['fallback', 'previous-app'], ['close']]);
  assert.deepEqual(await run({ found: false }), [['fallback', 'previous-app'], ['close']]);
  console.log('Existing-tab switch waits for the selected target, changes Space when needed, and closes safely on timeout.');
})().catch(error => { console.error(error); process.exitCode = 1; });
