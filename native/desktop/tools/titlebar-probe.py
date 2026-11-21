#!/usr/bin/env python3
"""titlebar-probe.py <shot.png|-> [x,y ...]: screenshot the PRIVATE headless KWin (RG dir, like hl-shot.py) and print JSON:
{"bbox": [x0,y0,x1,y1] of the pixels brighter than 10 (the app's frame; the desktop is black), "px": {"x,y": [r,g,b], ...}}.
Used by the desktop e2e to find where the window is and to read pixels (ball colours)."""
import json, os, sys, dbus
from PIL import Image
bus = dbus.bus.BusConnection(open(os.path.join(os.environ.get('RG', os.path.expanduser('~/data/agent-tmp/rune-gpui')), 'run/bus')).read().strip())
o = bus.get_object('org.kde.KWin', '/org/kde/KWin/ScreenShot2')
r, w = os.pipe()
res = dbus.Interface(o, 'org.kde.KWin.ScreenShot2').CaptureWorkspace({'native-resolution': True}, dbus.types.UnixFd(w))
os.close(w)
width, height, stride = int(res['width']), int(res['height']), int(res['stride'])
with os.fdopen(r, 'rb') as f: buf = f.read()
raw = 'RGBA' if int(res.get('format', 0)) in (16, 17, 18) else 'BGRA'
img = Image.frombuffer('RGBA', (width, height), buf, 'raw', raw, stride, 1).convert('RGB')
if sys.argv[1] != '-': img.save(sys.argv[1])
g = img.convert('L').point(lambda v: 255 if v > 10 else 0)
print(json.dumps({'size': [width, height], 'bbox': g.getbbox(), 'px': {a: list(img.getpixel(tuple(int(n) for n in a.split(',')))) for a in sys.argv[2:]}}))
