// Spotify library worker F: playlists + Liked Songs sync, in_library bookkeeping,
// on-demand album loading and save/unsave. All SQLite work is transactional after
// the network reads have been done up front (better-sqlite3 is synchronous).
import type { Album, ArtistRef, Track } from '@liner/shared';
import type { PlaylistDetail, PlaylistSummary, PlaylistTrack } from '@liner/shared';
import type Database from 'better-sqlite3';
import type { Db } from '../db/index.js';
import { getAlbum, publicTrack } from '../api/library.js';
import { loadTrack } from '../play/rows.js';
import type {
  SpotifyAlbum,
  SpotifyPlaylist,
  SpotifyPlaylistTrack,
  SpotifySavedTrack,
  SpotifyTrack,
} from './api.js';
import { ensureSpotifyLibrarySchema } from './library-schema.js';
import {
  ArtistResolver,
  largestImage,
  mapTrack,
  spotifyAlbumId,
  spotifyIdOf,
  unknownArtist,
  yearFromReleaseDate,
} from './map.js';
import { ensureSpotifySchema } from './schema.js';

export const LIKED_SONGS_PLAYLIST_ID = 'pl:sp:liked';
export const LIKED_SONGS_NAME = 'Liked Songs';

export function playlistId(spotifyPlaylistId: string): string {
  return `pl:sp:${spotifyPlaylistId}`;
}

// ---------- playable-entry filters ----------

/** Null tracks, local files and podcast episodes are not part of the library. */
export function isUsableSpotifyTrack(
  track: SpotifyTrack | null | undefined,
  itemIsLocal = false,
): track is SpotifyTrack {
  if (!track || !track.id) return false;
  if (itemIsLocal || track.is_local) return false;
  if (track.type === 'episode') return false;
  return true;
}

/** Playlist / liked-song entries also need their album object to be renderable. */
export function isPlayablePlaylistTrack(
  track: SpotifyTrack | null | undefined,
  itemIsLocal = false,
): track is SpotifyTrack {
  return isUsableSpotifyTrack(track, itemIsLocal) && !!track.album?.id;
}

// ---------- write helpers ----------

type Stmt = Database.Statement;

interface StoreContext {
  db: Db;
  resolver: ArtistResolver;
  now: () => number;
  artistIds: Set<string>;
  upsertAlbum: Stmt;
  upsertTrack: Stmt;
  upsertTrackArtist: Stmt;
}

function createStore(db: Db, now: () => number): StoreContext {
  return {
    db,
    resolver: new ArtistResolver(db),
    now,
    artistIds: new Set<string>(),
    upsertAlbum: db.prepare(
      `INSERT INTO albums
         (id, source, title, artist_id, year, release_date, label, genres, format,
          folder_path, cover_path, spotify_id, added_at, in_library)
       VALUES (?, 'spotify', ?, ?, ?, ?, ?, ?, 'Spotify', NULL, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         artist_id = excluded.artist_id,
         year = COALESCE(excluded.year, albums.year),
         release_date = COALESCE(excluded.release_date, albums.release_date),
         label = COALESCE(excluded.label, albums.label),
         genres = CASE WHEN excluded.genres = '[]' THEN albums.genres ELSE excluded.genres END,
         format = COALESCE(excluded.format, albums.format),
         cover_path = COALESCE(excluded.cover_path, albums.cover_path),
         spotify_id = excluded.spotify_id`,
    ),
    upsertTrack: db.prepare(
      `INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms, spotify_uri)
       VALUES (?, ?, 'spotify', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         album_id = excluded.album_id,
         title = excluded.title,
         disc = excluded.disc,
         number = excluded.number,
         duration_ms = excluded.duration_ms,
         spotify_uri = excluded.spotify_uri`,
    ),
    upsertTrackArtist: db.prepare(
      `INSERT INTO track_artists (track_id, artist_id, position) VALUES (?, ?, ?)
       ON CONFLICT(track_id, artist_id) DO UPDATE SET position = excluded.position`,
    ),
  };
}

