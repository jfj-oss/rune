/* Pure maths of the "Foil waves" backdrop (see components/FoilBackdrop.tsx; the native app's backdrop.rs is a port of this
   file, line for line, so both draw the same picture).

   The look: printed foil. A near-black navy field with flowing parallel wave lines, each made of single sparkling
   stipple dots; behind them a mottled cloud of icy-blue stipple that breathes, a soft stippled fog drifting in from the
   left edge, a stippled moon, and a few dots that glint and fade like light on metal.

   Everything is a function of (cell, size, time): no state, deterministic. A "cell" is one dot-sized pixel of the low
   resolution frame; the frame is upscaled with nearest-neighbour so the dots stay dots. The noise that decides which
   cells are lit is a fixed integer-hash tile (identical bytes in TypeScript and Rust, so no float hashing differs). */

export const FOIL_N = 128;
/** Frame cap (fps). The motion is slow; 30 is the ceiling the other backdrops use. */
export const FOIL_FPS = 30;
/** Target size of one dot in CSS pixels; the frame is rendered at (viewport / FOIL_DOT) cells. */
export const FOIL_DOT = 3;

/* ---- noise tile ---- */
function h32(x: number, y: number, c: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(c + 1, -2048144777)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return h >>> 24;
}
let tile: Uint8Array | null = null;
/** FOIL_N x FOIL_N RGBA bytes: R = wave stipple, G = cloud stipple, B = glint phase, A = brightness variance. */
export function foilNoise(): Uint8Array {
  if (!tile) {
    const t = new Uint8Array(FOIL_N * FOIL_N * 4);
    for (let y = 0; y < FOIL_N; y++) for (let x = 0; x < FOIL_N; x++) for (let c = 0; c < 4; c++) t[(y * FOIL_N + x) * 4 + c] = h32(x, y, c);
    tile = t;
  }
  return tile;
}
const nz = (n: Uint8Array, x: number, y: number, c: number) =>
  ((n[(((y % FOIL_N) + FOIL_N) % FOIL_N * FOIL_N + (((x % FOIL_N) + FOIL_N) % FOIL_N)) * 4 + c]!) + 0.5) / 256;

const sstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const fract = (x: number) => x - Math.floor(x);

export const FOIL = {
  base: [6, 10, 26] as const,
  wave: [118, 134, 255] as const,
  cloud: [130, 176, 255] as const,
  moon: [116, 130, 255] as const,
  glint: [226, 238, 255] as const,
  gain: 0.85,
};

export type Rgb = [number, number, number];

