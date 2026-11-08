// Spotify library worker F: playlists + Liked Songs sync, in_library bookkeeping,
// on-demand album loading and save/unsave. All SQLite work is transactional after
// the network reads have been done up front (better-sqlite3 is synchronous).
import type { Album, ArtistRef, Track } from '@liner/shared';
import type { PlaylistDetail, PlaylistSummary, PlaylistTrack } from '@liner/shared';
import type Database from 'better-sqlite3';
import type { Db } from '../db/index.js';
import { getAlbum, publicTrack } from '../api/library.js';
import { coverUrlFor } from '../api/cover.js';
import { loadTracks } from '../play/rows.js';
import type {
  SpotifyAlbum,
  SpotifyPaging,
  SpotifyPlaylist,
  SpotifyPlaylistTrack,
  SpotifySavedTrack,
  SpotifyTrack,
} from './api.js';
import { ensureSpotifyLibrarySchema } from './library-schema.js';
import { ensureOverlaySchema, mergedEntries, overlayCount } from '../myplaylists/overlay.js';
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
  /** One-page Liked Songs probe (total + newest added_at). Optional for test fakes. */
  savedTracks?(opts?: { offset?: number; limit?: number }): Promise<SpotifyPaging<SpotifySavedTrack>>;
}

export interface PlaylistSyncOptions {
  now?: () => number;
  /** Leave Liked Songs as stored (e.g. while Spotify rate-limits /me/tracks). */
  skipLiked?: boolean;
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
  /** Set when Spotify rate-limited Liked Songs (playlists still synced). */
  likedRetryAfterMs?: number;
}

function addedAtMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function ownerName(p: SpotifyPlaylist): string | null {
  return p.owner?.display_name || p.owner?.id || null;
}

// ---------- Liked Songs change probe ----------

const LIKED_STAMP_KEY = 'spotify.likedStamp';
const LIKED_FULL_AT_KEY = 'spotify.likedFullAt';
/** A full Liked Songs pass costs ~100 requests: only redo it daily (or when the probe changed). */
export const LIKED_FULL_SYNC_TTL_MS = 24 * 60 * 60 * 1000;

function ensureAppState(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
}

