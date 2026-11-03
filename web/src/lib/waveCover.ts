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

// ---------- more generative covers, for a random few albums ----------

export type GenKind = 'wave' | 'ripple' | 'aurora' | 'dunes';
const KINDS: GenKind[] = ['wave', 'ripple', 'aurora', 'dunes'];
/** Characters of each kind's ASCII header: [faint edge, crest]. */
export const ASCII_CHARS: Record<GenKind, [string, string]> = { wave: ['x', 'o'], ripple: ['·', 'o'], aurora: [':', '|'], dunes: ['-', '~'] };

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  // finalise (FNV's low bits are weak): murmur3's avalanche
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

/** The pattern an album with no artwork wears as its cover (always one, fixed by the id). */
export function genKindFor(id: string): { kind: GenKind; seed: number } {
  const k = hash(`${id}#kind`);
  return { kind: KINDS[k % KINDS.length]!, seed: (k >>> 8) % 7 };
}

/** Generative cover + header for the wave playlists (MUDs, HORSE); other playlists keep their own art. */
export function genArtFor(id: string): { kind: GenKind; seed: number } | null {
  return WAVE_COVER_IDS.has(id) ? { kind: 'wave', seed: hash(id) % 7 } : null;
}

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const frac = (x: number) => x - Math.floor(x);

/** Cover brightness 0..1 for a kind (the wave is waveField). */
export function coverField(kind: GenKind, t: number, w: number, h: number, into = new Float32Array(w * h), seed = 0): Float32Array {
  if (kind === 'wave') return waveField(t, w, h, into, seed);
  const cx = 0.5 + 0.12 * Math.sin(0.21 * t + seed), cy = 0.52 + 0.1 * Math.cos(0.17 * t + seed);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = (x + 0.5) / w, v = (y + 0.5) / h;
    let f: number;
    if (kind === 'ripple') {
      const r = Math.hypot(u - cx, v - cy);
      const ring = 0.5 + 0.5 * Math.sin(TAU * r * 5 - 1.6 * t + seed);
      f = smooth(0.3, 1, ring) * (1 - smooth(0.5, 0.8, r)) + 0.35 * (1 - smooth(0, 0.12, r));
    } else if (kind === 'aurora') {
      const sway = 0.07 * Math.sin(TAU * 1.3 * v + 0.5 * t + seed) + 0.04 * Math.sin(TAU * 2.7 * v - 0.3 * t);
      const c = 0.5 + 0.5 * Math.sin(TAU * (2.1 * u + sway) + 0.35 * t + seed);
      f = smooth(0.25, 1, c) * (1 - 0.55 * v) + 0.12 * (1 - v);
    } else {
      const s = 0.5 + 0.5 * Math.sin(TAU * 1.5 * (u + 0.6 * v) - 0.7 * t + 0.5 * Math.sin(TAU * u + 0.3 * t + seed));
      f = smooth(0.2, 0.95, s) * (0.65 + 0.35 * v);
    }
    into[y * w + x] = Math.min(1, f);
  }
  return into;
}

/** How strongly a kind's ASCII header lights cell (x, y) at t (0..1). The wave is asciiWaveAt; the bands of the
    others are wide enough that each sea is about as busy as the wave's. */
export function asciiAt(kind: GenKind, x: number, y: number, t: number): number {
  const line = (d: number, wdt: number) => Math.exp(-((d / wdt) ** 2));
  if (kind === 'wave') return asciiWaveAt(x, y, t);
  if (kind === 'ripple') {
    const r = Math.hypot((x - 0.62) * 2.6, y - 0.5);
    return line(frac(r * 2.6 - 0.3 * t) - 0.5, 0.26) * (1 - smooth(1.3, 2.6, r));
  }
  if (kind === 'aurora') return line(frac(2.4 * x + 0.12 * Math.sin(TAU * y + 0.4 * t) + 0.04 * t) - 0.5, 0.28) * (1 - 0.2 * y);
  return line(frac(1.7 * x + 0.9 * y - 0.11 * t) - 0.5, 0.25);
}
