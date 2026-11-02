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
}

/** A playlist track plus the album bits needed to render its row / cover. */
export interface PlaylistTrack extends Track {
  album: {
    id: Id;
    title: string;
    coverUrl?: string;
  };
}

/** GET /api/playlists/:id — playlist metadata plus its ordered tracks. */
export interface PlaylistDetail extends PlaylistSummary {
  description?: string;
  tracks: PlaylistTrack[];
}
