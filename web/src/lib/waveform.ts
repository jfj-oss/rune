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
