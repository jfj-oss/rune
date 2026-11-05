// Worker P — rune's own playlists (mixing local files and Spotify tracks).
//
// Rune playlists live in the same `playlists` / `playlist_tracks` tables as the
// synced Spotify playlists (worker F), distinguished by source = 'local' and
// id = 'pl:rune:<uuid>'. Smart playlists reuse the same row plus the rule columns
// added by db/migrations-myplaylists.sql.
//
// `registerMyPlaylistRoutes(app, db)` adds the mutating routes plus M3U8
// export/import. GET /playlists and GET /playlists/:id already exist in
// src/api/server.ts; the main session should call the exported
// `listAllPlaylists(db)` / `getPlaylistDetail(db, id)` there instead of adding
// duplicate routes (see the report for the exact two-line change).
import { playlistImageUrl } from './image.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PlaylistDetail, PlaylistSummary, PlaylistTrack, Track } from '@liner/shared';
import type { Db } from '../db/index.js';
import { coverUrlFor, publicTrack } from '../api/library.js';
import { loadTrack, loadTracks } from '../play/rows.js';
import { buildM3u8, m3u8Filename, parseM3u8, resolveImportEntry } from './m3u.js';
import {
  addOverlayTracks,
  deleteOverlayEntries,
  ensureOverlaySchema,
  mergedEntries,
  moveOverlayEntry,
  overlayCount,
  OverlayConflictError,
  OverlayInputError,
  type MergedEntry,
} from './overlay.js';
import {
  createSmartSession,
  evaluateSmartSpec,
  parseLimit,
  parseSort,
  PlaylistInputError,
  validateSmartSpec,
  type SmartRule,
  type SmartSession,
  type SmartSpec,
} from './rules.js';
import { ensureMyPlaylistSchema } from './schema.js';

export const RUNE_PLAYLIST_PREFIX = 'pl:rune:';
/** Rune playlists sort before Spotify's (whose positions start at 0). */
const RUNE_POSITION_BASE = -1_000_000;

export class PlaylistNotFoundError extends Error {}
export class PlaylistConflictError extends Error {}

export interface RunePlaylistSummary extends PlaylistSummary {
  /** 'static' (manual track list) or 'smart' (rules evaluated on every read). */
  kind?: 'static' | 'smart';
  /**
   * Up to four distinct album ids, in track order, for a 2×2 cover mosaic.
   * Present for rune playlists only; Spotify playlists keep `imageUrl`.
   */
  coverAlbumIds?: string[];
}

export interface RunePlaylistDetail extends PlaylistDetail {
  kind?: 'static' | 'smart';
  coverAlbumIds?: string[];
}

interface PlaylistRow {
  id: string;
  source: string;
  name: string;
  description: string | null;
  owner: string | null;
  image_url: string | null;
  track_count: number;
  position: number;
  kind: string | null;
  rules: string | null;
  match_mode: string | null;
  sort: string | null;
  limit_count: number | null;
}

const SELECT_PLAYLIST = `
  SELECT id, source, name, description, owner, image_url, track_count, position,
         kind, rules, match_mode, sort, limit_count
    FROM playlists`;

interface Entry {
  trackId: string;
  addedAt: number | null;
}

// ---------------------------------------------------------------- validation

function requireName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PlaylistInputError('name required');
  }
  const name = value.trim();
  if (name.length > 200) throw new PlaylistInputError('name too long (max 200)');
  return name;
}

function optionalDescription(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new PlaylistInputError('description must be a string');
  const description = value.trim();
  if (description.length > 5000) throw new PlaylistInputError('description too long (max 5000)');
  return description === '' ? null : description;
}

function parseTrackIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PlaylistInputError('trackIds must be a non-empty array');
  }
  return value.map((id, i) => {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new PlaylistInputError(`trackIds[${i}] must be a track id`);
    }
    return id.trim();
  });
}

function parsePosition(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new PlaylistInputError('position must be a non-negative integer');
  }
  return value;
}

function parseIndex(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new PlaylistInputError(`${what} must be a non-negative integer`);
  }
  return value;
}

// ---------------------------------------------------------------- db helpers

