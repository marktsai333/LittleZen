# macOS installation research (working draft)

## Findings

- The existing LittleZen JavaScript requires a privileged browser loader; CSS or an ordinary extension alone does not provide its current functionality.
- fx-autoconfig installs program-side files into the application bundle's `Contents/Resources` and loader files into each profile. Its upstream license is MPL-2.0. [Upstream](https://github.com/MrOtherGuy/fx-autoconfig)
- Modifying a signed macOS app bundle breaks its code-signing seal, and system behavior may depend on context. [Apple](https://developer.apple.com/documentation/xcode/embedding-nonstandard-code-structures-in-a-bundle)
- The existing third-party shell installer places files in the app bundle and refuses differing existing autoconfig files. It is not a complete installer for this project's Hammerspoon bridge. [Source](https://github.com/wahyuabrory/little-zen/blob/main/install.sh)
- Hammerspoon requires its own installation and permissions; simply copying a Lua file is insufficient. [Hammerspoon](https://www.hammerspoon.org/go/)

## Design requirements

1. Detect app version, selected profile(s), existing loader files and Hammerspoon without modifying them. Show exact proposed changes and conflicts.
2. Never overwrite an unrelated loader, browser setting, Hammerspoon configuration or existing customized LittleZen file. Track ownership and hashes.
3. Record original state before writes, use atomic changes where possible, and recover from interruption; do not remove components subsequently modified by the user.
4. Treat the loader as shared; selective removal must not break other customizations. Handle upgrades and replaced app bundles explicitly.
5. Make global shortcut setup optional, preserve Hammerspoon settings, and describe macOS permission requirements accurately.
6. Use an isolated, user-selected test profile and disposable app copies for integration tests; never mutate the daily Zen app while testing.
7. Evaluate distribution, developer signing/notarization and precise third-party licensing separately. Do not promise a seamless one-click workflow until tested.

## Open decisions requiring evidence

- Whether a supported signed-bundle-preserving route can load the existing browser code. If not, document the effect of fx-autoconfig and present it as an explicit installation choice rather than silently invalidating a signature.
- Identify and pin an appropriate loader revision with its MPL-2.0 license and source. Determine rights for the Little Zen upstream derivative separately.
- Determine how to support multiple profiles, running Zen, Hammerspoon accessibility permissions, app updates, partial install and rollback across process interruption.
