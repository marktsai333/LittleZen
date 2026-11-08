#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUTPUT=${1:-"$ROOT/build/LittleZen Installer Preview.app"}
[ ! -e "$OUTPUT" ] || { printf 'Output already exists; choose another path: %s\n' "$OUTPUT" >&2; exit 2; }
case "$OUTPUT" in /*) ;; *) printf '%s\n' 'Use an absolute output path.' >&2; exit 2;; esac
CACHE=${TMPDIR:-/tmp}/littlezen-swift-module-cache
CORE=${LITTLEZEN_CORE_BIN:-"$ROOT/build/core-arm64/littlezen-core"}
[ -x "$CORE" ] || { printf 'Missing bundled core executable: %s\n' "$CORE" >&2; exit 2; }
[ "$(lipo -archs "$CORE")" = arm64 ] || { printf '%s\n' 'Core must be an Apple Silicon-only executable.' >&2; exit 2; }
FINGERPRINT_FILE="$(dirname -- "$CORE")/core-inputs.sha256"
[ -f "$FINGERPRINT_FILE" ] || { printf '%s\n' 'Missing core input fingerprint; rebuild the core.' >&2; exit 2; }
EXPECTED=$(/usr/bin/python3 "$ROOT/scripts/core-fingerprint.py")
[ "$(cat "$FINGERPRINT_FILE")" = "$EXPECTED" ] || { printf '%s\n' 'Core does not match current source; rebuild it.' >&2; exit 2; }
BINARY_HASH_FILE="$(dirname -- "$CORE")/core-binary.sha256"
[ -f "$BINARY_HASH_FILE" ] || { printf '%s\n' 'Missing core binary fingerprint; rebuild the core.' >&2; exit 2; }
[ "$(shasum -a 256 "$CORE" | awk '{print $1}')" = "$(cat "$BINARY_HASH_FILE")" ] || { printf '%s\n' 'Core binary does not match its build fingerprint.' >&2; exit 2; }
mkdir -p "$OUTPUT/Contents/MacOS" "$OUTPUT/Contents/Resources/installer" "$OUTPUT/Contents/Resources/candidate" "$OUTPUT/Contents/Resources/vendor"
mkdir -p "$CACHE"
CLANG_MODULE_CACHE_PATH="$CACHE" swiftc -module-cache-path "$CACHE" -target arm64-apple-macos12.0 "$ROOT/installer/macos/main.swift" -framework AppKit -o "$OUTPUT/Contents/MacOS/LittleZenInstaller"
cp "$CORE" "$OUTPUT/Contents/Resources/installer/littlezen-core"
cp "$ROOT/candidate/littleZen.uc.js" "$ROOT/candidate/little-zen.css" "$ROOT/candidate/little-zen-bridge.lua" "$OUTPUT/Contents/Resources/candidate/"
cp -R "$ROOT/vendor/fx-autoconfig" "$OUTPUT/Contents/Resources/vendor/"
cp -R "$ROOT/third_party" "$OUTPUT/Contents/Resources/third_party"
cat > "$OUTPUT/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>LittleZen Installer Preview</string>
<key>CFBundleDisplayName</key><string>LittleZen Installer Preview</string>
<key>CFBundleIdentifier</key><string>local.littlezen.installer.preview</string>
<key>CFBundleExecutable</key><string>LittleZenInstaller</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.0.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
printf 'Review build created at %s\n' "$OUTPUT"
printf '%s\n' 'Preview only: not Developer ID signed or notarized; not ready for distribution.'
