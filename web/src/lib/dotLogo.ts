/* Pure helpers for the animated mark (components/Logo.tsx): four balls on a square, one diagonal pair at a time
   swapping corners, drawn as a soft brightness field (balls + motion trails) and then ordered-dithered into very fine
   dots in the backdrop's tones. DOM-free so it can be unit-tested. */

import { blueNoise, densities, ditherLevel, type DotSize } from './dither';

/** One loop: pair A swaps in the first half, pair B in the second, each starting the moment the other lands. */
export const LOOP_MS = 1250;
const MOVE = 0.5;
const B_START = 0.5;

/** Layout, as fractions of the logo's width. */
const HALF_SIDE = 0.17; // corners at centre ± this
const RADIUS = 0.15; // ball radius
const BOW = 0.07; // how far the two travellers bow apart mid-way
const SWELL = 0.16; // extra size mid-flight

/** Trail: earlier samples of the same motion, fainter and smaller the further back. */
const TRAIL_STEPS = 9;
const TRAIL_GAP_MS = 20;

/** cubic-bezier(x1, y1, x2, y2) as an easing function (Newton on x, then y). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const bx = (t: number) => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3;
  const by = (t: number) => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3;
  const dx = (t: number) => 3 * x1 * (1 - t) ** 2 + 6 * (x2 - x1) * t * (1 - t) + 3 * (1 - x2) * t * t;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t = Math.min(1, Math.max(0, t - (bx(t) - x) / d));
    }
    return by(t);
  };
}

/** Hard start, quick middle, a small overshoot past the corner that settles. */
const ease = cubicBezier(0.72, 0, 0.18, 1.14);

export interface Ball { x: number; y: number; r: number }

/** The four balls at time `ms` (positions and radius as fractions of the logo width). */
export function ballsAt(ms: number): Ball[] {
  const phase = (((ms % LOOP_MS) + LOOP_MS) % LOOP_MS) / LOOP_MS;
  const out: Ball[] = [];
  // pair A: top-left <-> bottom-right; pair B: top-right <-> bottom-left
  const pairs = [
    { from: [-1, -1], to: [1, 1], start: 0 },
    { from: [1, -1], to: [-1, 1], start: B_START },
  ] as const;
  for (const p of pairs) {
    const u = Math.min(1, Math.max(0, (phase - p.start) / MOVE));
    const k = ease(u);
    const lift = Math.sin(Math.PI * u);
    // perpendicular to the diagonal travelled, unit length
    const px = -(p.to[1] - p.from[1]) / (2 * Math.SQRT2), py = (p.to[0] - p.from[0]) / (2 * Math.SQRT2);
    for (const dir of [1, -1] as const) {
      const a = dir === 1 ? p.from : p.to, b = dir === 1 ? p.to : p.from;
      out.push({
        x: 0.5 + HALF_SIDE * (a[0] + (b[0] - a[0]) * k) + px * BOW * lift * dir,
        y: 0.5 + HALF_SIDE * (a[1] + (b[1] - a[1]) * k) + py * BOW * lift * dir,
        r: RADIUS * (1 + SWELL * lift),
      });
    }
  }
  return out;
}

/**
 * Brightness of every cell of a `w` x `h` grid at time `ms`: soft balls plus their motion trail (earlier samples,
 * fainter and smaller). Values are 0..1+.
 */
export function brightness(ms: number, w: number, h: number, into = new Float32Array(w * h)): Float32Array {
  into.fill(0);
  const layers: { balls: Ball[]; gain: number; scale: number }[] = [{ balls: ballsAt(ms), gain: 1.25, scale: 1 }];
  for (let k = 1; k <= TRAIL_STEPS; k++) {
    layers.push({ balls: ballsAt(ms - k * TRAIL_GAP_MS), gain: 0.8 * (1 - k / (TRAIL_STEPS + 1)), scale: 1 - k * 0.06 });
  }
  for (const { balls, gain, scale } of layers) {
    for (const b of balls) {
      const r = b.r * scale * w;
      const cx = b.x * w, cy = b.y * w;
      const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
      const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const d2 = ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) / (r * r);
        if (d2 >= 1) continue;
        const f = (1 - d2) * (1 - d2);
        // brightest layer wins, so passing balls and their trails blend instead of adding up
        into[y * w + x] = Math.max(into[y * w + x]!, f * gain);
      }
    }
  }
  return into;
}

/** The backdrop's dot size in device pixels (see dotSize in lib/dither): fine ~1.5 CSS px, classic ~2. */
export function logoDot(dpr: number, grain: DotSize): number {
  return grain === 'fine' ? Math.max(1, Math.floor(1.5 * dpr + 0.01)) : Math.max(2, Math.round(2 * dpr));
}

const NOISE_N = 64;
let rank: Uint16Array | null = null;

/**
 * Dither the field exactly like the backdrop: blue-noise thresholds and the backdrop's light / mid shares, so even the
 * brightest ball is a speckle of light dots over mid ones. Levels: 0 = see-through (where the backdrop would be
 * black), 1 = mid tone, 2 = light tone. `ox`/`oy` shift the noise so neighbouring logos do not repeat each other.
 */
export function ditherLevels(field: Float32Array, w: number, h: number, into = new Uint8Array(w * h), ox = 0, oy = 0): Uint8Array {
  rank ??= blueNoise(NOISE_N);
  const N = NOISE_N * NOISE_N;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const [dL, dM] = densities(Math.min(1, field[i]!));
    const th = (rank[((y + oy) % NOISE_N) * NOISE_N + ((x + ox) % NOISE_N)]! + 0.5) / N;
    into[i] = ditherLevel(dL, dM, th);
  }
  return into;
}
