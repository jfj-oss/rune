#!/bin/bash
# shots.sh <W> <H> <outdir> route...   : web | native pairs at the same size (needs the temp server on RUNE_URL, default :4599, and the private KWin)
RG=${RG:-$HOME/data/agent-tmp/rune-gpui}; HERE=$(cd $(dirname $0); pwd); URL=${RUNE_URL:-http://127.0.0.1:4599}
W=$1; H=$2; OUT=$3; shift 3; mkdir -p $OUT
i=0
for r in "$@"; do
  n=$(printf "%02d" $i); i=$((i+1))
  node $HERE/web-shot.mjs $URL "$r" $W $H $OUT/$n-web.png
  $HERE/native-shot.sh "$r" $W $H $OUT/$n-native.png 5
  python3 - <<PY
from PIL import Image
a=Image.open("$OUT/$n-web.png"); b=Image.open("$OUT/$n-native.png")
p=Image.new('RGB',(a.width*2+10,a.height),(255,0,255)); p.paste(a,(0,0)); p.paste(b,(a.width+10,0)); p.save("$OUT/$n-pair.png")
PY
done
