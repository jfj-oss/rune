#!/usr/bin/env python3
"""crop.py in.png out.png W H : cut the app window's content (W x H, below KWin's title bar) out of the workspace shot.
The window is centred; its title bar is the lighter band above the content."""
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB'); W, H = int(sys.argv[3]), int(sys.argv[4])
sw, sh = im.size
x0 = (sw - W) // 2
# the frame is centred as a whole: title bar (about 33 px) + content
y0 = (sh - (H + 33)) // 2 + 33
im.crop((x0, y0, x0 + W, y0 + H)).save(sys.argv[2])
