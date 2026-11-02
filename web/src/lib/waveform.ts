/** Pure geometry for the mirrored peak waveform (canvas draws it, tests check it). */

export interface BarRect {
  index: number;
  x: number;
  width: number;
  /** top offset inside the track height */
  top: number;
  height: number;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

/**
 * One bar per peak, evenly spaced across `width`, mirrored around the vertical centre.
 * A zero peak still gets a 2px line so the bass line reads as a line, not a gap.
 */
export function peakBars(data: number[], width: number, height: number, gap = 1): BarRect[] {
  const n = data.length;
  if (!n || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];
  const slot = width / n;
  const w = Math.max(0.5, slot - Math.max(0, gap));
  const usable = Math.max(2, height);
  return data.map((raw, index) => {
    const h = Math.max(2, clamp01(raw) * usable);
    return { index, x: index * slot + (slot - w) / 2, width: w, top: (usable - h) / 2, height: h };
  });
}

/**
 * Merge peaks down to at most `bars` values (loudest of each group), so every
 * drawn bar is wide enough to see: 400 peaks in a 380 px bar would blur to haze.
 */
export function fitPeaks(data: number[], bars: number): number[] {
  const n = data.length;
  const m = Math.max(1, Math.floor(bars));
  if (n <= m) return data;
  const out: number[] = new Array(m);
  for (let i = 0; i < m; i++) {
    const from = Math.floor((i * n) / m);
    const to = Math.max(from + 1, Math.floor(((i + 1) * n) / m));
    let max = 0;
    for (let j = from; j < to; j++) max = Math.max(max, data[j] ?? 0);
    out[i] = max;
  }
  return out;
}

/** How many leading bars count as played (at the very end every bar is accent-coloured). */
export function playedBars(count: number, positionMs: number, durationMs: number): number {
  if (count <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, (Number.isFinite(positionMs) ? positionMs : 0) / durationMs));
  return Math.round(ratio * count);
}

/** Pointer x -> byte/time position inside the waveform. */
export function seekTimeAt(x: number, width: number, durationMs: number): number {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.max(0, Math.min(1, x / width)) * durationMs;
}

/** Which bar a pointer is over (for the hover readout). */
export function barAt(x: number, width: number, count: number): number {
  if (!Number.isFinite(width) || width <= 0 || count <= 0) return -1;
  return Math.max(0, Math.min(count - 1, Math.floor((Math.max(0, Math.min(width, x)) / width) * count)));
}

/** 32-bit FNV-1a hash, the seed for a generated waveform. */
function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, deterministic PRNG in [0, 1). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A song-shaped stand-in waveform (0–1) for songs whose audio rune cannot read
 * (Spotify without a local copy). It is NOT the song's real loudness: sections of
 * ~12–28 s at different levels, a fade in and out, and per-bar texture, always the
 * same for the same id.
 */
export function generatedPeaks(id: string, buckets: number, durationMs: number): number[] {
  const n = Math.max(1, Math.floor(buckets));
  const rand = rng(hashSeed(id));
  const secs = Math.max(30, durationMs / 1000);
  // section levels across the song
  const levels: number[] = new Array(n);
  let i = 0;
  while (i < n) {
    const len = Math.max(1, Math.round(((12 + rand() * 16) / secs) * n));
    const level = 0.3 + rand() * 0.6;
    for (let k = 0; k < len && i < n; k++, i++) levels[i] = level;
  }
    const fade = Math.max(1, Math.round((4 / secs) * n));
  const beat = 2 + Math.floor(rand() * 3); // accent every 2–4 bars
  const out: number[] = new Array(n);
  let smooth = levels[0] ?? 0.6;
  let wobble = 0.7;
  for (let j = 0; j < n; j++) {
    smooth += ((levels[j] ?? smooth) - smooth) * 0.25; // soften section edges
    wobble += (rand() - wobble) * 0.35; // slow drift, so neighbours relate
    const edge = Math.min(1, (j + 1) / fade, (n - j) / fade);
    const hit = j % beat === 0 ? 1.15 : 1;
    const texture = (0.25 + 0.55 * wobble + 0.35 * rand()) * hit;
    out[j] = Math.round(1000 * Math.min(1, smooth * texture * (0.25 + 0.75 * edge))) / 1000;
  }
return out;
}