interface UpsertAlbumOptions {
  addedAt: number;
  /** 1 for saved albums, 0 for playlist-only / on-demand albums. */
  inLibrary: boolean;
  /** Used when the Spotify album payload has no artist list. */
  fallbackArtist?: ArtistRef;
}

/** Upsert an album row without ever downgrading an existing in_library flag. */
function upsertSpotifyAlbum(
  ctx: StoreContext,
  sp: SpotifyAlbum,
  opts: UpsertAlbumOptions,
): { id: string; artist: ArtistRef } {
  const primarySp = sp.artists?.[0];
  const primary = primarySp
    ? ctx.resolver.resolve(primarySp)
    : (opts.fallbackArtist ?? ctx.resolver.ensure(unknownArtist()));
  for (const extra of sp.artists?.slice(1) ?? []) ctx.artistIds.add(ctx.resolver.resolve(extra).id);
  ctx.artistIds.add(primary.id);

  const albumId = spotifyAlbumId(sp.id);
  ctx.upsertAlbum.run(
    albumId,
    sp.name,
    primary.id,
    yearFromReleaseDate(sp.release_date) ?? null,
    sp.release_date ?? null,
    sp.label ?? null,
    JSON.stringify(sp.genres ?? []),
    largestImage(sp.images) ?? null,
    sp.id,
    opts.addedAt,
    opts.inLibrary ? 1 : 0,
  );
  ftsReplace(ctx.db, 'album', albumId, `${sp.name} ${primary.name}`);
  return { id: albumId, artist: primary };
}

function upsertSpotifyTrack(
  ctx: StoreContext,
  sp: SpotifyTrack,
  albumId: string,
  albumTitle: string,
): Track | undefined {
  if (!sp.id) return undefined;
  const track = mapTrack(sp, albumId);
  const artists = sp.artists?.length
    ? ctx.resolver.resolveAll(sp.artists)
    : [ctx.resolver.ensure(unknownArtist())];
  for (const ref of artists) ctx.artistIds.add(ref.id);

  ctx.upsertTrack.run(
    track.id,
    albumId,
    track.title,
    track.disc,
    track.number,
    track.durationMs,
    track.spotifyUri ?? null,
  );
  artists.forEach((ref, position) => ctx.upsertTrackArtist.run(track.id, ref.id, position));
  ftsReplace(
    ctx.db,
    'track',
    track.id,
    `${track.title} ${artists.map((a) => a.name).join(' ')} ${albumTitle}`,
  );
  return track;
}

/** Store a playlist/liked entry's album, track and artists. */
function storePlaylistTrack(ctx: StoreContext, sp: SpotifyTrack): Track | undefined {
  const spAlbum = sp.album;
  if (!spAlbum?.id) return undefined;
  const fallbackArtist = sp.artists?.[0]
    ? ctx.resolver.resolve(sp.artists[0])
    : undefined;
  const { id: albumId } = upsertSpotifyAlbum(ctx, spAlbum, {
    addedAt: ctx.now(),
    inLibrary: false,
    fallbackArtist,
  });
  return upsertSpotifyTrack(ctx, sp, albumId, spAlbum.name);
}

function indexArtists(ctx: StoreContext): void {
  const stmt = ctx.db.prepare('SELECT name FROM artists WHERE id = ?');
  for (const id of ctx.artistIds) {
    const row = stmt.get(id) as { name: string } | undefined;
    if (row) ftsReplace(ctx.db, 'artist', id, row.name);
  }
}

function ftsReplace(db: Db, kind: string, refId: string, text: string): void {
  ftsDelete(db, kind, refId);
  db.prepare('INSERT INTO search_fts (kind, ref_id, text) VALUES (?, ?, ?)').run(kind, refId, text);
}

