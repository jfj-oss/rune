#!/usr/bin/env python3
"""Screenshot the private headless KWin's workspace to a PNG: hl-shot.py out.png"""
import os, sys, dbus
from PIL import Image
bus = dbus.bus.BusConnection(open(os.path.expanduser('~/data/agent-tmp/rune-gpui/run/bus')).read().strip())
o = bus.get_object('org.kde.KWin', '/org/kde/KWin/ScreenShot2')
r, w = os.pipe()
res = dbus.Interface(o, 'org.kde.KWin.ScreenShot2').CaptureWorkspace({'native-resolution': True}, dbus.types.UnixFd(w))
os.close(w)
width, height, stride = int(res['width']), int(res['height']), int(res['stride'])
buf = b''
with os.fdopen(r, 'rb') as f:
    buf = f.read()
# QImage formats 16-18 are RGBX/RGBA byte order; the 32-bit ARGB ones are BGRA in memory
raw = 'RGBA' if int(res.get('format', 0)) in (16, 17, 18) else 'BGRA'
img = Image.frombuffer('RGBA', (width, height), buf, 'raw', raw, stride, 1).convert('RGB')
img.save(sys.argv[1]); print(width, height, res.get('format'))
