/* Animated "wave" playlist covers: a thick dithered wave filling ~80% of the square, in the colour opposite the
   backdrop's. Pure helpers (DOM-free) for components/WaveCover.tsx. */
import type { DitherPalette, Rgb } from './dither';

/** Playlists that wear the wave instead of their Spotify image (the user's "MUDs" and "HORSE"). */
export const WAVE_COVER_IDS = new Set(['pl:sp:0gE0wwKJ6rGKGFUF7YfZPu', 'pl:sp:44JPFAQyJioNkmIdEoWdzK']);

const TAU = Math.PI * 2;

/** The wave's surface height (0 = top) at x (0..1), t seconds: ~20% down, so the wave covers ~80%. */
export function surfaceAt(x: number, t: number, phase = 0): number {
  return 0.2 + 0.065 * Math.sin(TAU * 1.05 * x + 1.2 * t + phase) + 0.03 * Math.sin(TAU * 2.4 * x - 0.85 * t + 1 + phase);
}

/** Brightness 0..1 of a w x h grid: black above the surface, a bright crest just under it, rolling swells below. */
export function waveField(t: number, w: number, h: number, into = new Float32Array(w * h), phase = 0): Float32Array {
  for (let x = 0; x < w; x++) {
    const u = (x + 0.5) / w;
    const s = surfaceAt(u, t, phase);
    for (let y = 0; y < h; y++) {
      const v = (y + 0.5) / h;
      const d = v - s;
      if (d < -0.02) { into[y * w + x] = 0; continue; }
      const edge = Math.min(1, Math.max(0, (d + 0.02) / 0.05));
      const crest = Math.exp(-(((d - 0.035) / 0.04) ** 2));
      const swell = 0.5 + 0.5 * Math.sin(TAU * (1.7 * v - 0.6 * u) - 0.9 * t + phase);
      const deep = 1 - 0.35 * Math.min(1, d / 0.8); // a little darker towards the bottom
      into[y * w + x] = Math.min(1, edge * (0.55 + 0.3 * swell) * deep + 0.55 * crest);
    }
  }
  return into;
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t: number) => {
    t = ((t % 1) + 1) % 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/** The complementary colour (hue turned half way round, same saturation and lightness). */
export function opposite(c: Rgb): Rgb {
  const [h, s, l] = rgbToHsl(c);
  return hslToRgb(h + 0.5, s, l);
}

export const oppositePalette = (p: DitherPalette): DitherPalette => ({ light: opposite(p.light), mid: opposite(p.mid) });

/**
 * Sparse ASCII sea for the header behind a wave playlist: three slow wave lines across the box. Returns, per cell,
 * how strongly a wave passes there (0..1). x, y in 0..1, t seconds.
 */
export function asciiWaveAt(x: number, y: number, t: number): number {
  let f = 0;
  for (let i = 0; i < 3; i++) {
    const base = 0.25 + i * 0.25;
    const c = base + 0.09 * Math.sin(TAU * (0.8 + i * 0.35) * x + (0.55 - i * 0.12) * t + i * 2.1) + 0.04 * Math.sin(TAU * 2.1 * x - 0.4 * t + i);
    const d = (y - c) / (0.07 + 0.02 * i);
    f = Math.max(f, Math.exp(-d * d));
  }
  return f;
}
