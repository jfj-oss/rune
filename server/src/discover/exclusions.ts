// "Do I already have this?" for recommendation candidates.
//
// Owned = Liked Songs, any synced Spotify / rune playlist, saved Spotify albums,
// or the local library. Matching is done three ways:
//   - Spotify track id (exact, covers every playlist reference),
//   - MusicBrainz recording id (local files carry it after matching),
//   - normalized primary artist + title (covers files without MBIDs and tracks
//     that are not linked to Spotify).
import type { Db } from '../db/index.js';
import { ensureSpotifyLibrarySchema } from '../spotify/library-schema.js';
import { ownedKey } from './match.js';
import { ensureDiscoverSchema } from './schema.js';

export interface OwnedIndex {
  /** Full ids, e.g. `sp:4uLU6hMCjMI75M1A2tKUQC`. */
  spotifyIds: Set<string>;
  recordingMbids: Set<string>;
  keys: Set<string>;
  dismissed: Set<string>;
}

export interface OwnedCandidate {
  /** Full track id (`sp:...`). */
  spotifyId?: string;
  recordingMbid?: string;
  title: string;
  artists: string[];
}

/** Every owned track id/key; safe to call repeatedly (the service caches it). */
export function loadOwned(db: Db): OwnedIndex {
  ensureSpotifyLibrarySchema(db);
  ensureDiscoverSchema(db);

  const spotifyIds = new Set<string>();
  const recordingMbids = new Set<string>();
  const keys = new Set<string>();

  // A track is owned if it is in the local library, in a saved Spotify album,
  // or referenced by any playlist (Liked Songs included). Discover-only tracks
  // (albums.in_library = 0 and not playlisted) are deliberately not owned.
  const ownedWhere = `(t.source = 'local' OR a.in_library = 1
    OR EXISTS (SELECT 1 FROM playlist_tracks pt WHERE pt.track_id = t.id))`;

  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.source, coalesce(ar.name, aar.name) AS artist, t.mb_recording_id
       FROM tracks t
       JOIN albums a ON a.id = t.album_id
       LEFT JOIN artists aar ON aar.id = a.artist_id
       LEFT JOIN track_artists ta ON ta.track_id = t.id
       LEFT JOIN artists ar ON ar.id = ta.artist_id
       WHERE ${ownedWhere}`,
    )
    .all() as {
    id: string;
    title: string;
    source: string;
    artist: string | null;
    mb_recording_id: string | null;
  }[];

  for (const row of rows) {
    if (row.source === 'spotify') spotifyIds.add(row.id);
    if (row.mb_recording_id) recordingMbids.add(row.mb_recording_id);
    if (row.artist) keys.add(ownedKey(row.artist, row.title));
  }

  // Playlist rows always count, even if their track row was deleted by a sync.
  const playlistIds = db
    .prepare('SELECT DISTINCT track_id FROM playlist_tracks')
    .all() as { track_id: string }[];
  for (const row of playlistIds) spotifyIds.add(row.track_id);

  const dismissed = new Set(
    (db.prepare('SELECT track_id FROM discover_dismissed').all() as { track_id: string }[]).map(
      (r) => r.track_id,
    ),
  );

  return { spotifyIds, recordingMbids, keys, dismissed };
}

export function isOwned(index: OwnedIndex, candidate: OwnedCandidate): boolean {
  if (candidate.spotifyId && index.spotifyIds.has(candidate.spotifyId)) return true;
  if (candidate.recordingMbid && index.recordingMbids.has(candidate.recordingMbid)) return true;
  return candidate.artists.some((artist) => index.keys.has(ownedKey(artist, candidate.title)));
}

export function isDismissed(index: OwnedIndex, trackId: string): boolean {
  return index.dismissed.has(trackId);
}
