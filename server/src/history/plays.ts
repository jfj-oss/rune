// Turns a stream of PlayerState snapshots into counted plays.
//
// Counting rule (last.fm-style): a listen counts when at least 30 s or at least
// 50% of the track was actually heard, whichever is smaller:
//   threshold = durationMs > 0 ? min(30_000, durationMs / 2) : 30_000
//
// "Heard" is accumulated from positive position deltas while `playing`, capped
// by the wall-clock time between snapshots (+ tolerance) so a forward seek
// cannot manufacture listening time. Seeks backwards simply contribute 0.
// Pauses keep the same play alive (the position does not advance while paused);
// a pause longer than `pauseSplitMs` ends it, and the resume starts a new one.
// Repeat-one/one-track-repeat wraps are detected when the position jumps from
// the end back to the start and produce a separate play for each loop.
import type { PlayerState, QueueItem } from '@liner/shared';

export interface RecordedPlay {
  trackId: string;
  albumId: string;
  zone: string;
  /** Epoch ms, estimated when the listen began. */
  startedAt: number;
  /** Estimated listened duration (not final position). */
  playedMs: number;
  /** True when the track reached its end. */
  completed: boolean;
}

export interface PlayCounterOptions {
  /** Pausing longer than this ends the play. Default 5 minutes. */
  pauseSplitMs?: number;
  /** Position jumps up to wall-clock elapsed + this are treated as playback. */
  seekToleranceMs?: number;
  /** How close to duration counts as "reached the end". */
  endSlackMs?: number;
}

const DEFAULT_PAUSE_SPLIT_MS = 5 * 60_000;
const DEFAULT_SEEK_TOLERANCE_MS = 2_000;
const DEFAULT_END_SLACK_MS = 2_000;
const MIN_PLAY_MS = 30_000;

interface ActivePlay {
  trackId: string;
  albumId: string;
  queueId: string;
  durationMs: number;
  startedAt: number;
  heardMs: number;
  /** Wall-clock time of the pause that may split this play. */
  pausedAt?: number;
  /** True once a long pause has closed this play; the current segment is new. */
  splitDone?: boolean;
}

interface ZoneState {
  /** Last state we processed for this zone (not necessarily the caller's `prev`). */
  last: PlayerState;
  active: ActivePlay | null;
}

function cloneState(s: PlayerState): PlayerState {
  return { ...s, queue: s.queue.slice() };
}

function itemAt(s: PlayerState): QueueItem | undefined {
  if (s.index < 0 || s.index >= s.queue.length) return undefined;
  return s.queue[s.index];
}

