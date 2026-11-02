// Browse-page queries: all tracks, genre / label / year facets and genre album lists.
//
// Read-only. Every track is mapped by hand (never via SELECT *) so the local file
// path can never leak to a client. Route paths are registered without the /api
// prefix; the main server mounts this plugin under /api.
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { AlbumSummary, ArtistRef, Id, Page, Track } from '@liner/shared';
import type { Db } from '../db/index.js';
import { coverUrlFor } from './cover.js';

const migrationSql = readFileSync(new URL('../db/migrations-browse.sql', import.meta.url), 'utf8');

/** A track plus the album fields the Tracks page needs in one round-trip. */
export interface BrowseTrack extends Track {
  album: { id: Id; title: string; coverUrl?: string };
}

export interface GenreFacet {
  genre: string;
  albumCount: number;
  /** Up to four album ids (newest first) that have artwork, for the genre tile. */
  coverAlbumIds: Id[];
}

export interface LabelFacet {
  label: string;
  albumCount: number;
}

export interface YearFacet {
  year: number;
  albumCount: number;
  /** Decade start (e.g. 1970), so the Years page can group by decade. */
  decade: number;
}

/** Fastify's default parser yields an array for repeated keys (`?q=a&q=b`). */
type Query = Record<string, string | string[] | undefined>;

function queryValue(q: Query, key: string): string | undefined {
  const v = q[key];
  return Array.isArray(v) ? v[0] : v;
}

interface TrackRow {
  id: string;
  album_id: string;
  source: string;
  title: string;
  disc: number;
  number: number;
  duration_ms: number;
  cue_start_ms: number | null;
  cue_end_ms: number | null;
  format: string | null;
  sample_rate: number | null;
  bit_depth: number | null;
  bitrate_kbps: number | null;
  spotify_uri: string | null;
  album_title: string;
  album_artist_id: string | null;
  album_artist_name: string | null;
  cover_path: string | null;
}

interface AlbumRow {
  id: string;
  source: string;
  title: string;
  artist_id: string;
  artist_name: string | null;
  year: number | null;
  format: string | null;
  cover_path: string | null;
  added_at: number;
}

/** Same URL the rest of the API uses (`size` handled by the cover route). */
export function coverUrl(albumId: string): string {
  return `/api/cover/${encodeURIComponent(albumId)}?size=600`;
}

function albumSummary(r: AlbumRow): AlbumSummary {
  return {
    id: r.id,
    source: r.source === 'spotify' ? 'spotify' : 'local',
    title: r.title,
    artist: { id: r.artist_id, name: r.artist_name ?? 'Unknown Artist' },
    ...(r.year ? { year: r.year } : {}),
    ...(r.cover_path ? { coverUrl: coverUrlFor(r.id, r.cover_path) } : {}),
    ...(r.format ? { format: r.format } : {}),
    addedAt: r.added_at,
  };
}

const ALBUM_SELECT = `
  SELECT a.id, a.source, a.title, a.artist_id, ar.name AS artist_name, a.year,
         a.format, a.cover_path, a.added_at
  FROM albums a LEFT JOIN artists ar ON ar.id = a.artist_id`;

function hasColumn(db: Db, table: 'albums', column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

function pageParams(q: Query): { limit: number; offset: number } {
  const limitStr = queryValue(q, 'limit');
  const offsetStr = queryValue(q, 'offset');
  const rawLimit = limitStr == null || limitStr === '' ? undefined : Number(limitStr);
  const rawOffset = offsetStr == null || offsetStr === '' ? undefined : Number(offsetStr);
  const limit = rawLimit != null && Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 2000) : 100;
  const offset = rawOffset != null && Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0;
  return { limit, offset };
}

/** Escape LIKE metacharacters so a user's `%`/`_` stay literal. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** FTS5 prefix query: every word matches as a prefix (same rule as library search). */
export function ftsQuery(q: string): string | null {
  const words = q
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
  if (words.length === 0) return null;
  return words.map((w) => `"${w.replace(/"/g, '')}"*`).join(' ');
}

// ---------------------------------------------------------------- tracks

const TRACK_SORTS = ['title', 'artist', 'album', 'added', 'duration'] as const;
type TrackSort = (typeof TRACK_SORTS)[number];

function isTrackSort(v: string | undefined): v is TrackSort {
  return v != null && (TRACK_SORTS as readonly string[]).includes(v);
}

/** Name of a track's first credited artist, else the album artist. */
const PRIMARY_TRACK_ARTIST = `coalesce(
  (SELECT ar2.name FROM track_artists ta2 JOIN artists ar2 ON ar2.id = ta2.artist_id
   WHERE ta2.track_id = t.id ORDER BY ta2.position LIMIT 1),
  ar.name, '')`;

