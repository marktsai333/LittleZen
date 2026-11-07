#!/bin/sh
set -eu

# Update an already configured profile without changing user or loader settings.
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PROFILE=${LITTLE_ZEN_PROFILE:-}
[ -n "$PROFILE" ] || { printf '%s\n' 'Set LITTLE_ZEN_PROFILE to the configured Zen profile directory.' >&2; exit 2; }
HAMMERSPOON=${LITTLE_ZEN_HAMMERSPOON_DIR:-"$HOME/.hammerspoon"}
CSS="$PROFILE/chrome/CSS/little-zen.css"
JS="$PROFILE/chrome/JS/littleZen.uc.js"
BRIDGE="$HAMMERSPOON/little-zen-bridge.lua"
for required in "$PROFILE/chrome/userChrome.css" "$PROFILE/chrome/utils/boot.sys.mjs" "$CSS" "$JS" "$HAMMERSPOON/init.lua" "$BRIDGE" "$ROOT/candidate/little-zen.css" "$ROOT/candidate/littleZen.uc.js" "$ROOT/candidate/little-zen-bridge.lua"; do
  [ -f "$required" ] || { printf 'Missing required file: %s\n' "$required" >&2; exit 2; }
done
grep -Fq '@import url("CSS/little-zen.css");' "$PROFILE/chrome/userChrome.css" || { printf '%s\n' 'Little Zen CSS import not found; no changes made.' >&2; exit 2; }
grep -Fq 'little-zen-bridge.lua' "$HAMMERSPOON/init.lua" || { printf '%s\n' 'Hammerspoon bridge is not configured; no changes made.' >&2; exit 2; }
cmp -s "$ROOT/candidate/little-zen-bridge.lua" "$BRIDGE" || { printf '%s\n' 'Existing bridge differs from the candidate; review it before updating.' >&2; exit 2; }
BACKUP="$ROOT/backups/update-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$ROOT/backups"
mkdir -m 700 "$BACKUP"
cp -p "$CSS" "$BACKUP/little-zen.css"
cp -p "$JS" "$BACKUP/littleZen.uc.js"
restore_on_failure() { cp -p "$BACKUP/little-zen.css" "$CSS"; cp -p "$BACKUP/littleZen.uc.js" "$JS"; }
if ! cp "$ROOT/candidate/little-zen.css" "$CSS" || ! cp "$ROOT/candidate/littleZen.uc.js" "$JS" || ! cmp -s "$ROOT/candidate/little-zen.css" "$CSS" || ! cmp -s "$ROOT/candidate/littleZen.uc.js" "$JS"; then
  restore_on_failure
  printf '%s\n' 'Update failed; previous browser files were restored.' >&2
  exit 1
fi
printf 'Updated browser files. Backup: %s\n' "$BACKUP"
printf '%s\n' 'Restart Zen to load the updated files. Hammerspoon was not changed.'
