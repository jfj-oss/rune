// The one queue. Pure value-in/value-out functions over QueueItem[]: no I/O, no clock. Every zone's queue (the pc
// zone, a browser zone, Soloist) is kept with these, and the browser's mock mode uses them too, so shuffle, repeat
// and queue edits cannot drift apart.
//
// Shuffle is a real reordering: turning it on mixes everything after the current song in place, so the queue as shown
// IS the play order. Turning it off leaves the order as it is. `index` is the current song; next/prev walk `items`.
import type { PlayerState, QueueItem } from './index';

export type RepeatMode = PlayerState['repeat'];

export interface QueueState {
  /** The queue in the order it is shown and played. */
  items: QueueItem[];
  /** Index into `items` of the current track, -1 when the queue is empty. */
  index: number;
  shuffle: boolean;
  repeat: RepeatMode;
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
  return { items: [], index: -1, shuffle: false, repeat: 'off' };
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

/** A mixed copy of `items` with the one at `keep` (if any) first. */
export function shuffled<T>(items: T[], keep: number, rng: () => number = Math.random): T[] {
  const first = keep >= 0 && keep < items.length ? [items[keep]!] : [];
  const rest = items.filter((_, i) => i !== keep);
  shuffleInPlace(rest, rng);
  return [...first, ...rest];
}

export function currentItem(q: QueueState): QueueItem | undefined {
  if (q.index < 0 || q.index >= q.items.length) return undefined;
  return q.items[q.index];
}

/** Index in `items` of the first entry with the given queueId, or -1. */
export function indexOfQueueId(q: QueueState, queueId: string): number {
  return q.items.findIndex((it) => it.queueId === queueId);
}

/**
 * Replace the queue contents and start at `startIndex`. With shuffle on, the chosen song plays first and the rest are
 * mixed; `mixAll` (the Shuffle button) mixes everything, the first song included, and turns shuffle on.
 */
export function play(
  q: QueueState,
  items: QueueItem[],
  startIndex = 0,
  rng: () => number = Math.random,
  mixAll = false,
): QueueState {
  if (items.length === 0) return { ...q, items: [], index: -1 };
  const shuffle = q.shuffle || mixAll;
  if (!shuffle) return { ...q, items: [...items], index: clamp(Math.trunc(startIndex) || 0, 0, items.length - 1) };
  const keep = mixAll ? -1 : clamp(Math.trunc(startIndex) || 0, 0, items.length - 1);
  return { ...q, shuffle: true, items: shuffled(items, keep, rng), index: 0 };
}

/**
 * Add items to the queue. `next` inserts them directly after the current track (play next); otherwise they are
 * appended. Enqueueing into an empty queue starts at the first added item.
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
    const at = q.index + 1;
    return { ...q, items: [...q.items.slice(0, at), ...items, ...q.items.slice(at)] };
  }
  return { ...q, items: [...q.items, ...items] };
}

/** Make the item at `index` current. */
export function jump(q: QueueState, index: number): QueueState {
  if (!Number.isInteger(index) || index < 0 || index >= q.items.length) return q;
  if (index === q.index) return q;
  return { ...q, index };
}

/** Remove a queue entry by queueId. Removing the current track moves on to the one after it (the new last one when it was last). */
export function remove(q: QueueState, queueId: string): QueueState {
  const i = q.items.findIndex((it) => it.queueId === queueId);
  if (i < 0) return q;
  const items = q.items.filter((_, k) => k !== i);
  if (items.length === 0) return { ...q, items: [], index: -1 };
  let index = q.index;
  if (i < q.index) index = q.index - 1;
  else if (i === q.index) index = Math.min(i, items.length - 1);
  return { ...q, items, index };
}

/**
 * Reorder the queue: the entry with `queueId` moves to `toIndex` (clamped to the ends). The current track stays
 * current wherever it lands. Throws for an unknown queueId so the API can report a useful error.
 */
export function move(q: QueueState, queueId: string, toIndex: number): QueueState {
  const from = q.items.findIndex((it) => it.queueId === queueId);
  if (from < 0) throw new Error(`unknown queue item ${queueId}`);
  const requested = Number.isFinite(toIndex) ? Math.trunc(toIndex) : from;
  const to = clamp(requested, 0, q.items.length - 1);
  if (from === to) return q;
  const items = q.items.slice();
  const [moved] = items.splice(from, 1);
  items.splice(to, 0, moved!);
  const cur = q.index >= 0 ? q.items[q.index]?.queueId : undefined;
  const index = cur === undefined ? q.index : items.findIndex((it) => it.queueId === cur);
  return { ...q, items, index };
}

/** Empty the queue. Shuffle/repeat settings stay as they are. */
export function clear(q: QueueState): QueueState {
  return { ...q, items: [], index: -1 };
}

/** Advance. `auto` is true for natural end-of-track advances: repeat 'one' then repeats the current track. */
export function next(q: QueueState, opts: { auto?: boolean } = {}): NextResult {
  if (q.items.length === 0 || q.index < 0) return { state: q, ended: true };
  if (opts.auto && q.repeat === 'one') return { state: q, ended: false };
  if (q.index + 1 < q.items.length) return { state: { ...q, index: q.index + 1 }, ended: false };
  if (q.repeat === 'all') return { state: { ...q, index: 0 }, ended: false };
  return { state: q, ended: true };
}

/** Go back; restarts the current track if more than 3 s have played, unless `force` (always the previous song). */
export function prev(q: QueueState, positionMs: number, force = false): PrevResult {
  if (q.items.length === 0 || q.index < 0) return { state: q, restart: false, ended: true };
  if (!force && positionMs > PREV_RESTART_THRESHOLD_MS) return { state: q, restart: true, ended: false };
  if (q.index > 0) return { state: { ...q, index: q.index - 1 }, restart: false, ended: false };
  if (q.repeat === 'all' && q.items.length > 1) return { state: { ...q, index: q.items.length - 1 }, restart: false, ended: false };
  // Already at the beginning: restart the current track.
  return { state: q, restart: true, ended: false };
}

/** Turn shuffle on/off. On: the current track keeps playing and everything after it is mixed. Off: the order stays. */
export function setShuffle(q: QueueState, on: boolean, rng: () => number = Math.random): QueueState {
  if (!on || q.items.length === 0) return { ...q, shuffle: on };
  const head = q.items.slice(0, q.index + 1);
  const tail = q.items.slice(q.index + 1);
  shuffleInPlace(tail, rng);
  return { ...q, shuffle: true, items: [...head, ...tail] };
}

export function setRepeat(q: QueueState, mode: RepeatMode): QueueState {
  if (q.repeat === mode) return q;
  return { ...q, repeat: mode };
}

/**
 * The next automatic transitions from the current track, in playback order. Honors repeat 'all' (wraps) and repeat
 * 'one' (repeats current).
 */
export function upcoming(q: QueueState, count: number): UpcomingEntry[] {
  if (count <= 0 || q.items.length === 0 || q.index < 0) return [];
  const current = q.items[q.index]!;
  if (q.repeat === 'one') return Array.from({ length: count }, () => ({ item: current, queueIndex: q.index }));
  const out: UpcomingEntry[] = [];
  const n = q.items.length;
  const maxSteps = q.repeat === 'all' ? count + n : n;
  for (let step = 1; out.length < count && step <= maxSteps; step++) {
    let pos = q.index + step;
    if (pos >= n) {
      if (q.repeat !== 'all') break;
      pos %= n;
    }
    out.push({ item: q.items[pos]!, queueIndex: pos });
  }
  return out;
}
