#!/bin/bash
# Run this ON the Mac (Apple silicon, Swift or the Xcode Command Line Tools installed):
#   native/build-mac.sh [install]
# It builds "native/mac/build/rune mini.app" with SwiftPM, ad-hoc signs it (codesign --force --deep --sign -) and, with
# `install`, copies it to "/Applications/rune mini.app". The same way Claude Summon is built.
set -euo pipefail
cd "$(dirname "$0")/mac"
swift test
exec scripts/build-app.sh "$@"