/** Colour (0..255, unrounded) of cell (cx, cy) of a w x h frame at time t seconds. `n` is foilNoise(). */
export function foilCell(cx: number, cy: number, w: number, h: number, t: number, n: Uint8Array): Rgb {
  const asp = w / h;
  const u = (cx + 0.5) / w, v = (cy + 0.5) / h;
  const x = u * asp;

  // ---- cloud + fog (icy-blue stipple)
  const px = x * 1.25, py = v * 1.25;
  const a = Math.sin(px * 2.1 + 1.4 * Math.sin(py * 2.7 + t * 0.05) + t * 0.03);
  const b = Math.sin(py * 2.9 - 1.2 * Math.sin(px * 1.9 - t * 0.04) - t * 0.025 + 2.0);
  const c3 = Math.sin((px + py) * 3.7 + t * 0.045);
  const cl = 0.5 + 0.5 * (0.45 * a + 0.35 * b + 0.2 * c3);
  const br = 0.82 + 0.18 * Math.sin(t * 0.13);
  const dc = sstep(0.52, 0.9, cl) * 0.85 * br + 0.3 * Math.exp(-x * 2.0) * (0.5 + 0.5 * cl);

  // ---- wave lines
  const base = 0.22 + 0.42 * u + 0.12 * Math.sin(x * 1.6 + t * 0.09) + 0.06 * Math.sin(x * 3.4 - t * 0.14 + 1.3) + 0.02 * Math.sin(x * 9.3 + v * 3.0 + t * 0.23);
  const sp = 0.115 + 0.04 * Math.sin(x * 1.3 + 0.8);
  const s = (v - base) / sp - t * 0.025;
  const d = Math.abs(fract(s + 0.5) - 0.5) * sp;
  const sig = 1.05 / h;
  const env = 0.1 + 0.9 * sstep(0.3, 0.78, 0.5 + 0.5 * Math.sin(x * 1.8 + v * 2.2 - t * 0.05 + Math.sin(v * 3.0 + t * 0.03)));
  const dw = (Math.exp(-(d * d) / (2 * sig * sig)) + 0.13 * Math.exp(-(d * d) / (2 * (3.2 * sig) * (3.2 * sig)))) * env * 0.88;

  // ---- moon
  const mx = asp * 0.86 + 0.008 * Math.sin(t * 0.07), my = 0.2 + 0.008 * Math.cos(t * 0.05);
  const dm = 0.75 * (1 - sstep(0.0425, 0.05, Math.hypot(x - mx, v - my)));

  const nR = nz(n, cx, cy, 0), nG = nz(n, cx, cy, 1), nB = nz(n, cx, cy, 2), nA = nz(n, cx, cy, 3);
  const nM = nz(n, cx + 53, cy + 11, 0);
  const vr = 0.55 + 0.6 * nA;

  // glint: ~28% of cells can sparkle, each on its own phase; a rare few more light up on the dark
  const ph = (nB - 0.72) / 0.28;
  const g = nB > 0.72 ? Math.pow(Math.max(0, Math.sin(t * 0.7 + ph * 6.2832)), 30) : 0;
  const ph2 = (nB - 0.99) / 0.01;
  const star = nB > 0.99 ? Math.pow(Math.max(0, Math.sin(t * 0.5 + ph2 * 6.2832)), 12) : 0;

  let col: Rgb;
  let lit = true;
  if (nR < dw) col = [FOIL.wave[0] * vr, FOIL.wave[1] * vr, FOIL.wave[2] * vr];
  else if (nM < dm) col = [FOIL.moon[0] * vr, FOIL.moon[1] * vr, FOIL.moon[2] * vr];
  else if (nG < dc) { const k = vr * 0.72; col = [FOIL.cloud[0] * k, FOIL.cloud[1] * k, FOIL.cloud[2] * k]; }
  else {
    lit = false;
    const k = cl * br;
    col = [FOIL.base[0] + 4 * k + 150 * 0.6 * star, FOIL.base[1] + 8 * k + 170 * 0.6 * star, FOIL.base[2] + 18 * k + 230 * 0.6 * star];
  }
  if (lit && g > 0) { const m = g * 0.9; col = [col[0] + (FOIL.glint[0] - col[0]) * m, col[1] + (FOIL.glint[1] - col[1]) * m, col[2] + (FOIL.glint[2] - col[2]) * m]; }

  const vig = (1 - 0.5 * sstep(0.3, 0.85, Math.hypot(u - 0.5, v - 0.5))) * FOIL.gain;
  return [Math.min(255, col[0] * vig), Math.min(255, col[1] * vig), Math.min(255, col[2] * vig)];
}

/** A whole frame as RGBA bytes (the Canvas 2D fallback, the tests, and the reference the other renderers are checked against). */
export function foilFrame(w: number, h: number, t: number): Uint8ClampedArray<ArrayBuffer> {
  const n = foilNoise();
  const out = new Uint8ClampedArray(new ArrayBuffer(w * h * 4));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = foilCell(x, y, w, h, t, n);
    const i = (y * w + x) * 4;
    out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255;
  }
  return out;
}

/** Internal frame size for a viewport: about one dot per FOIL_DOT CSS px (device pixels / (dot * dpr) cells), never fewer than 8. */
export function foilSize(cssW: number, cssH: number, dpr: number): { w: number; h: number; dot: number } {
  // whole device pixels per dot, at least 2, so the nearest-neighbour upscale is an integer one
  const dot = Math.max(2, Math.round(FOIL_DOT * dpr));
  return { w: Math.max(8, Math.ceil((cssW * dpr) / dot)), h: Math.max(8, Math.ceil((cssH * dpr) / dot)), dot };
}

/** Seconds are wrapped so float32 shaders keep their precision on a window left open for days (one small jump per ~28 h). */
export const FOIL_T_WRAP = 100000;
export const foilClock = (ms: number) => (ms / 1000) % FOIL_T_WRAP;

/** The still frame (reduced motion): a nicely composed moment. */
export const FOIL_STILL_T = 40;

/** Should the backdrop be drawing frames? Not when the tab is hidden / the window unfocused with Battery saver
    (`looking`), nor under reduced motion / Reduce effects (`still`: one frame is drawn instead), nor without WebGL. */
