const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('candidate/littleZen.uc.js', 'utf8');
const start = source.indexOf('  function searchWindowFeatures(opener, selectedScreen = null) {');
const end = source.indexOf('\n  const LITTLE_ZEN_THEME_CACHE_LIMIT', start);
assert.ok(start >= 0 && end > start);
const context = { OPEN_FEATURES: 'width=520', URLBAR_WIDTH: 520, NORMAL_WINDOW_WIDTH: 1000, NORMAL_WINDOW_HEIGHT: 600, initialSearchHeight: () => 340 };
vm.runInNewContext(source.slice(start, end) + '\nthis.features = searchWindowFeatures; this.pageFeatures = pageWindowFeatures;', context);
assert.match(context.features({screen: {availLeft: 100, availTop: 25, availWidth: 1440}}), /left=1000,top=45/);
assert.equal(context.features({}), 'width=520,height=340');
assert.doesNotMatch(source.slice(source.indexOf('  const OPEN_FEATURES'), start), /centerscreen/);

assert.match(context.features({screen: {availLeft: 0, availTop: 0, availWidth: 1440}}, {availLeft: -1600, availTop: -100, availWidth: 1600, availHeight: 900}), /left=-540,top=-80/);
assert.match(context.pageFeatures({screen: {availLeft: -1600, availTop: 20, availWidth: 1600, availHeight: 900}}), /width=1440,height=810,left=-1520,top=65/);
