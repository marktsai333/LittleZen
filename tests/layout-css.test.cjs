const assert = require("node:assert/strict");
const fs = require("node:fs");

const css = fs.readFileSync("candidate/little-zen.css", "utf8");
const js = fs.readFileSync("candidate/littleZen.uc.js", "utf8");

const urlbarRule = css.match(
  /:root\[zen-little-window="true"\]\[zen-has-empty-tab="true"\]\s+#urlbar\[breakout-extend\]\s*\{([^}]*)\}/s
);
assert.ok(urlbarRule, "empty Little Zen URL bar rule should exist");
assert.match(urlbarRule[1], /translate:\s*none\s*!important\s*;/,
  "clear the browser's individual translate offset");
assert.doesNotMatch(urlbarRule[1], /transform:\s*translateX\(/,
  "do not use transform to cancel the separate translate offset");

const closeRule = css.match(
  /:root\[zen-little-window="true"\]\[zen-has-empty-tab="true"\]\s+#little-zen-search-close-button\s*\{([^}]*)\}/s
);
assert.ok(closeRule, "empty-window close control rule should exist");
assert.match(closeRule[1], /position:\s*absolute\s*!important\s*;/);
assert.match(closeRule[1], /top:\s*50%\s*!important\s*;/);
assert.match(closeRule[1], /translateY\(-50%\)/);
assert.match(closeRule[1], /inset-inline-end:\s*12px\s*!important\s*;/);
assert.match(js, /translate:\s*style\.translate/,
  "layout diagnostics should record the computed individual translate value");

assert.match(css, /\[zen-has-empty-tab="true"\][\s\S]*?#urlbar\[breakout-extend\][\s\S]*?#page-action-buttons[\s\S]*?display:\s*none\s*!important\s*;/,
  "hide toolbar extensions in the search palette so they cannot overlap its close control");
assert.match(css, /\.urlbarView-title[\s\S]*?text-overflow:\s*ellipsis\s*!important\s*;/,
  "clip long suggestion titles within the popup width");
assert.match(css, /\.urlbarView-url[\s\S]*?text-overflow:\s*ellipsis\s*!important\s*;/,
  "clip long suggestion URLs within the popup width");

const controlHost = css.match(
  /:root\[zen-little-window="true"\]\s+#nav-bar\s+#zen-sidebar-top-buttons\.browser-toolbar,[\s\S]*?\{([^}]*)\}/
);
const controlButtonbox = css.match(
  /:root\[zen-little-window="true"\]\s+#nav-bar\s+#zen-sidebar-top-buttons\s+\.titlebar-buttonbox-container\s*\{([^}]*)\}/
);
assert.ok(controlHost && controlButtonbox,
  "native titlebar controls should have dedicated host and buttonbox-container rules");
assert.match(controlHost[1], /inset-block-start:\s*0\s*!important\s*;/,
  "native titlebar control host should start at the top of the 44px toolbar");
assert.match(controlButtonbox[1], /inset-block-start:\s*0\s*!important\s*;/,
  "native titlebar buttonbox should start at the top of the 44px toolbar before flex centering");
assert.doesNotMatch(css, /inset-block-start:\s*-1\.5px\s*!important\s*;/,
  "do not offset native traffic lights away from the toolbar center");
assert.match(controlHost[1], /transform:\s*translateY\(-3px\)\s*!important\s*;/,
  "correct the measured 3px downward host offset to vertically center the native controls");

console.log("Little Zen search-panel CSS invariants passed (static; visual alignment still needs live confirmation).");
