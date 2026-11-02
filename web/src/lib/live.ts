import type { PlayerState, QueueItem } from '@liner/shared';

export interface LiveMeta {
  /** ICY now-playing title when the stream sends one, else the station name. */
  title: string;
  artist: string;
  station: string;
}

/**
 * What to show for a live station: the server reads ICY metadata into
 * PlayerState.nowPlaying, so the station name is only the fallback.
 */
export function liveMeta(state: PlayerState, cur: QueueItem | undefined): LiveMeta {
  const np = state.nowPlaying;
  const station = np?.station?.trim() || cur?.album.title || cur?.track.title || 'Internet radio';
  return {
    title: np?.title?.trim() || station,
    artist: np?.artist?.trim() || '',
    station,
  };
}

/** One-line station/artist string for compact rows. */
export function liveSubtitle(state: PlayerState, cur: QueueItem | undefined): string {
  const m = liveMeta(state, cur);
  return [m.artist, m.station].filter(Boolean).join(' · ');
}