function ftsDelete(db: Db, kind: string, refId: string): void {
  db.prepare('DELETE FROM search_fts WHERE kind = ? AND ref_id = ?').run(kind, refId);
}

// ---------- playlist + liked-songs sync ----------

export interface PlaylistSyncSource {
  allPlaylists(): Promise<SpotifyPlaylist[]>;
  allPlaylistTracks(playlistId: string): Promise<SpotifyPlaylistTrack[]>;
  allSavedTracks(): Promise<SpotifySavedTrack[]>;
}

export interface PlaylistSyncOptions {
  now?: () => number;
}

export interface PlaylistSyncResult {
  /** Liked Songs + user playlists stored. */
  playlists: number;
  /** Entries stored across all playlists (liked songs included). */
  tracks: number;
  /** Subset of `tracks` that came from Liked Songs. */
  liked: number;
  /** Playlists removed because Spotify no longer returns them. */
  removed: number;
}

function addedAtMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function ownerName(p: SpotifyPlaylist): string | null {
  return p.owner?.display_name || p.owner?.id || null;
}

/**
 * Upsert the user's playlists (+ Liked Songs) and their tracks. Tracks are only
 * refetched when Spotify's snapshot_id changed; metadata/order always refreshes.
 */
export async function syncPlaylists(
  source: PlaylistSyncSource,
  db: Db,
  opts: PlaylistSyncOptions = {},
): Promise<PlaylistSyncResult> {
  ensureSpotifySchema(db);
  ensureSpotifyLibrarySchema(db);
  const now = opts.now ?? Date.now;

  // Network first: better-sqlite3 transactions must be synchronous.
  const [playlists, liked] = await Promise.all([source.allPlaylists(), source.allSavedTracks()]);

  const previous = new Map<string, { snapshot_id: string | null }>();
  for (const row of db
    .prepare("SELECT id, snapshot_id FROM playlists WHERE source = 'spotify'")
    .all() as { id: string; snapshot_id: string | null }[]) {
    previous.set(row.id, row);
  }

  const fetched = new Map<string, SpotifyPlaylistTrack[]>();
  const skipped: string[] = [];
  for (const p of playlists) {
    if (!p.id) continue;
    const prev = previous.get(playlistId(p.id));
    if (prev && p.snapshot_id && prev.snapshot_id === p.snapshot_id) continue;
    try {
      fetched.set(p.id, await source.allPlaylistTracks(p.id));
    } catch (err) {
      // Spotify returns 403 for playlists it owns (Discover Weekly, editorial, "Made
      // for you") to apps in development mode. Skip those instead of failing the sync.
      const status = (err as { status?: number }).status;
      if (status === 403 || status === 404) {
        skipped.push(p.name ?? p.id);
        continue;
      }
      throw err;
    }
  }

  const result: PlaylistSyncResult = { playlists: 0, tracks: 0, liked: 0, removed: 0 };
  const likedImage = liked
    .map((item) => item.track)
    .filter((t): t is SpotifyTrack => isPlayablePlaylistTrack(t))
    .map((t) => largestImage(t.album?.images))
    .find((url): url is string => !!url) ?? null;

  const tx = db.transaction(() => {
    const ctx = createStore(db, now);
    const upsertPlaylist = db.prepare(
      `INSERT INTO playlists
         (id, source, name, description, owner, image_url, snapshot_id, track_count, position, updated_at)
       VALUES (?, 'spotify', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         owner = excluded.owner,
         image_url = excluded.image_url,
         snapshot_id = excluded.snapshot_id,
         track_count = excluded.track_count,
         position = excluded.position,
         updated_at = excluded.updated_at`,
    );
    const updateMetadata = db.prepare(
      `UPDATE playlists SET name = ?, description = ?, owner = ?, image_url = ?,
         position = ?, updated_at = ? WHERE id = ?`,
    );
    const deleteEntries = db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?');
    const insertEntry = db.prepare(
      'INSERT INTO playlist_tracks (playlist_id, position, track_id, added_at) VALUES (?, ?, ?, ?)',
    );
    const setTrackCount = db.prepare('UPDATE playlists SET track_count = ? WHERE id = ?');
    const keep = new Set<string>();

    // ---- Liked Songs (always refetched; Spotify has no snapshot for it) ----
    keep.add(LIKED_SONGS_PLAYLIST_ID);
    deleteEntries.run(LIKED_SONGS_PLAYLIST_ID);
    upsertPlaylist.run(
      LIKED_SONGS_PLAYLIST_ID,
      LIKED_SONGS_NAME,
      null,
      null,
      likedImage,
      null,
      0,
      0,
      now(),
    );
    result.playlists++;
    let likedCount = 0;
    for (const item of liked) {
      if (!isPlayablePlaylistTrack(item.track)) continue;
      const track = storePlaylistTrack(ctx, item.track);
      if (!track) continue;
      insertEntry.run(LIKED_SONGS_PLAYLIST_ID, likedCount, track.id, addedAtMs(item.added_at));
      likedCount++;
    }
    setTrackCount.run(likedCount, LIKED_SONGS_PLAYLIST_ID);
    result.liked = likedCount;
    result.tracks += likedCount;

    // ---- User playlists ----
    playlists.forEach((p, index) => {
      if (!p.id) return;
      const id = playlistId(p.id);
      keep.add(id);
      const image = largestImage(p.images) ?? null;
      if (fetched.has(p.id)) {
        upsertPlaylist.run(
          id,
          p.name,
          p.description ?? null,
          ownerName(p),
          image,
          p.snapshot_id ?? null,
          0,
          index + 1,
          now(),
        );
        deleteEntries.run(id);
        let count = 0;
        for (const item of fetched.get(p.id) ?? []) {
          if (!isPlayablePlaylistTrack(item.track, item.is_local)) continue;
          const track = storePlaylistTrack(ctx, item.track);
          if (!track) continue;
          insertEntry.run(id, count, track.id, addedAtMs(item.added_at));
          count++;
        }
        setTrackCount.run(count, id);
        result.tracks += count;
      } else {
        // Snapshot unchanged: refresh metadata but keep the stored track list.
        updateMetadata.run(p.name, p.description ?? null, ownerName(p), image, index + 1, now(), id);
      }
      result.playlists++;
    });

    // ---- Playlists that disappeared from Spotify ----
    // Only synced Spotify rows participate: rune-owned playlists (source 'local',
    // ids 'pl:rune:…') live in the same table and must survive a sync.
    for (const row of db
      .prepare("SELECT id FROM playlists WHERE source = 'spotify'")
      .all() as { id: string }[]) {
      if (keep.has(row.id)) continue;
      db.prepare('DELETE FROM playlists WHERE id = ?').run(row.id); // entries cascade
      result.removed++;
    }

    indexArtists(ctx);
  });

  tx();
  return result;
}

