#!/bin/bash
# build.sh [outdir]: builds fakeptr (needs wayland-scanner and libwayland-client headers); prints the binary path
set -e
H=$(cd "$(dirname "$0")"; pwd); O=${1:-$H/out}; mkdir -p "$O"
wayland-scanner client-header "$H/fake-input.xml" "$O/fake-input-client-protocol.h"
wayland-scanner private-code "$H/fake-input.xml" "$O/fake-input-protocol.c"
cc -O1 -I"$O" -o "$O/fakeptr" "$H/fakeptr.c" "$O/fake-input-protocol.c" -lwayland-client -lm
echo "$O/fakeptr"
