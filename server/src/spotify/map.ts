// Mapping Spotify Web API objects onto @liner/shared types + saved-album sync.
import type { Album, AlbumSummary, Artist, ArtistRef, Track } from '@liner/shared';
import { hash16, ids, normalizeName, type Db } from '../db/index.js';
import type { SpotifyAlbum, SpotifyArtist, SpotifyImage, SpotifySavedAlbum, SpotifyTrack } from './api.js';
import { ensureSpotifyLibrarySchema } from './library-schema.js';
import { ensureSpotifySchema } from './schema.js';

// ---------- ids ----------

export function spotifyAlbumId(id: string): string {
  return 'sp:' + id;
}

export function spotifyTrackId(id: string): string {
  return 'sp:' + id;
}

/** Spotify artists are namespaced so a same-named local artist can take over the id. */
export function spotifyArtistId(id: string): string {
  return 'ar:sp:' + id;
}

export function isSpotifyId(id: string): boolean {
  return id.startsWith('sp:');
}

export function spotifyIdOf(id: string): string {
  return id.startsWith('sp:') ? id.slice(3) : id;
}

const UNKNOWN_ARTIST: ArtistRef = { id: ids.artistByName('Unknown Artist'), name: 'Unknown Artist' };

export function unknownArtist(): ArtistRef {
  return { ...UNKNOWN_ARTIST };
}

// ---------- pure mappers ----------

export function largestImage(images: SpotifyImage[] | undefined | null): string | undefined {
  if (!images || images.length === 0) return undefined;
  const first = images[0];
  if (!first) return undefined;
  let best = first;
  let bestScore = imageScore(best);
  for (const img of images.slice(1)) {
    const score = imageScore(img);
    if (score > bestScore) {
      best = img;
      bestScore = score;
    }
  }
  return best.url;
}

function imageScore(img: SpotifyImage): number {
  if (img.width && img.height) return img.width * img.height;
  return img.width ?? img.height ?? 0;
}

export function yearFromReleaseDate(releaseDate: string | undefined): number | undefined {
  if (!releaseDate) return undefined;
  const match = /^(\d{4})/.exec(releaseDate);
  return match && match[1] ? Number(match[1]) : undefined;
}

export function mapArtistRef(sp: SpotifyArtist): ArtistRef {
  return { id: spotifyArtistId(sp.id), name: sp.name };
}

export function mapAlbumArtist(sp: SpotifyAlbum): ArtistRef {
  const first = sp.artists?.[0];
  return first ? mapArtistRef(first) : unknownArtist();
}

export interface MapAlbumOptions {
  tracks?: SpotifyTrack[];
  addedAt?: number;
  /** Override the primary artist (used after local-artist merging). */
  artist?: ArtistRef;
}

export function mapAlbumSummary(sp: SpotifyAlbum, opts: MapAlbumOptions = {}): AlbumSummary {
  return {
    id: spotifyAlbumId(sp.id),
    source: 'spotify',
    title: sp.name,
    artist: opts.artist ?? mapAlbumArtist(sp),
    year: yearFromReleaseDate(sp.release_date),
    coverUrl: largestImage(sp.images),
    format: 'Spotify',
    addedAt: opts.addedAt ?? Date.now(),
  };
}

export function mapAlbum(sp: SpotifyAlbum, opts: MapAlbumOptions = {}): Album {
  const rawTracks = opts.tracks ?? sp.tracks?.items ?? [];
  return {
    ...mapAlbumSummary(sp, opts),
    tracks: rawTracks.filter((t) => !!t.id).map((t) => mapTrack(t, spotifyAlbumId(sp.id))),
    genres: sp.genres ?? [],
    label: sp.label,
    releaseDate: sp.release_date,
    credits: [],
  };
}