function trackOrder(sort: TrackSort, dir: 'ASC' | 'DESC'): string {
  // The requested direction applies to the sort key only; tie-breakers stay
  // ascending so tracks of one album always read in disc/track order.
  switch (sort) {
    case 'artist':
      return `${PRIMARY_TRACK_ARTIST} COLLATE NOCASE ${dir}, a.title COLLATE NOCASE, t.disc, t.number, t.id`;
    case 'album':
      return `a.title COLLATE NOCASE ${dir}, t.disc, t.number, t.id`;
    case 'added':
      return `a.added_at ${dir}, t.disc, t.number, t.id`;
    case 'duration':
      return `t.duration_ms ${dir}, t.title COLLATE NOCASE, t.id`;
    case 'title':
    default:
      return `t.title COLLATE NOCASE ${dir}, t.id`;
  }
}

function trackDir(sort: TrackSort, raw: string | undefined): 'ASC' | 'DESC' {
  const v = raw?.toLowerCase();
  if (v === 'asc') return 'ASC';
  if (v === 'desc') return 'DESC';
  // Newest-first is the useful default for "added"; everything else reads A→Z.
  return sort === 'added' ? 'DESC' : 'ASC';
}

function mapFormat(format: string | null): Track['format'] {
  const f = (format ?? '').toLowerCase();
  if (f.includes('flac')) return 'flac';
  if (f.includes('mp3')) return 'mp3';
  if (f.length > 0) return 'other';
  return undefined;
}

