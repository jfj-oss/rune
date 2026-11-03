/* Pure helpers for the dithered ladybird logo (components/DitherLogo.tsx). DOM-free so they can be unit-tested.
   The artwork is a tone map + cut-out mask (public/icons/ladybug-tones.png, made by scripts/ladybug-logo.py); the
   logo resamples it to a small grid and ordered-dithers it into the backdrop's three tones. */

import { bayer, smoothstep, type DitherPalette, type Rgb } from './dither';

/** Level codes in the output grid: 0 black, 1 mid, 2 light, OUTSIDE = transparent. */
export const OUTSIDE = 255;

export interface ToneMap { w: number; h: number; /** tone 0..255 */ tone: Uint8Array; /** cut-out: 255 inside */ mask: Uint8Array }

/** Box-filter a tone map down (or bilinearly up) to dw x dh. Tones are averaged over the masked pixels only, so the
    green-screen edge never darkens the rim; coverage is the share of masked source pixels in the cell (0..1). */
export function resampleTones(src: ToneMap, dw: number, dh: number): { tone: Float32Array; cover: Float32Array } {
  const tone = new Float32Array(dw * dh), cover = new Float32Array(dw * dh);
  const sx = src.w / dw, sy = src.h / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = y * sy, y1 = (y + 1) * sy;
    for (let x = 0; x < dw; x++) {
      const x0 = x * sx, x1 = (x + 1) * sx;
      let sum = 0, wsum = 0, area = 0;
      for (let yy = Math.floor(y0); yy < Math.min(src.h, Math.ceil(y1)); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        for (let xx = Math.floor(x0); xx < Math.min(src.w, Math.ceil(x1)); xx++) {
          const w = wy * (Math.min(xx + 1, x1) - Math.max(xx, x0));
          area += w;
          if (src.mask[yy * src.w + xx]! > 127) { sum += w * src.tone[yy * src.w + xx]!; wsum += w; }
        }
      }
      tone[y * dw + x] = wsum > 0 ? sum / wsum / 255 : 0;
      cover[y * dw + x] = area > 0 ? wsum / area : 0;
    }
  }
  return { tone, cover };
}

const BAYER = bayer(8);

/** Three-level ordered dither: tone 0..1 -> black / mid / light with an 8x8 Bayer threshold; cells with under half
    coverage are transparent. A cell on the cut-out's rim is lifted to at least the mid tone so the silhouette (and the
    black spots on it) stay readable on the near-black backdrop. */
export function ditherGrid(tone: ArrayLike<number>, cover: ArrayLike<number>, w: number, h: number, rim = true, crisp = 0): Uint8Array {
  const out = new Uint8Array(w * h).fill(OUTSIDE);
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && cover[y * w + x]! >= 0.5;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!inside(x, y)) continue;
    const v = Math.min(1, Math.max(0, tone[i]!)) * 2;
    const base = Math.min(1, Math.floor(v));
    const th = (BAYER[(y & 7) * 8 + (x & 7)]! + 0.5) / 64;
    const frac = v - base;
    // crisp > 0 pulls the fraction towards 0 / 1, so the grain only lives in the middle of each tone band
    const f = frac + (smoothstep(0.25, 0.75, frac) - frac) * crisp;
    let level = base + (f > th ? 1 : 0);
    if (rim && level === 0 && !(inside(x - 1, y) && inside(x + 1, y) && inside(x, y - 1) && inside(x, y + 1))) level = 1;
    out[i] = level;
  }
  return out;
}

/** How much to sharpen the dither for a grid `w` cells wide: none from ~72 cells up, strongest on a tiny logo, so
    spots and highlights stay solid shapes instead of turning into checker noise. */
export const crispFor = (w: number): number => Math.min(0.8, Math.max(0, (72 - w) / 40));

/** Grid size for a logo `cssW` CSS px wide: dots are `dot` device pixels, so each dot is an integer number of device pixels. */
export function logoGrid(cssW: number, aspect: number, dpr: number, dot: number): { w: number; h: number } {
  const w = Math.max(4, Math.round((cssW * dpr) / dot));
  return { w, h: Math.max(4, Math.round(w * aspect)) };
}

/** Dot size in device pixels: ~1 CSS px (1 at dpr 1, 2 at dpr 2, ...) so the grid stays the same on every screen. */
export const logoDot = (dpr: number): number => Math.max(1, Math.round(dpr));

/** RGBA bytes for a level grid in a palette (black is the backdrop's pure black). */
export function paintGrid(levels: Uint8Array, pal: DitherPalette, into: Uint8ClampedArray): void {
  const cols: (Rgb | null)[] = [[0, 0, 0], pal.mid, pal.light];
  for (let i = 0; i < levels.length; i++) {
    const c = cols[levels[i]!];
    const o = i * 4;
    if (!c) { into[o] = into[o + 1] = into[o + 2] = into[o + 3] = 0; continue; }
    into[o] = Math.round(c[0]); into[o + 1] = Math.round(c[1]); into[o + 2] = Math.round(c[2]); into[o + 3] = 255;
  }
}

/** Seconds of the logo's little animation: the dots pop in, then a band of light runs across now and then. */
export const LOGO_INTRO_MS = 900;
export const LOGO_WAVE_MS = 1100;
export const LOGO_WAVE_EVERY_MS = 6000;
export const LOGO_FIRST_WAVE_MS = 2200;
const WAVE_HALF = 0.13;

/** Where the animation is `elapsed` ms after the logo appeared: reveal 0..1 and the wave's position (null = none). */
export function logoAnimAt(elapsed: number): { reveal: number; wave: number | null; nextInMs: number } {
  const reveal = Math.min(1, Math.max(0, elapsed / LOGO_INTRO_MS));
  const k = elapsed - LOGO_FIRST_WAVE_MS;
  const ph = k < 0 ? -1 : k % LOGO_WAVE_EVERY_MS;
  const wave = ph >= 0 && ph < LOGO_WAVE_MS ? ph / LOGO_WAVE_MS : null;
  const nextInMs = reveal < 1 || wave !== null ? 0 : k < 0 ? -k : LOGO_WAVE_EVERY_MS - ph;
  return { reveal, wave, nextInMs };
}

/**
 * One animation frame from the finished level grid. While `reveal` < 1 the dots appear in Bayer order (like a dither
 * fading in, one dot after another); while `wave` (0..1) runs, a diagonal band from the upper left lifts the dots it
 * passes one tone up — denser in the middle of the band, so they light up and go out in sequence.
 */
export function animateLevels(levels: Uint8Array, w: number, h: number, reveal: number, wave: number | null, into: Uint8Array = new Uint8Array(levels.length)): Uint8Array {
  const pos = wave === null ? 0 : -WAVE_HALF + wave * (1 + 2 * WAVE_HALF);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    let l = levels[i]!;
    const rank = (BAYER[(y & 7) * 8 + (x & 7)]! + 0.5) / 64;
    if (l !== OUTSIDE && rank > reveal) l = OUTSIDE;
    if (l !== OUTSIDE && wave !== null && l < 2) {
      const d = Math.abs((x / w + y / h) / 2 - pos);
      if (d < WAVE_HALF && (1 - d / WAVE_HALF) * 0.85 > rank) l += 1;
    }
    into[i] = l;
  }
  return into;
}
