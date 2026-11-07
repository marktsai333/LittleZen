const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../candidate/littleZen.uc.js'), 'utf8');
const start = source.indexOf('  function patchBrowserDOMWindow(win) {');
const end = source.indexOf('\n  function patchOpenBrowserWindow', start);
assert(start >= 0 && end > start);
for (const method of ['openURI', 'openURIInFrame']) {
  for (const outcome of ['success', 'failure', 'throw']) {
    let fallbackCalls = 0;
    let receivedOptions;
    const original = {
      openURI() { fallbackCalls++; return 'original'; },
      openURIInFrame() { fallbackCalls++; return 'original'; },
    };
    const win = { browserDOMWindow: original };
    const context = {
      PATCH_FLAGS: { browserDOMWindow: 'patched' },
      isExternalOpenContext: () => true,
      LittleZen: { openLittleWindow(_win, options) {
        receivedOptions = options;
        if (outcome === 'throw') throw new Error('synthetic failure');
        return outcome === 'success' ? {} : null;
      } },
      log() {}, Ci: {}, Components: {},
    };
    vm.runInNewContext(source.slice(start, end) + '\nthis.patch = patchBrowserDOMWindow;', context);
    context.patch(win);
    const result = win.browserDOMWindow[method]({spec: 'https://example.invalid/'}, null, null, 1);
    assert.equal(fallbackCalls, outcome === 'success' ? 0 : 1, `${method}: ${outcome}`);
    assert.equal(result, outcome === 'success' ? null : 'original');
    assert.equal(receivedOptions.expanded, true, `${method}: external links start as page windows`);
  }
}
console.log('External URLs fall back to Zen if Little Zen cannot open or throws.');
