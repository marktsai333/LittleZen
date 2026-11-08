#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PYTHON=${LITTLEZEN_PACKAGING_PYTHON:-}
[ -n "$PYTHON" ] && [ -x "$PYTHON" ] || { printf '%s\n' 'Set LITTLEZEN_PACKAGING_PYTHON to a Python 3.13.17 executable with PyInstaller 6.16.0.' >&2; exit 2; }
[ "$("$PYTHON" -c 'import sys; print(".".join(map(str,sys.version_info[:3])))')" = 3.13.17 ] || { printf '%s\n' 'Expected Python 3.13.17.' >&2; exit 2; }
[ "$("$PYTHON" -c 'import PyInstaller; print(PyInstaller.__version__)')" = 6.16.0 ] || { printf '%s\n' 'Expected PyInstaller 6.16.0.' >&2; exit 2; }
DIST=${1:-"$ROOT/build/core-arm64"}
case "$DIST" in /*) ;; *) printf '%s\n' 'Use an absolute output path.' >&2; exit 2;; esac
[ ! -e "$DIST" ] || { printf 'Output exists; choose another path: %s\n' "$DIST" >&2; exit 2; }
mkdir -p "$ROOT/build" "$DIST"
WORK=$(mktemp -d "$ROOT/build/core-work.XXXXXXXX")
BEFORE=$(/usr/bin/python3 "$ROOT/scripts/core-fingerprint.py")
PYINSTALLER_CONFIG_DIR="${TMPDIR:-/tmp}/littlezen-pyinstaller-cache-313" "$PYTHON" -m PyInstaller --noconfirm --onefile --noupx --target-architecture arm64 --name littlezen-core --distpath "$DIST" --workpath "$WORK/work" --specpath "$WORK" --add-data "$ROOT/candidate:candidate" --add-data "$ROOT/vendor/fx-autoconfig:vendor/fx-autoconfig" "$ROOT/installer/littlezen.py"
AFTER=$(/usr/bin/python3 "$ROOT/scripts/core-fingerprint.py")
[ "$BEFORE" = "$AFTER" ] || { printf '%s\n' 'Inputs changed during build; discard output.' >&2; exit 1; }
[ "$(lipo -archs "$DIST/littlezen-core")" = arm64 ] || { printf '%s\n' 'Unexpected executable architecture.' >&2; exit 1; }
printf '%s\n' "$AFTER" > "$DIST/core-inputs.sha256"
shasum -a 256 "$DIST/littlezen-core" | awk '{print $1}' > "$DIST/core-binary.sha256"
printf 'Standalone review core created: %s\n' "$DIST/littlezen-core"
