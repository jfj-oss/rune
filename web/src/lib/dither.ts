/* Pure helpers for the "Dither" ambient backdrop (see components/DitherBackdrop.tsx).
   Everything here is deterministic and DOM-free so it can be unit-tested and reused by the Canvas 2D fallback. */

export type Rgb = readonly [number, number, number];
/** A dither palette: black plus a dark mid tone and the strong "light" colour. */
export interface DitherPalette { mid: Rgb; light: Rgb }
export type DitherHue = 'red' | 'blue' | 'purple' | 'green';
export type DitherColour = DitherHue | 'cycle';

const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** Strong, saturated duotones; the mid tone sits roughly 45% of the way up so dithered gradients read as three steps. */
export const DITHER_PALETTES: Record<DitherHue, DitherPalette> = {
  red: { light: hex('#d4584f'), mid: hex('#521d1a') },
  blue: { light: hex('#3f74e8'), mid: hex('#1c3270') },
  purple: { light: hex('#8f5ae8'), mid: hex('#3f2675') },
  green: { light: hex('#22924c'), mid: hex('#0e3519') },
};

/** Cycle order and timing: ~2 min round trip, each colour holds 20 s then eases into the next over 10 s. */
export const CYCLE_ORDER: DitherHue[] = ['red', 'purple', 'blue', 'green'];
export const CYCLE_HOLD = 20;
export const CYCLE_FADE = 10;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpRgb = (a: Rgb, b: Rgb, t: number): Rgb => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Palette for a colour choice at time `t` seconds (only `cycle` depends on t). */
export function paletteAt(colour: DitherColour, t: number): DitherPalette {
  if (colour !== 'cycle') return DITHER_PALETTES[colour];
  const step = CYCLE_HOLD + CYCLE_FADE;
  const period = step * CYCLE_ORDER.length;
  const p = ((t % period) + period) % period;
  const i = Math.floor(p / step);
  const a = DITHER_PALETTES[CYCLE_ORDER[i]!];
  const b = DITHER_PALETTES[CYCLE_ORDER[(i + 1) % CYCLE_ORDER.length]!];
  const k = smoothstep(CYCLE_HOLD, step, p - i * step);
  return { mid: lerpRgb(a.mid, b.mid, k), light: lerpRgb(a.light, b.light, k) };
}

/** Classic recursive Bayer matrix, n = 2^k; values 0..n*n-1, row-major. */
export function bayer(n: number): number[] {
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error('bayer: n must be a power of two >= 2');
  let m = [0, 2, 3, 1];
  for (let size = 2; size < n; size *= 2) {
    const next = new Array<number>(size * size * 4);
    const s2 = size * 2;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const v = 4 * m[y * size + x]!;
      next[y * s2 + x] = v;
      next[y * s2 + x + size] = v + 2;
      next[(y + size) * s2 + x] = v + 3;
      next[(y + size) * s2 + x + size] = v + 1;
    }
    m = next;
  }
  return m;
}

/** Small seeded PRNG (mulberry32) so the noise tile is identical on every load. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Blue-noise threshold tile (void-and-cluster, toroidal Gaussian sigma 1.5). Returns ranks 0..n*n-1, row-major.
    64x64 takes ~20-40 ms once; the result is cached by the caller. Gives film-grain-like dither without Bayer cross-hatching. */
