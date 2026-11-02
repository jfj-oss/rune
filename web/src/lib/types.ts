import type { AlbumSummary, PlayerCommand, Track, Zone } from '@liner/shared';

/** A zone as returned by GET /zones. */
export interface ZoneInfo {
  id: Zone;
  name: string;
  kind: 'pc' | 'browser' | 'spotify';
}

/** A track plus just enough album context to put it in a queue. */
export interface PlayItem {
  track: Track;
  album: Pick<AlbumSummary, 'id' | 'title' | 'coverUrl'>;
}

/**
 * Contract gaps (not in @liner/shared): the queue drawer needs reorder and clear.
 * `move` / `clear` are handled locally by the browser zone; for server zones `clear`
 * is emulated with `remove` per item and `move` is sent as-is (server may ignore it).
 */
export type ExtCommand =
  | PlayerCommand
  | { type: 'move'; queueId: string; toIndex: number }
  | { type: 'clear' };

/** Contract gap: candidate list for "Fix match" (GET /albums/:id/candidates). */
export interface MatchCandidate {
  musicbrainzReleaseId: string;
  title: string;
  artist: string;
  year?: number;
  trackCount: number;
  country?: string;
  score: number; // 0..1
}

export interface SearchResults {
  albums: AlbumSummary[];
  artists: { id: string; name: string }[];
  tracks: Track[];
}

/** Extended query — genre/label/year filters are a gap in LibraryQuery. */
export interface AlbumQuery {
  q?: string;
  source?: 'local' | 'spotify' | 'all';
  sort?: 'added' | 'artist' | 'title' | 'year';
  offset?: number;
  limit?: number;
  genre?: string;
  label?: string;
  year?: number;
}
