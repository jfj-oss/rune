#!/usr/bin/env bash
# rune installer for Linux: checks what rune needs, gets the code, builds it, and (if you say yes) runs it as a
# systemd USER service. It never uses sudo: when something is missing it prints the command for you to run.
#
#   scripts/install.sh [--yes] [--dry-run] [--no-systemd] [--dir PATH]
#   scripts/install.sh --uninstall [--purge] [--yes]
#
# Options
#   --yes          do not ask questions (install the service; with --purge, delete without asking)
#   --dry-run      print every step and change nothing
#   --no-systemd   skip systemctl entirely (still writes the unit file); for containers and tests
#   --dir PATH     where the code lives (default: the checkout this script is in, else ~/.local/share/rune)
#   --uninstall    stop and remove the service; your music settings and data stay
#   --purge        with --uninstall: also delete rune's data, config and (if rune cloned it) the code
#   -h, --help     this text
#
# Environment: RUNE_REPO (default https://github.com/jfj-oss/rune.git), RUNE_BRANCH (default master), RUNE_PORT (4545).
set -euo pipefail

REPO="${RUNE_REPO:-https://github.com/jfj-oss/rune.git}"
BRANCH="${RUNE_BRANCH:-master}"
PORT="${RUNE_PORT:-4545}"
DEFAULT_DIR="$HOME/.local/share/rune"
DATA_DIR="$HOME/.local/share/liner"
KEY_DIR="$HOME/.config/rune"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/rune.service"

YES=0 DRY=0 NO_SYSTEMD=0 UNINSTALL=0 PURGE=0 DIR=""

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --dry-run) DRY=1 ;;
    --no-systemd) NO_SYSTEMD=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    --dir) shift; [ $# -gt 0 ] || die "--dir needs a path"; DIR="$1" ;;
    --dir=*) DIR="${1#--dir=}" ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done
[ "$PURGE" -eq 0 ] || [ "$UNINSTALL" -eq 1 ] || die "--purge only goes with --uninstall"
[ "$(id -u)" -ne 0 ] || die "do not run the installer as root: rune is installed for your own user"
[ "$DRY" -eq 0 ] || say "(dry run: nothing will be changed)"

# run CMD...: print it; run it unless this is a dry run.
run() {
  printf '+ %s\n' "$*"
  [ "$DRY" -eq 1 ] || "$@"
}

