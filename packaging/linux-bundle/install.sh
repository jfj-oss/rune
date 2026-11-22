#!/bin/sh
# Installs rune for this user (no root): the app in ~/.local/share/rune-app, a user service that runs its server, the
# app-menu entry and the `rune` command. Your music is only read; settings stay in ~/.config/rune-app and the library
# database in ~/.local/share/liner.
#   ./install.sh             install (or update) and start
#   ./install.sh --yes       no questions;  --no-systemd  do not set up the service (rune starts the server itself)
#   --update                 (used by rune-update) replace the app and restart the server
set -eu
SRC=$(cd "$(dirname "$0")" && pwd)
YES=0; SYSD=1; UPD=0
for a in "$@"; do case $a in --yes) YES=1;; --no-systemd) SYSD=0;; --update) UPD=1; YES=1;; -h|--help) sed -n 2,8p "$0"; exit 0;; esac; done
DATA=${XDG_DATA_HOME:-$HOME/.local/share}; CONF=${XDG_CONFIG_HOME:-$HOME/.config}
A="$DATA/rune-app"
say() { printf '%s\n' "$*"; }

if [ $UPD = 0 ]; then
  # what rune needs from the system
  miss=""
  for c in mpv ffmpeg pactl; do command -v $c >/dev/null || miss="$miss $c"; done
  if [ -n "$miss" ]; then
    pkgs=$(echo "$miss" | sed 's/pactl/pulseaudio-utils/')
    say "rune needs:$miss (to play your music files). Install them, for example:"
    say "  Ubuntu/Debian:  sudo apt install$(echo "$pkgs")"
    say "  Fedora:         sudo dnf install$(echo "$miss" | sed 's/pactl/pulseaudio-utils/; s/ffmpeg/ffmpeg-free/')"
    say "  Arch/CachyOS:   sudo pacman -S$(echo "$miss" | sed 's/pactl/libpulse/')"
    if [ $YES = 0 ]; then printf 'Go on anyway? [y/N] '; read -r r; case $r in y|Y) ;; *) exit 1;; esac; fi
  fi
  ls /usr/share/vulkan/icd.d/*.json /etc/vulkan/icd.d/*.json >/dev/null 2>&1 || say "Note: no Vulkan driver found. The rune window needs one (most graphics drivers include it)."
  command -v flatpak >/dev/null && flatpak info com.spotify.Client >/dev/null 2>&1 || say "For Spotify songs rune uses the Spotify app: flatpak install flathub com.spotify.Client"
fi

# the files: put the new copy next to the old one, then swap, so a running rune never sees half a copy
mkdir -p "$DATA"
rm -rf "$A.new"; cp -a "$SRC" "$A.new"
rm -f "$A.new/install.sh.log"
if [ -d "$A" ]; then rm -rf "$A.old"; mv "$A" "$A.old"; fi
mv "$A.new" "$A"; rm -rf "$A.old"

# the command, the menu entry and its icons
mkdir -p "$HOME/.local/bin" "$DATA/applications"
ln -sf "$A/bin/rune" "$HOME/.local/bin/rune"
ln -sf "$A/bin/rune-update" "$HOME/.local/bin/rune-update"
for s in 48 128 256 512; do mkdir -p "$DATA/icons/hicolor/${s}x${s}/apps"; cp "$A/icons/$s.png" "$DATA/icons/hicolor/${s}x${s}/apps/rune-desktop.png"; done
cat > "$DATA/applications/rune-desktop.desktop" <<D
[Desktop Entry]
Type=Application
Name=rune
Comment=Your music, and your Spotify
Exec=$A/bin/rune
Icon=rune-desktop
Terminal=false
Categories=Audio;Music;Player;AudioVideo;
StartupWMClass=rune-desktop
D
command -v update-desktop-database >/dev/null && update-desktop-database "$DATA/applications" >/dev/null 2>&1 || true

# the server as a user service: starts at login, restarts when the setup page asks it to
if [ $SYSD = 1 ] && command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p "$CONF/systemd/user"
  cat > "$CONF/systemd/user/rune-app.service" <<U
[Unit]
Description=rune music server (the download from jfj-oss/rune)
After=pipewire.service pipewire-pulse.service

[Service]
ExecStart=$A/bin/rune-server
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
U
  systemctl --user daemon-reload
  if [ $UPD = 1 ]; then systemctl --user restart rune-app.service; else systemctl --user enable --now rune-app.service >/dev/null 2>&1; systemctl --user restart rune-app.service; fi
elif [ $UPD = 1 ]; then
  pkill -f "$A/server/main.mjs" 2>/dev/null || true
fi

say "rune $(cat "$A/VERSION") is installed. Open it from the app menu, or type: rune"
[ $UPD = 1 ] || say "The first time, your browser opens rune's setup page: pick your music folder and sign in to Spotify there."
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) say "(~/.local/bin is not on your PATH, so use the app menu, or $A/bin/rune)";; esac
