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

An earlier sandboxed `codesign` check of `/Applications/Zen.app` returned an invalid-signature message, but later checks show that sandbox restrictions can produce misleading results. A subsequent unsandboxed read-only strict check encountered Finder extended attributes; it does not establish the status or cause of the currently installed app’s code signature. No changes to that app were made.

## 2026-11-08: clean Zen 1.24b bundle experiment

Downloaded `zen.macos-universal.dmg` from the official `zen-browser/desktop` GitHub release tagged `1.24b`, mounted it read-only, and copied `Zen.app` into the ignored local `build/` test area. The mounted image's copied files carried Finder extended attributes that `codesign --strict` rejected, so extended attributes were removed only from the disposable copy before the baseline verification. Baseline `codesign --verify --deep --strict` passed.

The installation core was then run directly against that copy and empty, disposable profile and Hammerspoon directories. After it added the loader, `codesign --verify --deep --strict` failed with `a sealed resource is missing or invalid`. Removing LittleZen using the current default path removed project files but deliberately retained the shared loader, and signature verification still failed. Finally, for this experiment only, the two program-side files created by the test were verified byte-for-byte against the pinned vendor copies and removed from the disposable app; the original signature verified again.

This proves the specific clean 1.24b copy can recover its signature if those exact additions are removed. It does not prove that loader removal is safe when other profiles or customizations use it, nor does it cover other Zen versions or overwritten signed resources. The final uninstaller needs an explicit safe strategy for shared dependencies; default removal must not assume they are unused. The official image was detached after the experiment. The daily Zen application and profile were not used in this experiment.

## Optional owned-loader cleanup prototype

`plan_remove(..., remove_app_loader=True, registry_path=...)` can include the two app-bundle loader files only when their installation record says they were created by LittleZen, the current bytes match, the selected profile is registered, and the audit finds no other scripts in it or obvious loader usage in other registered profiles. The CLI also requires explicit acknowledgement that unregistered profiles cannot be detected. The default retains all shared loader files. The audit is repeated when applying the plan, and conflicts abort cleanup. This is conservative but cannot prove the absence of unregistered profiles or every possible external dependency; the option is available in the experimental GUI with an explicit warning and is not enabled by default. The GUI has not yet been visually tested.

In a disposable official Zen 1.24b copy with a synthetic single-profile registry, the actual installer and optional cleanup were run end to end. Unsandboxed `codesign --verify --deep --strict` returned 0 on the original copy, nonzero with the installed loader, and 0 after the owned app-loader cleanup. The test did not launch Zen or validate its runtime behavior.

## 2026-11-08: Apple Silicon standalone experiment

The requested target is now Apple Silicon only. A core executable was packaged using the python.org 3.13.17 macOS universal installer (SHA-256 recorded in `third_party/README.md`) and PyInstaller 6.16.0. The package was extracted to the ignored build directory rather than installed. Its local Python launcher was relocated and ad-hoc signed for the build experiment; this is not Developer ID signing or notarization.

The arm64 core was bundled into the prototype AppKit app. A process-level test executed the bundled core with PATH restricted to system utilities and Python environment variables removed; install, update and optional owned-loader removal succeeded against a newly-created synthetic app and profile. The test driver itself used local Python; the core under test was the bundled executable. The app GUI was compiled but not launched or visually verified. The prototype still lacks a safe privilege-elevation implementation for root-owned application bundles and remains unsuitable for public release.

The build scripts compute and verify source and binary fingerprints before assembling the preview app. The intended scope does not include Intel support.

## 2026-11-08: packaged Apple Silicon core and version gate

The prototype now launches a bundled arm64 PyInstaller core instead of requiring `python3` from the user's PATH. The build appends source-input and binary fingerprints and refuses to assemble a stale or altered core. Two opt-in standalone process tests succeeded against temporary synthetic apps and profiles: install/update/remove, and refusal to apply against an unverified Zen version without acknowledgement. The test driver used Python; the tested core executable carried its own runtime. GUI interaction, actual permissions and a fresh real Zen session remain unverified.

The initial packaging experiment used Python.org 3.13.17 because an official macOS binary was available. Python.org subsequently lists security fixes in 3.13.18 without a binary installer. Do not treat 3.13.17 as a final release-runtime choice: evaluate a current supported patched runtime, affected modules, reproducibility, and complete notices before distribution. The bundled application is neither Developer ID signed nor notarized.
