// The server queue's saved state: what comes back after a restart (paused, silent), what is dropped, what is refused.
// Pure functions of the saved row (play/session.ts), plus the driver's own save/restore with a fake mpv.
import { describe, expect, it } from 'vitest';
import type { QueueItem } from '@liner/shared';
import { parseSavedSession, restoreQueue, type SavedSession } from '../src/play/session.js';
import { QUEUE_KEY, QueueDriver, type DriverStore } from '../src/play/driver.js';
import { MpvOutput } from '../src/play/outputs.js';
import { FakeRunMpv } from './support/fake-run-mpv.js';

const item = (n: number, dur = 200_000): QueueItem => ({
  queueId: `fresh${n}`,
  track: { id: `l:${n}`, albumId: 'la:a', source: 'local', title: `Track ${n}`, artists: [], disc: 1, number: n, durationMs: dur, path: `/m/${n}.flac` } as QueueItem['track'],
  album: { id: 'la:a', title: 'A' },
});
const session = (over: Partial<SavedSession> = {}): SavedSession => ({
  v: 1,
  queue: [1, 2, 3, 4, 5].map((n) => ({ queueId: `q${n}`, trackId: `l:${n}` })),
  index: 2, positionMs: 42_000, shuffle: false, repeat: 'off', order: [0, 1, 2, 3, 4], volume: 70,
  ...over,
});
const ids = (q: { items: QueueItem[] }) => q.items.map((i) => i.track.id);

describe('restoring a saved queue', () => {
  it('keeps the queue ids, the current song, the position and the modes', () => {
    const { q, positionMs } = restoreQueue(session({ repeat: 'all' }), [1, 2, 3, 4, 5].map((n) => item(n)));
    expect(q.items.map((i) => i.queueId)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5']);
    expect(q.index).toBe(2);
    expect(positionMs).toBe(42_000);
    expect(q.repeat).toBe('all');
  });

  it('drops songs that no longer exist and moves the cursor to the next survivor, from its start', () => {
    const { q, positionMs } = restoreQueue(session(), [2, 4, 5].map((n) => item(n)));
    expect(ids(q)).toEqual(['l:2', 'l:4', 'l:5']);
    expect(q.items.map((i) => i.queueId)).toEqual(['q2', 'q4', 'q5']);
    expect(q.index).toBe(1);
    expect(positionMs).toBe(0);
  });

  it('starts a song that had finished (within 100 ms of its end) over; keeps a position that is not that close', () => {
    const all = [1, 2, 3, 4, 5].map((n) => item(n));
    expect(restoreQueue(session({ positionMs: 199_950 }), all).positionMs).toBe(0);
    expect(restoreQueue(session({ positionMs: 199_800 }), all).positionMs).toBe(199_800);
  });

  it('keeps the saved position of a song whose length is unknown', () => {
    const all = [1, 2, 3, 4, 5].map((n) => item(n, 0));
    expect(restoreQueue(session(), all).positionMs).toBe(42_000);
  });

  it('a queue an older build saved shuffled (original order + play order on the side) comes back in play order', () => {
    // played in the order 3, 1, 5, 2, 4; the current song is 5 (queue position 4)
    const { q } = restoreQueue(session({ shuffle: true, order: [2, 0, 4, 1, 3], index: 4 }), [1, 2, 3, 4, 5].map((n) => item(n)));
    expect(ids(q)).toEqual(['l:3', 'l:1', 'l:5', 'l:2', 'l:4']);
    expect(q.items[q.index]?.track.id).toBe('l:5');
    expect(q.shuffle).toBe(true);
  });
});

describe('reading the saved row', () => {
  it('refuses an old version, garbage and a half-written shuffle', () => {
    expect(parseSavedSession({ v: 0, queue: [], index: -1 })).toBeUndefined();
    expect(parseSavedSession('nope')).toBeUndefined();
    expect(parseSavedSession({ ...session(), shuffle: true, order: [0, 1] })).toBeUndefined();
    expect(parseSavedSession(session())).toMatchObject({ index: 2, volume: 70 });
  });
});

class MemStore implements DriverStore {
  rows = new Map<string, string>();
  read(k: string) { return this.rows.get(k); }
  write(k: string, v: string) { this.rows.set(k, v); }
}

describe('the driver saves and restores its queue', () => {
  const make = (store: DriverStore, mpv = new FakeRunMpv()) => {
    let n = 0;
    return new QueueDriver({
      load: (trackIds) => trackIds.map((id) => ({ ...item(Number(id.slice(2))), queueId: `n${++n}` })),
      outputs: { mpv: new MpvOutput(mpv) },
      store,
    });
  };

  it('writes on close, comes back paused and silent, shuffled queues keep their order', async () => {
    const store = new MemStore();
    const mpv1 = new FakeRunMpv();
    const d1 = make(store, mpv1);
    await d1.command({ type: 'play', trackIds: ['l:1', 'l:2', 'l:3', 'l:4', 'l:5', 'l:6'], startIndex: 2 });
    await d1.command({ type: 'shuffle', on: true });
    await d1.command({ type: 'seek', positionMs: 9_000 });
    await d1.command({ type: 'pause' });
    const before = d1.state();
    await d1.close();
    mpv1.dispose();

    const mpv2 = new FakeRunMpv();
    const d2 = make(store, mpv2);
    const after = d2.state();
    expect(after.status).toBe('paused');
    expect(after.queue.map((q) => q.queueId)).toEqual(before.queue.map((q) => q.queueId));
    expect(after.queue.map((q) => q.track.id)).toEqual(before.queue.map((q) => q.track.id));
    expect(after.index).toBe(before.index);
    expect(after.positionMs).toBe(9_000);
    expect(after.shuffle).toBe(true);
    expect(mpv2.log).toEqual([]); // nothing sounds at boot
    await d2.command({ type: 'resume' });
    expect(mpv2.log[0]).toMatch(/^load l:\d(,l:\d)*@9000$/);
    await d2.close();
    mpv2.dispose();
  });

  it('a corrupt row means an empty queue, not a crash', async () => {
    const store = new MemStore();
    store.write(QUEUE_KEY, '{not json');
    const mpv = new FakeRunMpv();
    const d = make(store, mpv);
    expect(d.state()).toMatchObject({ status: 'stopped', index: -1, queue: [] });
    await d.close();
    mpv.dispose();
  });
});
