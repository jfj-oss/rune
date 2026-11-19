// What the server queue saves of itself (a list of ids, the cursor, the modes) and how it is read back. The row format
// is the one the PC zone has always written, so an older build can still read what a newer one saved.
import type { PlayerState, QueueItem } from '@liner/shared';
import * as Q from './queue.js';

/** The old PC zone session row (read once, to start the server queue from it; never written any more). */
export const SESSION_KEY = 'player.pc.session';
const SESSION_VERSION = 1;
/** A corrupt row claiming a million entries must not stall startup. */
const MAX_SAVED_QUEUE = 20_000;

export interface SavedQueueEntry {
  queueId: string;
  trackId: string;
}

export interface SavedSession {
  v: typeof SESSION_VERSION;
  queue: SavedQueueEntry[];
  index: number;
  positionMs: number;
  shuffle: boolean;
  repeat: PlayerState['repeat'];
  order: number[];
  volume: number;
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const REPEAT_MODES = new Set<PlayerState['repeat']>(['off', 'one', 'all']);

function isId(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/**
 * Validate a row read back from app_state. Anything unexpected (old schema,
 * hand-edited JSON, a half-written value) is rejected so startup falls back to
 * an empty zone instead of crashing on it.
 */
export function parseSavedSession(value: unknown): SavedSession | undefined {
  if (!isStringRecord(value) || value.v !== SESSION_VERSION) return undefined;
  const rawQueue = value.queue;
  if (!Array.isArray(rawQueue) || rawQueue.length > MAX_SAVED_QUEUE) return undefined;
  const queue: SavedQueueEntry[] = [];
  for (const entry of rawQueue) {
    if (!isStringRecord(entry)) return undefined;
    if (!isId(entry.queueId, 200) || !isId(entry.trackId, 300)) return undefined;
    queue.push({ queueId: entry.queueId, trackId: entry.trackId });
  }

  const index = value.index;
  // -1 means "no current track"; an empty queue may only be -1.
  if (!Number.isInteger(index) || (index as number) < -1 || (index as number) >= Math.max(queue.length, 1)) {
    return undefined;
  }
  const positionMs = value.positionMs;
  if (typeof positionMs !== 'number' || !Number.isFinite(positionMs) || positionMs < 0) {
    return undefined;
  }
  const volume = value.volume;
  if (typeof volume !== 'number' || !Number.isFinite(volume)) return undefined;
  if (typeof value.shuffle !== 'boolean') return undefined;
  const repeat = value.repeat;
  if (typeof repeat !== 'string' || !REPEAT_MODES.has(repeat as PlayerState['repeat'])) {
    return undefined;
  }
  const rawOrder = value.order;
  if (!Array.isArray(rawOrder) || rawOrder.length > queue.length) return undefined;
  const order: number[] = [];
  for (const n of rawOrder) {
    if (!Number.isInteger(n) || n < 0 || n >= queue.length) return undefined;
    order.push(n as number);
  }
  // A shuffled session must describe a full playback order; otherwise keep the
  // queue and fall back to identity order rather than trusting a partial one.
  if (value.shuffle && queue.length > 0) {
    if (order.length !== queue.length || new Set(order).size !== order.length) return undefined;
  }

  return {
    v: SESSION_VERSION,
    queue,
    index: index as number,
    positionMs,
    shuffle: value.shuffle,
    repeat: repeat as PlayerState['repeat'],
    order,
    volume,
  };
}


/**
 * Line saved entries up with the items that still exist (load drops vanished local songs and keeps the order), so
 * queue ids, the current song and a shuffled order survive.
 */
export function restoreQueue(session: SavedSession, items: QueueItem[]): { q: Q.QueueState; positionMs: number } {
  const kept: number[] = [];
  let cursor = 0;
  for (let i = 0; i < session.queue.length && cursor < items.length; i++) {
    if (items[cursor]!.track.id === session.queue[i]!.trackId) {
      kept.push(i);
      cursor += 1;
    }
  }
  if (kept.length !== items.length) return { q: Q.createQueue(), positionMs: 0 };
  const oldToNew = new Map<number, number>();
  kept.forEach((oldPos, newPos) => oldToNew.set(oldPos, newPos));
  const queue = items.map((item, newPos) => ({ ...item, queueId: session.queue[kept[newPos]!]!.queueId }));
  let index = -1;
  let positionMs = 0;
  if (queue.length > 0) {
    const exact = oldToNew.get(session.index);
    if (exact !== undefined) {
      index = exact;
      positionMs = session.positionMs;
    } else {
      const after = kept.find((oldPos) => oldPos >= session.index);
      index = oldToNew.get(after ?? kept.at(-1)!) ?? -1;
    }
  }
  const cur = index >= 0 ? queue[index] : undefined;
  if (cur && cur.track.durationMs > 0) {
    positionMs = Math.min(cur.track.durationMs, Math.max(0, positionMs));
    if (positionMs >= cur.track.durationMs - 100) positionMs = 0;
  } else if (!cur) positionMs = 0;
  let items2 = queue;
  if (session.shuffle) {
    // An older build kept the queue as it was added and the shuffled play order on the side: bring the queue itself
    // into play order (identity orders, which is all that is written now, change nothing).
    const order: number[] = [];
    const seen = new Set<number>();
    for (const oldPos of session.order) {
      const n = oldToNew.get(oldPos);
      if (n !== undefined && !seen.has(n)) {
        seen.add(n);
        order.push(n);
      }
    }
    for (let i = 0; i < queue.length; i++) if (!seen.has(i)) order.push(i);
    items2 = order.map((n) => queue[n]!);
    index = cur ? items2.findIndex((q) => q.queueId === cur.queueId) : -1;
  }
  return { q: { items: items2, index, shuffle: session.shuffle, repeat: session.repeat }, positionMs };
}

