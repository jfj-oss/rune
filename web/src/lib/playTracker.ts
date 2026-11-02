import type { HistoryPlayRequest, PlayerState } from '@liner/shared';
import { livePosition } from '../player/types';

/** Within this many ms of the end a track counts as having been played to the end. */
const END_SLACK_MS = 3000;
/** Ignore blips shorter than this; the server's 30 s / 50 % rule drops them anyway. */
const MIN_REPORT_MS = 1000;

interface Cur {
  queueId: string;
  trackId: string;
  durationMs: number;
  startedAt: number;
  /** Wall-clock ms spent in 'playing' so far. */
  playedMs: number;
  /** When the current 'playing' stretch began (null while paused/loading). */
  since: number | null;
  last: PlayerState;
}

/**
 * Turns a stream of browser-zone PlayerStates into listen reports: one per track, sent when it
 * ends, is skipped, is replaced, or the zone is left. `update(null)` means "not the browser zone".
 * The server decides whether a listen counts; we only say what was heard.
 */
export class PlayTracker {
  private cur: Cur | null = null;
  constructor(private emit: (r: HistoryPlayRequest) => void) {}

  update(s: PlayerState | null, now = Date.now()): void {
    const item = s && s.status !== 'stopped' ? s.queue[s.index] : undefined;
    const c = this.cur;

    if (c && (!item || item.queueId !== c.queueId)) this.finish(now);
    else if (c && item && s && this.restarted(c, s, now)) this.finish(now);

    if (!s || !item) return;
    if (!this.cur) {
      this.cur = { queueId: item.queueId, trackId: item.track.id, durationMs: item.track.durationMs, startedAt: now, playedMs: 0, since: null, last: s };
    }
    const cur = this.cur;
    if (s.status === 'playing') cur.since ??= now;
    else if (cur.since !== null) { cur.playedMs += now - cur.since; cur.since = null; }
    cur.last = s;
  }

  /** Report whatever is in flight (tab closing). Keeps tracking afterwards. */
  flush(now = Date.now()): void {
    const c = this.cur;
    if (!c) return;
    this.finish(now);
  }

  /** repeat-one / single-track repeat: same queue item, position jumped back to the start after playing through. */
  private restarted(c: Cur, s: PlayerState, now: number): boolean {
    if (s.status !== 'playing' || s.positionMs > 1500) return false;
    return livePosition(c.last, now) >= c.durationMs - END_SLACK_MS && c.playedMs + (c.since !== null ? now - c.since : 0) > 0;
  }

  private finish(now: number): void {
    const c = this.cur;
    this.cur = null;
    if (!c) return;
    const playedMs = Math.round(c.playedMs + (c.since !== null ? now - c.since : 0));
    if (playedMs < MIN_REPORT_MS) return;
    // The last state we saw (still "playing") extrapolated to now tells whether it ran to the end.
    const pos = livePosition(c.last, now);
    this.emit({
      trackId: c.trackId,
      zone: 'browser',
      startedAt: c.startedAt,
      playedMs: Math.min(playedMs, c.durationMs > 0 ? c.durationMs + 5000 : playedMs),
      completed: pos >= c.durationMs - END_SLACK_MS,
    });
  }
}
