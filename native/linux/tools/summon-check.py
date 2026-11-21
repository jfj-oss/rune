#!/usr/bin/env python3
"""Summon timing and window reuse, in a PRIVATE headless KWin (never the desktop's; do not point this at a real session).

  1. start a private kwin:  dbus-run-session -- kwin_wayland --virtual --socket wayland-test --no-lockscreen ...
     (write its DBUS_SESSION_BUS_ADDRESS to a file; put the kwinrulesrc [runemini] rule in its XDG_CONFIG_HOME)
  2. start the panel in it: WAYLAND_DISPLAY=wayland-test RUNE_MINI_TRACE=1 RUNE_MINI_NO_SINGLE=1 RUNE_MINI_PORTAL=off \
         RUNE_MINI_CONFIG_DIR=/tmp/x rune-mini 2> panel.log
  3. BUS_FILE=bus panel_log=panel.log summon-check.py [N]

It toggles the panel N times over D-Bus, takes screenshots until the panel is on screen (and gone again), and fails when a
summon takes longer than MAX_MS (default 100) or when the log shows the window being made more than once (the window is
kept between summons: hiding minimizes it, showing activates it). Layer-shell mode (RUNE_MINI_LAYER=1) makes the window
each time by design: run it with MAX_MS=400 and WINDOWS=any there. AREA=x,y,w,h is where the panel appears."""
import os, sys, time, dbus
bus = dbus.bus.BusConnection(open(os.environ['BUS_FILE']).read().strip())
shot = dbus.Interface(bus.get_object('org.kde.KWin', '/org/kde/KWin/ScreenShot2'), 'org.kde.KWin.ScreenShot2')
ctl = dbus.Interface(bus.get_object('org.rune.Mini', '/org/rune/Mini'), 'org.rune.Mini')
AREA = tuple(int(x) for x in os.environ.get('AREA', '500,420,600,160').split(','))
MAX_MS = float(os.environ.get('MAX_MS', '100'))

def grab():
    r, w = os.pipe()
    shot.CaptureArea(*AREA, {'native-resolution': True}, dbus.types.UnixFd(w))
    os.close(w)
    with os.fdopen(r, 'rb') as f:
        return f.read()

def until(pred, limit=3.0):
    t = time.time()
    while time.time() - t < limit:
        if pred(grab()):
            return time.time()
    return None

n = int(sys.argv[1]) if len(sys.argv) > 1 else 5
base = grab()
shows = []
for _ in range(n):
    time.sleep(0.8)
    t0 = time.time(); ctl.Toggle()
    t1 = until(lambda b: b != base)
    if t1 is None:
        sys.exit('the panel never appeared')
    shows.append((t1 - t0) * 1000)
    time.sleep(0.8)
    ctl.Toggle()
    if until(lambda b: b == base) is None:
        sys.exit('the panel never went away')
shows.sort()
print('summon to on screen, ms: median %.0f  max %.0f' % (shows[len(shows) // 2], shows[-1]))
bad = shows[-1] > MAX_MS
log = os.environ.get('panel_log')
if log and os.environ.get('WINDOWS') != 'any':
    made = open(log).read().count('open_window start')
    print('windows made: %d (expected 1: summoning must not make a new one)' % made)
    bad = bad or made != 1
sys.exit(1 if bad else 0)
