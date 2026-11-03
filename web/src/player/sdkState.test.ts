import { describe, expect, it } from 'vitest';
import {
  detectEnded,
  extrapolate,
  shouldReport,
  spotifyIdOf,
  type ReportState,
  type Snap,
} from './sdkState';

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

const report = (o: Partial<ReportState> = {}): ReportState => ({
  active: true,
  trackId: 'abc',
  playing: true,
  positionMs: 10_000,
  shuffle: false,
  repeat: 0,
  volume: 0.7,
  at: 100_000,
  ...o,
});

describe('shouldReport', () => {
  it('always reports the first state', () => {
    expect(shouldReport(null, report(), 100_000)).toBe(true);
  });

  it('stays quiet for an unchanged, on-time state', () => {
    expect(shouldReport(report(), report({ positionMs: 12_000 }), 102_000)).toBe(false);
  });

  it('reports any visible change', () => {
    const now = 101_000;
    expect(shouldReport(report(), report({ trackId: 'next' }), now)).toBe(true);
    expect(shouldReport(report(), report({ playing: false }), now)).toBe(true);
    expect(shouldReport(report(), report({ shuffle: true }), now)).toBe(true);
    expect(shouldReport(report(), report({ repeat: 2 }), now)).toBe(true);
    expect(shouldReport(report(), report({ volume: 0.5 }), now)).toBe(true);
    expect(shouldReport(report(), report({ active: false }), now)).toBe(true);
  });

  it('reports a seek, i.e. a position far from the extrapolated one', () => {
    const prev = report({ positionMs: 10_000, at: 100_000 });
    // 2 s later, 2 s of playback expected: a 3 s jump is a seek...
    expect(shouldReport(prev, report({ positionMs: 15_100 }), 102_000)).toBe(true);
    // ...but ordinary clock skew is not.
    expect(shouldReport(prev, report({ positionMs: 15_000 }), 102_000)).toBe(false);
  });

  it('does not extrapolate while paused', () => {
    const prev = report({ playing: false, positionMs: 10_000, at: 100_000 });
    expect(shouldReport(prev, report({ playing: false, positionMs: 10_000 }), 110_000)).toBe(false);
    expect(shouldReport(prev, report({ playing: false, positionMs: 14_000 }), 110_000)).toBe(true);
  });

  it('sends a heartbeat after 15 s however small the change', () => {
    const prev = report({ positionMs: 10_000, at: 100_000 });
    expect(shouldReport(prev, report({ positionMs: 24_999 }), 114_999)).toBe(false);
    expect(shouldReport(prev, report({ positionMs: 25_000 }), 115_000)).toBe(true);
  });
});