function durationOf(item: QueueItem | undefined): number {
  const d = item?.track.durationMs ?? 0;
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/** Minimum listened ms for a play to count. */
export function playThreshold(durationMs: number): number {
  return durationMs > 0 ? Math.min(MIN_PLAY_MS, durationMs / 2) : MIN_PLAY_MS;
}

export class PlayCounter {
  private readonly zones = new Map<string, ZoneState>();
  private readonly pauseSplitMs: number;
  private readonly seekToleranceMs: number;
  private readonly endSlackMs: number;

  constructor(
    private readonly sink: (play: RecordedPlay) => void,
    opts: PlayCounterOptions = {},
  ) {
    this.pauseSplitMs = opts.pauseSplitMs ?? DEFAULT_PAUSE_SPLIT_MS;
    this.seekToleranceMs = opts.seekToleranceMs ?? DEFAULT_SEEK_TOLERANCE_MS;
    this.endSlackMs = opts.endSlackMs ?? DEFAULT_END_SLACK_MS;
  }

  /**
   * Feed two successive snapshots of one zone's state. `prev` is used only to
   * seed a zone the first time it is seen; afterwards the counter keeps its own
   * last state, which also makes an exactly repeated state harmless.
   */
  recordFromState(prev: PlayerState, next: PlayerState): void {
    const zone = next.zone;
    let tracker = this.zones.get(zone);
    if (!tracker) {
      const seed = prev !== undefined && prev.zone === zone ? prev : next;
      tracker = { last: cloneState(seed), active: null };
      const seedItem = itemAt(seed);
      if (seedItem && seed.status !== 'stopped') {
        // Joined mid-track: treat the current position as heard so far.
        tracker.active = this.begin(seed, seedItem, seed.positionMs, seed.updatedAt - seed.positionMs);
      }
      this.zones.set(zone, tracker);
    }
    this.step(tracker, next);
  }

  /** Forget all in-flight plays (tests / long-lived maintenance). */
  reset(): void {
    this.zones.clear();
  }

  private step(z: ZoneState, next: PlayerState): void {
    const prev = z.last;
    z.last = cloneState(next);

    const prevItem = itemAt(prev);
    const nextItem = itemAt(next);
    const nextActive = next.status !== 'stopped' ? nextItem : undefined;

    // The caller jumped (or a duplicate arrived): don't pair the old active play
    // with an unrelated state.
    if (
      z.active &&
      (!prevItem || prevItem.queueId !== z.active.queueId || prevItem.track.id !== z.active.trackId)
    ) {
      z.active = null;
    }
    if (!z.active && prevItem && prev.status !== 'stopped') {
      z.active = this.begin(prev, prevItem, prev.positionMs, prev.updatedAt - prev.positionMs);
    }

    const sameEntry =
      z.active !== null &&
      prevItem !== undefined &&
      nextItem !== undefined &&
      next.status !== 'stopped' &&
      prevItem.queueId === z.active.queueId &&
      nextItem.queueId === prevItem.queueId &&
      nextItem.track.id === z.active.trackId;

    if (sameEntry && z.active && nextItem) {
      // Repeat-one loop: the same queue entry wrapped from (near) the end to the start.
      if (
        prev.status === 'playing' &&
        next.status === 'playing' &&
        z.active.durationMs > 0 &&
        prev.positionMs >= z.active.durationMs - this.endSlackMs &&
        next.positionMs < prev.positionMs &&
        next.positionMs <= this.endSlackMs
      ) {
        const wall = Math.max(0, next.updatedAt - prev.updatedAt);
        z.active.heardMs += Math.min(Math.max(0, z.active.durationMs - prev.positionMs), wall);
        this.finish(z.active, true, next.zone);
        z.active = this.begin(next, nextItem, 0, next.updatedAt - next.positionMs);
        return;
      }

      // A long pause separates two listens of the same track. It is detected
      // either on the resume or, if paused states keep arriving, while paused.
      if (
        prev.status === 'paused' &&
        next.status === 'paused' &&
        z.active.pausedAt !== undefined &&
        !z.active.splitDone &&
        next.updatedAt - z.active.pausedAt > this.pauseSplitMs
      ) {
        this.finish(z.active, false, next.zone);
        z.active.heardMs = 0;
        z.active.startedAt = next.updatedAt;
        z.active.splitDone = true;
        return;
      }
      if (prev.status === 'paused' && next.status !== 'paused') {
        if (
          z.active.pausedAt !== undefined &&
          !z.active.splitDone &&
          next.updatedAt - z.active.pausedAt > this.pauseSplitMs
        ) {
          this.finish(z.active, false, next.zone);
          z.active = this.begin(next, nextItem, 0, next.updatedAt);
          return;
        }
        z.active.pausedAt = undefined;
        z.active.splitDone = undefined;
      }

      if (prev.status === 'playing') {
        const delta = next.positionMs - prev.positionMs;
        if (delta > 0) {
          const wall = Math.max(0, next.updatedAt - prev.updatedAt);
          const credited = delta <= wall + this.seekToleranceMs ? delta : Math.min(delta, wall);
          z.active.heardMs += Math.max(0, credited);
        }
        if (z.active.durationMs > 0) {
          z.active.heardMs = Math.min(z.active.heardMs, z.active.durationMs);
        }
      }
      if (next.status === 'paused' && prev.status !== 'paused') {
        z.active.pausedAt = next.updatedAt;
      }
      return;
    }

    // Track/entry change, stop, or queue replacement: close the current play.
    if (z.active) {
      const duration = z.active.durationMs;
      const reachedEnd =
        prevItem !== undefined &&
        prev.status !== 'stopped' &&
        prevItem.track.id === z.active.trackId &&
        duration > 0 &&
        prev.positionMs >= duration - this.endSlackMs;
      this.finish(z.active, reachedEnd, next.zone);
      z.active = null;
    }

    if (nextActive) {
      const pos = Math.max(0, next.positionMs);
      const startedAt =
        next.status === 'playing' && pos > 0 ? next.updatedAt - pos : next.updatedAt;
      z.active = this.begin(next, nextActive, 0, startedAt);
    }
  }

  private begin(state: PlayerState, item: QueueItem, heardMs: number, startedAt: number): ActivePlay {
    return {
      trackId: item.track.id,
      albumId: item.track.albumId,
      queueId: item.queueId,
      durationMs: durationOf(item),
      startedAt: Math.round(startedAt),
      heardMs: Math.max(0, heardMs),
      pausedAt: state.status === 'paused' ? state.updatedAt : undefined,
    };
  }

  private finish(play: ActivePlay, completed: boolean, zone: string): void {
    const duration = play.durationMs;
    let playedMs = Math.round(play.heardMs);
    if (duration > 0) playedMs = Math.min(playedMs, duration);
    if (playedMs < playThreshold(duration)) return;
    this.sink({
      trackId: play.trackId,
      albumId: play.albumId,
      zone,
      startedAt: play.startedAt,
      playedMs,
      completed,
    });
  }
}
