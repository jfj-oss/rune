#!/bin/bash
# Builds build/rune mini.app with SwiftPM (no Xcode project) and ad-hoc signs it, the way Claude Summon is built.
# Usage: scripts/build-app.sh [install]      (install copies it to "/Applications/rune mini.app")
set -euo pipefail
cd "$(dirname "$0")/.."

swift build -c release
BIN="$(swift build -c release --show-bin-path)/RuneMini"
APP="build/rune mini.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/RuneMini"
strip -x "$APP/Contents/MacOS/RuneMini" 2>/dev/null || true
cp Resources/Info.plist "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist"

# Icon is optional: the app works without it.
if [ -f scripts/make-icon.swift ] && swift scripts/make-icon.swift build/AppIcon.iconset 2>/dev/null \
   && iconutil -c icns build/AppIcon.iconset -o "$APP/Contents/Resources/AppIcon.icns" 2>/dev/null; then
    echo "icon: ok"
else
    echo "icon: skipped"
fi

codesign --force --deep --sign - "$APP"     # ad-hoc: Apple silicon refuses to run anything unsigned
codesign --verify --strict "$APP"
echo "built $APP"

if [ "${1:-}" = "install" ]; then
    rm -rf "/Applications/rune mini.app"
    cp -R "$APP" "/Applications/rune mini.app"
    echo "installed /Applications/rune mini.app"
fi
