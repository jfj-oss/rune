/* Pure helpers for the "Dither" ambient backdrop (see components/DitherBackdrop.tsx).
   Everything here is deterministic and DOM-free so it can be unit-tested and reused by the Canvas 2D fallback. */

export type Rgb = readonly [number, number, number];
/** A dither palette: black plus a dark mid tone and the strong "light" colour. */
export interface DitherPalette { mid: Rgb; light: Rgb }
export type DitherHue = 'red' | 'blue' | 'purple' | 'green' | 'olive' | 'lime';
export type DitherColour = DitherHue | 'cycle';

const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** Strong, saturated duotones; the mid tone sits roughly 45% of the way up so dithered gradients read as three steps. */
export const DITHER_PALETTES: Record<DitherHue, DitherPalette> = {
  red: { light: hex('#d4584f'), mid: hex('#521d1a') },
  blue: { light: hex('#3f74e8'), mid: hex('#1c3270') },
  purple: { light: hex('#8f5ae8'), mid: hex('#3f2675') },
  green: { light: hex('#22924c'), mid: hex('#0e3519') },
  olive: { light: hex('#a39642'), mid: hex('#464020') },
  lime: { light: hex('#a2a646'), mid: hex('#454721') },
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

/** Dot grain: `fine` (default) is ~1.5 CSS px, `classic` the original ~2 CSS px. */
export type DotSize = 'fine' | 'classic';

/** Device-pixel size of one dither dot, always an integer number of device pixels, grown on huge screens so the
    canvas never exceeds `maxPixels`. Classic: ~2 CSS px. Fine: ~1.5 CSS px (1 px at dpr 1, 3 at dpr 2, 4 at dpr 3),
    with a higher pixel budget (one cheap fragment pass; the adaptive `coarse` step still backs off on slow devices). */
export function dotSize(cssW: number, cssH: number, dpr: number, coarse = 0, maxPixels?: number, grain: DotSize = 'classic'): number {
  const fine = grain === 'fine';
  const cap = maxPixels ?? (fine ? 2_200_000 : 600_000);
  let dot = fine ? Math.max(1, Math.floor((1.5 + coarse) * dpr + 0.01)) : Math.max(2, Math.round((2 + coarse) * dpr));
  while ((cssW * dpr / dot) * (cssH * dpr / dot) > cap) dot++;
  return dot;
}

/** Share of the strong-colour / mid-tone dots kept: the phone's fine grain is a little sparser so it reads as
    calm texture rather than noise. */
export const calmFor = (grain: DotSize, phone: boolean): number => (grain === 'fine' && phone ? 0.84 : 1);

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
 * New-song wave: the dot shapes already on screen swell outwards until they cover ~80% of the page (gently
 * at first, building, easing into the peak), rest there a moment, then draw back in, slowly at first and
 * faster as they shrink, settling softly at rest. 8.4 s in all. The shader maps `amt` to the field exponent
 * geometrically (e = peak^amt), which makes the covered area grow evenly with `amt` (a linear map grew
 * very little at first and then rushed the last 30%).
 * The shader lifts the field (f -> f^e): faint shape edges fill in first, so the shapes grow from where they
 * are. `amt` 0..1 (how far out), `dir` +1 swelling, 0 holding, -1 drawing back.
 */
export const WAVE = {
  rise: 3.4, hold: 1.6, fall: 3.4,
  /** After the crash: a damped bounce (dips below rest, comes back a little above, settles). */
  bounce: 4.0, bouncePeriod: 3.2, bounceDamping: 0.3, ripple: 0.035,
  get length() { return this.rise + this.hold + this.fall + this.bounce; },
};

/**
 * Field exponent at the peak for a screen shape (width / height). Measured with field() over many frames,
 * counting clearly filled dots (tone > 0.4): desktop 16:10 28% at rest -> ~82% at 0.16 (~80% of the screen in practice), phone portrait
 * 39% -> ~83% at 0.24.
 */
export function wavePeakExponent(aspect: number): number {
  const k = Math.min(1, Math.max(0, (aspect - 0.46) / (1.6 - 0.46)));
  return 0.24 + (0.16 - 0.24) * k;
}

export function waveAt(dt: number): { amt: number; dir: number; t: number } {
  const { rise, hold, fall, bounce, length } = WAVE;
  if (!(dt >= 0) || dt >= length) return { amt: 0, dir: 1, t: 0 };
  // out: starts gently, builds, and eases into the peak (like a swell of water, not a jolt)
  if (dt < rise) return { amt: 0.5 - 0.5 * Math.cos(Math.PI * (dt / rise)), dir: 1, t: dt };
  // a moment at full size
  if (dt < rise + hold) return { amt: 1, dir: 0, t: dt };
  // back: starts gently and builds speed, reaching rest still moving (the crash)
  if (dt < rise + hold + fall) {
    const q = (dt - rise - hold) / fall;
    return { amt: Math.cos((Math.PI / 2) * q), dir: -1, t: dt };
  }
  // the bounce: a damped spring that starts at the crash's speed (no kink), dips below rest, comes back
  // a little above it, and fades out to exactly rest
  const t = dt - rise - hold - fall;
  const wd = (2 * Math.PI) / WAVE.bouncePeriod;
  const w = wd / Math.sqrt(1 - WAVE.bounceDamping ** 2);
  const v0 = Math.PI / (2 * fall); // speed of the crash (per second)
  const fade = 1 - smoothstep(bounce * 0.7, bounce, t);
  return { amt: -(v0 / wd) * Math.exp(-WAVE.bounceDamping * w * t) * Math.sin(wd * t) * fade, dir: 0, t: dt };
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

/* ---------- evolution ----------
   The animation is not one fixed pattern: the field slowly wanders between four characters, each a different
   field function in the shader. Drift is today's look (and where every session starts), Tide is broad rolling
   horizontal bands, Ripple is soft interfering rings around wandering centres, Aurora is tall swaying curtains.
   Which one is shown is a set of weights computed here (pure, deterministic in t) and handed to the shader;
   the weights glide through long crossfades, so there is never a cut. Order and timing come from a seeded
   random sequence, so it does not read as a loop. Alongside, a few slow modulators (flow direction, zoom, speed,
   an occasional travelling current) keep each character from looking the same every time it returns. */

/** 0 drift, 1 tide, 2 ripple, 3 aurora. */
export type Character = 0 | 1 | 2 | 3;
export const CHARACTERS = ['drift', 'tide', 'ripple', 'aurora'] as const;
export type Mix = [number, number, number, number];

interface Segment { char: Character; /** centre of the crossfade into the next segment (s) */ end: number; /** length of that crossfade (s) */ fade: number }
const plan: Segment[] = [];
let planRng: (() => number) | null = null;
let bag: Character[] = [];
let lastChar: Character = 0;
export const EVOLVE = { firstEnd: 75, holdMin: 80, holdSpread: 60, fadeMin: 20, fadeSpread: 20, seed: 20261103 };

function nextChar(): Character {
  const r = planRng!;
  if (!bag.length) {
    bag = [1, 2, 3]; // drift (0), the original pools, is no longer in the rotation: only the wave characters
    for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [bag[i], bag[j]] = [bag[j]!, bag[i]!]; }
    // never the same character twice running across bag boundaries
    if (bag[bag.length - 1] === lastChar) { const k = Math.floor(r() * (bag.length - 1)); [bag[k], bag[bag.length - 1]] = [bag[bag.length - 1]!, bag[k]!]; }
  }
  lastChar = bag.pop()!;
  return lastChar;
}
function extendPlan(t: number) {
  if (!planRng) {
    planRng = rng(EVOLVE.seed);
    lastChar = 1;
    plan.push({ char: 1, end: EVOLVE.firstEnd, fade: EVOLVE.fadeMin + planRng() * EVOLVE.fadeSpread });
  }
  const r = planRng;
  // keep one segment beyond t
  while (plan[plan.length - 1]!.end - plan[plan.length - 1]!.fade / 2 <= t) {
    const prev = plan[plan.length - 1]!;
    plan.push({ char: nextChar(), end: prev.end + EVOLVE.holdMin + r() * EVOLVE.holdSpread, fade: EVOLVE.fadeMin + r() * EVOLVE.fadeSpread });
  }
}

/** Weights (sum 1) of the four characters at time t seconds. Starts as pure tide and moves between tide, ripple and
    aurora (drift is out of the rotation); crossfades are smoothstepped. */
export function mixAt(t: number): Mix {
  const m: Mix = [0, 0, 0, 0];
  if (!(t > 0)) { m[1] = 1; return m; }
  extendPlan(t);
  // segments whose fade starts after t are not reached: find the first fade that has not finished
  let lo = 0, hi = plan.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; const s = plan[mid]!; if (s.end + s.fade / 2 > t) hi = mid; else lo = mid + 1; }
  const s = plan[lo]!;
  const from = s.end - s.fade / 2;
  if (t < from) { m[s.char] = 1; return m; }
  const k = smoothstep(0, 1, (t - from) / s.fade);
  m[s.char] = 1 - k;
  const next = plan[lo + 1]?.char ?? s.char;
  m[next] = (m[next] ?? 0) + k;
  return m;
}

