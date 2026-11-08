// Spotify playlist response types (worker F). Re-exported from ./index.ts so the
// web client gets them through `@liner/shared` without touching the original types.
import type { Id, Source, Track } from './index.js';

/** A playlist row as shown in the playlists list. */
export interface PlaylistSummary {
  id: Id;
  name: string;
  owner?: string;
  imageUrl?: string;
  trackCount: number;
  source: Source;
  /**
   * Spotify playlists only: the signed-in user may change its tracks on Spotify
   * (it is theirs or collaborative; Liked Songs is always true). Unset for rune
   * playlists, whose editability is implied by their kind.
   */
  canEdit?: boolean;
}

/** A playlist track plus the album bits needed to render its row / cover. */
export interface PlaylistTrack extends Track {
  album: {
    id: Id;
    title: string;
    coverUrl?: string;
  };
  /**
   * Which side of a merged playlist this row came from (Spotify playlists can carry
   * rune-local overlay entries). Note: `Track.source` already means local/Spotify,
   * so this is a separate field rather than overloading `source`.
   */
  entrySource?: 'spotify-playlist' | 'rune-overlay';
  /** Stable id for entry operations (rune overlay entries use this with DELETE/move). */
  entryId?: string;
  /** When this entry was added to the playlist (epoch ms), if known. */
  addedAt?: number;
}

/** GET /api/playlists/:id — playlist metadata plus its ordered tracks. */
export interface PlaylistDetail extends PlaylistSummary {
  description?: string;
  tracks: PlaylistTrack[];
}
