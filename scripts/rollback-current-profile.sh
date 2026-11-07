#!/bin/sh
set -eu

# Restore only browser files from an explicitly selected backup.
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PROFILE=${LITTLE_ZEN_PROFILE:-}
[ -n "$PROFILE" ] || { printf '%s\n' 'Set LITTLE_ZEN_PROFILE to the configured Zen profile directory.' >&2; exit 2; }
BACKUP=${1:-}
CSS="$PROFILE/chrome/CSS/little-zen.css"
JS="$PROFILE/chrome/JS/littleZen.uc.js"
[ -n "$BACKUP" ] && [ -f "$BACKUP/little-zen.css" ] && [ -f "$BACKUP/littleZen.uc.js" ] || { printf '%s\n' 'Usage: rollback-current-profile.sh /path/to/backup-directory' >&2; exit 2; }
for file in "$CSS" "$JS" "$ROOT/candidate/little-zen.css" "$ROOT/candidate/littleZen.uc.js"; do
  [ -f "$file" ] || { printf 'Missing file: %s\n' "$file" >&2; exit 2; }
done
cmp -s "$ROOT/candidate/little-zen.css" "$CSS" && cmp -s "$ROOT/candidate/littleZen.uc.js" "$JS" || { printf '%s\n' 'Installed files differ from the candidate; review before restoring.' >&2; exit 2; }
SAFETY="$ROOT/backups/pre-restore-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$ROOT/backups"
mkdir -m 700 "$SAFETY"
cp -p "$CSS" "$SAFETY/little-zen.css"
cp -p "$JS" "$SAFETY/littleZen.uc.js"
if ! cp -p "$BACKUP/little-zen.css" "$CSS" || ! cp -p "$BACKUP/littleZen.uc.js" "$JS"; then
  cp -p "$SAFETY/little-zen.css" "$CSS"
  cp -p "$SAFETY/littleZen.uc.js" "$JS"
  printf '%s\n' 'Restore failed; the previous browser files were put back.' >&2
  exit 1
fi
printf 'Restored browser files from %s. Previous files saved in %s.\n' "$BACKUP" "$SAFETY"
printf '%s\n' 'Restart Zen to load the restored files. User settings and Hammerspoon were not changed.'