# ask QUESTION: y/N, default no; --yes answers yes.
ask() {
  [ "$YES" -eq 0 ] || { say "$1 [y/N] y (--yes)"; return 0; }
  [ "$DRY" -eq 0 ] || { say "$1 [y/N] (dry run: would ask)"; return 0; }
  [ -t 0 ] || { say "$1 [y/N] n (no terminal to ask on; use --yes)"; return 1; }
  local reply
  read -r -p "$1 [y/N] " reply
  case "$reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- where the code lives
script_root() {
  local src="${BASH_SOURCE[0]:-}" here
  [ -n "$src" ] && [ -f "$src" ] || return 1
  here="$(cd "$(dirname "$src")/.." 2>/dev/null && pwd)" || return 1
  [ -f "$here/pnpm-workspace.yaml" ] && [ -f "$here/server/src/main.ts" ] || return 1
  printf '%s' "$here"
}

if [ -z "$DIR" ]; then
  if ROOT_FROM_SCRIPT="$(script_root)"; then DIR="$ROOT_FROM_SCRIPT"; else DIR="$DEFAULT_DIR"; fi
fi
case "$DIR" in /*) ;; *) DIR="$PWD/$DIR" ;; esac

# ---------------------------------------------------------------- uninstall
if [ "$UNINSTALL" -eq 1 ]; then
  step "Stopping and removing the rune service"
  # Only touch systemd when this install wrote a unit file (a different HOME has none).
  if [ -f "$UNIT" ]; then
    if [ "$NO_SYSTEMD" -eq 0 ] && have systemctl; then
      run systemctl --user disable --now rune.service || warn "the service was not running"
    fi
    run rm -f "$UNIT"
    if [ "$NO_SYSTEMD" -eq 0 ] && have systemctl; then run systemctl --user daemon-reload; fi
  else
    say "no service unit at $UNIT: nothing to stop"
  fi
  if [ "$PURGE" -eq 1 ]; then
    step "Purging rune's data"
    say "This deletes: $DATA_DIR (library index, covers, caches), $KEY_DIR (including a saved Soloist key),"
    say "and $DIR/server/config.json. Your music files and Soloist's own session are never touched."
    if [ "$DIR" = "$DEFAULT_DIR" ]; then say "It also deletes the code in $DIR."; fi
    if ask "Delete all of that?"; then
      run rm -rf "$DATA_DIR" "$KEY_DIR"
      if [ "$DIR" = "$DEFAULT_DIR" ]; then run rm -rf "$DIR"; else run rm -f "$DIR/server/config.json"; fi
    else
      say "Nothing deleted."
    fi
  else
    say "Kept: $DATA_DIR, $KEY_DIR, $DIR (add --purge to delete the data)."
  fi
  say "rune is uninstalled."
  exit 0
fi

# ---------------------------------------------------------------- requirements
step "Checking requirements"
distro="unknown"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  case " ${ID:-} ${ID_LIKE:-} " in
    *" arch "*|*" cachyos "*|*" manjaro "*|*" endeavouros "*) distro="arch" ;;
    *" debian "*|*" ubuntu "*) distro="debian" ;;
    *" fedora "*|*" rhel "*) distro="fedora" ;;
  esac
fi

missing=()
# Packages per distro for each missing tool, collected as we go.
arch_pk=() deb_pk=() fed_pk=()
need() { # need TOOL arch-pkgs debian-pkgs fedora-pkgs
  missing+=("$1")
  # shellcheck disable=SC2206
  arch_pk+=($2) deb_pk+=($3) fed_pk+=($4)
}
ok() { say "  ok       $1"; }
bad() { say "  MISSING  $1"; }

if have git; then ok "git"; else bad "git"; need git "git" "git" "git"; fi

node_ok=0
if have node; then
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$node_major" -ge 22 ] 2>/dev/null; then ok "node $(node -v)"; node_ok=1; else bad "node 22 or newer (found $(node -v))"; fi
else
  bad "node 22 or newer"
fi
if [ "$node_ok" -eq 0 ]; then need node "nodejs npm" "nodejs npm" "nodejs npm"; NODE_NOTE=1; fi

pnpm_fix=""
if have pnpm; then
  ok "pnpm $(pnpm --version 2>/dev/null || true)"
elif have corepack; then
  say "  missing  pnpm (corepack can provide it; the installer will enable it without sudo)"
  pnpm_fix="corepack"
else
  bad "pnpm (or corepack)"
  need pnpm "pnpm" "" ""
  PNPM_NOTE=1
fi

if have mpv; then ok "mpv"; else bad "mpv"; need mpv "mpv" "mpv" "mpv"; fi
if have ffmpeg; then ok "ffmpeg"; else bad "ffmpeg"; need ffmpeg "ffmpeg" "ffmpeg" "ffmpeg-free"; fi

if have pactl; then
  if pactl info 2>/dev/null | grep -qi 'pipewire'; then
    ok "PipeWire (pactl)"
  elif pactl info >/dev/null 2>&1; then
    warn "pactl answers, but the sound server does not say PipeWire. rune is built for PipeWire; PulseAudio may work for local playback."
    ok "pactl"
  else
    bad "a running PipeWire sound server (pactl cannot connect)"
    need pipewire "pipewire pipewire-pulse wireplumber" "pipewire pipewire-pulse wireplumber" "pipewire pipewire-pulseaudio wireplumber"
  fi
else
  bad "pactl and PipeWire"
  need pactl "libpulse pipewire pipewire-pulse wireplumber" "pulseaudio-utils pipewire pipewire-pulse wireplumber" "pulseaudio-utils pipewire pipewire-pulseaudio wireplumber"
fi

if [ "$NO_SYSTEMD" -eq 1 ]; then
  say "  skipped  systemd user session (--no-systemd)"
elif have systemctl && systemctl --user show-environment >/dev/null 2>&1; then
  ok "systemd user session"
else
  bad "a systemd user session (log in on the desktop or a normal login shell, or run with --no-systemd and start rune yourself)"
  missing+=("systemd-user")
fi

print_install_help() {
  say ""
  say "Install the missing pieces, then run this installer again. Pick the line for your distro"
  say "(detected: $distro). rune never runs sudo for you."
  say ""
  say "  Arch / CachyOS:    sudo pacman -S --needed $(printf '%s\n' "${arch_pk[@]}" | sort -u | tr '\n' ' ')"
  say "  Debian / Ubuntu:   sudo apt install $(printf '%s\n' "${deb_pk[@]}" | sort -u | tr '\n' ' ')"
  say "  Fedora:            sudo dnf install $(printf '%s\n' "${fed_pk[@]}" | sort -u | tr '\n' ' ')"
  if [ -n "${NODE_NOTE:-}" ]; then
    say ""
    say "  Node 22 or newer: Debian/Ubuntu repositories are often older. Get a current one from https://nodejs.org"
    say "  or with nvm (https://github.com/nvm-sh/nvm): nvm install 22"
  fi
  if [ -n "${PNPM_NOTE:-}" ]; then
    say "  pnpm: with Node installed, run  corepack enable  (or  npm install -g pnpm)"
  fi
  case " ${missing[*]} " in *" mpv "*)
    say "  Fedora keeps mpv in RPM Fusion: https://rpmfusion.org/Configuration" ;;
  esac
  case " ${missing[*]} " in *" systemd-user "*)
    say "  Without a systemd user session, run the installer with --no-systemd and start rune with:"
    say "    cd $DIR/server && node_modules/.bin/tsx src/main.ts" ;;
  esac
}

if [ ${#missing[@]} -gt 0 ]; then
  print_install_help
  if [ "$DRY" -eq 1 ]; then
    say ""
    say "(dry run: a real run would stop here; the steps below show what it does once everything is installed)"
  else
    exit 1
  fi
fi

# ---------------------------------------------------------------- the code
step "Getting the code ($DIR)"
if [ -e "$DIR/.git" ]; then
  if [ -n "$(git -C "$DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    warn "$DIR has local changes; leaving the code as it is"
  else
    run git -C "$DIR" pull --ff-only
  fi
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  die "$DIR exists and is not a rune checkout; pass --dir with another path"
else
  run mkdir -p "$(dirname "$DIR")"
  run git clone --branch "$BRANCH" "$REPO" "$DIR"
fi

step "Installing dependencies and building the web app"
if [ "$pnpm_fix" = "corepack" ]; then
  run mkdir -p "$HOME/.local/bin"
  run corepack enable --install-directory "$HOME/.local/bin" pnpm
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH"; export PATH ;; esac
fi
if [ "$DRY" -eq 1 ] && [ ! -d "$DIR" ]; then
  say "+ (cd $DIR && pnpm install --frozen-lockfile)"
  say "+ (cd $DIR && pnpm --filter @liner/web build)"
else
  run pnpm --dir "$DIR" install --frozen-lockfile
  run pnpm --dir "$DIR" --filter @liner/web build
fi

# ---------------------------------------------------------------- config
step "Settings"
CONFIG="$DIR/server/config.json"
if [ -e "$CONFIG" ]; then
  say "keeping your existing $CONFIG"
else
  say "writing a starting $CONFIG: no music folder yet (the setup page asks), no Spotify, this PC only"
  if [ "$DRY" -eq 1 ]; then
    say "+ write $CONFIG: {\"audioDevice\": \"pipewire\"}"
  else
    printf '{\n  "audioDevice": "pipewire"\n}\n' > "$CONFIG"
    chmod 600 "$CONFIG"
  fi
fi

# ---------------------------------------------------------------- service
build_unit() {
  # PATH for the service: where node and pnpm live (they may be under nvm), then the usual places.
  local p="$HOME/.local/bin" d
  for tool in node pnpm; do
    if have "$tool"; then
      d="$(dirname "$(command -v "$tool")")"
      case ":$p:" in *":$d:"*) ;; *) p="$d:$p" ;; esac
    fi
  done
  p="$p:/usr/local/bin:/usr/bin:/bin"
  # Only pin the port when asked to; otherwise "port" in config.json decides.
  local port_line=''
  [ -z "${RUNE_PORT:-}" ] || port_line="Environment=RUNE_PORT=$PORT"$'\n'
  cat <<UNITEOF
[Unit]
Description=rune music server
After=network-online.target

[Service]
WorkingDirectory=$DIR/server
Environment=RUNE_HOST=127.0.0.1
${port_line}Environment=LOG_LEVEL=warn
Environment=PATH=$p
ExecStart=$DIR/server/node_modules/.bin/tsx src/main.ts
Restart=on-failure
RestartSec=5
MemoryMax=2G

[Install]
WantedBy=default.target
UNITEOF
}

step "Service"
service_started=0
if ask "Install rune as a systemd user service that starts when you log in?"; then
  unit_text="$(build_unit)"
  if [ -f "$UNIT" ] && [ "$(cat "$UNIT")" != "$unit_text" ]; then
    say "A different $UNIT exists; the old one is kept as rune.service.bak"
    run cp "$UNIT" "$UNIT.bak"
  fi
  if [ "$DRY" -eq 1 ]; then
    say "+ write $UNIT:"
    printf '%s\n' "$unit_text" | sed 's/^/    | /'
  else
    mkdir -p "$UNIT_DIR"
    printf '%s\n' "$unit_text" > "$UNIT"
    say "wrote $UNIT"
  fi
  if [ "$NO_SYSTEMD" -eq 1 ]; then
    say "(--no-systemd: not touching systemctl; start rune with: cd $DIR/server && node_modules/.bin/tsx src/main.ts)"
  else
    run systemctl --user daemon-reload
    run systemctl --user enable --now rune.service
    service_started=1
  fi
else
  say "Not installing the service. To run rune by hand:"
  say "  cd $DIR/server && RUNE_HOST=127.0.0.1 node_modules/.bin/tsx src/main.ts"
fi

if [ "$service_started" -eq 1 ] && [ "$DRY" -eq 0 ]; then
  say "waiting for rune to answer..."
  up=0
  for _ in $(seq 1 40); do
    if have curl && curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then up=1; break; fi
    sleep 1
  done
  if [ "$up" -eq 0 ]; then
    warn "rune did not answer yet. Look at: journalctl --user -u rune.service -e"
  fi
fi

step "Done"
say "Open  http://127.0.0.1:$PORT  in your browser. The first page walks you through picking your music."
say ""
say "To start rune at boot without logging in:  loginctl enable-linger \"\$USER\""
say "Updates: the Update chip in rune's top bar (or Settings) installs new versions."
say "Uninstall: $DIR/scripts/install.sh --uninstall   (add --purge to delete your data too)"
