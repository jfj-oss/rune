#!/bin/bash
# pair.sh <W> <H> <outdir> <name> <route> <web-js-before-shot> '<native PRE hook cmds, | separated>' [native wait]
# One web | native pair for a state that needs a command first (the server state is set by a play command on the pc zone).
RG=${RG:-$HOME/data/agent-tmp/rune-gpui2}; HERE=$(cd $(dirname $0); pwd); URL=${RUNE_URL:-http://127.0.0.1:4599}
W=$1; H=$2; OUT=$3; N=$4; ROUTE=$5; WEBJS=$6; PRE=$7; WAIT=${8:-3}; mkdir -p $OUT
node $HERE/web-shot.mjs $URL "$ROUTE" $W $H $OUT/$N-web.png "$WEBJS" 1500
PRE="$PRE" $HERE/native-shot.sh "$ROUTE" $W $H $OUT/$N-native.png $WAIT
python3 - <<PY
from PIL import Image
a=Image.open("$OUT/$N-web.png"); b=Image.open("$OUT/$N-native.png")
p=Image.new('RGB',(a.width*2+10,a.height),(255,0,255)); p.paste(a,(0,0)); p.paste(b,(a.width+10,0)); p.save("$OUT/$N-pair.png")
PY
