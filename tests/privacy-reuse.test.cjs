const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../candidate/littleZen.uc.js'), 'utf8');
const start = source.indexOf('    openLittleWindow(opener = window, options = {}) {');
const end = source.indexOf('\n    },\n  };', start);
assert(start >= 0 && end > start);
function run(openerPrivate, otherPrivate) {
  let opened = 0, queued = 0, focused = 0;
  const other = {private: otherPrivate, focus() {focused++;}};
  const opener = {private: openerPrivate, OpenBrowserWindow() {opened++; return {focus() {focused++;}};}};
  const context = {
    getLittleZenOriginSpace: () => ({containerTabId: 3}),
    ChromeUtils: {importESModule: () => ({PrivateBrowsingUtils: {isWindowPrivate: w => w.private}})},
    browserWindows: function* () {yield other;},
    isEmptyLittleWindow: () => true,
    log() {}, focusUrlbar() {}, cursorScreenBounds: () => null, positionSearchWindow() {}, OPEN_FEATURES: '', searchWindowFeatures: () => '', whenStartupReady() {},
  };
  vm.runInNewContext('this.subject = {' + source.slice(start,end) + '\n    }, queueNavigation() { queued++; }};',
    Object.assign(context, {get queued() { return queued; }, set queued(v) { queued = v; }}));
  const result = context.subject.openLittleWindow(opener);
  return {result, opened, queued, focused};
}
assert.equal(run(true, false).result, null, 'private opener must not use normal little window');
assert.equal(run(false, true).opened, 1, 'normal opener must not reuse private little window');
assert.equal(run(false, false).opened, 0, 'normal empty window can be reused');
console.log('Private origins fail closed and normal windows do not reuse private little windows.');