// ---------- reads ----------

interface PlaylistRow {
  id: string;
  source: string;
  name: string;
  description: string | null;
  owner: string | null;
  image_url: string | null;
  track_count: number;
}

const PLAYLIST_SELECT = `
  SELECT id, source, name, description, owner, image_url, track_count
  FROM playlists`;

function summary(r: PlaylistRow): PlaylistSummary {
  return {
    id: r.id,
    name: r.name,
    ...(r.owner ? { owner: r.owner } : {}),
    ...(r.image_url ? { imageUrl: r.image_url } : {}),
    trackCount: r.track_count,
    source: r.source === 'local' ? 'local' : 'spotify',
  };
}

/** GET /api/playlists: Liked Songs first (position 0), then the user's order. */
export function listPlaylists(db: Db): PlaylistSummary[] {
  ensureSpotifyLibrarySchema(db);
  const rows = db
    .prepare(`${PLAYLIST_SELECT} ORDER BY position, name COLLATE NOCASE`)
    .all() as PlaylistRow[];
  return rows.map(summary);
}

/** GET /api/playlists/:id: metadata + ordered tracks with album info. */
export function getPlaylist(db: Db, id: string): PlaylistDetail | undefined {
  ensureSpotifyLibrarySchema(db);
  const row = db.prepare(`${PLAYLIST_SELECT} WHERE id = ?`).get(id) as PlaylistRow | undefined;
  if (!row) return undefined;

  const entries = db
    .prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position')
    .all(id) as { track_id: string }[];
  const albumStmt = db.prepare('SELECT title, cover_path FROM albums WHERE id = ?');

  const tracks: PlaylistTrack[] = [];
  for (const entry of entries) {
    const track = loadTrack(db, entry.track_id);
    if (!track) continue; // dangling entry (album/track removed) — just skip it
    const album = albumStmt.get(track.albumId) as
      | { title: string | null; cover_path: string | null }
      | undefined;
    const coverUrl = album?.cover_path
      ? `/api/cover/${encodeURIComponent(track.albumId)}?size=200`
      : undefined;
    const shared = publicTrack(track) as Track;
    tracks.push({
      ...shared,
      album: {
        id: track.albumId,
        title: album?.title ?? '',
        ...(coverUrl ? { coverUrl } : {}),
      },
    });
  }

  return {
    ...summary(row),
    ...(row.description ? { description: row.description } : {}),
    tracks,
  };
}

