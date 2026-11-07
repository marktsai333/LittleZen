const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('candidate/littleZen.uc.js', 'utf8');
const start = source.indexOf('    const refreshIdentityBadge = () => {');
const end = source.indexOf('\n    refreshIdentityBadge();', start);
assert(start >= 0 && end > start);
function run(id, fail = false) {
  const badge = {setAttribute() {}};
  const context = {
    win: {gBrowser: {selectedTab: {getAttribute: () => String(id)}}},
    spaceBadgeIcon: {}, spaceBadgeName: {}, spaceBadge: badge, log() {},
    ChromeUtils: {importESModule(path) {
      assert.equal(path, 'moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs');
      if (fail) throw Error('unavailable');
      return {ContextualIdentityService: {
        getPublicIdentityFromId: n => n === 6 ? {name:'Education'} : null,
        getUserContextLabel: n => n === 6 ? 'Education' : ''
      }};
    }}
  };
  vm.runInNewContext(source.slice(start, end) + '\nrefreshIdentityBadge();', context);
  return context.spaceBadgeName.textContent;
}
assert.equal(run(6), 'Education');
assert.equal(run(0), 'Default');
assert.equal(run(6, true), 'Identity unavailable');
