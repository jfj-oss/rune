// Removing songs from Spotify playlists (and unliking on Liked Songs) on Spotify's
// side, through the shared API client (budget counters, 429 Retry-After, lockout).
// The core mirrors the change in rune's DB; this module checks the stored grant and
// maps Spotify failures onto the playlist routes' error types.
import type { Db } from '../db/index.js';
import type { SpotifyApi } from '../spotify/api.js';
import type { SpotifyAuth } from '../spotify/auth.js';
import {
  LIKED_SONGS_PLAYLIST_ID,
  SpotifyReconnectNeeded,
  removeTracksFromSpotifyPlaylist,
  setTracksLiked,
} from '../spotify/library.js';
import { PlaylistConflictError, PlaylistRateLimitError } from '../myplaylists/index.js';
import { PlaylistInputError } from '../myplaylists/rules.js';

/** Unlike is a library write; playlist edits accept either public or private permission. */
const TRACK_WRITE_SCOPE = 'user-library-modify';
const PLAYLIST_WRITE_SCOPES = ['playlist-modify-private', 'playlist-modify-public'];

export interface SpotifyPlaylistWriteDeps {
  auth: Pick<SpotifyAuth, 'status' | 'grantedScopes'>;
  api: SpotifyApi;
  db: Db;
  /** Called after a write that really changed something. */
  onChange?(): void;
}

export async function removeSpotifyPlaylistTracks(
  deps: SpotifyPlaylistWriteDeps,
  playlistId: string,
  trackIds: string[],
): Promise<void> {
  const { auth, api, db } = deps;
  if (!auth.status().connected) {
    throw new PlaylistConflictError('Spotify is not connected');
  }
  const scopes = auth.grantedScopes();

  if (playlistId === LIKED_SONGS_PLAYLIST_ID) {
    if (!scopes.includes(TRACK_WRITE_SCOPE)) {
      throw new PlaylistInputError(new SpotifyReconnectNeeded('unlike songs').message);
    }
    try {
      await setTracksLiked(api, db, trackIds, false);
    } catch (err) {
      throw writeError(err);
    }
  } else {
    if (!PLAYLIST_WRITE_SCOPES.some((scope) => scopes.includes(scope))) {
      throw new PlaylistInputError(
        new SpotifyReconnectNeeded('remove songs from your Spotify playlists').message,
      );
    }
    try {
      await removeTracksFromSpotifyPlaylist(api, db, playlistId, trackIds);
    } catch (err) {
      throw writeError(err);
    }
  }
  deps.onChange?.();
}

/** Map the shared client's HTTP failure onto the playlist routes' error classes. */
function writeError(err: unknown): Error {
  const status = (err as { status?: number }).status;
  const retryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs;
  if (status === 429) return new PlaylistRateLimitError(undefined, retryAfterMs);
  if (status === 403) {
    return new PlaylistConflictError(
      'Spotify only lets you change playlists you own or that are collaborative',
    );
  }
  if (status === 404) {
    return new PlaylistConflictError(
      'Spotify could not find that playlist — it may have been deleted',
    );
  }
  return new PlaylistConflictError('Spotify refused the change');
}