export function blueNoise(n = 64, seed = 7): Uint16Array {
  const N = n * n;
  const R = 6;
  const sigma2 = 2 * 1.5 * 1.5;
  const kw = 2 * R + 1;
  const kern = new Float64Array(kw * kw);
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) kern[(dy + R) * kw + dx + R] = Math.exp(-(dx * dx + dy * dy) / sigma2);
  const energy = new Float64Array(N);
  const bits = new Uint8Array(N);
  const splat = (idx: number, sign: number) => {
    const x0 = idx % n, y0 = (idx / n) | 0;
    for (let dy = -R; dy <= R; dy++) {
      const row = ((y0 + dy + n) % n) * n;
      for (let dx = -R; dx <= R; dx++) energy[row + ((x0 + dx + n) % n)]! += sign * kern[(dy + R) * kw + dx + R]!;
    }
  };
  const pick = (want: 0 | 1, max: boolean) => {
    let best = -1, bv = max ? -Infinity : Infinity;
    for (let i = 0; i < N; i++) {
      if (bits[i] !== want) continue;
      const e = energy[i]!;
      if (max ? e > bv : e < bv) { bv = e; best = i; }
    }
    return best;
  };
  // initial pattern: ~10% random ones, then relax (move tightest cluster -> largest void) until stable
  const rand = rng(seed);
  const ones = Math.max(1, Math.floor(N / 10));
  let placed = 0;
  while (placed < ones) {
    const i = Math.floor(rand() * N);
    if (bits[i]) continue;
    bits[i] = 1; splat(i, 1); placed++;
  }
  for (let guard = 0; guard < N * 4; guard++) {
    const c = pick(1, true);
    bits[c] = 0; splat(c, -1);
    const v = pick(0, false);
    bits[v] = 1; splat(v, 1);
    if (v === c) break;
  }
  const proto = bits.slice();
  const protoEnergy = energy.slice();
  const rank = new Uint16Array(N);
  // phase 1: remove tightest clusters from the prototype, ranks ones-1 .. 0
  for (let r = ones - 1; r >= 0; r--) {
    const c = pick(1, true);
    bits[c] = 0; splat(c, -1); rank[c] = r;
  }
  // phase 2: from the prototype, fill largest voids up to half
  bits.set(proto); energy.set(protoEnergy);
  let r = ones;
  for (; r < N / 2; r++) {
    const v = pick(0, false);
    bits[v] = 1; splat(v, 1); rank[v] = r;
  }
  // phase 3: the zeros are now the minority; repeatedly fill the tightest cluster of zeros (energy of the zero pattern)
  energy.fill(0);
  for (let i = 0; i < N; i++) if (!bits[i]) splat(i, 1);
  for (; r < N; r++) {
    const c = pick(0, true);
    bits[c] = 1; splat(c, -1); rank[c] = r;
  }
  return rank;
}

/* ---------- tone -> dither ----------
   Each pixel gets a shape tone tau (0..1). Two densities are derived from it: dL = share of pixels in the strong
   colour, dM = share in the dark mid tone; the rest is black. One blue-noise threshold per pixel picks the level
   (th < dL -> light, th < dL + dM -> mid), so both sets are evenly spread grain, never clumps or bands.
   The shares are capped (MASK) so the *mean* backdrop luminance under any text stays low enough for WCAG AA
   (see the test), while the colour still reads as crisp strong-colour grain: a form's body is ~26% strong colour on
   a dark mid tone, its rim fades through sparse mid dots into clean black. */

export const TONE = { lo: 0.42, hi: 0.88, gamma: 1.0 };
export const MASK = { light: 0.26, mid: 0.74 };

/** Shape tone: field -> 0..1 (a fairly steep S so forms have bodies and soft rims, and the gaps are clean black). */
export function toneCurve(f: number): number {
  return Math.pow(smoothstep(TONE.lo, TONE.hi, f), TONE.gamma);
}

/** Light / mid pixel shares for a tone; `grain` (0.72..1, from the mottle noise) varies the light share inside bodies. */
export function densities(tau: number, grain = 1): [number, number] {
  const t = Math.min(1, Math.max(0, tau));
  const dL = Math.pow(t, 1.6) * MASK.light * Math.min(1, grain);
  const dM = Math.min(1 - dL, Math.pow(t, 0.6) * MASK.mid);
  return [dL, dM];
}

/** Palette index for a pixel: 0 black, 1 mid, 2 light. */
export function ditherLevel(dL: number, dM: number, threshold: number): 0 | 1 | 2 {
  return threshold < dL ? 2 : threshold < dL + dM ? 1 : 0;
}

/** Device-pixel size of one dither dot: ~2 CSS px, always an integer number of device pixels, grown on huge screens
    so the canvas never exceeds `maxPixels`. */
export function dotSize(cssW: number, cssH: number, dpr: number, coarse = 0, maxPixels = 600_000): number {
  let dot = Math.max(2, Math.round((2 + coarse) * dpr));
  while ((cssW * dpr / dot) * (cssH * dpr / dot) > maxPixels) dot++;
  return dot;
}

/* ---------- shape field ----------
   The same numbers drive the WebGL shader (generated GLSL in components/DitherBackdrop) and the CPU fallback below.
   Coordinates: x 0..aspect, y 0..1 (y down); t in seconds. */

