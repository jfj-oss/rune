// Pure queue logic for the PC zone. No I/O: everything here is a value-in/value-out
// transformation over QueueItem[] so it can be unit-tested without mpv or a database.
import type { PlayerState, QueueItem } from '@liner/shared';

export type RepeatMode = PlayerState['repeat'];

export interface QueueState {
  /** Canonical queue order (the order the queue is shown in). */
  items: QueueItem[];
  /** Index into `items` of the current track, -1 when the queue is empty. */
  index: number;
  shuffle: boolean;
  repeat: RepeatMode;
  /** Playback order as indices into `items`. Identity order when shuffle is off. */
  order: number[];
}

export interface UpcomingEntry {
  item: QueueItem;
  /** Index into QueueState.items. */
  queueIndex: number;
}

export interface NextResult {
  state: QueueState;
  /** True when playback ran past the end of the queue (repeat off). */
  ended: boolean;
}

export interface PrevResult {
  state: QueueState;
  /** True when prev should restart the current track instead of changing track. */
  restart: boolean;
  ended: boolean;
}

/** Prev restarts the current track when more than this much has played. */
export const PREV_RESTART_THRESHOLD_MS = 3000;

export function createQueue(): QueueState {
  return { items: [], index: -1, shuffle: false, repeat: 'off', order: [] };
}

function identityOrder(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** In-place Fisher-Yates. */
function shuffleInPlace<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
}

export function currentItem(q: QueueState): QueueItem | undefined {
  if (q.index < 0 || q.index >= q.items.length) return undefined;
  return q.items[q.index];
}

/** Index in `items` of the first entry with the given queueId, or -1. */
export function indexOfQueueId(q: QueueState, queueId: string): number {
  return q.items.findIndex((it) => it.queueId === queueId);
}

/** Replace the queue contents and start at `startIndex`. */
export function play(
  q: QueueState,
  items: QueueItem[],
  startIndex = 0,
  rng: () => number = Math.random,
): QueueState {
  if (items.length === 0) {
    return { ...q, items: [], index: -1, order: [] };
  }
  const index = clamp(Math.trunc(startIndex), 0, items.length - 1);
  if (q.shuffle) {
    const rest = identityOrder(items.length).filter((i) => i !== index);
    shuffleInPlace(rest, rng);
    return { ...q, items: [...items], index, order: [index, ...rest] };
  }
  return { ...q, items: [...items], index, order: identityOrder(items.length) };
}

/**
 * Add items to the queue. `next` inserts them directly after the current track
 * (play next); otherwise they are appended. Enqueueing into an empty queue starts
 * at the first added item.
 */
export function enqueue(
  q: QueueState,
  items: QueueItem[],
  opts: { next?: boolean } = {},
  rng: () => number = Math.random,
): QueueState {
  if (items.length === 0) return q;
  if (q.items.length === 0 || q.index < 0) return play(q, items, 0, rng);

  if (opts.next) {
    const insertAt = q.index + 1;
    const newItems = [
      ...q.items.slice(0, insertAt),
      ...items,
      ...q.items.slice(insertAt),
    ];
    const orderPos = q.order.indexOf(q.index);
    const anchor = orderPos >= 0 ? orderPos : q.order.length - 1;
    const shifted = q.order.map((i) => (i >= insertAt ? i + items.length : i));
    const newIndices = items.map((_, k) => insertAt + k);
    const order = [
      ...shifted.slice(0, anchor + 1),
      ...newIndices,
      ...shifted.slice(anchor + 1),
    ];
    return { ...q, items: newItems, order };
  }

  const newIndices = items.map((_, k) => q.items.length + k);
  return {
    ...q,
    items: [...q.items, ...items],
    order: [...q.order, ...newIndices],
  };
}

/** Make the item at `index` current. Order is preserved. */
export function jump(q: QueueState, index: number): QueueState {
  if (!Number.isInteger(index) || index < 0 || index >= q.items.length) return q;
  if (index === q.index) return q;
  return { ...q, index };
}

