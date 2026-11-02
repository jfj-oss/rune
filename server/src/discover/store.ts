// Persist recommended Spotify tracks (+ their albums/artists) so the web can
// play, queue and add them to playlists by id. Albums are stored with
// in_library = 0; existing saved albums keep in_library = 1 untouched.
import type { Track } from '@liner/shared';
import type { Db } from '../db/index.js';
import { coverUrl } from '../api/library.js';
import type { SpotifyTrack } from '../spotify/api.js';
import { ensureSpotifySchema } from '../spotify/schema.js';
import {
  ArtistResolver,
  largestImage,
  mapTrack,
  spotifyAlbumId,
  unknownArtist,
  yearFromReleaseDate,
} from '../spotify/map.js';
import type { DiscoverAlbum } from './types.js';

export interface StoredTrack {
  track: Track;
  album: DiscoverAlbum;
}

/** Upsert and map a set of Spotify tracks. Returns a map keyed by full track id. */
export function storeSpotifyTracks(
  db: Db,
  tracks: SpotifyTrack[],
  opts: { now?: () => number } = {},
): Map<string, StoredTrack> {
  ensureSpotifySchema(db);
  const now = opts.now ?? Date.now;
  const out = new Map<string, StoredTrack>();
  const unique = new Map<string, SpotifyTrack>();
  for (const track of tracks) {
    if (track.id && track.album?.id && !unique.has(track.id)) unique.set(track.id, track);
  }
  if (unique.size === 0) return out;

  const tx = db.transaction(() => {
    const resolver = new ArtistResolver(db);
    const upsertAlbum = db.prepare(
      `INSERT INTO albums
         (id, source, title, artist_id, year, release_date, label, genres, format,
          folder_path, cover_path, spotify_id, added_at, in_library)
       VALUES (?, 'spotify', ?, ?, ?, ?, NULL, ?, 'Spotify', NULL, ?, ?, ?, 0)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         artist_id = excluded.artist_id,
         year = coalesce(albums.year, excluded.year),
         release_date = coalesce(albums.release_date, excluded.release_date),
         genres = CASE WHEN excluded.genres != '[]' THEN excluded.genres ELSE albums.genres END,
         cover_path = coalesce(albums.cover_path, excluded.cover_path),
         spotify_id = coalesce(albums.spotify_id, excluded.spotify_id)`,
    );
    const upsertTrack = db.prepare(
      `INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms, spotify_uri)
       VALUES (?, ?, 'spotify', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         album_id = excluded.album_id,
         title = excluded.title,
         duration_ms = excluded.duration_ms,
         spotify_uri = excluded.spotify_uri`,
    );
    const upsertTrackArtist = db.prepare(
      `INSERT INTO track_artists (track_id, artist_id, position) VALUES (?, ?, ?)
       ON CONFLICT(track_id, artist_id) DO UPDATE SET position = excluded.position`,
    );
    const coverRow = db.prepare('SELECT cover_path FROM albums WHERE id = ?');

    for (const sp of unique.values()) {
      const album = sp.album;
      if (!album) continue;
      const albumId = spotifyAlbumId(album.id);
      const primary = album.artists?.[0] ? resolver.resolve(album.artists[0]) : resolver.ensure(unknownArtist());
      for (const extra of album.artists?.slice(1) ?? []) resolver.resolve(extra);

      upsertAlbum.run(
        albumId,
        album.name,
        primary.id,
        yearFromReleaseDate(album.release_date) ?? null,
        album.release_date ?? null,
        JSON.stringify(album.genres ?? []),
        largestImage(album.images) ?? null,
        album.id,
        now(),
      );

      const track = mapTrack(sp, albumId);
      const trackArtists = sp.artists?.length
        ? resolver.resolveAll(sp.artists)
        : [resolver.ensure(unknownArtist())];
      upsertTrack.run(
        track.id,
        albumId,
        track.title,
        track.disc,
        track.number,
        track.durationMs,
        track.spotifyUri ?? null,
      );
      trackArtists.forEach((ref, position) => upsertTrackArtist.run(track.id, ref.id, position));

      const cover = (coverRow.get(albumId) as { cover_path: string | null } | undefined)?.cover_path;
      out.set(track.id, {
        track,
        album: {
          id: albumId,
          title: album.name,
          ...(cover ? { coverUrl: coverUrl(albumId) } : {}),
        },
      });
    }
  });
  tx();
  return out;
}