/** Light pools: centre (bx*aspect, by) + Lissajous drift (ax*aspect, ay) with angular speeds wx/wy (periods 45-80 s). */
export interface Pool { bx: number; by: number; ax: number; ay: number; wx: number; wy: number; px: number; py: number; r: number; w: number }
export const POOLS: Pool[] = [
  { bx: 0.08, by: 0.12, ax: 0.07, ay: 0.08, wx: 0.11, wy: 0.09, px: 0.0, py: 1.3, r: 0.27, w: 1.0 }, // top-left, behind the sidebar
  { bx: 0.80, by: 0.04, ax: 0.13, ay: 0.06, wx: 0.08, wy: 0.12, px: 2.1, py: 0.4, r: 0.31, w: 1.1 }, // top-right
  { bx: 1.00, by: 0.55, ax: 0.03, ay: 0.20, wx: 0.12, wy: 0.085, px: 4.0, py: 2.6, r: 0.22, w: 0.95 }, // right edge
  { bx: 0.52, by: 0.6, ax: 0.30, ay: 0.20, wx: 0.079, wy: 0.104, px: 1.1, py: 5.0, r: 0.24, w: 0.95 }, // wanderer (mid tone in content)
  { bx: 0.04, by: 0.92, ax: 0.06, ay: 0.06, wx: 0.1, wy: 0.13, px: 3.3, py: 0.9, r: 0.2, w: 0.6 }, // bottom-left glow
];
/** Soft ribbons: y = y0 + slope*xn + a1*sin(xn*f1 + t*s1) + a2*sin(xn*f2 - t*s2), gaussian width^2 = w2, fading in
    from xn = fadeFrom. */
export interface Ribbon { y0: number; slope: number; a1: number; f1: number; s1: number; a2: number; f2: number; s2: number; w2: number; w: number; fadeFrom: number }
export const RIBBONS: Ribbon[] = [
  { y0: 0.2, slope: 0.06, a1: 0.1, f1: 2.7, s1: 0.045, a2: 0.04, f2: 6.1, s2: 0.07, w2: 0.0028, w: 0.75, fadeFrom: -0.05 },
  { y0: 0.86, slope: -0.32, a1: 0.06, f1: 4.2, s1: 0.06, a2: 0.025, f2: 9.0, s2: 0.05, w2: 0.0011, w: 0.4, fadeFrom: 0.15 },
];
export const WARP = { amp: 0.09, freq: 2.3, speed: 0.02 };
export const MOTTLE = { freq: 7, base: 0.66, amp: 0.4, speed: 0.03 };

/** Sine-free hash (Dave Hoskins) — stable on GPUs, unlike fract(sin(big)), so value noise has no cell seams. */
export function hash2(x: number, y: number): number {
  const fr = (v: number) => v - Math.floor(v);
  let a = fr(x * 0.1031), b = fr(y * 0.1031), c = fr(x * 0.1031);
  const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33);
  a += d; b += d; c += d;
  return fr((a + b) * c);
}
export function vnoise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  return lerp(lerp(hash2(ix, iy), hash2(ix + 1, iy), ux), lerp(hash2(ix, iy + 1), hash2(ix + 1, iy + 1), ux), uy);
}

/** Shapes are sized in viewport heights; on portrait screens shrink them so a phone isn't one big blob. */
export const radiusScale = (aspect: number) => Math.min(1, Math.sqrt(aspect));

export function field(x: number, y: number, aspect: number, t: number): number {
  const rs = radiusScale(aspect);
  const wx = x + WARP.amp * (vnoise(x * WARP.freq + t * WARP.speed, y * WARP.freq) - 0.5);
  const wy = y + WARP.amp * (vnoise(x * WARP.freq + 7.1, y * WARP.freq - t * WARP.speed * 0.8) - 0.5);
  let f = 0;
  for (const b of POOLS) {
    const dx = wx - (b.bx * aspect + b.ax * aspect * Math.sin(t * b.wx + b.px));
    const dy = wy - (b.by + b.ay * Math.cos(t * b.wy + b.py));
    f += b.w * Math.exp(-(dx * dx + dy * dy) / (b.r * b.r * rs * rs));
  }
  const xn = wx / aspect;
  for (const r of RIBBONS) {
    const d = wy - (r.y0 + r.slope * xn + r.a1 * Math.sin(xn * r.f1 + t * r.s1) + r.a2 * Math.sin(xn * r.f2 - t * r.s2));
    f += r.w * Math.exp(-(d * d) / (r.w2 * rs * rs)) * smoothstep(r.fadeFrom, r.fadeFrom + 0.5, xn);
  }
  return f;
}

