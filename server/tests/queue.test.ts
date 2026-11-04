import { describe, expect, it } from 'vitest';
import type { QueueItem } from '@liner/shared';
import {
  PREV_RESTART_THRESHOLD_MS,
  clear,
  createQueue,
  currentItem,
  enqueue,
  indexOfQueueId,
  jump,
  move,
  next,
  play,
  prev,
  remove,
  setRepeat,
  setShuffle,
  upcoming,
  type QueueState,
} from '../src/play/queue.js';

function items(n: number): QueueItem[] {
  return Array.from({ length: n }, (_, i) => ({
    queueId: `q${i}`,
    track: {
      id: `t:${i}`,
      albumId: 'la:x',
      source: 'local' as const,
      title: `Track ${i}`,
      artists: [],
      disc: 1,
      number: i + 1,
      durationMs: 60_000,
    },
    album: { id: 'la:x', title: 'Album' },
  }));
}

function ids(q: QueueState): string[] {
  return q.items.map((it) => it.queueId);
}

function orderIds(q: QueueState): string[] {
  return q.order.map((i) => q.items[i]!.queueId);
}

/** Deterministic rng for shuffle assertions. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('queue basics', () => {
  it('starts empty', () => {
    const q = createQueue();
    expect(q).toEqual({ items: [], index: -1, shuffle: false, repeat: 'off', order: [] });
    expect(currentItem(q)).toBeUndefined();
  });

  it('play sets the queue and start index', () => {
    const q = play(createQueue(), items(4), 2);
    expect(q.index).toBe(2);
    expect(currentItem(q)?.queueId).toBe('q2');
    expect(orderIds(q)).toEqual(['q0', 'q1', 'q2', 'q3']);
  });

  it('play clamps the start index', () => {
    expect(play(createQueue(), items(3), 99).index).toBe(2);
    expect(play(createQueue(), items(3), -5).index).toBe(0);
  });

  it('play with no items empties the queue', () => {
    const q = play(play(createQueue(), items(2), 1), [], 0);
    expect(q.items).toEqual([]);
    expect(q.index).toBe(-1);
    expect(q.order).toEqual([]);
  });

  it('jump changes index and ignores invalid indexes', () => {
    const q = play(createQueue(), items(3), 0);
    expect(jump(q, 2).index).toBe(2);
    expect(jump(q, 2).index).toBe(2);
    expect(jump(q, 3)).toBe(q);
    expect(jump(q, -1)).toBe(q);
  });
});

describe('enqueue', () => {
  it('appends items by default', () => {
    const q = play(enqueue(createQueue(), items(2)), items(2), 0);
    const extra = items(2).map((it, i) => ({ ...it, queueId: `x${i}` }));
    const next = enqueue(q, extra);
    expect(ids(next)).toEqual(['q0', 'q1', 'x0', 'x1']);
    expect(orderIds(next)).toEqual(['q0', 'q1', 'x0', 'x1']);
    expect(next.index).toBe(0);
  });

  it('enqueues next right after the current track', () => {
    const q = play(createQueue(), items(3), 1);
    const extra = items(1).map((it) => ({ ...it, queueId: 'nx' }));
    const next = enqueue(q, extra, { next: true });
    expect(ids(next)).toEqual(['q0', 'q1', 'nx', 'q2']);
    expect(orderIds(next)).toEqual(['q0', 'q1', 'nx', 'q2']);
    expect(next.index).toBe(1);
    expect(currentItem(next)?.queueId).toBe('q1');
  });

  it('enqueues next after the current track in shuffled playback order', () => {
    const q = setShuffle(play(createQueue(), items(4), 2), true, seeded(7));
    const before = orderIds(q);
    const pos = q.order.indexOf(q.index);
    const extra = items(1).map((it) => ({ ...it, queueId: 'nx' }));
    const next = enqueue(q, extra, { next: true });
    // nx is inserted at playback position right after the current track.
    expect(next.order[next.order.indexOf(next.index) + 1]).toBe(3); // canonical index of nx
    expect(orderIds(next)[pos + 1]).toBe('nx');
    // Everything that played before the current track keeps its order.
    expect(orderIds(next).slice(0, pos)).toEqual(before.slice(0, pos));
  });

  it('enqueue into an empty queue starts at the first added item', () => {
    const q = enqueue(createQueue(), items(2));
    expect(q.index).toBe(0);
    expect(ids(q)).toEqual(['q0', 'q1']);
  });
});

describe('remove', () => {
  it('removes a non-current item and keeps the current track current', () => {
    const q = play(createQueue(), items(4), 2);
    const next = remove(q, 'q0');
    expect(ids(next)).toEqual(['q1', 'q2', 'q3']);
    expect(currentItem(next)?.queueId).toBe('q2');
    expect(orderIds(next)).toEqual(['q1', 'q2', 'q3']);
  });

  it('removes an item after the current track without changing the index', () => {
    const q = play(createQueue(), items(4), 1);
    const next = remove(q, 'q3');
    expect(next.index).toBe(1);
    expect(ids(next)).toEqual(['q0', 'q1', 'q2']);
  });

  it('removing the current track advances to the next in playback order', () => {
    const q = play(createQueue(), items(4), 1);
    const next = remove(q, 'q1');
    expect(ids(next)).toEqual(['q0', 'q2', 'q3']);
    expect(currentItem(next)?.queueId).toBe('q2');
  });

  it('removing the last current track wraps to the first', () => {
    const q = play(createQueue(), items(3), 2);
    const next = remove(q, 'q2');
    expect(currentItem(next)?.queueId).toBe('q0');
    expect(next.index).toBe(0);
  });

  it('removing the current track in shuffled order advances along the shuffled order', () => {
    const q = play(createQueue(), items(4), 0);
    const shuffled = setShuffle(q, true, seeded(3));
    const order = orderIds(shuffled);
    const currentPos = order.indexOf(currentItem(shuffled)!.queueId);
    const successorId = order[(currentPos + 1) % order.length]!;
    const next = remove(shuffled, currentItem(shuffled)!.queueId);
    expect(currentItem(next)?.queueId).toBe(successorId);
  });

  it('removing the only item empties the queue', () => {
    const q = play(createQueue(), items(1), 0);
    const next = remove(q, 'q0');
    expect(next.items).toEqual([]);
    expect(next.index).toBe(-1);
    expect(next.order).toEqual([]);
  });

  it('ignores unknown queue ids', () => {
    const q = play(createQueue(), items(2), 0);
    expect(remove(q, 'nope')).toBe(q);
  });

  it('finds queue ids', () => {
    const q = play(createQueue(), items(3), 0);
    expect(indexOfQueueId(q, 'q2')).toBe(2);
    expect(indexOfQueueId(q, 'nope')).toBe(-1);
  });
});

describe('move', () => {
  it('moves an item down past the current track and keeps it current', () => {
    const q = play(createQueue(), items(4), 1); // current q1
    const next = move(q, 'q0', 2);
    expect(ids(next)).toEqual(['q1', 'q2', 'q0', 'q3']);
    expect(currentItem(next)?.queueId).toBe('q1');
    expect(next.index).toBe(0);
    expect(orderIds(next)).toEqual(ids(next)); // shuffle off: identity order
  });

  it('moves an item up across the current track and adjusts the index', () => {
    const q = play(createQueue(), items(4), 2); // current q2
    const next = move(q, 'q0', 3);
    expect(ids(next)).toEqual(['q1', 'q2', 'q3', 'q0']);
    expect(currentItem(next)?.queueId).toBe('q2');
    expect(next.index).toBe(1);
  });

  it('moves an item from after the current track to before it', () => {
    const q = play(createQueue(), items(4), 1); // current q1
    const next = move(q, 'q3', 0);
    expect(ids(next)).toEqual(['q3', 'q0', 'q1', 'q2']);
    expect(currentItem(next)?.queueId).toBe('q1');
    expect(next.index).toBe(2);
  });

  it('moves the playing track itself and keeps it current', () => {
    const q = play(createQueue(), items(4), 1); // current q1
    const next = move(q, 'q1', 3);
    expect(ids(next)).toEqual(['q0', 'q2', 'q3', 'q1']);
    expect(currentItem(next)?.queueId).toBe('q1');
    expect(next.index).toBe(3);
  });

  it('clamps toIndex at both ends', () => {
    const q = play(createQueue(), items(3), 0);
    const end = move(q, 'q0', 99);
    expect(ids(end)).toEqual(['q1', 'q2', 'q0']);
    expect(end.index).toBe(2);
    expect(currentItem(end)?.queueId).toBe('q0');
    const start = move(q, 'q2', -4);
    expect(ids(start)).toEqual(['q2', 'q0', 'q1']);
    expect(start.index).toBe(1);
  });

  it('is a no-op when the item is already at that index', () => {
    const q = play(createQueue(), items(3), 1);
    expect(move(q, 'q1', 1)).toBe(q);
  });

  it('throws a clear error for an unknown queue id', () => {
    const q = play(createQueue(), items(2), 0);
    expect(() => move(q, 'nope', 0)).toThrow(/unknown queue item nope/);
  });

  it('keeps the shuffled playback sequence and the current track', () => {
    const q = setShuffle(play(createQueue(), items(5), 2), true, seeded(9));
    const before = orderIds(q);
    const next = move(q, 'q0', 4);
    expect(ids(next)).toEqual(['q1', 'q2', 'q3', 'q4', 'q0']);
    expect(currentItem(next)?.queueId).toBe('q2');
    expect(next.index).toBe(1);
    // The playback sequence is still the same entries in the same play order.
    expect(orderIds(next)).toEqual(before);
    expect(new Set(next.order)).toEqual(new Set([0, 1, 2, 3, 4]));
  });
});

describe('clear', () => {
  it('empties the queue and keeps shuffle/repeat settings', () => {
    const q = setRepeat(setShuffle(play(createQueue(), items(3), 1), true, seeded(1)), 'all');
    const next = clear(q);
    expect(next.items).toEqual([]);
    expect(next.index).toBe(-1);
    expect(next.order).toEqual([]);
    expect(next.shuffle).toBe(true);
    expect(next.repeat).toBe('all');
  });
});

describe('next / prev', () => {
  it('next moves forward through the order', () => {
    const r = next(play(createQueue(), items(3), 0));
    expect(r.ended).toBe(false);
    expect(r.state.index).toBe(1);
  });

  it('next at the end stops when repeat is off', () => {
    const r = next(play(createQueue(), items(3), 2));
    expect(r.ended).toBe(true);
    expect(r.state.index).toBe(2);
  });

  it('next wraps with repeat all', () => {
    const q = setRepeat(play(createQueue(), items(3), 2), 'all');
    const r = next(q);
    expect(r.ended).toBe(false);
    expect(r.state.index).toBe(0);
  });

  it('next on an empty queue ends', () => {
    expect(next(createQueue()).ended).toBe(true);
  });

  it('automatic next repeats with repeat one, manual next moves on', () => {
    const q = setRepeat(play(createQueue(), items(3), 1), 'one');
    const auto = next(q, { auto: true });
    expect(auto.ended).toBe(false);
    expect(auto.state.index).toBe(1);
    expect(next(q, { auto: false }).state.index).toBe(2);
  });

  it('next follows shuffled order', () => {
    const q = setShuffle(play(createQueue(), items(5), 0), true, seeded(11));
    const first = orderIds(q);
    let cur = q;
    const seen: string[] = [currentItem(cur)!.queueId];
    for (let i = 0; i < 4; i++) {
      cur = next(cur).state;
      seen.push(currentItem(cur)!.queueId);
    }
    expect(seen).toEqual(first);
  });

  it('prev restarts the current track after 3 seconds', () => {
    const q = play(createQueue(), items(3), 1);
    const r = prev(q, PREV_RESTART_THRESHOLD_MS + 1);
    expect(r.restart).toBe(true);
    expect(r.state.index).toBe(1);
  });

  it('prev moves back before 3 seconds', () => {
    const q = play(createQueue(), items(3), 2);
    const r = prev(q, 500);
    expect(r.restart).toBe(false);
    expect(r.state.index).toBe(1);
  });

  it('prev at the first track restarts it', () => {
    const r = prev(play(createQueue(), items(3), 0), 500);
    expect(r.restart).toBe(true);
    expect(r.state.index).toBe(0);
  });

  it('prev at the first track wraps to the last with repeat all', () => {
    const q = setRepeat(play(createQueue(), items(3), 0), 'all');
    const r = prev(q, 500);
    expect(r.restart).toBe(false);
    expect(r.state.index).toBe(2);
  });

  it('prev on an empty queue ends', () => {
    expect(prev(createQueue(), 0).ended).toBe(true);
  });
});

describe('shuffle / repeat', () => {
  it('shuffle keeps the current track and shuffles the rest', () => {
    const q = play(createQueue(), items(6), 3);
    const shuffled = setShuffle(q, true, seeded(1));
    expect(shuffled.shuffle).toBe(true);
    expect(shuffled.index).toBe(3);
    expect(new Set(orderIds(shuffled))).toEqual(new Set(ids(q)));
    expect(orderIds(shuffled)[0]).toBe('q3');
    expect(orderIds(shuffled)).not.toEqual(orderIds(q));
  });

  it('unshuffle restores the original order and keeps the current track', () => {
    const q = play(createQueue(), items(6), 4);
    const shuffled = setShuffle(q, true, seeded(2));
    const restored = setShuffle(shuffled, false);
    expect(restored.shuffle).toBe(false);
    expect(restored.index).toBe(4);
    expect(currentItem(restored)?.queueId).toBe('q4');
    expect(orderIds(restored)).toEqual(ids(restored));
    expect(orderIds(restored)).toEqual(['q0', 'q1', 'q2', 'q3', 'q4', 'q5']);
  });

  it('shuffle works for a single item and an empty queue', () => {
    const one = setShuffle(play(createQueue(), items(1), 0), true, seeded(1));
    expect(orderIds(one)).toEqual(['q0']);
    const empty = setShuffle(createQueue(), true);
    expect(empty.order).toEqual([]);
    expect(empty.index).toBe(-1);
  });

  it('repeat modes are stored', () => {
    const q = setRepeat(createQueue(), 'all');
    expect(q.repeat).toBe('all');
    expect(setRepeat(q, 'all')).toBe(q);
    expect(setRepeat(q, 'one').repeat).toBe('one');
  });
});

describe('upcoming window', () => {
  it('lists the next entries in queue order', () => {
    const q = play(createQueue(), items(5), 1);
    expect(upcoming(q, 3).map((e) => e.item.queueId)).toEqual(['q2', 'q3', 'q4']);
  });

  it('stops at the end with repeat off', () => {
    const q = play(createQueue(), items(3), 1);
    expect(upcoming(q, 5).map((e) => e.item.queueId)).toEqual(['q2']);
  });

  it('wraps with repeat all', () => {
    const q = setRepeat(play(createQueue(), items(3), 2), 'all');
    expect(upcoming(q, 4).map((e) => e.item.queueId)).toEqual(['q0', 'q1', 'q2', 'q0']);
  });

  it('repeats the current item with repeat one', () => {
    const q = setRepeat(play(createQueue(), items(3), 1), 'one');
    expect(upcoming(q, 2).map((e) => e.item.queueId)).toEqual(['q1', 'q1']);
    expect(upcoming(q, 2).map((e) => e.queueIndex)).toEqual([1, 1]);
  });

  it('follows shuffled order', () => {
    const q = setShuffle(play(createQueue(), items(5), 2), true, seeded(5));
    const order = orderIds(q);
    const pos = order.indexOf('q2');
    expect(upcoming(q, 2).map((e) => e.item.queueId)).toEqual(order.slice(pos + 1, pos + 3));
  });

  it('is empty for an empty queue or zero count', () => {
    expect(upcoming(createQueue(), 2)).toEqual([]);
    expect(upcoming(play(createQueue(), items(3), 0), 0)).toEqual([]);
  });
});
