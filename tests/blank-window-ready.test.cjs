const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../candidate/littleZen.uc.js'), 'utf8');
const start = source.indexOf('  function scheduleBlankLittleWindowReady(');
const end = source.indexOf('  function positionLittleWindowNavbar(', start);
assert(start >= 0 && end > start, 'blank readiness helper exists');
const code = source.slice(start, end) + '\nthis.scheduleReady = scheduleBlankLittleWindowReady;';

function scenario({ spec = 'about:blank', pendingURL = null, closed = false } = {}) {
  const scheduled = [];
  const loadingChanges = [];
  const win = {
    closed,
    __littleZenPendingURL: pendingURL,
    gBrowser: { selectedBrowser: { currentURI: { spec } } },
    requestAnimationFrame(fn) { scheduled.push(fn); },
    setTimeout(fn) { scheduled.push(fn); },
  };
  const context = {
    isLittleWindow: () => true,
    setLittleWindowLoading(_win, isLoading, reason) {
      loadingChanges.push({ isLoading, reason });
    },
  };
  vm.runInNewContext(code, context);
  context.scheduleReady(win, 'unit-test');
  for (const callback of scheduled) callback();
  return { win, loadingChanges };
}

const blank = scenario();
assert.deepEqual(blank.loadingChanges, [{
  isLoading: false,
  reason: 'blank-document-ready:unit-test:raf',
}], 'a settled blank search window releases its loading veil once');

assert.equal(scenario({ spec: 'https://example.invalid/' }).loadingChanges.length, 0,
  'a real navigation is never treated as a ready blank document');
assert.equal(scenario({ pendingURL: 'https://example.invalid/' }).loadingChanges.length, 0,
  'an outstanding queued URL keeps its loading veil');
assert.equal(scenario({ closed: true }).loadingChanges.length, 0,
  'a closed popup is ignored');

console.log('Blank Little Zen startup releases only the settled about:blank loading veil.');