// ---------- on-demand album / save ----------

export interface AlbumFetchApi {
  album(id: string): Promise<SpotifyAlbum>;
  allAlbumTracks(id: string): Promise<SpotifyTrack[]>;
}

/**
 * GET /api/albums/sp:<id> for an album not in the DB: fetch it, store it with
 * in_library = 0, and return the stored album. Existing tracks are upserted (not
 * deleted) so playlist entries that point at them stay intact.
 */
export async function fetchSpotifyAlbum(
  api: AlbumFetchApi,
  db: Db,
  albumId: string,
  opts: { now?: () => number } = {},
): Promise<Album | undefined> {
  if (!albumId.startsWith('sp:')) return undefined;
  ensureSpotifySchema(db);
  ensureSpotifyLibrarySchema(db);
  const now = opts.now ?? Date.now;
  const spId = spotifyIdOf(albumId);
  const sp = await api.album(spId);

  let tracks = sp.tracks?.items ?? [];
  if (!sp.tracks || sp.tracks.next || tracks.length < (sp.tracks.total ?? 0)) {
    tracks = await api.allAlbumTracks(spId);
  }

  const tx = db.transaction(() => {
    const ctx = createStore(db, now);
    const stored = upsertSpotifyAlbum(ctx, sp, { addedAt: now(), inLibrary: false });
    for (const track of tracks) {
      if (!isUsableSpotifyTrack(track)) continue;
      upsertSpotifyTrack(ctx, track, stored.id, sp.name);
    }
    indexArtists(ctx);
  });
  tx();
  return getAlbum(db, spotifyAlbumId(sp.id));
}

export interface AlbumSaveApi {
  saveAlbums(ids: string[]): Promise<void>;
  removeSavedAlbums(ids: string[]): Promise<void>;
}

/** POST/DELETE /api/albums/sp:<id>/save — Spotify library + local in_library flag. */
export async function setSpotifyAlbumSaved(
  api: AlbumSaveApi,
  db: Db,
  albumId: string,
  saved: boolean,
): Promise<boolean> {
  ensureSpotifyLibrarySchema(db);
  const spId = spotifyIdOf(albumId);
  if (saved) await api.saveAlbums([spId]);
  else await api.removeSavedAlbums([spId]);
  const info = db.prepare('UPDATE albums SET in_library = ? WHERE id = ?').run(saved ? 1 : 0, albumId);
  return info.changes > 0;
}
