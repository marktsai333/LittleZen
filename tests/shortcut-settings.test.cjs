const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('candidate/littleZen.uc.js', 'utf8');
const start = source.indexOf('  function globalShortcutConfigPath() {');
const end = source.indexOf('  function patchContentLinkShortcut()', start);
assert.ok(start >= 0 && end > start, 'shortcut registration functions must remain in the expected block');

const nodes = new Map();
const keyset = {
  id: 'mainKeyset',
  appendChild(node) { nodes.set(node.id, node); },
};
nodes.set(keyset.id, keyset);

const win = {
  MutationObserver: class { observe() {} disconnect() {} },
  document: {
    documentElement: { lang: 'zh-TW' },
    getElementById(id) { return nodes.get(id) || null; },
    createXULElement(tagName) {
      const attributes = new Map();
      return {
        tagName,
        id: '',
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.get(name) || ''; },
        attributes,
      };
    },
  },
  addEventListener() {},
  setTimeout() { return 1; },
  clearTimeout() {},
};

const manager = {
  async addKeys(_actor, keys) { return keys; },
};
const context = {
  BRIDGE_SHORTCUT_KEY_ID: 'little-zen-bridge-key',
  COMMAND_ID: 'cmd_zenNewLittleWindow',
  GLOBAL_SHORTCUT_KEY_ID: 'little-zen-global-shortcut-key',
  LOCAL_SHORTCUT_KEY_ID: 'little-zen-shortcut-key',
  PATCH_FLAGS: { keyListener: '__littleZenShortcutInstalled' },
  SHORTCUT_CONFIG_FILE: 'global-shortcut.json',
  ChromeUtils: { importESModule: () => ({ ZenKeyboardShortcuts: manager }) },
  Ci: { nsIFile: {} },
  Services: { dirsvc: { get: () => ({ path: '/Users/test' }) } },
  PathUtils: { join: (...parts) => parts.join('/') },
  IOUtils: {},
  Promise,
  log() {},
  win,
};

vm.runInNewContext(
  `${source.slice(start, end)}\nthis.installShortcuts = ensureFallbackShortcut;`,
  context
);
context.installShortcuts(win);

const actor = {
  browsingContext: { topChromeWindow: win },
  getKeyData(id) {
    const key = nodes.get(id);
    if (!key) return null;
    return {
      shortcut: `${key.getAttribute('modifiers')}+${key.getAttribute('key')}`,
      isCustomized: false,
      internal: false,
      systemAssigned: false,
    };
  },
};

(async () => {
  const registered = await manager.addKeys(actor, { File: {} });
  const category = registered['Little Zen'];
  assert.ok(category, 'Little Zen gets its own category in Zen Keyboard Shortcuts');
  assert.equal(category['little-zen-shortcut-key'].title, 'Little Zen — Zen 內');
  assert.equal(category['little-zen-shortcut-key'].shortcut, 'accel,alt+n');
  assert.equal(category['little-zen-global-shortcut-key'].title, 'Little Zen — 全域');
  assert.equal(category['little-zen-global-shortcut-key'].shortcut, 'accel,alt,shift+n');
  console.log('Zen Keyboard Shortcuts: both Little Zen actions are listed and editable.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
