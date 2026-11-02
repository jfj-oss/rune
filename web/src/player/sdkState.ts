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
