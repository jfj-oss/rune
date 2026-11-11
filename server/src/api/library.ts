// Read-side library queries → shared types. Never leaks file paths to clients except
// album.folderPath (shown in "Copy folder path").
import type { Album, AlbumSummary, Artist, ArtistRef, Credit, Page, Track } from '@liner/shared';
import type { Db } from '../db/index.js';
import { ensureSpotifyLibrarySchema } from '../spotify/library-schema.js';
import { loadTrack } from '../play/rows.js';
import { albumNotHiddenSql } from '../library/dupes.js';
import { coverUrlFor } from './cover.js';

export interface AlbumListQuery {
  q?: string;
  source?: 'local' | 'spotify' | 'all';
  sort?: 'added' | 'artist' | 'title' | 'year';
  offset?: number;
  limit?: number;
  genre?: string;
  label?: string;
  year?: number;
  artistId?: string;
  /** Default true: only albums in the user's library (Spotify in_library = 1). */
  inLibrary?: boolean;
  /** Pinned albums before everything else (the Library grid). */
  pinnedFirst?: boolean;
}

interface AlbumRow {
  id: string;
  source: string;
  title: string;
  artist_id: string;
  artist_name: string | null;
  year: number | null;
  release_date: string | null;
  label: string | null;
  genres: string;
  format: string | null;
  folder_path: string | null;
  cover_path: string | null;
  mb_release_id: string | null;
  match_confidence: number | null;
  added_at: number;
  pinned_at: number | null;
}

const ALBUM_SELECT = `
  SELECT a.id, a.source, a.title, a.artist_id, ar.name AS artist_name, a.year, a.release_date,
         a.label, a.genres, a.format, a.folder_path, a.cover_path, a.mb_release_id,
         a.match_confidence, a.added_at, p.pinned_at
  FROM albums a LEFT JOIN artists ar ON ar.id = a.artist_id LEFT JOIN pins p ON p.item_id = a.id`;

// Kept here for existing callers; the helpers themselves live in cover.ts so the
// play/rows and myplaylists layers can use them without importing this module.
export { coverUrl, coverUrlFor } from './cover.js';

function summary(r: AlbumRow): AlbumSummary {
  const cover = coverUrlFor(r.id, r.cover_path);
  return {
    id: r.id,
    source: r.source === 'spotify' ? 'spotify' : 'local',
    title: r.title,
    artist: { id: r.artist_id, name: r.artist_name ?? 'Unknown Artist' },
    ...(r.year ? { year: r.year } : {}),
    ...(cover ? { coverUrl: cover } : {}),
    ...(r.format ? { format: r.format } : {}),
    addedAt: r.added_at,
    ...(r.pinned_at !== null && r.pinned_at !== undefined ? { pinned: true } : {}),
  };
}

/** Escape LIKE metacharacters so a user's `%`/`_` stay literal. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Query numbers arrive as text: keep a finite whole number, else use the fallback. */
function whole(v: number | undefined, fallback: number): number {
  return v !== undefined && Number.isFinite(v) ? Math.trunc(v) : fallback;
}

/** FTS5 prefix query from free text: every word must match as a prefix. */
export function ftsQuery(q: string): string | null {
  const words = q
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
  if (words.length === 0) return null;
  return words.map((w) => `"${w.replace(/"/g, '')}"*`).join(' ');
}

