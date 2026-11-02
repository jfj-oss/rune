import { describe, expect, it } from 'vitest';
import { barAt, peakBars, playedBars, seekTimeAt } from './waveform';

describe('peakBars', () => {
  it('lays one evenly spaced bar per peak across the width', () => {
    const bars = peakBars([0, 0.5, 1, 0.25], 100, 40, 1);
    expect(bars).toHaveLength(4);
    expect(bars.map((b) => b.index)).toEqual([0, 1, 2, 3]);
    expect(bars[0]!.x).toBeCloseTo(0.5);
    expect(bars[1]!.x).toBeCloseTo(25.5);
    expect(bars[3]!.x).toBeCloseTo(75.5);
    for (const b of bars) {
      expect(b.width).toBeCloseTo(24);
      expect(b.top + b.height / 2).toBeCloseTo(20);
    }
  });

  it('mirrors heights around the centre and keeps a 2px line for silence', () => {
    const [quiet, half, full] = peakBars([0, 0.5, 1], 30, 20);
    expect(quiet!.height).toBe(2);
    expect(quiet!.top).toBe(9);
    expect(half!.height).toBeCloseTo(10);
    expect(half!.top).toBeCloseTo(5);
    expect(full!.height).toBe(20);
    expect(full!.top).toBe(0);
  });

  it('clamps bad input instead of drawing outside the box', () => {
    const [low, high, nan] = peakBars([-2, 4, Number.NaN], 30, 20);
    expect(low!.height).toBe(2);
    expect(high!.height).toBe(20);
    expect(nan!.height).toBe(2);
  });

  it('returns nothing for an empty list or a zero-size box', () => {
    expect(peakBars([], 100, 30)).toEqual([]);
    expect(peakBars([1, 2], 0, 30)).toEqual([]);
    expect(peakBars([1, 2], 100, 0)).toEqual([]);
    expect(peakBars([1, 2], Number.POSITIVE_INFINITY, 30)).toEqual([]);
  });

  it('compresses a big peak list into the same width without gaps', () => {
    const bars = peakBars(Array.from({ length: 800 }, () => 0.6), 400, 30);
    expect(bars).toHaveLength(800);
    expect(bars[0]!.x).toBeGreaterThanOrEqual(0);
    expect(bars[799]!.x + bars[799]!.width).toBeLessThanOrEqual(400);
    expect(bars[1]!.x).toBeGreaterThan(bars[0]!.x);
  });
});

describe('playedBars', () => {
  it('counts leading bars by position', () => {
    expect(playedBars(100, 0, 200_000)).toBe(0);
    expect(playedBars(100, 50_000, 200_000)).toBe(25);
    expect(playedBars(100, 200_000, 200_000)).toBe(100);
  });
  it('clamps past the ends and tolerates a live/unknown duration', () => {
    expect(playedBars(100, -10, 200_000)).toBe(0);
    expect(playedBars(100, 400_000, 200_000)).toBe(100);
    expect(playedBars(100, 50_000, 0)).toBe(0);
    expect(playedBars(0, 50_000, 200_000)).toBe(0);
  });
});

describe('seekTimeAt', () => {
  it('maps pointer x to time with clamped ends', () => {
    expect(seekTimeAt(0, 400, 240_000)).toBe(0);
    expect(seekTimeAt(200, 400, 240_000)).toBe(120_000);
    expect(seekTimeAt(400, 400, 240_000)).toBe(240_000);
    expect(seekTimeAt(-20, 400, 240_000)).toBe(0);
    expect(seekTimeAt(900, 400, 240_000)).toBe(240_000);
  });
  it('returns 0 when there is no duration or width', () => {
    expect(seekTimeAt(100, 0, 240_000)).toBe(0);
    expect(seekTimeAt(100, 400, 0)).toBe(0);
  });
});

describe('barAt', () => {
  it('finds the bar under the pointer', () => {
    expect(barAt(0, 100, 10)).toBe(0);
    expect(barAt(55, 100, 10)).toBe(5);
    expect(barAt(100, 100, 10)).toBe(9);
    expect(barAt(500, 100, 10)).toBe(9);
  });
  it('returns -1 for an empty or invalid track', () => {
    expect(barAt(10, 0, 10)).toBe(-1);
    expect(barAt(10, 100, 0)).toBe(-1);
  });
});
