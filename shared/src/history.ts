// Listening history contracts (worker I). Re-exported from ./index.ts.
import type { Id } from './index.js';

/** One row of "Recently played": an album plus when/how often it was played. */
export interface RecentAlbum {
  albumId: Id;
  /** Epoch ms of the most recent counted play. */
  lastPlayedAt: number;
  /** Number of counted plays (not raw playback attempts). */
  plays: number;
}

/**
 * An album suggested by "Rediscover": either never played or last played before
 * the requested window. Ordering is deterministic for a given UTC day.
 */
export interface RediscoverAlbum {
  albumId: Id;
  /** Null when the album has never been played. */
  lastPlayedAt: number | null;
  plays: number;
}

/** Play stats for an album id or a track id. */
export interface HistoryStats {
  plays: number;
  lastPlayedAt: number | null;
}

/**
 * Body of POST /history/played, used by the browser zone (audio played inside
 * the tab, so the server never sees its PlayerState). The album is resolved
 * from the track id; the server applies the same play-counting rule as
 * PlayerState tracking (>= 30 s or >= 50% of the track).
 */
export interface HistoryPlayRequest {
  trackId: Id;
  zone: string;
  /** Epoch ms. Defaults to now. */
  startedAt?: number;
  playedMs: number;
  completed?: boolean;
}

export interface HistoryPlayResponse {
  /** False when the submitted listen was too short to count as a play. */
  recorded: boolean;
}
