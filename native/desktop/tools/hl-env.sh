# source: environment for a client inside the private headless KWin. A temp XDG_CONFIG_HOME so no real config is read.
RG=${RG:-$HOME/data/agent-tmp/rune-gpui}
export WAYLAND_DISPLAY=wayland-runegpui
export DBUS_SESSION_BUS_ADDRESS=$(cat $RG/run/bus)
export XDG_CONFIG_HOME=$RG/run/app-config
export RUNE_DESKTOP_CONFIG_DIR=$RG/run/app-config/rune-desktop
unset DISPLAY
