#!/bin/bash
# native-shot.sh <route> <W> <H> <out.png> [wait-s]  : run rune-desktop in the PRIVATE headless KWin against the temp server, crop the window's content.
# env: RUNE_URL (default http://127.0.0.1:4599; port 4545 is refused), RG (work dir), BIN (default release? no: debug)
RG=${RG:-$HOME/data/agent-tmp/rune-gpui}; HERE=$(cd $(dirname $0); pwd)
. $HERE/hl-env.sh
URL=${RUNE_URL:-http://127.0.0.1:4599}
case "$URL" in *:4545*) echo "refusing the live rune"; exit 2;; esac
ROUTE=$1; W=$2; H=$3; OUT=$4; WAIT=${5:-4}
mkdir -p $RUNE_DESKTOP_CONFIG_DIR
RUNE_DESKTOP_URL=$URL RUNE_DESKTOP_ROUTE="$ROUTE" RUNE_DESKTOP_SIZE=${W}x${H} ${BIN:-$RG/target/debug/rune-desktop} >> $RG/run/app.log 2>&1 &
PID=$!
sleep $WAIT
python3 $HERE/hl-shot.py $OUT.full.png >/dev/null
python3 $HERE/crop.py $OUT.full.png $OUT $W $H
kill $PID; wait $PID 2>/dev/null
