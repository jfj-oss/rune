import type { HistoryPlayRequest, PlayerState, QueueItem } from '@liner/shared';
import { describe, expect, it } from 'vitest';
import { PlayTracker } from './playTracker';

const item = (n: number, durationMs = 200_000): QueueItem => ({
  queueId: `q${n}`,
  track: { id: `t${n}`, albumId: 'a', source: 'local', title: `T${n}`, artists: [], disc: 1, number: n, durationMs },
  album: { id: 'a', title: 'A' },
});
const state = (over: Partial<PlayerState>, at: number): PlayerState => ({
  zone: 'browser', status: 'playing', queue: [item(1), item(2)], index: 0, positionMs: 0, volume: 70, shuffle: false, repeat: 'off', updatedAt: at, ...over,
});

function setup() {
  const out: HistoryPlayRequest[] = [];
  return { out, t: new PlayTracker((r) => out.push(r)) };
}

describe('PlayTracker', () => {
  it('reports a skipped track with only the time heard', () => {
    const { out, t } = setup();
    t.update(state({}, 1000), 1000);
    t.update(state({ index: 1, positionMs: 0, updatedAt: 41_000 }, 41_000), 41_000);
    expect(out).toEqual([{ trackId: 't1', zone: 'browser', startedAt: 1000, playedMs: 40_000, completed: false }]);
  });

  it('reports completed when the track ran to its end', () => {
    const { out, t } = setup();
    t.update(state({}, 0), 0);
    t.update(state({ index: 1, updatedAt: 200_000 }, 200_000), 200_000);
    expect(out[0]).toMatchObject({ trackId: 't1', playedMs: 200_000, completed: true });
  });

  it('does not count paused time', () => {
    const { out, t } = setup();
    t.update(state({}, 0), 0);
    t.update(state({ status: 'paused', positionMs: 20_000, updatedAt: 20_000 }, 20_000), 20_000);
    t.update(state({ status: 'playing', positionMs: 20_000, updatedAt: 120_000 }, 120_000), 120_000);
    t.update(state({ status: 'stopped', index: 0, updatedAt: 130_000 }, 130_000), 130_000);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ playedMs: 30_000, completed: false });
  });

  it('reports when the zone is left, and ignores blips', () => {
    const { out, t } = setup();
    t.update(state({}, 0), 0);
    t.update(null, 500);
    expect(out).toHaveLength(0);
    t.update(state({}, 1000), 1000);
    t.update(null, 61_000);
    expect(out).toEqual([{ trackId: 't1', zone: 'browser', startedAt: 1000, playedMs: 60_000, completed: false }]);
  });

  it('handles repeat-one restarts as a new listen', () => {
    const { out, t } = setup();
    const q = [item(1, 30_000)];
    t.update(state({ queue: q, repeat: 'one' }, 0), 0);
    t.update(state({ queue: q, repeat: 'one', positionMs: 0, updatedAt: 30_000 }, 30_000), 30_000);
    expect(out).toHaveLength(1);
    expect(out[0]?.completed).toBe(true);
    t.update(null, 45_000);
    expect(out).toHaveLength(2);
  });
});
