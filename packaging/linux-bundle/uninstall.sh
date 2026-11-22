#!/bin/sh
# Removes rune (the app, the service, the menu entry). Your music is never touched. Your library database and settings
# stay unless you add --all (~/.local/share/liner, ~/.config/rune-app).
set -eu
DATA=${XDG_DATA_HOME:-$HOME/.local/share}; CONF=${XDG_CONFIG_HOME:-$HOME/.config}
systemctl --user disable --now rune-app.service >/dev/null 2>&1 || true
rm -f "$CONF/systemd/user/rune-app.service"; systemctl --user daemon-reload >/dev/null 2>&1 || true
pkill -x rune-desktop 2>/dev/null || true
rm -rf "$DATA/rune-app" "$DATA/applications/rune-desktop.desktop"
for s in 48 128 256 512; do rm -f "$DATA/icons/hicolor/${s}x${s}/apps/rune-desktop.png"; done
for l in rune rune-update; do [ "$(readlink "$HOME/.local/bin/$l" 2>/dev/null)" = "$DATA/rune-app/bin/$l" ] && rm -f "$HOME/.local/bin/$l"; done
if [ "${1:-}" = --all ]; then rm -rf "$DATA/liner" "$CONF/rune-app" "${XDG_STATE_HOME:-$HOME/.local/state}/rune-app"; echo "rune and its library database and settings are removed."; else echo "rune is removed. Your library database and settings are kept (./uninstall.sh --all removes them too)."; fi
