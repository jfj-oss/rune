/** Pure helpers for the Spotify Web Playback SDK engine (kept separate so they can be unit-tested). */

export interface Snap {
  /** Spotify track id of the loaded track (after relinking). */
  id: string;
  positionMs: number;
  durationMs: number;
  playing: boolean;
  /** Date.now() when the snapshot was taken. */
  at: number;
  /** ids in track_window.previous_tracks */
  previousIds: string[];
}

export const spotifyIdOf = (trackId: string): string => (trackId.startsWith('sp:') ? trackId.slice(3) : trackId);

/** Where playback should be now, extrapolated from a snapshot. */
export function extrapolate(s: Snap, now: number): number {
  const base = s.positionMs + (s.playing ? Math.max(0, now - s.at) : 0);
  return s.durationMs > 0 ? Math.min(base, s.durationMs) : base;
}

/**
 * Spotify has no "ended" event. When a single-track context finishes, the SDK reports the same track paused at
 * position 0 (and lists it in previous_tracks). We call that "ended" only if the previous snapshot was playing
 * and close to the end — so pausing, seeking to 0 or replaying never counts.
 */
export function detectEnded(prev: Snap | null, next: Snap): boolean {
  if (!prev || prev.id !== next.id || !prev.playing) return false;
  if (next.playing || next.positionMs > 500) return false;
  const expected = extrapolate(prev, next.at);
  const nearEnd = prev.durationMs > 0 && expected >= prev.durationMs - 2500;
  const listed = next.previousIds.includes(next.id) && prev.durationMs > 0 && expected > prev.durationMs * 0.5;
  return nearEnd || listed;
}

// ---------- local playback reports ----------

/** What the SDK last told the server, and when it was sent. */
export interface ReportState {
  active: boolean;
  trackId: string | null;
  playing: boolean;
  positionMs: number;
  shuffle: boolean;
  repeat: 0 | 1 | 2;
  /** 0..1 */
  volume: number;
  /** Date.now() when this state was sent. */
  at: number;
}

/** Position drift beyond this is a seek, not clock skew. */
export const REPORT_SEEK_MS = 3000;
/** Even with no change, report this often so the server's synthetic answer stays fresh. */
export const REPORT_HEARTBEAT_MS = 15_000;

const sameVolume = (a: number, b: number) => Math.abs(a - b) < 0.001;

/**
 * Should this SDK state be sent to the server? Pure so it can be unit-tested: send on any
 * visible change, on a seek (position differs from the extrapolated previous report by
 * more than {@link REPORT_SEEK_MS}) and as a heartbeat every {@link REPORT_HEARTBEAT_MS}.
 */
export function shouldReport(prev: ReportState | null, next: ReportState, now: number): boolean {
  if (!prev) return true;
  if (prev.active !== next.active) return true;
  if (prev.trackId !== next.trackId) return true;
  if (prev.playing !== next.playing) return true;
  if (prev.shuffle !== next.shuffle) return true;
  if (prev.repeat !== next.repeat) return true;
  if (!sameVolume(prev.volume, next.volume)) return true;
  const expected = prev.positionMs + (prev.playing ? Math.max(0, now - prev.at) : 0);
  if (Math.abs(next.positionMs - expected) > REPORT_SEEK_MS) return true;
  return now - prev.at >= REPORT_HEARTBEAT_MS;
}
