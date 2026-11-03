#!/usr/bin/env python3
"""Cut a ladybird out of a photo and export a 3-band tone map for rune's dithered logo.

    python3 web/scripts/ladybug-logo.py <photo.jpg> [out.png] [long-side-px]

The photo is not stored in the repo; only the output (web/public/icons/ladybug-tones.png) is.
Output: an 8-bit LA PNG. L = tone (0 black spot / shadow, 128 shell, 255 highlight / cream head shield),
A = cut-out mask (255 inside the ladybird, soft 0..255 edge is NOT used: the mask is binary so the dither stays crisp).
The component (src/components/DitherLogo.tsx) turns L into black / mid / light with an ordered dither.

Steps: downscale -> chroma key the green leaf (g clearly above r and b, or a very dark green shadow) -> opening to
drop legs, antennae and speckle -> largest connected component -> fill holes -> light smoothing -> tight crop with a
small margin -> luminance curve tuned so spots stay black, the orange shell sits in the mid band with its shading
spilling into light and the cream shield / highlight are light -> resample to the final size.
Needs Pillow and numpy only (no scipy / OpenCV).
"""
import sys
from collections import deque

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SRC = sys.argv[1] if len(sys.argv) > 1 else 'ladybug.jpg'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'web/public/icons/ladybug-tones.png'
LONG = int(sys.argv[3]) if len(sys.argv) > 3 else 128
WORK = 700  # working width for segmentation


def largest_component(mask: np.ndarray) -> np.ndarray:
    h, w = mask.shape
    lab = np.zeros((h, w), np.int32)
    best, best_n, n = 0, 0, 0
    for sy in range(h):
        for sx in range(w):
            if not mask[sy, sx] or lab[sy, sx]:
                continue
            n += 1
            lab[sy, sx] = n
            q = deque([(sy, sx)])
            cnt = 0
            while q:
                y, x = q.popleft()
                cnt += 1
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    yy, xx = y + dy, x + dx
                    if 0 <= yy < h and 0 <= xx < w and mask[yy, xx] and not lab[yy, xx]:
                        lab[yy, xx] = n
                        q.append((yy, xx))
            if cnt > best_n:
                best, best_n = n, cnt
    return lab == best


def morph(mask: np.ndarray, op: str, size: int) -> np.ndarray:
    im = Image.fromarray((mask * 255).astype(np.uint8))
    lo, hi = ImageFilter.MinFilter(size), ImageFilter.MaxFilter(size)
    for f in ((lo, hi) if op == 'open' else (hi, lo)):
        im = im.filter(f)
    return np.asarray(im) > 127


def fill_holes(mask: np.ndarray) -> np.ndarray:
    im = Image.fromarray((mask * 255).astype(np.uint8))
    pad = Image.new('L', (im.width + 2, im.height + 2), 0)
    pad.paste(im, (1, 1))
    ImageDraw.floodfill(pad, (0, 0), 128)  # background reachable from the border
    a = np.asarray(pad)[1:-1, 1:-1]
    return a != 128


def main() -> None:
    photo = Image.open(SRC).convert('RGB')
    photo = photo.resize((WORK, round(photo.height * WORK / photo.width)), Image.LANCZOS)
    rgb = np.asarray(photo).astype(np.float32)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    lum = 0.299 * r + 0.587 * g + 0.114 * b

    # leaf: green dominates; also the deep green shadow under the beetle (dark, g above r and b)
    leaf = ((g - r > 14) & (g - b > 14)) | ((lum < 40) & (g - r > 6) & (g - b > 4))
    fg = ~leaf
    fg = morph(fg, 'open', 9)  # legs, antennae, leaf speckle
    fg = largest_component(fg)
    fg = fill_holes(fg)
    fg = morph(fg, 'close', 7)
    fg = morph(fg, 'open', 5)
    fg = fill_holes(fg)
    # a touch of smoothing of the outline (blur + threshold)
    sm = Image.fromarray((fg * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(3))
    fg = np.asarray(sm) > 127

    ys, xs = np.where(fg)
    pad = 6
    y0, y1, x0, x1 = max(0, ys.min() - pad), ys.max() + 1 + pad, max(0, xs.min() - pad), xs.max() + 1 + pad
    fg = fg[y0:y1, x0:x1]
    lum = lum[y0:y1, x0:x1]
    r, g, b = r[y0:y1, x0:x1], g[y0:y1, x0:x1], b[y0:y1, x0:x1]

    # tone: spots (very dark, or dark blue-grey) -> 0; shaded shell -> low mid; lit orange shell -> upper mid;
    # highlight and cream head shield -> 1. Piecewise linear on the photo luminance.
    tone = np.interp(lum, [45, 85, 120, 165, 215, 240], [0.0, 0.18, 0.5, 0.88, 1.0, 1.0])
    # blue-grey spots (b >= r-ish and dim) are still spots
    grey_spot = (b > r - 12) & (lum < 130)
    tone = np.where(grey_spot, np.minimum(tone, 0.04), tone)
    # slight blur so single bright / dark specks do not become noise once dithered
    img = Image.fromarray((tone * 255).astype(np.uint8))
    img = img.filter(ImageFilter.GaussianBlur(3.0))
    mask = Image.fromarray((fg * 255).astype(np.uint8))

    # fit into a square-ish canvas of LONG px on the long side
    scale = LONG / max(img.width, img.height)
    size = (max(1, round(img.width * scale)), max(1, round(img.height * scale)))
    img = img.resize(size, Image.LANCZOS)
    mask = mask.resize(size, Image.LANCZOS).point(lambda v: 255 if v > 127 else 0)
    # inside the mask, the tone near the edge is pulled to the shell's neighbours, never to the green: keep as is
    out = Image.merge('LA', (img, mask))
    out.save(OUT, optimize=True)
    print(f'{OUT}: {size[0]}x{size[1]}, coverage {np.asarray(mask).mean() / 255:.2f}')


if __name__ == '__main__':
    main()