function getRow(db: Db, id: string): PlaylistRow | undefined {
  return db.prepare(`${SELECT_PLAYLIST} WHERE id = ?`).get(id) as PlaylistRow | undefined;
}

function isRune(row: PlaylistRow): boolean {
  return row.source === 'local' && row.id.startsWith(RUNE_PLAYLIST_PREFIX);
}

function isSmart(row: PlaylistRow): boolean {
  return isRune(row) && row.kind === 'smart';
}

function requireRune(db: Db, id: string): PlaylistRow {
  const row = getRow(db, id);
  if (!row) throw new PlaylistNotFoundError('playlist not found');
  if (!isRune(row)) throw new PlaylistConflictError('only rune playlists can be modified');
  return row;
}

function readEntries(db: Db, playlistId: string): Entry[] {
  return (
    db
      .prepare(
        'SELECT track_id, added_at FROM playlist_tracks WHERE playlist_id = ? ORDER BY position',
      )
      .all(playlistId) as { track_id: string; added_at: number | null }[]
  ).map((r) => ({ trackId: r.track_id, addedAt: r.added_at }));
}

/** Replace the playlist's ordered entries (positions 0..n-1). */
function writeEntries(db: Db, playlistId: string, entries: Entry[], now: number): void {
  db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(playlistId);
  const insert = db.prepare(
    'INSERT INTO playlist_tracks (playlist_id, position, track_id, added_at) VALUES (?, ?, ?, ?)',
  );
  entries.forEach((entry, position) =>
    insert.run(playlistId, position, entry.trackId, entry.addedAt),
  );
  db.prepare('UPDATE playlists SET track_count = ?, updated_at = ? WHERE id = ?').run(
    entries.length,
    now,
    playlistId,
  );
}

function nextPosition(db: Db): number {
  const row = db
    .prepare("SELECT MAX(position) AS p FROM playlists WHERE source = 'local' AND id LIKE 'pl:rune:%'")
    .get() as { p: number | null };
  return row.p === null ? RUNE_POSITION_BASE : row.p + 1;
}

function specFromRow(row: PlaylistRow): SmartSpec {
  let rules: SmartRule[] = [];
  if (row.rules) {
    try {
      const parsed: unknown = JSON.parse(row.rules);
      if (Array.isArray(parsed)) rules = parsed as SmartRule[];
    } catch {
      /* corrupted rules: evaluate as an empty (all tracks) smart playlist */
    }
  }
  const limit =
    row.limit_count !== null && Number.isInteger(row.limit_count) && row.limit_count > 0
      ? row.limit_count
      : undefined;
  return {
    rules,
    match: row.match_mode === 'any' ? 'any' : 'all',
    sort: row.sort ?? 'artist:asc',
    ...(limit !== undefined ? { limit } : {}),
  };
}

/**
 * Ordered track ids for any playlist row (smart rows are evaluated live; synced
 * Spotify rows include the user's local overlay entries at their resolved spots).
 */