/** Slow modulators for the non-drift characters. `ang` rotates the flow, `zoom` scales feature size,
    `time` is a warped clock (speed varies about +-25%). All smooth sums of slow sines. */
export function modulatorsAt(t: number): { ang: number; zoom: number; time: number } {
  return {
    ang: 0.45 * Math.sin(t / 97 + 0.7) + 0.2 * Math.sin(t / 41 + 2.1),
    zoom: 1 + 0.1 * Math.sin(t / 61 + 1) + 0.05 * Math.sin(t / 29),
    time: t + 8 * Math.sin(t / 47) + 2 * Math.sin(t / 23 + 1),
  };
}

/** An occasional "current": a soft band that travels across the field once every ~95 s (not every time).
    Returns the unit direction, the band's position along it (screen heights from the centre) and its strength. */
export const CURRENT = { period: 95, strength: 0.22 };
export function currentAt(t: number): { dx: number; dy: number; pos: number; amp: number } {
  const p = t / CURRENT.period;
  const k = Math.floor(p), f = p - k;
  const h = hash2(k * 1.7 + 3.1, 5.3);
  const h2 = hash2(k * 2.9 + 1.3, 8.1);
  const a = h * Math.PI * 2;
  const on = smoothstep(0.35, 0.55, h2); // some periods have no current at all
  const env = Math.sin(Math.PI * f);
  return { dx: Math.cos(a), dy: Math.sin(a), pos: -0.75 + 1.5 * f, amp: CURRENT.strength * on * env * env };
}
