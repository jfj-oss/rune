#!/bin/bash
# From the Linux box: copy the source to the Mac, build and install /Applications/rune.app there (ad-hoc signed).
#   native/desktop/packaging/mac-update.sh <version> [ssh-key] [user@host]
# The key and address are arguments (not in the repo); the source goes to ~/rune-desktop-src on the Mac.
set -euo pipefail
V=${1:?version}
KEY=${2:-$HOME/.ssh/macbook-air}
TARGET=${3:?user@host of the Mac}
HERE=$(cd "$(dirname "$0")/../../.." && pwd)
SSH="ssh -i $KEY -o BatchMode=yes"
rsync -a --delete -e "$SSH" --exclude target --exclude node_modules --exclude .git --exclude 'web/dist' --exclude 'server/data' "$HERE/native/" "$TARGET:rune-desktop-src/native/"
$SSH "$TARGET" "cd ~/rune-desktop-src/native/desktop && packaging/build-mac.sh install $V 2>&1 | grep -E '^error|warning: unused manifest|built|installed|icon' "
