#!/bin/bash
# Runs ON the Mac (Apple silicon): builds rune-desktop in release mode, wraps it as "rune.app", signs it ad hoc (Apple silicon refuses
# unsigned code; no developer account is involved) and, with `install`, puts it in /Applications/rune.app.
#   native/desktop/packaging/build-mac.sh [install] [version]
# Needs Rust (rustup) and the Xcode Command Line Tools. The build runs under caffeinate with 4 jobs so the laptop stays awake and usable.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"
INSTALL=0; VERSION=0.1.0
for a in "$@"; do case "$a" in install) INSTALL=1;; *) VERSION=$a;; esac; done

caffeinate -i cargo build -j 4 --release -p rune-desktop
BIN=target/release/rune-desktop
APP="build/rune.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/rune-desktop"
sed "s/VERSION/$VERSION/g" packaging/Info.plist > "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist"

# the icon: an .icns made from the 1024 px PNG with sips + iconutil
ICONS=build/AppIcon.iconset
rm -rf "$ICONS"; mkdir -p "$ICONS"
for s in 16 32 64 128 256 512; do
  sips -z $s $s packaging/rune-desktop-1024.png --out "$ICONS/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) packaging/rune-desktop-1024.png --out "$ICONS/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONS" -o "$APP/Contents/Resources/AppIcon.icns" && echo "icon: ok" || echo "icon: skipped"

codesign --force --deep --sign - "$APP"
codesign --verify --strict "$APP"
echo "built $APP"

if [ $INSTALL = 1 ]; then
  osascript -e 'tell application "rune" to quit' 2>/dev/null || true
  sleep 2
  rm -rf "/Applications/rune.app"
  cp -R "$APP" "/Applications/rune.app"
  echo "installed /Applications/rune.app"
fi