/** Artist credits for a page of track ids, in one query (avoids N+1). */
function trackArtists(db: Db, trackIds: string[]): Map<string, ArtistRef[]> {
  const out = new Map<string, ArtistRef[]>();
  if (trackIds.length === 0) return out;
  const placeholders = trackIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT ta.track_id AS track_id, ar.id AS id, ar.name AS name
       FROM track_artists ta JOIN artists ar ON ar.id = ta.artist_id
       WHERE ta.track_id IN (${placeholders})
       ORDER BY ta.track_id, ta.position`,
    )
    .all(...trackIds) as { track_id: string; id: string; name: string }[];
  for (const r of rows) {
    let list = out.get(r.track_id);
    if (!list) {
      list = [];
      out.set(r.track_id, list);
    }
    list.push({ id: r.id, name: r.name });
  }
  return out;
}

function browseTrack(r: TrackRow, artists: ArtistRef[]): BrowseTrack {
  let cue: Track['cue'];
  if (r.cue_start_ms != null) {
    const startMs = r.cue_start_ms;
    const endMs = r.cue_end_ms ?? startMs + r.duration_ms;
    cue = { startMs, endMs };
  }
  const albumArtist: ArtistRef[] =
    r.album_artist_id && r.album_artist_name ? [{ id: r.album_artist_id, name: r.album_artist_name }] : [];
  const format = mapFormat(r.format);
  return {
    id: r.id,
    albumId: r.album_id,
    source: r.source === 'spotify' ? 'spotify' : 'local',
    title: r.title,
    artists: artists.length > 0 ? artists : albumArtist,
    disc: r.disc,
    number: r.number,
    durationMs: cue ? Math.max(0, cue.endMs - cue.startMs) : r.duration_ms,
    ...(format ? { format } : {}),
    ...(r.sample_rate != null ? { sampleRate: r.sample_rate } : {}),
    ...(r.bit_depth != null ? { bitDepth: r.bit_depth } : {}),
    ...(r.bitrate_kbps != null ? { bitrateKbps: r.bitrate_kbps } : {}),
    ...(cue ? { cue } : {}),
    ...(r.spotify_uri ? { spotifyUri: r.spotify_uri } : {}),
    album: {
      id: r.album_id,
      title: r.album_title,
      ...(r.cover_path ? { coverUrl: coverUrlFor(r.album_id, r.cover_path) } : {}),
    },
  };
}

export function listTracks(db: Db, q: Query, libFilter: string): Page<BrowseTrack> {
  const sortRaw = queryValue(q, 'sort');
  const sort: TrackSort = isTrackSort(sortRaw) ? sortRaw : 'title';
  const dir = trackDir(sort, queryValue(q, 'dir'));
  const { limit, offset } = pageParams(q);

  const where = [libFilter];
  const args: unknown[] = [];
  const text = queryValue(q, 'q')?.trim();
  if (text) {
    const like = `%${escapeLike(text)}%`;
    const esc = `ESCAPE '\\'`;
    const conds = [
      `t.title LIKE ? ${esc}`,
      `a.title LIKE ? ${esc}`,
      `ar.name LIKE ? ${esc}`,
      `EXISTS (SELECT 1 FROM track_artists ta3 JOIN artists ar3 ON ar3.id = ta3.artist_id
               WHERE ta3.track_id = t.id AND ar3.name LIKE ? ${esc})`,
    ];
    args.push(like, like, like, like);
    const fts = ftsQuery(text);
    if (fts) {
      conds.push(
        `t.id IN (SELECT ref_id FROM search_fts WHERE search_fts MATCH ? AND kind = 'track')`,
        `t.album_id IN (SELECT ref_id FROM search_fts WHERE search_fts MATCH ? AND kind = 'album')`,
      );
      args.push(fts, fts);
    }
    where.push(`(${conds.join(' OR ')})`);
  }

  const from = `FROM tracks t
    JOIN albums a ON a.id = t.album_id
    LEFT JOIN artists ar ON ar.id = a.artist_id
    WHERE ${where.join(' AND ')}`;

  const total = (db.prepare(`SELECT count(*) AS n ${from}`).get(...args) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT t.id, t.album_id, t.source, t.title, t.disc, t.number, t.duration_ms,
              t.cue_start_ms, t.cue_end_ms, t.format, t.sample_rate, t.bit_depth,
              t.bitrate_kbps, t.spotify_uri,
              a.title AS album_title, a.cover_path,
              a.artist_id AS album_artist_id, ar.name AS album_artist_name
       ${from}
       ORDER BY ${trackOrder(sort, dir)}
       LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset) as TrackRow[];

  const credits = trackArtists(
    db,
    rows.map((r) => r.id),
  );
  return { items: rows.map((r) => browseTrack(r, credits.get(r.id) ?? [])), total };
}

// ---------------------------------------------------------------- genres

/** Title Case for display: "pop punk" → "Pop Punk", "r&b" → "R&B", "IDM" → "IDM". */
export function titleCase(s: string): string {
  return s
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word.replace(/[^\s/&-]+/g, (part) => {
        if (/^[A-Z]{2,3}$/.test(part)) return part; // short acronyms / initialisms
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      }),
    )
    .join(' ');
}

function mostCommon(counts: Map<string, number>): string {
  let best = '';
  let bestCount = -1;
  for (const [text, count] of counts) {
    if (count > bestCount || (count === bestCount && text < best)) {
      best = text;
      bestCount = count;
    }
  }
  return best;
}

interface GenreAgg {
  displays: Map<string, number>;
  albums: Set<string>;
  covers: string[];
  coverSeen: Set<string>;
}

export function listGenres(db: Db, libFilter: string): GenreFacet[] {
  // Newest albums first so the first four with artwork become the tile covers.
  const rows = db
    .prepare(
      `SELECT a.id AS id, a.cover_path AS cover_path, a.added_at AS added_at, g.value AS value
       FROM albums a JOIN json_each(a.genres) g
       WHERE ${libFilter}
       ORDER BY a.added_at DESC`,
    )
    .all() as { id: string; cover_path: string | null; added_at: number; value: string | null }[];

  const aggs = new Map<string, GenreAgg>();
  for (const r of rows) {
    const original = (r.value ?? '').trim();
    if (!original) continue;
    const key = original.toLowerCase();
    let agg = aggs.get(key);
    if (!agg) {
      agg = { displays: new Map(), albums: new Set(), covers: [], coverSeen: new Set() };
      aggs.set(key, agg);
    }
    agg.albums.add(r.id);
    agg.displays.set(original, (agg.displays.get(original) ?? 0) + 1);
    if (r.cover_path && agg.covers.length < 4 && !agg.coverSeen.has(r.id)) {
      agg.coverSeen.add(r.id);
      agg.covers.push(r.id);
    }
  }

  const out: GenreFacet[] = [];
  for (const agg of aggs.values()) {
    out.push({
      genre: titleCase(mostCommon(agg.displays)),
      albumCount: agg.albums.size,
      coverAlbumIds: agg.covers,
    });
  }
  out.sort((a, b) => b.albumCount - a.albumCount || a.genre.localeCompare(b.genre, undefined, { sensitivity: 'base' }));
  return out;
}

const ALBUM_SORTS = ['added', 'artist', 'title', 'year'] as const;
type AlbumSort = (typeof ALBUM_SORTS)[number];

function isAlbumSort(v: string | undefined): v is AlbumSort {
  return v != null && (ALBUM_SORTS as readonly string[]).includes(v);
}

function albumOrder(sort: AlbumSort, dir: 'ASC' | 'DESC'): string {
  switch (sort) {
    case 'title':
      return `a.title COLLATE NOCASE ${dir}, a.id`;
    case 'year':
      return `a.year ${dir} NULLS LAST, a.title COLLATE NOCASE, a.id`;
    case 'added':
      return `a.added_at ${dir}, a.title COLLATE NOCASE, a.id`;
    case 'artist':
    default:
      return `coalesce(ar.sort_name, ar.name) COLLATE NOCASE ${dir}, a.year, a.title COLLATE NOCASE, a.id`;
  }
}

export function listGenreAlbums(db: Db, genreInput: string, q: Query, libFilter: string): Page<AlbumSummary> {
  const genre = genreInput.trim();
  const sortRaw = queryValue(q, 'sort');
  const sort: AlbumSort = isAlbumSort(sortRaw) ? sortRaw : 'artist';
  const dirRaw = queryValue(q, 'dir')?.toLowerCase();
  const dir: 'ASC' | 'DESC' = dirRaw === 'desc' ? 'DESC' : dirRaw === 'asc' ? 'ASC' : sort === 'added' ? 'DESC' : 'ASC';
  const { limit, offset } = pageParams(q);

  const where = [libFilter];
  const args: unknown[] = [];
  if (genre) {
    where.push(`EXISTS (SELECT 1 FROM json_each(a.genres) g WHERE lower(trim(g.value)) = lower(trim(?)))`);
    args.push(genre);
  } else {
    where.push('0 = 1'); // no genre given → empty page
  }
  const countFrom = `FROM albums a LEFT JOIN artists ar ON ar.id = a.artist_id WHERE ${where.join(' AND ')}`;
  const total = (db.prepare(`SELECT count(*) AS n ${countFrom}`).get(...args) as { n: number }).n;
  const rows = db
    .prepare(`${ALBUM_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${albumOrder(sort, dir)} LIMIT ? OFFSET ?`)
    .all(...args, limit, offset) as AlbumRow[];
  return { items: rows.map(albumSummary), total };
}

// ---------------------------------------------------------------- labels / years

export function listLabels(db: Db, libFilter: string): LabelFacet[] {
  const rows = db
    .prepare(
      `SELECT a.label AS label
       FROM albums a
       WHERE ${libFilter} AND a.label IS NOT NULL AND trim(a.label) <> ''`,
    )
    .all() as { label: string }[];

  const aggs = new Map<string, { count: number; displays: Map<string, number> }>();
  for (const r of rows) {
    const original = r.label.trim();
    const key = original.toLowerCase();
    let agg = aggs.get(key);
    if (!agg) {
      agg = { count: 0, displays: new Map() };
      aggs.set(key, agg);
    }
    agg.count += 1;
    agg.displays.set(original, (agg.displays.get(original) ?? 0) + 1);
  }

  const out: LabelFacet[] = [...aggs.values()].map((agg) => ({
    label: mostCommon(agg.displays),
    albumCount: agg.count,
  }));
  out.sort((a, b) => b.albumCount - a.albumCount || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  return out;
}

export function listYears(db: Db, libFilter: string): YearFacet[] {
  const rows = db
    .prepare(
      `SELECT a.year AS year, count(*) AS albumCount
       FROM albums a
       WHERE ${libFilter} AND a.year IS NOT NULL AND a.year > 0
       GROUP BY a.year
       ORDER BY a.year DESC`,
    )
    .all() as { year: number; albumCount: number }[];
  return rows.map((r) => ({
    year: r.year,
    albumCount: r.albumCount,
    decade: Math.floor(r.year / 10) * 10,
  }));
}

// ---------------------------------------------------------------- routes

/** Mount the browse routes (no /api prefix — the caller adds it). */
export function registerBrowseRoutes(app: FastifyInstance, db: Db): void {
  db.exec(migrationSql);

  // The Spotify-library worker may add albums.in_library; only browse saved albums
  // when it exists, otherwise every album in the table is browsable.
  const libFilter = hasColumn(db, 'albums', 'in_library') ? 'a.in_library = 1' : '1 = 1';

  app.get<{ Querystring: Query }>('/tracks', async (req) => listTracks(db, req.query ?? {}, libFilter));

  app.get('/genres', async () => listGenres(db, libFilter));

  app.get<{ Params: { genre: string }; Querystring: Query }>('/genres/:genre/albums', async (req) =>
    listGenreAlbums(db, req.params.genre, req.query ?? {}, libFilter),
  );

  app.get('/labels', async () => listLabels(db, libFilter));

  app.get('/years', async () => listYears(db, libFilter));
}
