#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUTPUT=${1:-"$ROOT/build/LittleZen Installer Preview.app"}
[ ! -e "$OUTPUT" ] || { printf 'Output already exists; choose another path: %s\n' "$OUTPUT" >&2; exit 2; }
case "$OUTPUT" in /*) ;; *) printf '%s\n' 'Use an absolute output path.' >&2; exit 2;; esac
CACHE=${TMPDIR:-/tmp}/littlezen-swift-module-cache
mkdir -p "$OUTPUT/Contents/MacOS" "$OUTPUT/Contents/Resources/installer" "$OUTPUT/Contents/Resources/candidate" "$OUTPUT/Contents/Resources/vendor"
mkdir -p "$CACHE"
CLANG_MODULE_CACHE_PATH="$CACHE" swiftc -module-cache-path "$CACHE" "$ROOT/installer/macos/main.swift" -framework AppKit -o "$OUTPUT/Contents/MacOS/LittleZenInstaller"
cp "$ROOT/installer/littlezen.py" "$ROOT/installer/littlezen_install.py" "$OUTPUT/Contents/Resources/installer/"
cp "$ROOT/candidate/littleZen.uc.js" "$ROOT/candidate/little-zen.css" "$ROOT/candidate/little-zen-bridge.lua" "$OUTPUT/Contents/Resources/candidate/"
cp -R "$ROOT/vendor/fx-autoconfig" "$OUTPUT/Contents/Resources/vendor/"
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
printf '%s\n' 'Not signed or notarized; Python 3.10+ is required. Not ready for distribution.'