export function listAlbums(db: Db, q: AlbumListQuery): Page<AlbumSummary> {
  ensureSpotifyLibrarySchema(db);
  const where: string[] = [];
  const args: unknown[] = [];
  // Spotify albums that exist only because a playlist/search referenced them stay
  // addressable by id (getAlbum) but are not part of the library grid.
  if (q.inLibrary !== false) where.push('a.in_library = 1');
  // Albums the user hid from the duplicate finder never appear in grids or search.
  where.push(albumNotHiddenSql(db, 'a'));
  if (q.source && q.source !== 'all') {
    where.push('a.source = ?');
    args.push(q.source);
  }
  if (q.genre) {
    where.push('EXISTS (SELECT 1 FROM json_each(a.genres) g WHERE lower(g.value) = lower(?))');
    args.push(q.genre);
  }
  if (q.label) {
    where.push('lower(a.label) = lower(?)');
    args.push(q.label);
  }
  if (q.year) {
    where.push('a.year = ?');
    args.push(q.year);
  }
  if (q.artistId) {
    where.push('a.artist_id = ?');
    args.push(q.artistId);
  }
  if (q.q) {
    // albums matching directly, or whose artist / tracks match. The LIKE fallback also
    // covers queries with no FTS words (e.g. a lone "%"), which must not mean "everything".
    const fts = ftsQuery(q.q);
    const like = `%${escapeLike(q.q)}%`;
    const match = [
      `a.title LIKE ? ESCAPE '\\'`,
      `ar.name LIKE ? ESCAPE '\\'`,
    ];
    args.push(like, like);
    if (fts) {
      match.push(
        `a.id IN (SELECT ref_id FROM search_fts WHERE search_fts MATCH ? AND kind = 'album')`,
        `a.id IN (SELECT t.album_id FROM tracks t WHERE t.id IN (SELECT ref_id FROM search_fts WHERE search_fts MATCH ? AND kind = 'track'))`,
      );
      args.push(fts, fts);
    }
    where.push(`(${match.join(' OR ')})`);
  }
  const order =
    q.sort === 'artist'
      ? "coalesce(ar.sort_name, ar.name) COLLATE NOCASE, a.year, a.title COLLATE NOCASE"
      : q.sort === 'title'
        ? 'a.title COLLATE NOCASE'
        : q.sort === 'year'
          ? 'a.year DESC NULLS LAST, a.title COLLATE NOCASE'
          : 'a.added_at DESC, a.title COLLATE NOCASE';
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // Pinned albums first (newest pin on top), then the chosen sort.
  const orderBy = q.pinnedFirst ? `p.pinned_at IS NULL, p.pinned_at DESC, ${order}` : order;
  const limit = Math.min(Math.max(whole(q.limit, 100), 1), 2000);
  const offset = Math.max(whole(q.offset, 0), 0);
  const total = (db.prepare(`SELECT count(*) n FROM albums a LEFT JOIN artists ar ON ar.id = a.artist_id ${w}`).get(...args) as { n: number }).n;
  const rows = db.prepare(`${ALBUM_SELECT} ${w} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...args, limit, offset) as AlbumRow[];
  return { items: rows.map(summary), total };
}

/**
 * Album summaries for an explicit list of ids, in the caller's order. Unknown ids
 * are skipped. This is the batch behind GET /library/albums?ids= (the Home page
 * uses it instead of one /albums/:id request per card).
 */
export function albumsByIds(db: Db, ids: string[]): { items: AlbumSummary[]; total: number } {
  ensureSpotifyLibrarySchema(db);
  const unique = [...new Set(ids)];
  const byId = new Map<string, AlbumRow>();
  for (let i = 0; i < unique.length; i += 500) {
    const part = unique.slice(i, i + 500);
    if (part.length === 0) continue;
    const placeholders = part.map(() => '?').join(',');
    for (const row of db
      .prepare(`${ALBUM_SELECT} WHERE a.id IN (${placeholders})`)
      .all(...part) as AlbumRow[]) {
      byId.set(row.id, row);
    }
  }
  const items = ids
    .map((id) => byId.get(id))
    .filter((row): row is AlbumRow => row !== undefined)
    .map(summary);
  return { items, total: items.length };
}

/** Strip server-only fields (file path) from a track before sending it to a client. */
export function publicTrack(t: Track): Track {
  const { path: _p, ...rest } = t as Track & { path?: string };
  return rest;
}

export function getAlbum(db: Db, id: string): Album | undefined {
  const r = db.prepare(`${ALBUM_SELECT} WHERE a.id = ?`).get(id) as AlbumRow | undefined;
  if (!r) return undefined;
  const trackIds = db
    .prepare('SELECT id FROM tracks WHERE album_id = ? ORDER BY disc, number, title')
    .all(id) as { id: string }[];
  const tracks = trackIds.map((t) => loadTrack(db, t.id)).filter((t): t is Track => !!t).map(publicTrack);
  const credits = (
    db
      .prepare(
        `SELECT c.artist_id, ar.name, c.role, c.track_ids FROM credits c
         JOIN artists ar ON ar.id = c.artist_id WHERE c.album_id = ?`,
      )
      .all(id) as { artist_id: string; name: string; role: string; track_ids: string | null }[]
  ).map((c): Credit => ({
    artist: { id: c.artist_id, name: c.name },
    role: c.role,
    ...(c.track_ids ? { trackIds: JSON.parse(c.track_ids) as string[] } : {}),
  }));
  let genres: string[] = [];
  try {
    genres = JSON.parse(r.genres) as string[];
  } catch {
    /* keep empty */
  }
  return {
    ...summary(r),
    tracks,
    genres,
    ...(r.label ? { label: r.label } : {}),
    ...(r.release_date ? { releaseDate: r.release_date } : {}),
    credits,
    ...(r.mb_release_id ? { musicbrainzReleaseId: r.mb_release_id } : {}),
    ...(r.match_confidence != null ? { matchConfidence: r.match_confidence } : {}),
    ...(r.folder_path ? { folderPath: r.folder_path } : {}),
  };
}

export function getArtist(db: Db, id: string): Omit<Artist, 'bio'> | undefined {
  ensureSpotifyLibrarySchema(db);
  const a = db.prepare('SELECT id, name, mbid, image_path FROM artists WHERE id = ?').get(id) as
    | { id: string; name: string; mbid: string | null; image_path: string | null }
    | undefined;
  if (!a) return undefined;
  const own = (db.prepare(`${ALBUM_SELECT} WHERE a.artist_id = ? AND a.in_library = 1 ORDER BY a.year, a.title`).all(id) as AlbumRow[]).map(summary);
  const ownIds = new Set(own.map((x) => x.id));
  const appears = (
    db
      .prepare(
        `${ALBUM_SELECT} WHERE a.in_library = 1 AND a.id IN (
           SELECT t.album_id FROM track_artists ta JOIN tracks t ON t.id = ta.track_id WHERE ta.artist_id = ?
           UNION SELECT album_id FROM credits WHERE artist_id = ?)
         ORDER BY a.year, a.title`,
      )
      .all(id, id) as AlbumRow[]
  )
    .map(summary)
    .filter((x) => !ownIds.has(x.id));
  // "Similar" for now = artists sharing credits with this artist (cheap, local).
  const similar = db
    .prepare(
      `SELECT DISTINCT ar.id, ar.name FROM credits c1
       JOIN credits c2 ON c2.album_id = c1.album_id AND c2.artist_id != c1.artist_id
       JOIN artists ar ON ar.id = c2.artist_id
       WHERE c1.artist_id = ? AND EXISTS (SELECT 1 FROM albums x WHERE x.artist_id = ar.id AND x.in_library = 1)
       LIMIT 12`,
    )
    .all(id) as ArtistRef[];
  return {
    id: a.id,
    name: a.name,
    ...(a.image_path ? { imageUrl: `/api/artist-image/${encodeURIComponent(a.id)}` } : {}),
    albums: own,
    appearsOn: appears,
    similar,
    ...(a.mbid ? { musicbrainzArtistId: a.mbid } : {}),
  };
}

export function listArtists(db: Db, q?: string): { id: string; name: string; albumCount: number; coverAlbumId?: string }[] {
  ensureSpotifyLibrarySchema(db);
  const like = q ? `%${escapeLike(q)}%` : '%';
  return (
    db
      .prepare(
        `SELECT ar.id, ar.name, count(a.id) AS albumCount, max(a.id) AS coverAlbumId
         FROM artists ar JOIN albums a ON a.artist_id = ar.id AND a.in_library = 1
         WHERE ar.name LIKE ? ESCAPE '\\' GROUP BY ar.id ORDER BY coalesce(ar.sort_name, ar.name) COLLATE NOCASE`,
      )
      .all(like) as { id: string; name: string; albumCount: number; coverAlbumId: string }[]
  );
}

export function search(db: Db, q: string): { albums: AlbumSummary[]; artists: ArtistRef[]; tracks: Track[] } {
  ensureSpotifyLibrarySchema(db);
  const fts = ftsQuery(q);
  const like = `%${escapeLike(q)}%`;
  const albums = listAlbums(db, { q, limit: 12, sort: 'artist' }).items;
  const notHiddenX = albumNotHiddenSql(db, 'x');
  const notHiddenA = albumNotHiddenSql(db, 'a');
  const artists = db
    .prepare(
      `SELECT id, name FROM artists
       WHERE (name LIKE ? ESCAPE '\\' ${fts ? "OR id IN (SELECT ref_id FROM search_fts WHERE search_fts MATCH ? AND kind = 'artist')" : ''})
         AND EXISTS (SELECT 1 FROM albums x WHERE x.artist_id = artists.id AND x.in_library = 1 AND ${notHiddenX})
       ORDER BY (EXISTS (SELECT 1 FROM albums WHERE artist_id = artists.id)) DESC, length(name) LIMIT 8`,
    )
    .all(...(fts ? [like, fts] : [like])) as ArtistRef[];
  const trackIds = fts
    ? (db
        .prepare(
          `SELECT search_fts.ref_id FROM search_fts
           JOIN tracks t ON t.id = search_fts.ref_id
           JOIN albums a ON a.id = t.album_id AND a.in_library = 1 AND ${notHiddenA}
           WHERE search_fts MATCH ? AND search_fts.kind = 'track'
           ORDER BY search_fts.rank LIMIT 12`,
        )
        .all(fts) as { ref_id: string }[])
    : [];
  const tracks = trackIds.map((t) => loadTrack(db, t.ref_id)).filter((t): t is Track => !!t).map(publicTrack);
  return { albums, artists, tracks };
}

export function coverPath(db: Db, albumId: string): string | undefined {
  const r = db.prepare('SELECT cover_path FROM albums WHERE id = ?').get(albumId) as { cover_path: string | null } | undefined;
  return r?.cover_path ?? undefined;
}
