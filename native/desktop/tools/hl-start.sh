#!/bin/bash
# Start a PRIVATE headless KWin for screenshots (own D-Bus session, own config dir, socket wayland-runegpui, 1600x1000).
# The PID of kwin_wayland is in run/kwin.pid: kill that PID (only) to stop it.
D=${RG:-$HOME/data/agent-tmp/rune-gpui}/run
mkdir -p $D/kwin-config $D/kwin-cache
export XDG_CONFIG_HOME=$D/kwin-config XDG_CACHE_HOME=$D/kwin-cache
export KWIN_SCREENSHOT_NO_PERMISSION_CHECKS=1 KWIN_WAYLAND_NO_PERMISSION_CHECKS=1
unset WAYLAND_DISPLAY DISPLAY
setsid dbus-run-session -- bash -c 'echo "$DBUS_SESSION_BUS_ADDRESS" > '$D'/bus; exec kwin_wayland --virtual --socket ${SOCK:-wayland-runegpui} --no-lockscreen --no-global-shortcuts --width ${W:-1600} --height ${H:-1000}' > $D/kwin.log 2>&1 &
echo $! > $D/kwin.pid
