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

## 2026-11-08: privilege boundary

Zen installed in `/Applications` may be writable only by an administrator. Running the entire installer as root would also create or replace per-user profile and Hammerspoon files as root, so the prototype rejects that mode. The current CLI intentionally aborts before writes if a selected target directory is not writable; it does not yet solve elevated installation.

A future installer needs two separated operations: the unprivileged user process owns profile changes and its journal, while a narrowly scoped, user-authorized helper changes only explicitly planned application-bundle loader files. Before performing privileged writes, the helper must independently revalidate the selected Zen app identity and executable, exact relative paths, pinned source hashes, expected previous content, filesystem links and the running-process state; it must not trust arbitrary paths or shell text from the user process. It must report partial failures for recovery without exposing or writing browser profile contents as root. Installing into a user-writable app location is another option, but a separate app copy may create identity/update confusion and must not be used as a silent substitute.

Current prototype lifecycle tests use synthetic profile/app directories. The `ps`-based running-process guard cannot be exercised directly in the current sandbox (operation not permitted); tests simulate this OS call and verify its decision logic. Real macOS integration and the user-visible elevation flow remain unverified.

## 2026-11-08: prototype UI and observed signing state

A native AppKit review prototype now builds locally with `scripts/build-installer-preview.sh`. It includes the installer core, candidate files and pinned loader. Its preview must complete before Apply is enabled; the CLI compares the current plan with the preview fingerprint before writing. The prototype still depends on an independently installed Python 3.10+, does not contain an authorization helper, is not notarized, and has not been launched or visually tested. It is not an installable public release.

Read-only `codesign --verify --deep --strict` on the currently installed `/Applications/Zen.app` reported an invalid signature. This observation alone does not establish what caused it. No changes to that app were made during the check, and this observation must not be generalized to a clean official installation. The effect on updates, launch behavior and a clean signed copy still needs an isolated experiment.
