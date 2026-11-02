import type { AlbumSummary, PlayerCommand, Track, Zone } from '@liner/shared';
import type { Source } from '@liner/shared';

/** What a zone can be asked to play: the shared sources plus live internet radio. */
export type PlaySource = Source | 'radio';

/** A zone as returned by GET /zones. */
export interface ZoneInfo {
  id: Zone;
  name: string;
  kind: 'pc' | 'browser' | 'spotify';
  /**
   * pc zone only: the Spotify desktop app running on the same PC (a Connect device, e.g. "HORSE").
   * When present the pc zone is hybrid: local files through mpv, Spotify tracks through that app.
   */
  spotifyDeviceId?: string;
  spotifyDeviceName?: string;
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

// ---------- browse (GET /tracks, /genres, /labels, /years) ----------
// Mirrors server/src/api/browse.ts; kept here because @liner/shared is frozen.

/** A track plus the album fields the Tracks page needs in one round-trip. */
export interface BrowseTrack extends Track {
  album: { id: string; title: string; coverUrl?: string };
}
export interface GenreFacet { genre: string; albumCount: number; coverAlbumIds: string[] }
export interface LabelFacet { label: string; albumCount: number }
export interface YearFacet { year: number; albumCount: number; decade: number }

export type TrackSort = 'title' | 'artist' | 'album' | 'duration' | 'added';
export interface TrackQuery { q?: string; sort?: TrackSort; dir?: 'asc' | 'desc'; offset?: number; limit?: number }
export interface GenreAlbumQuery { sort?: 'added' | 'artist' | 'title' | 'year'; dir?: 'asc' | 'desc'; offset?: number; limit?: number }
