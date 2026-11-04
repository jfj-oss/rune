/**
 * Perceptual volume slider mapping. The slider position p (0..1) is split in two:
 * the whole left half covers 0..25 % volume (fine control where it matters),
 * the right half covers 25..100 %.
 */
export const VOL_KNEE = 25; // % volume at the slider midpoint
export const VOL_FINE_STEP = 0.5; // % per step below the knee
export const VOL_COARSE_STEP = 2; // % per step above the knee
export const VOL_SHIFT_FACTOR = 5; // Shift multiplies the step

/** Clamp, but treat a missing / NaN level (bad or stale server state) as the bottom. */
const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);

/** Slider position (0..1) -> volume (0..100), unquantised. */
export function posToVolume(p: number): number {
  const x = clamp(p, 0, 1);
  return x <= 0.5 ? x * 2 * VOL_KNEE : VOL_KNEE + (x - 0.5) * 2 * (100 - VOL_KNEE);
}

/** Volume (0..100) -> slider position (0..1). Inverse of posToVolume. */
export function volumeToPos(v: number): number {
  const x = clamp(v, 0, 100);
  return x <= VOL_KNEE ? x / (2 * VOL_KNEE) : 0.5 + (x - VOL_KNEE) / (2 * (100 - VOL_KNEE));
}

/** Quantise: 0.5 steps below the knee, whole percents above it. */
export function snapVolume(v: number): number {
  const x = clamp(v, 0, 100);
  return x < VOL_KNEE ? Math.round(x / VOL_FINE_STEP) * VOL_FINE_STEP : Math.round(x);
}

/** One keyboard / wheel step in direction dir (+1 up, -1 down). */
export function stepVolume(v: number, dir: 1 | -1, coarse = false): number {
  const fine = dir > 0 ? v < VOL_KNEE : v <= VOL_KNEE;
  const step = (fine ? VOL_FINE_STEP : VOL_COARSE_STEP) * (coarse ? VOL_SHIFT_FACTOR : 1);
  return snapVolume(v + dir * step);
}

/** Volume text; never throws on a missing / non-finite level from a stale server state. */
export function formatVolume(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  return `${Number.isInteger(v) ? v : v.toFixed(1)}%`;
}

/** iOS / iPadOS: <audio>.volume is read-only there, so in-page volume does nothing. */
export function detectIOS(ua: string, maxTouchPoints = 0): 'iPhone' | 'iPad' | null {
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return 'iPad';
  return null;
}
