import { describe, expect, it } from 'vitest';
import { detectEnded, extrapolate, spotifyIdOf, type Snap } from './sdkState';

const snap = (o: Partial<Snap>): Snap => ({ id: 'abc', positionMs: 0, durationMs: 200_000, playing: true, at: 1_000_000, previousIds: [], ...o });

describe('detectEnded', () => {
  it('fires when the same track is paused at 0 after playing to its end', () => {
    const prev = snap({ positionMs: 196_000, at: 1_000_000 });
    expect(detectEnded(prev, snap({ playing: false, positionMs: 0, at: 1_005_000, previousIds: ['abc'] }))).toBe(true);
  });
  it('uses extrapolation (events can be late)', () => {
    const prev = snap({ positionMs: 150_000, at: 1_000_000 });
    expect(detectEnded(prev, snap({ playing: false, positionMs: 0, at: 1_051_000 }))).toBe(true);
  });
  it('does not fire when the user pauses early or seeks to 0', () => {
    const prev = snap({ positionMs: 30_000, at: 1_000_000 });
    expect(detectEnded(prev, snap({ playing: false, positionMs: 0, at: 1_001_000 }))).toBe(false);
    expect(detectEnded(prev, snap({ playing: true, positionMs: 0, at: 1_001_000 }))).toBe(false);
  });
  it('does not fire for a different track or when previously paused', () => {
    expect(detectEnded(snap({ id: 'x', positionMs: 199_000 }), snap({ playing: false, positionMs: 0, at: 1_002_000 }))).toBe(false);
    expect(detectEnded(snap({ playing: false, positionMs: 199_000 }), snap({ playing: false, positionMs: 0, at: 1_002_000 }))).toBe(false);
    expect(detectEnded(null, snap({ playing: false }))).toBe(false);
  });
  it('does not fire if it is still positioned in the track', () => {
    expect(detectEnded(snap({ positionMs: 199_000 }), snap({ playing: false, positionMs: 60_000, at: 1_002_000 }))).toBe(false);
  });
});

describe('helpers', () => {
  it('extrapolates only while playing and clamps to the duration', () => {
    expect(extrapolate(snap({ positionMs: 10_000, at: 1000 }), 4000)).toBe(13_000);
    expect(extrapolate(snap({ positionMs: 10_000, at: 1000, playing: false }), 4000)).toBe(10_000);
    expect(extrapolate(snap({ positionMs: 199_000, at: 1000 }), 9000)).toBe(200_000);
  });
  it('strips the sp: prefix', () => {
    expect(spotifyIdOf('sp:4uLU6hMCjMI75M1A2tKUQC')).toBe('4uLU6hMCjMI75M1A2tKUQC');
    expect(spotifyIdOf('4uLU')).toBe('4uLU');
  });
});
