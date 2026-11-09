# Setup and maintenance

## Current status

This is a review draft, not a first-time installer. The working local setup relies on an existing fx-autoconfig loader, profile stylesheet import, two browser files and a Hammerspoon module. Do not assume copying files alone enables userChromeJS. Installing an autoconfig loader can modify the Zen application bundle; consult the loader's own instructions and back up the existing configuration. Do not overwrite an existing profile or Hammerspoon configuration wholesale.

In the known working setup, the profile's `chrome/userChrome.css` imports `CSS/little-zen.css`; the script lives at `chrome/JS/littleZen.uc.js`. The `toolkit.legacyUserProfileCustomizations.stylesheets` preference is enabled, and `zen.widget.mac.mono-window-controls` is false. Hammerspoon loads `little-zen-bridge.lua` through its existing `init.lua` and starts its module. These are observations of one configuration, not a verified fresh-install procedure.

## Updating an existing configured setup

Find the profile directory via Zen's `about:support`, then run from the project root after reviewing the scripts:

```sh
LITTLE_ZEN_PROFILE="/path/to/zen/profile" ./scripts/install-current-profile.sh
```

The command verifies the existing loader and bridge, copies the two browser files, and prints a backup location. It does not install or modify the Hammerspoon bridge. Save open work and restart Zen normally to load the updated browser files.

## Restore a browser-file backup

```sh
LITTLE_ZEN_PROFILE="/path/to/zen/profile" ./scripts/rollback-current-profile.sh "/path/to/backup-directory"
```

The selected directory must contain `littleZen.uc.js` and `little-zen.css`. The tool checks that current browser files match this project's candidate and backs them up before restoring. It does not restore the loader, Hammerspoon, preferences, or the Zen app. Do not use old full-profile backups as an excuse to overwrite a profile.

## Uninstall

A tested, selective uninstall procedure is not yet available. Do not remove shared loader files or replace `user.js`, `userChrome.css`, or `init.lua` wholesale. Track which entries and files belong exclusively to Little Zen before attempting removal.

## Customize Little Zen shortcuts

In Zen, open **Settings → Keyboard Shortcuts** and search for **Little Zen**. The **In Zen** action defaults to `⌘⌥N`; the **Global** action defaults to `⌘⌥⇧N` to avoid Finder's `⌘⌥N` shortcut. Record a new combination or clear either action in that page.

When the Global action changes, Zen saves the binding under `~/Library/Application Support/Little Zen/global-shortcut.json`; the Hammerspoon bridge watches that file and updates its system-wide hotkey without requiring an `init.lua` edit. The binding itself is one macOS-wide shortcut, while Zen's shortcut page stores its displayed choice per profile. Set Global from the profile you normally use. Hammerspoon must be running for it to work outside Zen. If the new combination is already registered by macOS or another app, choose a different one.