export function mapTrack(sp: SpotifyTrack, albumId?: string): Track {
  const id = sp.id ? spotifyTrackId(sp.id) : 'sp:local:' + hash16(sp.uri);
  return {
    id,
    albumId: albumId ?? (sp.album ? spotifyAlbumId(sp.album.id) : 'sp:unknown'),
    source: 'spotify',
    title: sp.name,
    artists: (sp.artists ?? []).map(mapArtistRef),
    disc: sp.disc_number ?? 1,
    number: sp.track_number ?? 1,
    durationMs: sp.duration_ms ?? 0,
    spotifyUri: sp.uri,
  };
}

export function mapArtist(sp: SpotifyArtist): Artist {
  return {
    id: spotifyArtistId(sp.id),
    name: sp.name,
    imageUrl: largestImage(sp.images),
    albums: [],
    appearsOn: [],
    similar: [],
  };
}

export function albumSummaryFromTrack(sp: SpotifyTrack): Pick<AlbumSummary, 'id' | 'title' | 'coverUrl'> {
  if (!sp.album) return { id: 'sp:unknown', title: '', coverUrl: undefined };
  return {
    id: spotifyAlbumId(sp.album.id),
    title: sp.album.name,
    coverUrl: largestImage(sp.album.images),
  };
}

// ---------- artist resolution (merge with local library) ----------

/**
 * Spotify artist ids are `ar:sp:<spotify id>`, *unless* an artist with the same
 * normalized name already exists in the local library — then that local id is
 * reused, so the artist page shows both catalogues. The Spotify id is stored on
 * the shared artists row (spotify_id) to make the decision stable.
 */
export class ArtistResolver {
  private readonly bySpotify = new Map<string, ArtistRef>();
  private readonly byNormalizedName = new Map<string, ArtistRef>();

  constructor(private readonly db: Db) {
    const rows = db.prepare('SELECT id, name, spotify_id FROM artists').all() as {
      id: string;
      name: string;
      spotify_id: string | null;
    }[];
    for (const row of rows) {
      const ref = { id: row.id, name: row.name };
      if (row.spotify_id) this.bySpotify.set(row.spotify_id, ref);
      // Only local ids participate in name merging; two Spotify artists that
      // happen to share a name must stay distinct.
      if (!row.id.startsWith('ar:sp:')) {
        const key = normalizeName(row.name);
        if (!this.byNormalizedName.has(key)) this.byNormalizedName.set(key, ref);
      }
    }
  }

  resolve(sp: SpotifyArtist): ArtistRef {
    const known = this.bySpotify.get(sp.id);
    if (known) return known;

    const local = this.byNormalizedName.get(normalizeName(sp.name));
    if (local) {
      this.db.prepare('UPDATE artists SET spotify_id = ? WHERE id = ?').run(sp.id, local.id);
      this.bySpotify.set(sp.id, local);
      return local;
    }

    const ref: ArtistRef = { id: spotifyArtistId(sp.id), name: sp.name };
    this.db
      .prepare(
        `INSERT INTO artists (id, name, spotify_id) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, spotify_id = excluded.spotify_id`,
      )
      .run(ref.id, ref.name, sp.id);
    this.bySpotify.set(sp.id, ref);
    return ref;
  }

