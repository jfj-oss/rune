#!/bin/bash
# Installs rune-desktop for the current user: the binary, the desktop entry and the icon (no root needed).
#   packaging/install-linux.sh /path/to/rune-desktop
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
BIN=${1:?usage: install-linux.sh /path/to/rune-desktop}
install -Dm755 "$BIN" "$HOME/.local/bin/rune-desktop"
install -Dm644 "$HERE/rune-desktop.desktop" "$HOME/.local/share/applications/rune-desktop.desktop"
install -Dm644 "$HERE/rune-desktop.png" "$HOME/.local/share/icons/hicolor/512x512/apps/rune-desktop.png"
command -v update-desktop-database >/dev/null && update-desktop-database "$HOME/.local/share/applications" || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q "$HOME/.local/share/icons/hicolor" || true
echo "installed: rune-desktop is in your launcher (binary in ~/.local/bin)"