function orderedTrackIds(db: Db, row: PlaylistRow, session?: SmartSession): string[] {
  if (isSmart(row)) return evaluateSmartSpec(db, specFromRow(row), session);
  if (isRune(row)) return readEntries(db, row.id).map((e) => e.trackId);
  return mergedEntries(db, row.id).map((e) => e.trackId);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Up to four distinct album ids in track order — the 2×2 mosaic. */
function mosaicAlbumIds(db: Db, trackIds: string[]): string[] {
  const albumByTrack = new Map<string, string>();
  for (const part of chunk(trackIds, 500)) {
    const placeholders = part.map(() => '?').join(',');
    for (const row of db
      .prepare(`SELECT id, album_id FROM tracks WHERE id IN (${placeholders})`)
      .all(...part) as { id: string; album_id: string }[]) {
      albumByTrack.set(row.id, row.album_id);
    }
  }
  const seen = new Set<string>();
  const albums: string[] = [];
  for (const id of trackIds) {
    const album = albumByTrack.get(id);
    if (!album || seen.has(album)) continue;
    seen.add(album);
    albums.push(album);
    if (albums.length === 4) break;
  }
  return albums;
}

function summaryFor(
  db: Db,
  row: PlaylistRow,
  trackIds: string[] | undefined,
): RunePlaylistSummary {
  const rune = isRune(row);
  const chosen = playlistImageUrl(db, row.id);
  const summary: RunePlaylistSummary = {
    id: row.id,
    name: row.name,
    ...(row.owner ? { owner: row.owner } : {}),
    ...(chosen ?? row.image_url ? { imageUrl: (chosen ?? row.image_url) as string } : {}),
    trackCount: rune ? (trackIds?.length ?? 0) : row.track_count + overlayCount(db, row.id),
    source: rune ? 'local' : 'spotify',
  };
  if (rune) {
    summary.kind = isSmart(row) ? 'smart' : 'static';
    summary.coverAlbumIds = mosaicAlbumIds(db, trackIds ?? []);
  }
  return summary;
}

function toPlaylistTracks(
  db: Db,
  entries: (string | MergedEntry | { trackId: string; addedAt: number | null })[],
): PlaylistTrack[] {
  const items = entries.map((entry) =>
    typeof entry === 'string' ? { trackId: entry } : entry,
  );
  // One batched query for every track (and its artists), one for every album,
  // instead of two queries per playlist entry. loadTracks keeps the requested
  // order and duplicates; unknown (dangling) ids are skipped.
  const loaded = loadTracks(
    db,
    items.map((item) => item.trackId),
  );
  const trackById = new Map(loaded.map((track) => [track.id, track]));

  const albumIds = [...new Set(loaded.map((track) => track.albumId))];
  const albumById = new Map<string, { title: string | null; cover_path: string | null }>();
  for (const part of chunk(albumIds, 500)) {
    if (part.length === 0) continue;
    const placeholders = part.map(() => '?').join(',');
    for (const row of db
      .prepare(`SELECT id, title, cover_path FROM albums WHERE id IN (${placeholders})`)
      .all(...part) as { id: string; title: string | null; cover_path: string | null }[]) {
      albumById.set(row.id, row);
    }
  }

  const tracks: PlaylistTrack[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const item = items[i]!;
    const track = trackById.get(item.trackId);
    if (!track) continue; // dangling entry (track/album removed) — skip it
    const album = albumById.get(track.albumId);
    const coverUrl = coverUrlFor(track.albumId, album?.cover_path, 200);
    const playlistTrack: PlaylistTrack = {
      ...(publicTrack(track) as Track),
      album: {
        id: track.albumId,
        title: album?.title ?? '',
        ...(coverUrl ? { coverUrl } : {}),
      },
    };
    if (typeof entry !== 'string' && 'entryId' in entry) {
      playlistTrack.entrySource = entry.entrySource;
      playlistTrack.entryId = entry.entryId;
    }
    if (typeof entry !== 'string' && entry.addedAt != null) playlistTrack.addedAt = entry.addedAt;
    tracks.push(playlistTrack);
  }
  return tracks;
}

/** Merged entries for a synced Spotify playlist (overlay entries included). */
function spotifyMergedEntries(db: Db, playlistId: string): MergedEntry[] {
  return mergedEntries(db, playlistId);
}

// ---------------------------------------------------------------- reads

/**
 * GET /api/playlists — rune playlists first (creation order), then the synced
 * Spotify playlists in Spotify's order. This is the function the existing route
 * in src/api/server.ts should call.
 */
export function listAllPlaylists(db: Db): RunePlaylistSummary[] {
  ensureMyPlaylistSchema(db);
  const rows = db
    .prepare(
      `${SELECT_PLAYLIST}
       ORDER BY CASE WHEN source = 'local' THEN 0 ELSE 1 END, position, name COLLATE NOCASE`,
    )
    .all() as PlaylistRow[];
  // Every smart playlist evaluates the same whole-library candidate set; load it
  // once for the request instead of once per smart row.
  const session = rows.some(isSmart) ? createSmartSession(db) : undefined;
  return rows.map((row) =>
    summaryFor(db, row, isRune(row) ? orderedTrackIds(db, row, session) : undefined),
  );
}

/** GET /api/playlists/:id — metadata + ordered tracks (smart playlists live). */
export function getPlaylistDetail(db: Db, id: string): RunePlaylistDetail | undefined {
  ensureMyPlaylistSchema(db);
  const row = getRow(db, id);
  if (!row) return undefined;
  if (!isRune(row)) {
    // Synced Spotify playlist: merge the user's local overlay entries in place.
    return {
      ...summaryFor(db, row, undefined),
      ...(row.description ? { description: row.description } : {}),
      tracks: toPlaylistTracks(db, spotifyMergedEntries(db, row.id)),
    };
  }
  const trackIds = orderedTrackIds(db, row);
  const summary = summaryFor(db, row, trackIds);
  return {
    ...summary,
    ...(row.description ? { description: row.description } : {}),
    // static playlists carry each entry's added date (smart ones are computed live)
    tracks: toPlaylistTracks(db, isSmart(row) ? trackIds : readEntries(db, row.id)),
  };
}

// ---------------------------------------------------------------- create/patch/delete

export interface CreatePlaylistBody {
  name?: unknown;
  description?: unknown;
}

function insertPlaylist(
  db: Db,
  opts: {
    name: string;
    description: string | null;
    kind: 'static' | 'smart';
    spec?: SmartSpec;
  },
): string {
  const id = `${RUNE_PLAYLIST_PREFIX}${randomUUID()}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO playlists
       (id, source, name, description, owner, image_url, snapshot_id, track_count,
        position, updated_at, kind, rules, match_mode, sort, limit_count, created_at)
     VALUES (?, 'local', ?, ?, NULL, NULL, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.name,
    opts.description,
    nextPosition(db),
    now,
    opts.kind,
    opts.spec ? JSON.stringify(opts.spec.rules) : null,
    opts.spec?.match ?? 'all',
    opts.spec?.sort ?? null,
    opts.spec?.limit ?? null,
    now,
  );
  return id;
}

export function createPlaylist(db: Db, body: CreatePlaylistBody): RunePlaylistDetail {
  ensureMyPlaylistSchema(db);
  const name = requireName(body?.name);
  const description = optionalDescription(body?.description) ?? null;
  const id = insertPlaylist(db, { name, description, kind: 'static' });
  return getPlaylistDetail(db, id) as RunePlaylistDetail;
}

export interface UpdatePlaylistBody {
  name?: unknown;
  description?: unknown;
}

export function updatePlaylist(
  db: Db,
  id: string,
  body: UpdatePlaylistBody,
): RunePlaylistDetail {
  ensureMyPlaylistSchema(db);
  const row = requireRune(db, id);
  if (body.name === undefined && body.description === undefined) {
    throw new PlaylistInputError('name or description required');
  }
  const name = body.name === undefined ? row.name : requireName(body.name);
  const description =
    body.description === undefined ? row.description : (optionalDescription(body.description) ?? null);
  db.prepare('UPDATE playlists SET name = ?, description = ?, updated_at = ? WHERE id = ?').run(
    name,
    description,
    Date.now(),
    id,
  );
  return getPlaylistDetail(db, id) as RunePlaylistDetail;
}

export function deletePlaylist(db: Db, id: string): void {
  ensureMyPlaylistSchema(db);
  requireRune(db, id); // 404 unknown, 409 for synced Spotify playlists
  db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
}

// ---------------------------------------------------------------- smart create

export interface CreateSmartPlaylistBody {
  name?: unknown;
  rules?: unknown;
  match?: unknown;
  sort?: unknown;
  limit?: unknown;
}

export function createSmartPlaylist(db: Db, body: CreateSmartPlaylistBody): RunePlaylistDetail {
  ensureMyPlaylistSchema(db);
  const name = requireName(body?.name);
  const spec = validateSmartSpec(body);
  const id = insertPlaylist(db, { name, description: null, kind: 'smart', spec });
  return getPlaylistDetail(db, id) as RunePlaylistDetail;
}

// ---------------------------------------------------------------- static track edits

function assertStatic(row: PlaylistRow): void {
  if (isSmart(row)) {
    throw new PlaylistConflictError('smart playlist tracks are defined by rules');
  }
}

function requireExistingTracks(db: Db, trackIds: string[]): void {
  const existing = new Set<string>();
  for (const part of chunk([...new Set(trackIds)], 500)) {
    const placeholders = part.map(() => '?').join(',');
    for (const row of db
      .prepare(`SELECT id FROM tracks WHERE id IN (${placeholders})`)
      .all(...part) as { id: string }[]) {
      existing.add(row.id);
    }
  }
  const unknown = trackIds.filter((id) => !existing.has(id));
  if (unknown.length > 0) {
    throw new PlaylistInputError(`unknown track ids: ${[...new Set(unknown)].join(', ')}`);
  }
}

/** Map overlay-module errors onto the route error classes. */
function rethrowOverlay(err: unknown): never {
  if (err instanceof OverlayInputError) throw new PlaylistInputError(err.message);
  if (err instanceof OverlayConflictError) throw new PlaylistConflictError(err.message);
  throw err;
}

export interface AddTracksBody {
  trackIds?: unknown;
  position?: unknown;
}

export function addPlaylistTracks(
  db: Db,
  id: string,
  body: AddTracksBody,
): RunePlaylistDetail {
  ensureMyPlaylistSchema(db);
  const row = getRow(db, id);
  if (!row) throw new PlaylistNotFoundError('playlist not found');
  const trackIds = parseTrackIds(body?.trackIds);
  const position = parsePosition(body?.position);

  if (isRune(row)) {
    assertStatic(row);
    requireExistingTracks(db, trackIds);

    const tx = db.transaction(() => {
      const entries = readEntries(db, id);
      const at = position === undefined ? entries.length : Math.min(position, entries.length);
      const added: Entry[] = trackIds.map((trackId) => ({ trackId, addedAt: Date.now() }));
      entries.splice(at, 0, ...added);
      writeEntries(db, id, entries, Date.now());
    });
    tx();
  } else {
    // Synced Spotify playlist: keep local files in rune's overlay. Spotify tracks
    // would need Spotify write access (the API cannot add arbitrary songs anyway).
    if (trackIds.some((trackId) => trackId.startsWith('sp:'))) {
      throw new PlaylistConflictError(
        'adding Spotify songs to a Spotify playlist needs Spotify write access — coming later',
      );
    }
    requireExistingTracks(db, trackIds);
    try {
      addOverlayTracks(db, id, trackIds, position);
    } catch (err) {
      rethrowOverlay(err);
    }
  }
  return getPlaylistDetail(db, id) as RunePlaylistDetail;
}

export interface RemoveTracksBody {
  positions?: unknown;
  /** Overlay entries of a synced Spotify playlist are removed by stable entry id. */
  entryIds?: unknown;
}

function parseEntryIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new PlaylistInputError('entryIds must be an array');
  return value.map((id, i) => {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new PlaylistInputError(`entryIds[${i}] must be an entry id`);
    }
    return id.trim();
  });
}

function parsePositions(value: unknown): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new PlaylistInputError('positions must be an array');
  return value.map((p, i) => {
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 0) {
      throw new PlaylistInputError(`positions[${i}] must be a non-negative integer`);
    }
    return p;
  });
}

export function removePlaylistTracks(
  db: Db,
  id: string,
  body: RemoveTracksBody,
): RunePlaylistDetail {
  ensureMyPlaylistSchema(db);
  const row = getRow(db, id);
  if (!row) throw new PlaylistNotFoundError('playlist not found');

  if (isRune(row)) {
    assertStatic(row);
    if (!Array.isArray(body?.positions) || body.positions.length === 0) {
      throw new PlaylistInputError('positions must be a non-empty array');
    }
    const positions = parsePositions(body.positions);
    const tx = db.transaction(() => {
      const entries = readEntries(db, id);
      const drop = new Set(positions.filter((p) => p < entries.length));
      const kept = entries.filter((_, index) => !drop.has(index));
      writeEntries(db, id, kept, Date.now());
    });
    tx();
    return getPlaylistDetail(db, id) as RunePlaylistDetail;
  }

  // Synced Spotify playlist: only rune's overlay entries may be removed.
  const entries = spotifyMergedEntries(db, id);
  const entryIds = parseEntryIds(body?.entryIds);
  const positions = parsePositions(body?.positions);
  if (entryIds.length === 0 && positions.length === 0) {
    throw new PlaylistInputError('positions or entryIds must be a non-empty array');
  }
  const spotifyMessage =
    'Spotify tracks can only be removed in the Spotify app; remove local entries with entryId';
  const drop = new Set<string>();
  for (const position of positions) {
    if (position >= entries.length) continue;
    const entry = entries[position];
    if (!entry) continue;
    if (entry.entrySource !== 'rune-overlay') throw new PlaylistConflictError(spotifyMessage);
    drop.add(entry.entryId);
  }
  for (const entryId of entryIds) {
    const entry = entries.find((e) => e.entryId === entryId);
    if (!entry) throw new PlaylistInputError(`unknown entry id: ${entryId}`);
    if (entry.entrySource !== 'rune-overlay') throw new PlaylistConflictError(spotifyMessage);
    drop.add(entry.entryId);
  }
  deleteOverlayEntries(db, id, [...drop]);
  return getPlaylistDetail(db, id) as RunePlaylistDetail;
}

export interface MoveTrackBody {
  from?: unknown;
  to?: unknown;
}

export function movePlaylistTrack(
  db: Db,
  id: string,
  body: MoveTrackBody,
): RunePlaylistDetail {
  ensureMyPlaylistSchema(db);
  const row = getRow(db, id);
  if (!row) throw new PlaylistNotFoundError('playlist not found');
  const from = parseIndex(body?.from, 'from');
  const to = parseIndex(body?.to, 'to');

  if (isRune(row)) {
    assertStatic(row);
    const tx = db.transaction(() => {
      const entries = readEntries(db, id);
      if (from >= entries.length || to >= entries.length) {
        throw new PlaylistInputError('from/to out of range');
      }
      const [moved] = entries.splice(from, 1);
      if (!moved) throw new PlaylistInputError('from/to out of range');
      entries.splice(to, 0, moved);
      writeEntries(db, id, entries, Date.now());
    });
    tx();
  } else {
    // Overlay entries only: Spotify-owned rows cannot be reordered (409).
    try {
      moveOverlayEntry(db, id, from, to);
    } catch (err) {
      rethrowOverlay(err);
    }
  }
  return getPlaylistDetail(db, id) as RunePlaylistDetail;
}

/** Copy any playlist into a new rune playlist (smart copies keep their rules). */
export function duplicatePlaylist(db: Db, id: string): RunePlaylistDetail {
  ensureMyPlaylistSchema(db);
  const row = getRow(db, id);
  if (!row) throw new PlaylistNotFoundError('playlist not found');
  const copyName = `${row.name} copy`.slice(0, 200);

  const tx = db.transaction(() => {
    const newId = insertPlaylist(db, {
      name: copyName,
      description: row.description,
      kind: isSmart(row) ? 'smart' : 'static',
      ...(isSmart(row) ? { spec: specFromRow(row) } : {}),
    });
    if (!isSmart(row)) {
      // For a synced Spotify playlist this is the merged order, so the user's
      // local overlay entries are copied in place too.
      const entries = orderedTrackIds(db, row).map((trackId) => ({
        trackId,
        addedAt: Date.now(),
      }));
      writeEntries(db, newId, entries, Date.now());
    }
    return newId;
  });
  return getPlaylistDetail(db, tx()) as RunePlaylistDetail;
}

// ---------------------------------------------------------------- M3U8

export interface M3u8Export {
  name: string;
  filename: string;
  content: string;
  trackCount: number;
}

export function exportPlaylistM3u8(db: Db, id: string): M3u8Export | undefined {
  ensureMyPlaylistSchema(db);
  const row = getRow(db, id);
  if (!row) return undefined;
  const ids = orderedTrackIds(db, row);
  const tracks = ids
    .map((trackId) => loadTrack(db, trackId))
    .filter((t): t is Track => t !== undefined);
  return {
    name: row.name,
    filename: m3u8Filename(row.name),
    content: buildM3u8(row.name, tracks),
    trackCount: tracks.length,
  };
}

export interface ImportPlaylistResult extends RunePlaylistDetail {
  /** Entries resolved to tracks in the local DB. */
  imported: number;
  /** Entries that did not resolve (missing path / unknown Spotify id). */
  skipped: number;
  unmatched: string[];
}

export function importPlaylist(
  db: Db,
  content: string,
  opts: { name?: unknown; description?: unknown } = {},
): ImportPlaylistResult {
  ensureMyPlaylistSchema(db);
  const parsed = parseM3u8(content);
  const fallbackName = typeof opts.name === 'string' && opts.name.trim() ? opts.name : undefined;
  const name = requireName(fallbackName ?? parsed.name ?? 'Imported playlist');
  const description = optionalDescription(opts.description) ?? null;

  const resolved: string[] = [];
  const unmatched: string[] = [];
  for (const entry of parsed.entries) {
    const trackId = resolveImportEntry(db, entry);
    if (trackId) resolved.push(trackId);
    else unmatched.push(entry);
  }
  if (parsed.entries.length === 0) throw new PlaylistInputError('no tracks found in M3U8');

  const id = db.transaction(() => {
    const newId = insertPlaylist(db, { name, description, kind: 'static' });
    writeEntries(
      db,
      newId,
      resolved.map((trackId) => ({ trackId, addedAt: Date.now() })),
      Date.now(),
    );
    return newId;
  })();
  const detail = getPlaylistDetail(db, id) as RunePlaylistDetail;
  return { ...detail, imported: resolved.length, skipped: unmatched.length, unmatched };
}

// ---------------------------------------------------------------- routes

function sendInputError(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown): unknown {
  if (err instanceof PlaylistInputError) return reply.code(400).send({ error: err.message });
  if (err instanceof PlaylistNotFoundError) return reply.code(404).send({ error: err.message });
  if (err instanceof PlaylistConflictError) return reply.code(409).send({ error: err.message });
  throw err;
}

function registerTextParsers(app: FastifyInstance): void {
  for (const contentType of ['application/vnd.apple.mpegurl', 'audio/x-mpegurl', 'audio/mpegurl']) {
    if (app.hasContentTypeParser(contentType)) continue;
    app.addContentTypeParser(contentType, { parseAs: 'string' }, (_req, body, done) => {
      done(null, body);
    });
  }
}

/** Body for POST /playlists/import: JSON `{name?, description?, content}` or raw M3U8 text. */
function importBody(body: unknown): { content: string; name?: string; description?: unknown } {
  if (typeof body === 'string') {
    if (!body.trim()) throw new PlaylistInputError('M3U8 content required');
    return { content: body };
  }
  if (Buffer.isBuffer(body)) {
    const text = body.toString('utf8');
    if (!text.trim()) throw new PlaylistInputError('M3U8 content required');
    return { content: text };
  }
  if (body && typeof body === 'object') {
    const obj = body as { content?: unknown; name?: unknown; description?: unknown };
    if (typeof obj.content !== 'string' || !obj.content.trim()) {
      throw new PlaylistInputError('content required');
    }
    return {
      content: obj.content,
      ...(typeof obj.name === 'string' ? { name: obj.name } : {}),
      ...(obj.description !== undefined ? { description: obj.description } : {}),
    };
  }
  throw new PlaylistInputError('content required');
}

/**
 * Registers the rune-playlist routes. Call inside the /api prefix, next to the
 * other module registrations. GET /playlists and GET /playlists/:id are
 * intentionally NOT registered here (they already exist in api/server.ts); use
 * listAllPlaylists / getPlaylistDetail there instead.
 */
export interface MyPlaylistRouteOptions {
  /** Adds Spotify songs to a synced Spotify playlist on Spotify itself (and mirrors it locally). */
  addToSpotifyPlaylist?(playlistId: string, trackIds: string[]): Promise<void>;
}

export function registerMyPlaylistRoutes(app: FastifyInstance, db: Db, opts: MyPlaylistRouteOptions = {}): void {
  ensureMyPlaylistSchema(db);
  registerTextParsers(app);

  app.post<{ Body: CreatePlaylistBody }>('/playlists', (request, reply) => {
    try {
      reply.code(201);
      return createPlaylist(db, request.body ?? {});
    } catch (err) {
      return sendInputError(reply, err);
    }
  });

  // Live count for the smart-playlist builder (nothing is saved).
  app.post('/playlists/smart/preview', (request, reply) => {
    try {
      const ids = evaluateSmartSpec(db, validateSmartSpec(request.body ?? {}));
      const sample = ids.slice(0, 5).map((id) => loadTrack(db, id)).filter((t): t is NonNullable<typeof t> => !!t).map(publicTrack);
      return { count: ids.length, sample };
    } catch (err) {
      return sendInputError(reply, err);
    }
  });

  app.post<{ Body: CreateSmartPlaylistBody }>('/playlists/smart', (request, reply) => {
    try {
      reply.code(201);
      return createSmartPlaylist(db, request.body ?? {});
    } catch (err) {
      return sendInputError(reply, err);
    }
  });

  app.patch<{ Params: { id: string }; Body: UpdatePlaylistBody }>(
    '/playlists/:id',
    (request, reply) => {
      try {
        return updatePlaylist(db, request.params.id, request.body ?? {});
      } catch (err) {
        return sendInputError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/playlists/:id', (request, reply) => {
    try {
      deletePlaylist(db, request.params.id);
      return { deleted: true, id: request.params.id };
    } catch (err) {
      return sendInputError(reply, err);
    }
  });

  app.post<{ Params: { id: string }; Body: AddTracksBody }>(
    '/playlists/:id/tracks',
    async (request, reply) => {
      try {
        const id = request.params.id;
        const body = request.body ?? {};
        const row = getRow(db, id);
        // Synced Spotify playlist + Spotify songs: those go to the playlist on Spotify; local
        // files keep going to rune's overlay.
        if (row && !isRune(row) && opts.addToSpotifyPlaylist) {
          const ids = parseTrackIds(body.trackIds);
          const sp = ids.filter((t) => t.startsWith('sp:'));
          if (sp.length) {
            await opts.addToSpotifyPlaylist(id, sp);
            const local = ids.filter((t) => !t.startsWith('sp:'));
            if (local.length) return addPlaylistTracks(db, id, { ...body, trackIds: local, position: undefined });
            return getPlaylistDetail(db, id);
          }
        }
        return addPlaylistTracks(db, id, body);
      } catch (err) {
        return sendInputError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string }; Body: RemoveTracksBody }>(
    '/playlists/:id/tracks',
    (request, reply) => {
      try {
        return removePlaylistTracks(db, request.params.id, request.body ?? {});
      } catch (err) {
        return sendInputError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: MoveTrackBody }>(
    '/playlists/:id/move',
    (request, reply) => {
      try {
        return movePlaylistTrack(db, request.params.id, request.body ?? {});
      } catch (err) {
        return sendInputError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string } }>('/playlists/:id/duplicate', (request, reply) => {
    try {
      reply.code(201);
      return duplicatePlaylist(db, request.params.id);
    } catch (err) {
      return sendInputError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>('/playlists/:id/export.m3u8', (request, reply) => {
    const exported = exportPlaylistM3u8(db, request.params.id);
    if (!exported) return reply.code(404).send({ error: 'playlist not found' });
    return reply
      .header('content-disposition', `attachment; filename="${exported.filename}"`)
      .type('audio/x-mpegurl; charset=utf-8')
      .send(exported.content);
  });

  app.post<{ Body: unknown }>('/playlists/import', (request, reply) => {
    try {
      const body = importBody(request.body);
      reply.code(201);
      return importPlaylist(db, body.content, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      });
    } catch (err) {
      return sendInputError(reply, err);
    }
  });
}

// Re-exported for tests / the main session.
export { parseSort, parseLimit };
export { PlaylistInputError } from './rules.js';
export type { SmartRule, SmartSpec };