  /** Make sure a plain ref (e.g. Unknown Artist) exists. */
  ensure(ref: ArtistRef): ArtistRef {
    this.db
      .prepare(
        `INSERT INTO artists (id, name) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
      )
      .run(ref.id, ref.name);
    return ref;
  }

  resolveAll(list: SpotifyArtist[] | undefined): ArtistRef[] {
    return (list ?? []).map((a) => this.resolve(a));
  }
}

// ---------- saved album sync ----------

export interface SavedAlbumsSource {
  allSavedAlbums(): Promise<SpotifySavedAlbum[]>;
  allAlbumTracks(albumId: string): Promise<SpotifyTrack[]>;
}

export interface SyncResult {
  albums: number;
  tracks: number;
  artists: number;
  removed: number;
}

interface PreparedAlbum {
  album: SpotifyAlbum;
  tracks: SpotifyTrack[];
  addedAt: number;
}

/**
 * Upsert the user's saved albums (+tracks+artists) with source='spotify',
 * delete Spotify albums that are no longer saved, and refresh search_fts.
 * Local albums are never touched.
 */
export async function syncSavedAlbums(
  source: SavedAlbumsSource,
  db: Db,
  opts: { now?: () => number } = {},
): Promise<SyncResult> {
  ensureSpotifySchema(db);
  // The playlist tables are needed for the "still referenced by a playlist?" check.
  ensureSpotifyLibrarySchema(db);
  const now = opts.now ?? Date.now;
  const saved = await source.allSavedAlbums();

  // Fetch everything up-front: better-sqlite3 transactions are synchronous.
  const prepared: PreparedAlbum[] = [];
  for (const item of saved) {
    if (!item.album) continue;
    const album = item.album;
    const included = album.tracks;
    let tracks: SpotifyTrack[];
    if (included && !included.next && included.items.length >= (included.total ?? 0)) {
      tracks = included.items;
    } else {
      tracks = await source.allAlbumTracks(album.id);
    }
    const addedAt = Number.isFinite(Date.parse(item.added_at)) ? Date.parse(item.added_at) : now();
    prepared.push({ album, tracks, addedAt });
  }

  const result: SyncResult = { albums: 0, tracks: 0, artists: 0, removed: 0 };
  const savedAlbumIds = new Set(prepared.map((p) => spotifyAlbumId(p.album.id)));

  const tx = db.transaction(() => {
    const resolver = new ArtistResolver(db);
    const artistIds = new Set<string>();
    const upsertAlbum = db.prepare(
      `INSERT INTO albums
         (id, source, title, artist_id, year, release_date, label, genres, format,
          folder_path, cover_path, spotify_id, added_at, in_library)
       VALUES (?, 'spotify', ?, ?, ?, ?, ?, ?, 'Spotify', NULL, ?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         artist_id = excluded.artist_id,
         year = excluded.year,
         release_date = excluded.release_date,
         label = excluded.label,
         genres = excluded.genres,
         format = excluded.format,
         cover_path = excluded.cover_path,
         spotify_id = excluded.spotify_id,
         in_library = 1`,
    );
    const upsertTrack = db.prepare(
      `INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms, spotify_uri)
       VALUES (?, ?, 'spotify', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         album_id = excluded.album_id,
         title = excluded.title,
         disc = excluded.disc,
         number = excluded.number,
         duration_ms = excluded.duration_ms,
         spotify_uri = excluded.spotify_uri`,
    );
    const upsertTrackArtist = db.prepare(
      `INSERT INTO track_artists (track_id, artist_id, position) VALUES (?, ?, ?)
       ON CONFLICT(track_id, artist_id) DO UPDATE SET position = excluded.position`,
    );
    const oldTracks = db.prepare('SELECT id FROM tracks WHERE album_id = ?');
    const storedAlbum = db.prepare('SELECT added_at FROM albums WHERE id = ?');
    const storedTrackIds = db.prepare(
      'SELECT id FROM tracks WHERE album_id = ? ORDER BY disc, number, id',
    );
    const storedTrackArtists = db.prepare(
      'SELECT DISTINCT artist_id FROM track_artists WHERE track_id IN (SELECT id FROM tracks WHERE album_id = ?)',
    );

    for (const { album, tracks, addedAt } of prepared) {
      const albumId = spotifyAlbumId(album.id);
      const primarySp = album.artists?.[0];
      const primary = primarySp ? resolver.resolve(primarySp) : resolver.ensure(unknownArtist());
      artistIds.add(primary.id);
      // Album-level collaborators also get rows so artist pages can list the album.
      for (const extra of album.artists?.slice(1) ?? []) artistIds.add(resolver.resolve(extra).id);

      const albumArtistName = primary.name;
      const coverUrl = largestImage(album.images) ?? null;
      upsertAlbum.run(
        albumId,
        album.name,
        primary.id,
        yearFromReleaseDate(album.release_date) ?? null,
        album.release_date ?? null,
        album.label ?? null,
        JSON.stringify(album.genres ?? []),
        coverUrl,
        album.id,
        addedAt,
      );

      const expectedIds = tracks.filter((t) => !!t.id).map((t) => spotifyTrackId(t.id!));
      const stored = storedAlbum.get(albumId) as { added_at: number } | undefined;
      const storedIds = (storedTrackIds.all(albumId) as { id: string }[]).map((r) => r.id);
      // Unchanged (same tracks in the same order, same count, same added_at): keep the rows.
      const unchanged =
        !!stored &&
        stored.added_at === addedAt &&
        storedIds.length === expectedIds.length &&
        storedIds.every((id, index) => id === expectedIds[index]);
      if (unchanged) {
        // Their artists are already stored; re-add them so FTS refresh and counts stay right.
        for (const row of storedTrackArtists.all(albumId) as { artist_id: string }[]) {
          artistIds.add(row.artist_id);
        }
        result.tracks += expectedIds.length;
        result.albums++;
        ftsReplace(db, 'album', albumId, `${album.name} ${albumArtistName}`);
        continue;
      }

      // Replace the track list wholesale so re-syncs drop removed tracks.
      for (const old of oldTracks.all(albumId) as { id: string }[]) {
        ftsDelete(db, 'track', old.id);
      }
      db.prepare('DELETE FROM tracks WHERE album_id = ?').run(albumId);

      let trackCount = 0;
      for (const spTrack of tracks) {
        if (!spTrack.id) continue;
        const track = mapTrack(spTrack, albumId);
        const trackArtists = spTrack.artists?.length
          ? resolver.resolveAll(spTrack.artists)
          : [resolver.ensure(unknownArtist())];
        for (const ref of trackArtists) artistIds.add(ref.id);

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
        ftsReplace(
          db,
          'track',
          track.id,
          `${track.title} ${trackArtists.map((a) => a.name).join(' ')} ${album.name}`,
        );
        trackCount++;
      }
      result.tracks += trackCount;
      result.albums++;

      ftsReplace(db, 'album', albumId, `${album.name} ${albumArtistName}`);
    }

    for (const id of artistIds) {
      const row = db.prepare('SELECT name FROM artists WHERE id = ?').get(id) as { name: string } | undefined;
      if (row) ftsReplace(db, 'artist', id, row.name);
    }
    result.artists = artistIds.size;

    // Albums that disappeared from "Saved Albums" (Spotify albums only).
    // If a playlist (or Liked Songs) still references one, keep it and hide it from
    // library listings (in_library = 0); otherwise drop it and its tracks.
    const playlistRef = db.prepare(
      `SELECT 1 AS present FROM playlist_tracks pt
       JOIN tracks t ON t.id = pt.track_id
       WHERE t.album_id = ? LIMIT 1`,
    );
    const hideAlbum = db.prepare('UPDATE albums SET in_library = 0 WHERE id = ?');
    const existing = db.prepare(`SELECT id FROM albums WHERE source = 'spotify'`).all() as { id: string }[];
    for (const row of existing) {
      if (savedAlbumIds.has(row.id)) continue;
      if (playlistRef.get(row.id)) {
        hideAlbum.run(row.id);
        continue;
      }
      for (const old of oldTracks.all(row.id) as { id: string }[]) ftsDelete(db, 'track', old.id);
      ftsDelete(db, 'album', row.id);
      db.prepare('DELETE FROM albums WHERE id = ?').run(row.id); // tracks cascade
      result.removed++;
    }
  });

  tx();
  return result;
}

function ftsReplace(db: Db, kind: string, refId: string, text: string): void {
  ftsDelete(db, kind, refId);
  db.prepare('INSERT INTO search_fts (kind, ref_id, text) VALUES (?, ?, ?)').run(kind, refId, text);
}

function ftsDelete(db: Db, kind: string, refId: string): void {
  db.prepare('DELETE FROM search_fts WHERE kind = ? AND ref_id = ?').run(kind, refId);
}