export function foilAnimating(looking: boolean, still: boolean, webgl: boolean): boolean {
  return looking && !still && webgl;
}
/** Minimum gap between drawn frames, ms. */
export const foilFrameMs = () => 1000 / FOIL_FPS;

/* ---- the fragment shader: the same formulas, in GLSL ES 1.00 ---- */
const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const col3 = (c: readonly number[]) => `vec3(${c.map(f).join(', ')})`;
export const FOIL_VERT = `attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;
export const FOIL_FRAG = `precision highp float;
uniform vec2 u_res;
uniform float u_t;
uniform sampler2D u_noise;
float sstep(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
vec4 nz(vec2 c) { return texture2D(u_noise, (mod(c, ${f(FOIL_N)}) + 0.5) / ${f(FOIL_N)}); }
void main() {
  float w = u_res.x, h = u_res.y, t = u_t;
  vec2 cell = vec2(floor(gl_FragCoord.x), h - 1.0 - floor(gl_FragCoord.y));
  float asp = w / h;
  float u = (cell.x + 0.5) / w, v = (cell.y + 0.5) / h;
  float x = u * asp;

  float px = x * 1.25, py = v * 1.25;
  float a = sin(px * 2.1 + 1.4 * sin(py * 2.7 + t * 0.05) + t * 0.03);
  float b = sin(py * 2.9 - 1.2 * sin(px * 1.9 - t * 0.04) - t * 0.025 + 2.0);
  float c3 = sin((px + py) * 3.7 + t * 0.045);
  float cl = 0.5 + 0.5 * (0.45 * a + 0.35 * b + 0.2 * c3);
  float br = 0.82 + 0.18 * sin(t * 0.13);
  float dc = sstep(0.52, 0.9, cl) * 0.85 * br + 0.3 * exp(-x * 2.0) * (0.5 + 0.5 * cl);

  float base = 0.22 + 0.42 * u + 0.12 * sin(x * 1.6 + t * 0.09) + 0.06 * sin(x * 3.4 - t * 0.14 + 1.3) + 0.02 * sin(x * 9.3 + v * 3.0 + t * 0.23);
  float sp = 0.115 + 0.04 * sin(x * 1.3 + 0.8);
  float s = (v - base) / sp - t * 0.025;
  float d = abs(fract(s + 0.5) - 0.5) * sp;
  float sig = 1.05 / h;
  float env = 0.1 + 0.9 * sstep(0.3, 0.78, 0.5 + 0.5 * sin(x * 1.8 + v * 2.2 - t * 0.05 + sin(v * 3.0 + t * 0.03)));
  float dw = (exp(-(d * d) / (2.0 * sig * sig)) + 0.13 * exp(-(d * d) / (2.0 * (3.2 * sig) * (3.2 * sig)))) * env * 0.88;

  float mx = asp * 0.86 + 0.008 * sin(t * 0.07), my = 0.2 + 0.008 * cos(t * 0.05);
  float dm = 0.75 * (1.0 - sstep(0.0425, 0.05, length(vec2(x - mx, v - my))));

  vec4 n = nz(cell);
  float nM = nz(cell + vec2(53.0, 11.0)).r;
  float vr = 0.55 + 0.6 * n.a;
  float ph = (n.b - 0.72) / 0.28;
  float g = n.b > 0.72 ? pow(max(0.0, sin(t * 0.7 + ph * 6.2832)), 30.0) : 0.0;
  float ph2 = (n.b - 0.99) / 0.01;
  float star = n.b > 0.99 ? pow(max(0.0, sin(t * 0.5 + ph2 * 6.2832)), 12.0) : 0.0;

  vec3 col;
  bool lit = true;
  if (n.r < dw) col = ${col3(FOIL.wave)} * vr;
  else if (nM < dm) col = ${col3(FOIL.moon)} * vr;
  else if (n.g < dc) col = ${col3(FOIL.cloud)} * (vr * 0.72);
  else {
    lit = false;
    float k = cl * br;
    col = ${col3(FOIL.base)} + vec3(4.0, 8.0, 18.0) * k + vec3(150.0, 170.0, 230.0) * 0.6 * star;
  }
  if (lit && g > 0.0) col = mix(col, ${col3(FOIL.glint)}, g * 0.9);
  float vig = (1.0 - 0.5 * sstep(0.3, 0.85, length(vec2(u - 0.5, v - 0.5)))) * ${f(FOIL.gain)};
  gl_FragColor = vec4(min(col * vig, 255.0) / 255.0, 1.0);
}`;
