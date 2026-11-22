#!/usr/bin/env bash
# Builds the downloadable rune for Linux friends: dist/rune-linux-x86_64.tar.gz (+ .sha256). Everything is built inside
# Ubuntu 22.04 (glibc 2.35) so it runs on Ubuntu 22.04 and newer, Debian 12, Fedora and Arch. Inside the tarball:
#   node/        its own Node.js (nobody needs Node, pnpm, git or Rust)
#   server/      the rune server bundled into one file (esbuild) + better-sqlite3 built for that Node
#   db/          the SQL the server reads next to it;  web/  the built web UI (the setup page and phones use it)
#   bin/         rune-desktop (the native app), rune (launcher), rune-server, rune-update, helper.mjs
#   install.sh, uninstall.sh, README.txt, VERSION, icons/, and spotify-client-id (your Spotify app id, see below)
#
#   scripts/package-linux.sh 0.3.0          the version friends' apps compare against the latest GitHub release
#
# The Spotify app id comes from server/config.json (spotifyClientId) unless RUNE_SPOTIFY_CLIENT_ID is set. It is not a secret
# (PKCE, no client secret), but only people added under User Management on the Spotify dashboard can sign in with it.
# RUNE_BUNDLE_NO_SPOTIFY=1 leaves it out (then friends make their own Spotify app on the setup page).
set -euo pipefail
cd "$(dirname "$0")/.."
VER=${1:?usage: scripts/package-linux.sh VERSION}
NODE_VER=${RUNE_NODE_VERSION:-22.23.2}
OUT=$(realpath -m "${RUNE_OUT:-dist}")
CACHE=$(realpath -m "${RUNE_BUILD_CACHE:-$HOME/.cache/rune-package}")
mkdir -p "$OUT" "$CACHE"
CID=""
if [ "${RUNE_BUNDLE_NO_SPOTIFY:-}" != 1 ]; then
  CID=${RUNE_SPOTIFY_CLIENT_ID:-$(node -e 'try{process.stdout.write(require("./server/config.json").spotifyClientId||"")}catch{}')}
fi
# the work tree as committed (plus local changes), without node_modules, builds or data
SRC=$(mktemp -d); trap 'rm -rf "$SRC"' EXIT
git ls-files -co --exclude-standard -z | grep -zv -E '^(dist|ios)/' | tar --null --ignore-failed-read -T - -cf - 2>/dev/null | tar -xf - -C "$SRC"
printf '%s' "$CID" > "$SRC/.spotify-client-id"
trap 'chmod -R u+w "$SRC" 2>/dev/null; rm -rf "$SRC"' EXIT
docker run --rm --memory=10g --cpus="${RUNE_BUILD_JOBS:-6}" -v "$SRC":/src -v "$OUT":/out -v "$CACHE":/cache -w /src \
  -e VER="$VER" -e NODE_VER="$NODE_VER" -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" -e CARGO_BUILD_JOBS="${RUNE_BUILD_JOBS:-6}" \
  -e CARGO_HOME=/cache/cargo -e RUSTUP_HOME=/cache/rustup -e CARGO_TARGET_DIR=/cache/target ubuntu:22.04 bash -euc '
  export DEBIAN_FRONTEND=noninteractive PATH=/cache/cargo/bin:/cache/node-$NODE_VER/bin:$PATH
  apt-get update -qq
  apt-get install -y -qq curl xz-utils ca-certificates build-essential pkg-config cmake clang python3 libssl-dev libasound2-dev libxkbcommon-dev libxkbcommon-x11-dev libwayland-dev libx11-xcb-dev libxcb1-dev libxcb-render0-dev libxcb-shape0-dev libxcb-xfixes0-dev libfontconfig1-dev libfreetype6-dev libvulkan-dev libdbus-1-dev libpulse-dev libglib2.0-dev libgbm-dev imagemagick >/dev/null
  if [ ! -x /cache/node-$NODE_VER/bin/node ]; then
    curl -fsSL https://nodejs.org/dist/v$NODE_VER/node-v$NODE_VER-linux-x64.tar.xz | tar -xJ -C /cache && mv /cache/node-v$NODE_VER-linux-x64 /cache/node-$NODE_VER
  fi
  command -v cargo >/dev/null || curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path
  corepack enable >/dev/null 2>&1 || npm i -g pnpm >/dev/null
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PNPM_HOME=/cache/pnpm npm_config_store_dir=/cache/pnpm-store
  pnpm install --frozen-lockfile >/dev/null
  pnpm --filter web build >/dev/null
  P=/tmp/rune-linux-x86_64; rm -rf $P; mkdir -p $P/bin $P/server $P/db $P/icons
  # the server: one ESM file; better-sqlite3 (native) stays outside and is installed next to it, built for this Node
  (cd server && node_modules/.bin/esbuild src/main.ts --bundle --platform=node --format=esm --target=node22 \
     --external:better-sqlite3 --outfile=$P/server/main.mjs --log-level=warning \
     --banner:js="import { createRequire as __cr } from \"node:module\"; const require = __cr(import.meta.url);")
  BSV=$(node -p "require(\"./server/node_modules/better-sqlite3/package.json\").version")
  (cd $P/server && echo "{\"type\":\"module\",\"private\":true}" > package.json && npm install --no-audit --no-fund --omit=dev better-sqlite3@$BSV >/dev/null)
  cp server/src/db/*.sql $P/db/; cp server/src/db/schema.sql $P/server/
  cp -r web/dist $P/web
  cp -r /cache/node-$NODE_VER $P/node; rm -rf $P/node/include $P/node/share $P/node/lib/node_modules/npm $P/node/lib/node_modules/corepack $P/node/bin/npm $P/node/bin/npx $P/node/bin/corepack
  # the native app
  (cd native/desktop && cargo build --release -p rune-desktop >/dev/null)
  cp /cache/target/release/rune-desktop $P/bin/
  cp packaging/linux-bundle/rune packaging/linux-bundle/rune-server packaging/linux-bundle/rune-update packaging/linux-bundle/helper.mjs $P/bin/
  cp packaging/linux-bundle/install.sh packaging/linux-bundle/uninstall.sh packaging/linux-bundle/README.txt $P/
  chmod 755 $P/bin/* $P/install.sh $P/uninstall.sh
  for s in 48 128 256 512; do convert native/desktop/packaging/rune-desktop-1024.png -resize ${s}x${s} $P/icons/$s.png; done
  [ -s .spotify-client-id ] && cp .spotify-client-id $P/spotify-client-id
  echo "$VER" > $P/VERSION
  tar -C /tmp -czf /out/rune-linux-x86_64.tar.gz rune-linux-x86_64
  (cd /out && sha256sum rune-linux-x86_64.tar.gz > rune-linux-x86_64.tar.gz.sha256)
  chown -R "$HOST_UID:$HOST_GID" /out /cache /src
'
ls -la "$OUT"/rune-linux-x86_64.tar.gz*