/** Grain mottle (MOTTLE.base..base+amp) at (x, y): varies the strong-colour share inside bodies. */
export function mottle(x: number, y: number, t: number): number {
  return MOTTLE.base + MOTTLE.amp * vnoise(x * MOTTLE.freq + t * MOTTLE.speed, y * MOTTLE.freq);
}

/**
 * The dither hue closest to a CSS colour (`rgb(r g b)`, `rgb(r, g, b)` or `hsl(h s% l%)`, as useCoverColor gives),
 * or null for greys and anything unparsable. Oranges and yellows count as red, teals as blue.
 */
export function ditherHueOf(css: string): DitherHue | null {
  let h: number, s: number;
  const hsl = /^hsla?\(\s*([\d.]+)[\s,]+([\d.]+)%/i.exec(css);
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(css);
  if (hsl) {
    h = Number(hsl[1]); s = Number(hsl[2]) / 100;
  } else if (rgb) {
    const [r, g, b] = [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255];
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    s = max === 0 ? 0 : d / max;
    if (d === 0) h = 0;
    else if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  } else return null;
  if (!Number.isFinite(h) || !Number.isFinite(s) || s < 0.18) return null;
  h = ((h % 360) + 360) % 360;
  if (h < 70 || h >= 335) return 'red';
  if (h < 165) return 'green';
  if (h < 255) return 'blue';
  return 'purple';
}

/**
 * New-song wave: the dot shapes already on screen swell outwards until they cover ~60-70% of the page, then
 * draw back in, once. The shader lifts the field (f -> f^e): faint shape edges fill in first, so the shapes
 * grow from where they are. `amt` 0..1 (how far out), `dir` +1 while swelling, -1 while drawing back.
 */
export const WAVE = { length: 3.2, ripple: 0.05 };

/**
 * Field exponent at the peak for a screen shape (width / height). Measured with field() over many frames,
 * counting clearly filled dots (tone > 0.4): desktop 16:10 28% at rest -> ~65% at 0.27, phone portrait
 * 39% -> ~65% at 0.4.
 */
export function wavePeakExponent(aspect: number): number {
  const k = Math.min(1, Math.max(0, (aspect - 0.46) / (1.6 - 0.46)));
  return 0.4 + (0.27 - 0.4) * k;
}

export function waveAt(dt: number): { amt: number; dir: number; t: number } {
  if (!(dt >= 0) || dt >= WAVE.length) return { amt: 0, dir: 1, t: 0 };
  const p = dt / WAVE.length;
  // out and back in, easing at both ends and at the turn
  return { amt: 0.5 - 0.5 * Math.cos(2 * Math.PI * p), dir: p < 0.5 ? 1 : -1, t: dt };
}

/** Parse `rgb(r g b)`, `rgb(r, g, b)` or `hsl(h s% l%)` (as useCoverColor gives) to 0..255 RGB. */
export function parseCssColour(css: string): Rgb | null {
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(css);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const hsl = /^hsla?\(\s*([\d.]+)[\s,]+([\d.]+)%[\s,]+([\d.]+)%/i.exec(css);
  if (!hsl) return null;
  return hslToRgb(Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100);
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === R ? 60 * (((G - B) / d) % 6) : max === G ? 60 * ((B - R) / d + 2) : 60 * ((R - G) / d + 4);
  return [(h + 360) % 360, s, l];
}

/**
 * A dither palette in the album's own colour: a strong, saturated dot colour at a fixed brightness (so text
 * keeps its contrast whatever the cover) and a dark mid tone of the same hue. Greys stay grey-blue.
 */
export function paletteFromColour(css: string): DitherPalette | null {
  const c = parseCssColour(css);
  if (!c) return null;
  const [h, s] = rgbToHsl(c);
  if (s < 0.12) return { light: hslToRgb(220, 0.12, 0.5), mid: hslToRgb(220, 0.12, 0.18) };
  // yellows/greens look much brighter than blues at the same lightness: pull them down a little
  const l = h >= 40 && h <= 160 ? 0.42 : 0.52;
  const sat = Math.min(0.85, Math.max(0.55, s));
  return { light: hslToRgb(h, sat, l), mid: hslToRgb(h, sat * 0.85, 0.19) };
}

/** Blend two palettes (k = 0 → a, 1 → b). */
export function mixPalette(a: DitherPalette, b: DitherPalette, k: number): DitherPalette {
  return { light: lerpRgb(a.light, b.light, k), mid: lerpRgb(a.mid, b.mid, k) };
}