function getAppState(db: Db, key: string): string | undefined {
  return (db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

function setAppState(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/** `total:newestAddedAt` identifies the Liked Songs list without downloading it. */
export function likedStamp(total: number, newestAddedAt: string | undefined): string {
  return `${total}:${newestAddedAt ?? ''}`;
}

function newestAddedAt(items: SpotifySavedTrack[]): string | undefined {
  let newest: string | undefined;
  for (const item of items) {
    if (!item.added_at) continue;
    if (newest === undefined || item.added_at > newest) newest = item.added_at;
  }
  return newest;
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
  ensureAppState(db);
  const now = opts.now ?? Date.now;

  // Network first: better-sqlite3 transactions must be synchronous.
  // Liked Songs is the heavy part (~100 requests for ~4,600 songs) and is what Spotify
  // rate-limits first; it must never block the user's playlists from syncing. A one-track
  // probe (total + newest added_at) avoids that pass entirely while the list is unchanged.
  let likedRetryAfterMs: number | undefined;
  let likedProbeStamp: string | undefined;
  const likedPromise: Promise<SpotifySavedTrack[] | null> = opts.skipLiked
    ? Promise.resolve(null)
    : (async () => {
        try {
          if (source.savedTracks) {
            const probe = await source.savedTracks({ limit: 1 });
            likedProbeStamp = likedStamp(probe.total, probe.items?.[0]?.added_at);
            const stored = getAppState(db, LIKED_STAMP_KEY);
            const lastFull = Number(getAppState(db, LIKED_FULL_AT_KEY) ?? 0);
            // Probe says nothing changed and the last full pass is still fresh: skip it.
            if (stored === likedProbeStamp && now() - lastFull < LIKED_FULL_SYNC_TTL_MS) return null;
          }
          const liked = await source.allSavedTracks();
          likedProbeStamp ??= likedStamp(liked.length, newestAddedAt(liked));
          return liked;
        } catch (err) {
          if ((err as { status?: number })?.status === 429) {
            likedRetryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs ?? 60 * 60_000;
            return null;
          }
          throw err;
        }
      })();
  const [playlists, liked] = await Promise.all([source.allPlaylists(), likedPromise]);

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

  const result: PlaylistSyncResult = { playlists: 0, tracks: 0, liked: 0, removed: 0, likedRetryAfterMs };
  const likedImage = (liked ?? [])
    .map((item) => item.track)
    .filter((t): t is SpotifyTrack => isPlayablePlaylistTrack(t))
    .map((t) => largestImage(t.album?.images))
    .find((url): url is string => !!url) ?? null;

  const tx = db.transaction(() => {
    const ctx = createStore(db, now);
    const upsertPlaylist = db.prepare(
      `INSERT INTO playlists
         (id, source, name, description, owner, owner_id, collaborative, image_url, snapshot_id, track_count, position, updated_at)
       VALUES (?, 'spotify', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         owner = excluded.owner,
         owner_id = excluded.owner_id,
         collaborative = excluded.collaborative,
         image_url = excluded.image_url,
         snapshot_id = excluded.snapshot_id,
         track_count = excluded.track_count,
         position = excluded.position,
         updated_at = excluded.updated_at`,
    );
    const updateMetadata = db.prepare(
      `UPDATE playlists SET name = ?, description = ?, owner = ?, owner_id = ?, collaborative = ?,
         image_url = ?, position = ?, updated_at = ? WHERE id = ?`,
    );
    const deleteEntries = db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?');
    const insertEntry = db.prepare(
      'INSERT INTO playlist_tracks (playlist_id, position, track_id, added_at) VALUES (?, ?, ?, ?)',
    );
    const setTrackCount = db.prepare('UPDATE playlists SET track_count = ? WHERE id = ?');
    const keep = new Set<string>();

    // ---- Liked Songs (always refetched; Spotify has no snapshot for it) ----
    keep.add(LIKED_SONGS_PLAYLIST_ID);
    if (liked !== null) {
    deleteEntries.run(LIKED_SONGS_PLAYLIST_ID);
    upsertPlaylist.run(
      LIKED_SONGS_PLAYLIST_ID,
      LIKED_SONGS_NAME,
      null, // description
      null, // owner
      null, // owner_id
      0, // collaborative
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
    } // liked === null: skipped or rate limited — keep the stored Liked Songs as they are

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
          p.owner?.id ?? null,
          p.collaborative ? 1 : 0,
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
        updateMetadata.run(
          p.name,
          p.description ?? null,
          ownerName(p),
          p.owner?.id ?? null,
          p.collaborative ? 1 : 0,
          image,
          index + 1,
          now(),
          id,
        );
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
  // Remember what a full pass saw, so the next probe can skip it.
  if (liked !== null && likedProbeStamp !== undefined) {
    setAppState(db, LIKED_STAMP_KEY, likedProbeStamp);
    setAppState(db, LIKED_FULL_AT_KEY, String(now()));
  }
  return result;
}

// ---------- reads ----------

interface PlaylistRow {
  id: string;
  source: string;
  name: string;
  description: string | null;
  owner: string | null;
  owner_id: string | null;
  collaborative: number;
  image_url: string | null;
  track_count: number;
}

const PLAYLIST_SELECT = `
  SELECT id, source, name, description, owner, owner_id, collaborative, image_url, track_count
  FROM playlists`;

interface SpotifyViewer {
  id: string | null;
  name: string | null;
}

function spotifyViewer(db: Db): SpotifyViewer {
  ensureSpotifySchema(db); // the auth table may not exist yet when only library reads ran
  const row = db
    .prepare('SELECT user_id, user_name FROM spotify_auth WHERE id = 1')
    .get() as { user_id: string | null; user_name: string | null } | undefined;
  return { id: row?.user_id ?? null, name: row?.user_name ?? null };
}

/**
 * Whether the signed-in user may change this playlist's tracks on Spotify: theirs
 * (owner id matches) or collaborative. Liked Songs is always editable (unlike).
 * Logins made before Spotify ids were stored, and playlists synced before owner ids
 * were kept, fall back to comparing the owner display name.
 */
function canEditSpotifyRow(me: SpotifyViewer, r: PlaylistRow): boolean {
  if (r.id === LIKED_SONGS_PLAYLIST_ID) return true;
  if (r.source !== 'spotify' || !r.id.startsWith('pl:sp:')) return false;
  if (r.collaborative) return true;
  if (r.owner_id && me.id) return r.owner_id === me.id;
  return !!r.owner && me.name === r.owner;
}

/** Exported so the playlist-removal path can enforce the same rule as the UI. */
export function spotifyPlaylistEditable(db: Db, id: string): boolean {
  ensureSpotifyLibrarySchema(db);
  const row = db
    .prepare(`${PLAYLIST_SELECT} WHERE id = ?`)
    .get(id) as PlaylistRow | undefined;
  return !!row && canEditSpotifyRow(spotifyViewer(db), row);
}

function summary(db: Db, me: SpotifyViewer, r: PlaylistRow): PlaylistSummary {
  const source = r.source === 'local' ? 'local' : 'spotify';
  return {
    id: r.id,
    name: r.name,
    ...(r.owner ? { owner: r.owner } : {}),
    ...(r.image_url ? { imageUrl: r.image_url } : {}),
    trackCount: r.track_count,
    source,
    ...(source === 'spotify' ? { canEdit: canEditSpotifyRow(me, r) } : {}),
  };
}

/** GET /api/playlists: Liked Songs first (position 0), then the user's order. */
export function listPlaylists(db: Db): PlaylistSummary[] {
  ensureSpotifyLibrarySchema(db);
  ensureOverlaySchema(db);
  const rows = db
    .prepare(`${PLAYLIST_SELECT} ORDER BY position, name COLLATE NOCASE`)
    .all() as PlaylistRow[];
  const me = spotifyViewer(db);
  // trackCount includes the user's local overlay entries for Spotify playlists.
  return rows.map((row) => ({
    ...summary(db, me, row),
    trackCount: row.track_count + overlayCount(db, row.id),
  }));
}

/** GET /api/playlists/:id: metadata + ordered tracks with album info. */
export function getPlaylist(db: Db, id: string): PlaylistDetail | undefined {
  ensureSpotifyLibrarySchema(db);
  ensureOverlaySchema(db);
  const row = db.prepare(`${PLAYLIST_SELECT} WHERE id = ?`).get(id) as PlaylistRow | undefined;
  if (!row) return undefined;

  // Synced entries + local overlay entries, resolved after any Spotify resync.
  const entries = mergedEntries(db, id);
  // Batch the track/artist/album loads instead of two statements per entry.
  const loaded = loadTracks(db, entries.map((entry) => entry.trackId));
  const trackById = new Map(loaded.map((track) => [track.id, track]));
  const albumIds = [...new Set(loaded.map((track) => track.albumId))];
  const albumById = new Map<string, { title: string | null; cover_path: string | null }>();
  for (let i = 0; i < albumIds.length; i += 500) {
    const part = albumIds.slice(i, i + 500);
    const placeholders = part.map(() => '?').join(',');
    for (const album of db
      .prepare(`SELECT id, title, cover_path FROM albums WHERE id IN (${placeholders})`)
      .all(...part) as { id: string; title: string | null; cover_path: string | null }[]) {
      albumById.set(album.id, album);
    }
  }

  const tracks: PlaylistTrack[] = [];
  for (const entry of entries) {
    const track = trackById.get(entry.trackId);
    if (!track) continue; // dangling entry (album/track removed) — just skip it
    const album = albumById.get(track.albumId);
    const coverUrl = coverUrlFor(track.albumId, album?.cover_path, 200);
    const shared = publicTrack(track) as Track;
    tracks.push({
      ...shared,
      album: {
        id: track.albumId,
        title: album?.title ?? '',
        ...(coverUrl ? { coverUrl } : {}),
      },
      entrySource: entry.entrySource,
      entryId: entry.entryId,
      ...(entry.addedAt != null ? { addedAt: entry.addedAt } : {}),
    });
  }

  return {
    ...summary(db, spotifyViewer(db), row),
    trackCount: row.track_count + overlayCount(db, id),
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
  ensureFullTable(db);
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
  db.prepare('INSERT OR REPLACE INTO spotify_album_full (album_id, fetched_at) VALUES (?, ?)').run(spotifyAlbumId(sp.id), now());
  return getAlbum(db, spotifyAlbumId(sp.id));
}

/** Albums first seen through a playlist only hold the tracks that playlist had: has the full tracklist been fetched? */
export function spotifyAlbumIsFull(db: Db, albumId: string): boolean {
  ensureFullTable(db);
  return !!db.prepare('SELECT 1 FROM spotify_album_full WHERE album_id = ?').get(albumId);
}

function ensureFullTable(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS spotify_album_full (album_id TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL)');
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

// ---------- adding Spotify songs to Spotify playlists ----------

/** Thrown when the stored login predates a write permission (add, remove or unlike). */
export class SpotifyReconnectNeeded extends Error {
  constructor(action = 'add songs to your Spotify playlists') {
    super(`Reconnect Spotify once (Settings → Spotify) so rune may ${action}`);
    this.name = 'SpotifyReconnectNeeded';
  }
}

export interface PlaylistWriteApi {
  request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
  tracks(ids: string[]): Promise<SpotifyTrack[]>;
  saveTracks(ids: string[]): Promise<void>;
}

/**
 * Add Spotify songs to a synced Spotify playlist (or Liked Songs) on Spotify itself, then
 * mirror the change locally so rune shows it at once (the next sync confirms it).
 * Returns how many songs were added.
 */
export async function addTracksToSpotifyPlaylist(
  api: PlaylistWriteApi,
  db: Db,
  playlistId: string,
  trackIds: string[],
  opts: { now?: () => number } = {},
): Promise<number> {
  ensureSpotifySchema(db);
  ensureSpotifyLibrarySchema(db);
  const now = opts.now ?? Date.now;
  const ids = [...new Set(trackIds.filter((t) => t.startsWith('sp:')).map((t) => t.slice(3)))];
  if (ids.length === 0) return 0;

  // Songs from search / Discover may not be stored yet: store them so the playlist can show them.
  const have = new Set(
    (db.prepare(`SELECT id FROM tracks WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids.map((i) => `sp:${i}`)) as { id: string }[]).map((r) => r.id),
  );
  const missing = ids.filter((i) => !have.has(`sp:${i}`));
  if (missing.length) {
    const fetched = await api.tracks(missing);
    const tx = db.transaction(() => {
      const ctx = createStore(db, now);
      for (const t of fetched) if (t && isPlayablePlaylistTrack(t)) storePlaylistTrack(ctx, t);
      indexArtists(ctx);
    });
    tx();
  }

  const at = now();
  if (playlistId === LIKED_SONGS_PLAYLIST_ID) {
    // PUT /me/library (spotify:track: URIs, 40 per call); the old PUT /me/tracks answers 403 since February 2026
    for (let i = 0; i < ids.length; i += 40) await api.saveTracks(ids.slice(i, i + 40));
    // Liked Songs are stored newest first: shift everything down, put the new ones on top.
    const tx = db.transaction(() => {
      const n = ids.length;
      db.prepare('UPDATE playlist_tracks SET position = -(position + ?) - 1 WHERE playlist_id = ?').run(n, playlistId);
      db.prepare('UPDATE playlist_tracks SET position = -position - 1 WHERE playlist_id = ? AND position < 0').run(playlistId);
      const ins = db.prepare('INSERT INTO playlist_tracks (playlist_id, position, track_id, added_at) VALUES (?, ?, ?, ?)');
      ids.forEach((id, k) => ins.run(playlistId, k, `sp:${id}`, at));
      db.prepare('UPDATE playlists SET track_count = track_count + ?, updated_at = ? WHERE id = ?').run(n, at, playlistId);
    });
    tx();
    return ids.length;
  }

  const spId = playlistId.startsWith('pl:sp:') ? playlistId.slice(6) : playlistId;
  let snapshot: string | undefined;
  for (let i = 0; i < ids.length; i += 100) {
    const res = await api.request<{ snapshot_id?: string } | undefined>(`/playlists/${encodeURIComponent(spId)}/items`, {
      method: 'POST',
      body: { uris: ids.slice(i, i + 100).map((id) => `spotify:track:${id}`) },
    });
    snapshot = res?.snapshot_id ?? snapshot;
  }
  const tx = db.transaction(() => {
    const max = (db.prepare('SELECT max(position) AS m FROM playlist_tracks WHERE playlist_id = ?').get(playlistId) as { m: number | null }).m ?? -1;
    const ins = db.prepare('INSERT INTO playlist_tracks (playlist_id, position, track_id, added_at) VALUES (?, ?, ?, ?)');
    ids.forEach((id, k) => ins.run(playlistId, max + 1 + k, `sp:${id}`, at));
    db.prepare('UPDATE playlists SET track_count = track_count + ?, updated_at = ? WHERE id = ?').run(ids.length, at, playlistId);
  });
  tx();
  void snapshot; // the next sync picks up Spotify's new snapshot and confirms the order
  return ids.length;
}

// ---------- removing Spotify songs from Spotify playlists ----------

export interface PlaylistRemoval {
  /** Distinct songs sent to Spotify. */
  tracks: number;
  /** Local rows removed; a song held more than once counts once per copy. */
  copies: number;
}

/**
 * Remove Spotify songs from a synced Spotify playlist the user may edit, on Spotify
 * itself, then mirror the change locally. Spotify's DELETE /playlists/{id}/items
 * (the old /tracks path answers 403 since February 2026) takes `{items:[{uri}]}`
 * and removes *every* copy of a URI, so the local mirror drops every copy too.
 * The playlist's snapshot_id is sent when known and updated from the response.
 *
 * Liked Songs is not a playlist edit: unlike through setTracksLiked instead.
 */
export async function removeTracksFromSpotifyPlaylist(
  api: PlaylistWriteApi,
  db: Db,
  playlistId: string,
  trackIds: string[],
  opts: { now?: () => number } = {},
): Promise<PlaylistRemoval> {
  ensureSpotifySchema(db);
  ensureSpotifyLibrarySchema(db);
  const now = opts.now ?? Date.now;
  if (playlistId === LIKED_SONGS_PLAYLIST_ID) {
    throw new Error('Liked Songs removals are unlikes: use setTracksLiked(..., false)');
  }
  const ids = [
    ...new Set(
      trackIds
        .filter((id) => id.startsWith('sp:'))
        .map((id) => id.slice(3))
        .filter(Boolean),
    ),
  ];
  if (ids.length === 0) return { tracks: 0, copies: 0 };

  const localIds = ids.map((id) => `sp:${id}`);
  const copies = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM playlist_tracks
         WHERE playlist_id = ? AND track_id IN (${localIds.map(() => '?').join(',')})`,
      )
      .get(playlistId, ...localIds) as { n: number }
  ).n;

  const spId = playlistId.startsWith('pl:sp:') ? playlistId.slice(6) : playlistId;
  const stored = db
    .prepare('SELECT snapshot_id FROM playlists WHERE id = ?')
    .get(playlistId) as { snapshot_id: string | null } | undefined;
  let snapshot = stored?.snapshot_id ?? undefined;
  for (let i = 0; i < ids.length; i += 100) {
    const body: { items: { uri: string }[]; snapshot_id?: string } = {
      items: ids.slice(i, i + 100).map((id) => ({ uri: `spotify:track:${id}` })),
      ...(snapshot ? { snapshot_id: snapshot } : {}),
    };
    const res = await api.request<{ snapshot_id?: string } | undefined>(
      `/playlists/${encodeURIComponent(spId)}/items`,
      { method: 'DELETE', body },
    );
    snapshot = res?.snapshot_id ?? snapshot;
  }

  const at = now();
  const tx = db.transaction(() => {
    const del = db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?');
    for (const id of localIds) del.run(playlistId, id);
    // Removing rows leaves gaps: renumber the survivors densely (same as unliking).
    const rows = db
      .prepare('SELECT position FROM playlist_tracks WHERE playlist_id = ? ORDER BY position')
      .all(playlistId) as { position: number }[];
    const move = db.prepare('UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND position = ?');
    rows.forEach((row, index) => {
      if (row.position !== index) move.run(index, playlistId, row.position);
    });
    db.prepare('UPDATE playlists SET track_count = ?, snapshot_id = ?, updated_at = ? WHERE id = ?').run(
      rows.length,
      snapshot ?? null,
      at,
      playlistId,
    );
  });
  tx();
  return { tracks: ids.length, copies };
}

// ---------- Liked Songs: local reads + like/unlike ----------

/**
 * Which of these track ids (the `sp:<id>` form used across rune) are in the local
 * Liked Songs table? Reads the synced playlist, never Spotify — the point of the
 * mirror is that "is it liked?" is free against the daily request budget.
 */
export function likedTrackIds(db: Db, trackIds: string[]): string[] {
  ensureSpotifyLibrarySchema(db);
  const ids = [...new Set(trackIds.filter((id) => id.startsWith('sp:')))];
  const out: string[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const rows = db
      .prepare(
        `SELECT track_id FROM playlist_tracks
         WHERE playlist_id = ? AND track_id IN (${part.map(() => '?').join(',')})`,
      )
      .all(LIKED_SONGS_PLAYLIST_ID, ...part) as { track_id: string }[];
    for (const row of rows) out.push(row.track_id);
  }
  return out;
}

export interface LikedWriteApi {
  request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
  tracks(ids: string[]): Promise<SpotifyTrack[]>;
  saveTracks(ids: string[]): Promise<void>;
  removeSavedTracks(ids: string[]): Promise<void>;
}

export interface LikedWriteResult {
  liked: boolean;
  /** Songs whose Spotify/Liked Songs state actually changed (0 when it already matched). */
  changed: number;
}

/**
 * Like or unlike Spotify songs. Only songs whose local state differs are sent, so
 * pressing a heart that is already in the right state costs no Spotify request;
 * changes go out in batches of 50 through the shared API client (budget counters,
 * 429 Retry-After and the lockout all apply). The Liked Songs mirror is updated in
 * the same call: newest first on add, dense positions on remove.
 */
export async function setTracksLiked(
  api: LikedWriteApi,
  db: Db,
  trackIds: string[],
  liked: boolean,
  opts: { now?: () => number } = {},
): Promise<LikedWriteResult> {
  ensureSpotifySchema(db);
  ensureSpotifyLibrarySchema(db);
  const now = opts.now ?? Date.now;
  const ids = [
    ...new Set(
      trackIds
        .filter((id) => id.startsWith('sp:'))
        .map((id) => id.slice(3))
        .filter(Boolean),
    ),
  ];
  if (ids.length === 0) return { liked, changed: 0 };

  const have = new Set(likedTrackIds(db, ids.map((id) => `sp:${id}`)));
  const changing = ids.filter((id) => have.has(`sp:${id}`) !== liked);
  if (changing.length === 0) return { liked, changed: 0 };

  const at = now();
  if (liked) {
    await addTracksToSpotifyPlaylist(
      api,
      db,
      LIKED_SONGS_PLAYLIST_ID,
      changing.map((id) => `sp:${id}`),
      { now },
    );
  } else {
    for (let i = 0; i < changing.length; i += 40) await api.removeSavedTracks(changing.slice(i, i + 40));
    const tx = db.transaction(() => {
      const del = db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?');
      for (const id of changing) del.run(LIKED_SONGS_PLAYLIST_ID, `sp:${id}`);
      // Removing rows leaves gaps: renumber the survivors densely. Targets are
      // always ≤ the row's current position and no later row sits on a target, so
      // this cannot collide with an existing primary key.
      const rows = db
        .prepare('SELECT position FROM playlist_tracks WHERE playlist_id = ? ORDER BY position')
        .all(LIKED_SONGS_PLAYLIST_ID) as { position: number }[];
      const move = db.prepare('UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND position = ?');
      rows.forEach((row, index) => {
        if (row.position !== index) move.run(index, LIKED_SONGS_PLAYLIST_ID, row.position);
      });
      db.prepare('UPDATE playlists SET track_count = ?, updated_at = ? WHERE id = ?').run(
        rows.length,
        at,
        LIKED_SONGS_PLAYLIST_ID,
      );
    });
    tx();
  }

  rememberLocalLikedChange(db, at);
  return { liked, changed: changing.length };
}

/**
 * A heart press already told Spotify and the mirror is correct, so record the
 * Liked Songs probe stamp the next sync will compare against. This keeps a local
 * like/unlike from triggering the ~100-request full Liked Songs pass. If the guess
 * (count + newest added_at to the second) does not match Spotify's probe, the next
 * sync just does the full pass as usual — nothing is skipped that was not already
 * reflected locally.
 */
function rememberLocalLikedChange(db: Db, at: number): void {
  // Only once the mirror exists: writing a stamp before the first sync would make
  // the next sync skip Liked Songs entirely.
  if (!db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(LIKED_SONGS_PLAYLIST_ID)) return;
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n, MAX(added_at) AS newest FROM playlist_tracks WHERE playlist_id = ?',
    )
    .get(LIKED_SONGS_PLAYLIST_ID) as { n: number; newest: number | null };
  const newest = row.newest == null ? undefined : new Date(row.newest).toISOString().replace(/\.\d{3}Z$/, 'Z');
  ensureAppState(db);
  setAppState(db, LIKED_STAMP_KEY, likedStamp(row.n, newest));
  setAppState(db, LIKED_FULL_AT_KEY, String(at));
}