/** Remove a queue entry by queueId. Removing the current track advances to the next in order. */
export function remove(q: QueueState, queueId: string): QueueState {
  const i = q.items.findIndex((it) => it.queueId === queueId);
  if (i < 0) return q;

  const items = q.items.filter((_, k) => k !== i);
  if (items.length === 0) {
    return { ...q, items: [], index: -1, order: [] };
  }
  const remap = (old: number): number => (old > i ? old - 1 : old);
  const oldOrderPos = q.order.indexOf(i);

  let newIndex: number;
  if (q.index === i) {
    // Choose the successor in playback order, wrapping around.
    let successor: number | undefined;
    for (let step = 1; step <= q.order.length; step++) {
      const cand = q.order[(oldOrderPos + step) % q.order.length];
      if (cand !== undefined && cand !== i) {
        successor = cand;
        break;
      }
    }
    newIndex = successor === undefined ? -1 : remap(successor);
  } else {
    newIndex = q.index >= 0 ? remap(q.index) : -1;
  }

  const order = q.order.filter((x) => x !== i).map(remap);
  return { ...q, items, index: newIndex, order };
}

/**
 * Advance. `auto` is true for natural end-of-track advances: repeat 'one' then
 * repeats the current track instead of moving on.
 */
export function next(q: QueueState, opts: { auto?: boolean } = {}): NextResult {
  if (q.items.length === 0 || q.index < 0) return { state: q, ended: true };
  if (opts.auto && q.repeat === 'one') return { state: q, ended: false };

  const p = q.order.indexOf(q.index);
  const nextPos = p + 1;
  if (p >= 0 && nextPos < q.order.length) {
    const idx = q.order[nextPos]!;
    return { state: { ...q, index: idx }, ended: false };
  }
  if (q.repeat === 'all' && q.order.length > 0) {
    return { state: { ...q, index: q.order[0]! }, ended: false };
  }
  return { state: q, ended: true };
}

/** Go back; restarts the current track if more than 3 s have played. */
export function prev(q: QueueState, positionMs: number): PrevResult {
  if (q.items.length === 0 || q.index < 0) {
    return { state: q, restart: false, ended: true };
  }
  if (positionMs > PREV_RESTART_THRESHOLD_MS) {
    return { state: q, restart: true, ended: false };
  }
  const p = q.order.indexOf(q.index);
  if (p > 0) {
    return { state: { ...q, index: q.order[p - 1]! }, restart: false, ended: false };
  }
  if (q.repeat === 'all' && q.order.length > 1) {
    return {
      state: { ...q, index: q.order[q.order.length - 1]! },
      restart: false,
      ended: false,
    };
  }
  // Already at the beginning: restart the current track.
  return { state: q, restart: true, ended: false };
}

/**
 * Turn shuffle on/off. Turning it on keeps the current track playing and shuffles
 * everything else; turning it off restores the original queue order (current track
 * stays current).
 */
export function setShuffle(
  q: QueueState,
  on: boolean,
  rng: () => number = Math.random,
): QueueState {
  if (!on) {
    return { ...q, shuffle: false, order: identityOrder(q.items.length) };
  }
  if (q.items.length === 0) return { ...q, shuffle: true, order: [] };
  const current = q.index >= 0 ? q.index : 0;
  const rest = identityOrder(q.items.length).filter((i) => i !== current);
  shuffleInPlace(rest, rng);
  return { ...q, shuffle: true, index: current, order: [current, ...rest] };
}

export function setRepeat(q: QueueState, mode: RepeatMode): QueueState {
  if (q.repeat === mode) return q;
  return { ...q, repeat: mode };
}

/**
 * The next automatic transitions from the current track, in playback order.
 * Honors shuffle, repeat 'all' (wraps) and repeat 'one' (repeats current).
 */
export function upcoming(q: QueueState, count: number): UpcomingEntry[] {
  if (count <= 0) return [];
  if (q.items.length === 0 || q.index < 0) return [];
  const current = q.items[q.index]!;
  if (q.repeat === 'one') {
    return Array.from({ length: count }, () => ({ item: current, queueIndex: q.index }));
  }

  const out: UpcomingEntry[] = [];
  const p = q.order.indexOf(q.index);
  if (p < 0) return out;
  const n = q.order.length;
  const maxSteps = q.repeat === 'all' ? count + n : n;
  for (let step = 1; out.length < count && step <= maxSteps; step++) {
    let pos = p + step;
    if (pos >= n) {
      if (q.repeat !== 'all') break;
      pos %= n;
    }
    const idx = q.order[pos]!;
    out.push({ item: q.items[idx]!, queueIndex: idx });
  }
  return out;
}
