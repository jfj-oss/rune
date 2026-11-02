// Worker X — listening statistics ("rune wrapped").
//
//   createStats(db, opts?) -> StatsService
//   registerStatsRoutes(app, db, opts?) adds (under /api; the caller mounts):
//     GET /stats/summary?period=7d|30d|365d|all
//     GET /stats/artist/:id?period=...
//     GET /stats/album/:id?period=...
//
// Only rows in the history module's `plays` table are counted — that table
// already contains counted plays only (>= 30 s or >= 50 % of the track), so
// stats never need to re-apply the threshold. The schema is ensured here too so
// the stats module can be wired without the history routes.
//
// Day/hour/weekday buckets use SQLite's 'localtime' modifier, which follows the
// server process's timezone — the same clock the user sees in the UI.
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { ensureHistorySchema } from '../history/index.js';
import type {
  AlbumStats,
  ArtistStats,
  DayStat,
  FormatShare,
  NewDiscovery,
  StatsPeriod,
  StatsSummary,
  TopAlbumStat,
  TopArtistStat,
  TopGenreStat,
  TopTrackStat,
} from './types.js';

const migration = readFileSync(new URL('../db/migrations-stats.sql', import.meta.url), 'utf8');

const DAY_MS = 24 * 60 * 60 * 1000;
const TOP_LIMIT = 10;
const GENRE_LIMIT = 8;
const DISCOVERY_LIMIT = 10;

export const STATS_PERIODS = ['7d', '30d', '365d', 'all'] as const;

export function isStatsPeriod(value: unknown): value is StatsPeriod {
  return typeof value === 'string' && (STATS_PERIODS as readonly string[]).includes(value);
}

/** Lower bound for a rolling period, or null for `all`. */
export function periodStart(period: StatsPeriod, now: number): number | null {
  switch (period) {
    case '7d':
      return now - 7 * DAY_MS;
    case '30d':
      return now - 30 * DAY_MS;
    case '365d':
      return now - 365 * DAY_MS;
    case 'all':
      return null;
  }
}

// Local-timezone bucket expressions (see file header).
const HOUR_EXPR = `CAST(strftime('%H', p.started_at / 1000, 'unixepoch', 'localtime') AS INTEGER)`;
const WEEKDAY_EXPR = `CAST(strftime('%w', p.started_at / 1000, 'unixepoch', 'localtime') AS INTEGER)`;
const DAY_EXPR = `strftime('%Y-%m-%d', p.started_at / 1000, 'unixepoch', 'localtime')`;

const LOSSLESS_FORMATS = `('flac','wav','alac','aiff')`;
const HIRES_CONDITION = `(t.format IN ${LOSSLESS_FORMATS} AND (COALESCE(t.sample_rate, 0) > 48000 OR COALESCE(t.bit_depth, 0) > 16))`;

export interface StatsService {
  summary(period?: StatsPeriod): StatsSummary;
  /** Null when the artist id is not in the library. */
  artist(id: string, period?: StatsPeriod): ArtistStats | null;
  /** Null when the album id is not in the library. */
  album(id: string, period?: StatsPeriod): AlbumStats | null;
}

export interface StatsOptions {
  /** Injectable clock (tests / deterministic periods). Default Date.now. */
  now?: () => number;
}

/** Idempotently create the history schema plus the stats indexes. */
export function ensureStatsSchema(db: Db): void {
  ensureHistorySchema(db);
  db.exec(migration);
}

interface TotalsRow {
  plays: number;
  totalMs: number;
  distinctAlbums: number;
  distinctArtists: number;
  losslessMs: number;
  hiResMs: number;
}

interface DayRow {
  date: string;
  ms: number;
}

interface BucketRow {
  bucket: number | null;
  ms: number;
}

interface AggregateRow {
  plays: number;
  totalMs: number;
  firstPlayedAt: number | null;
  lastPlayedAt: number | null;
}

interface AlbumRow {
  id: string;
  title: string;
  artist_id: string | null;
  artist_name: string | null;
}

interface ArtistRow {
  id: string;
  name: string;
}

/** `WHERE` for the plays of one entity / range. All queries alias plays as p. */
interface Filter {
  sql: string;
  args: unknown[];
}

function rangeFilter(from: number | null): Filter {
  return from === null
    ? { sql: '', args: [] }
    : { sql: 'WHERE p.started_at >= ?', args: [from] };
}

/** The period query param for a detail route (defaults to all-time). */
function detailPeriod(period: string | undefined): StatsPeriod {
  return isStatsPeriod(period) ? period : 'all';
}

function percent(part: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.round((part / total) * 1000) / 10;
}

function byDayRows(db: Db, fromSql: string, where: Filter): DayStat[] {
  const rows = db
    .prepare(
      `SELECT ${DAY_EXPR} AS date, COALESCE(SUM(p.played_ms), 0) AS ms
         FROM plays p ${fromSql} ${where.sql}
        GROUP BY date
        ORDER BY date`,
    )
    .all(...where.args) as DayRow[];
  return rows.map((r) => ({ date: r.date, ms: r.ms }));
}

function topAlbums(db: Db, where: Filter, limit = TOP_LIMIT): TopAlbumStat[] {
  return db
    .prepare(
      `SELECT p.album_id AS albumId,
              a.title AS title,
              ar.name AS artist,
              COUNT(*) AS plays,
              COALESCE(SUM(p.played_ms), 0) AS totalMs,
              MAX(p.started_at) AS lastPlayedAt
         FROM plays p
         JOIN albums a ON a.id = p.album_id
         LEFT JOIN artists ar ON ar.id = a.artist_id
        ${where.sql}
        GROUP BY p.album_id
        ORDER BY plays DESC, totalMs DESC, albumId ASC
        LIMIT ?`,
    )
    .all(...where.args, limit) as TopAlbumStat[];
}

function topArtists(db: Db, where: Filter, limit = TOP_LIMIT): TopArtistStat[] {
  return db
    .prepare(
      `SELECT a.artist_id AS artistId,
              ar.name AS name,
              COUNT(*) AS plays,
              COALESCE(SUM(p.played_ms), 0) AS totalMs,
              COUNT(DISTINCT p.album_id) AS albumCount
         FROM plays p
         JOIN albums a ON a.id = p.album_id
         JOIN artists ar ON ar.id = a.artist_id
        ${where.sql}
        GROUP BY a.artist_id
        ORDER BY plays DESC, totalMs DESC, artistId ASC
        LIMIT ?`,
    )
    .all(...where.args, limit) as TopArtistStat[];
}

function topTracks(db: Db, where: Filter, limit = TOP_LIMIT): TopTrackStat[] {
  return db
    .prepare(
      `SELECT p.track_id AS trackId,
              COALESCE(t.title, p.track_id) AS title,
              p.album_id AS albumId,
              a.title AS albumTitle,
              ar.name AS artist,
              COUNT(*) AS plays,
              COALESCE(SUM(p.played_ms), 0) AS totalMs,
              MAX(p.started_at) AS lastPlayedAt
         FROM plays p
         LEFT JOIN tracks t ON t.id = p.track_id
         LEFT JOIN albums a ON a.id = p.album_id
         LEFT JOIN artists ar ON ar.id = a.artist_id
        ${where.sql}
        GROUP BY p.track_id
        ORDER BY plays DESC, totalMs DESC, trackId ASC
        LIMIT ?`,
    )
    .all(...where.args, limit) as TopTrackStat[];
}

function topGenres(db: Db, where: Filter, limit = GENRE_LIMIT): TopGenreStat[] {
  // json_each over the album genre array; a play counts once per genre.
  return db
    .prepare(
      `SELECT MIN(trim(g.value)) AS genre,
              COUNT(*) AS plays,
              COALESCE(SUM(p.played_ms), 0) AS totalMs
         FROM plays p
         JOIN albums a ON a.id = p.album_id
         JOIN json_each(CASE WHEN json_valid(a.genres) THEN a.genres ELSE '[]' END) g
        ${where.sql ? `${where.sql} AND` : 'WHERE'} trim(g.value) <> ''
        GROUP BY lower(trim(g.value))
        ORDER BY plays DESC, totalMs DESC, genre ASC
        LIMIT ?`,
    )
    .all(...where.args, limit) as TopGenreStat[];
}

function newDiscoveries(db: Db, from: number | null, limit = DISCOVERY_LIMIT): NewDiscovery[] {
  // Compare against the *first ever* play, so the query must not restrict the
  // scan to the period: HAVING does that after MIN().
  const having = from === null ? '' : 'HAVING MIN(p.started_at) >= ?';
  const args: unknown[] = from === null ? [] : [from];
  return db
    .prepare(
      `SELECT a.artist_id AS artistId,
              ar.name AS name,
              MIN(p.started_at) AS firstPlayedAt,
              COUNT(*) AS plays
         FROM plays p
         JOIN albums a ON a.id = p.album_id
         JOIN artists ar ON ar.id = a.artist_id
        GROUP BY a.artist_id
        ${having}
        ORDER BY firstPlayedAt DESC, artistId ASC
        LIMIT ?`,
    )
    .all(...args, limit) as NewDiscovery[];
}

function entityAggregate(db: Db, fromSql: string, where: Filter): AggregateRow {
  return db
    .prepare(
      `SELECT COUNT(*) AS plays,
              COALESCE(SUM(p.played_ms), 0) AS totalMs,
              MIN(p.started_at) AS firstPlayedAt,
              MAX(p.started_at) AS lastPlayedAt
         FROM plays p ${fromSql} ${where.sql}`,
    )
    .get(...where.args) as AggregateRow;
}

export function createStats(db: Db, opts: StatsOptions = {}): StatsService {
  ensureStatsSchema(db);
  const now = opts.now ?? Date.now;

  function summary(period: StatsPeriod = '30d'): StatsSummary {
    const at = now();
    const from = periodStart(period, at);
    const where = rangeFilter(from);

    const totals = db
      .prepare(
        `SELECT COUNT(*) AS plays,
                COALESCE(SUM(p.played_ms), 0) AS totalMs,
                COUNT(DISTINCT p.album_id) AS distinctAlbums,
                COUNT(DISTINCT a.artist_id) AS distinctArtists,
                COALESCE(SUM(CASE WHEN t.format IN ${LOSSLESS_FORMATS} THEN p.played_ms ELSE 0 END), 0) AS losslessMs,
                COALESCE(SUM(CASE WHEN ${HIRES_CONDITION} THEN p.played_ms ELSE 0 END), 0) AS hiResMs
           FROM plays p
           LEFT JOIN albums a ON a.id = p.album_id
           LEFT JOIN tracks t ON t.id = p.track_id
          ${where.sql}`,
      )
      .get(...where.args) as TotalsRow;

    const byHour = new Array<number>(24).fill(0);
    const hourRows = db
      .prepare(
        `SELECT ${HOUR_EXPR} AS bucket, COALESCE(SUM(p.played_ms), 0) AS ms
           FROM plays p ${where.sql}
          GROUP BY bucket`,
      )
      .all(...where.args) as BucketRow[];
    for (const row of hourRows) {
      if (row.bucket !== null && row.bucket >= 0 && row.bucket < 24) {
        byHour[row.bucket] = row.ms;
      }
    }

    const byWeekday = new Array<number>(7).fill(0);
    const weekdayRows = db
      .prepare(
        `SELECT ${WEEKDAY_EXPR} AS bucket, COALESCE(SUM(p.played_ms), 0) AS ms
           FROM plays p ${where.sql}
          GROUP BY bucket`,
      )
      .all(...where.args) as BucketRow[];
    for (const row of weekdayRows) {
      if (row.bucket !== null && row.bucket >= 0 && row.bucket < 7) {
        byWeekday[row.bucket] = row.ms;
      }
    }

    const formats: FormatShare = {
      lossless: percent(totals.losslessMs, totals.totalMs),
      hiRes: percent(totals.hiResMs, totals.totalMs),
    };

    return {
      period,
      from,
      to: at,
      totalMs: totals.totalMs,
      plays: totals.plays,
      distinctAlbums: totals.distinctAlbums,
      distinctArtists: totals.distinctArtists,
      topAlbums: topAlbums(db, where),
      topArtists: topArtists(db, where),
      topTracks: topTracks(db, where),
      topGenres: topGenres(db, where),
      byHour,
      byWeekday,
      // The summary buckets ignore album joins (range only), so no alias issues.
      byDay: byDayRows(db, '', where),
      newDiscoveries: newDiscoveries(db, from),
      formats,
    };
  }

  function album(id: string, period?: StatsPeriod): AlbumStats | null {
    const row = db
      .prepare(
        `SELECT a.id, a.title, a.artist_id, ar.name AS artist_name
           FROM albums a
           LEFT JOIN artists ar ON ar.id = a.artist_id
          WHERE a.id = ?`,
      )
      .get(id) as AlbumRow | undefined;
    if (!row) return null;

    const at = now();
    const selected = detailPeriod(period);
    const from = periodStart(selected, at);
    const conds = ['p.album_id = ?'];
    const args: unknown[] = [id];
    if (from !== null) {
      conds.push('p.started_at >= ?');
      args.push(from);
    }
    const where: Filter = { sql: `WHERE ${conds.join(' AND ')}`, args };
    const aggregate = entityAggregate(db, '', where);

    return {
      albumId: row.id,
      title: row.title,
      artist: row.artist_id ? { id: row.artist_id, name: row.artist_name ?? 'Unknown Artist' } : null,
      from,
      to: at,
      plays: aggregate.plays,
      totalMs: aggregate.totalMs,
      firstPlayedAt: aggregate.firstPlayedAt ?? null,
      lastPlayedAt: aggregate.lastPlayedAt ?? null,
      byDay: byDayRows(db, '', where),
      topTracks: topTracks(db, where),
    };
  }

  function artist(id: string, period?: StatsPeriod): ArtistStats | null {
    const row = db.prepare('SELECT id, name FROM artists WHERE id = ?').get(id) as
      | ArtistRow
      | undefined;
    if (!row) return null;

    const at = now();
    const selected = detailPeriod(period);
    const from = periodStart(selected, at);
    // Artist plays come from the album's primary artist; the join is required
    // for the byDay aggregate too, so it is passed as the FROM clause.
    const conds = ['a.artist_id = ?'];
    const args: unknown[] = [id];
    if (from !== null) {
      conds.push('p.started_at >= ?');
      args.push(from);
    }
    const where: Filter = { sql: `WHERE ${conds.join(' AND ')}`, args };
    const fromSql = 'JOIN albums a ON a.id = p.album_id';
    const aggregate = entityAggregate(db, fromSql, where);

    return {
      artistId: row.id,
      name: row.name,
      from,
      to: at,
      plays: aggregate.plays,
      totalMs: aggregate.totalMs,
      firstPlayedAt: aggregate.firstPlayedAt ?? null,
      lastPlayedAt: aggregate.lastPlayedAt ?? null,
      byDay: byDayRows(db, fromSql, where),
      topAlbums: topAlbums(db, where),
      topTracks: topTracks(db, where),
    };
  }

  return { summary, artist, album };
}

/** Query-string values may be arrays when a key is repeated. */
function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return typeof value === 'string' ? value : undefined;
}

/** Routes are registered under /api by the caller, like the other modules. */
export function registerStatsRoutes(
  app: FastifyInstance,
  db: Db,
  opts: StatsOptions = {},
): StatsService {
  const stats = createStats(db, opts);

  app.get<{ Querystring: { period?: string } }>('/stats/summary', async (request, reply) => {
    const raw = firstString(request.query.period);
    const period = raw === undefined ? '30d' : raw;
    if (!isStatsPeriod(period)) {
      return reply.code(400).send({ error: 'invalid period; use 7d, 30d, 365d or all' });
    }
    return stats.summary(period);
  });

  app.get<{ Params: { id: string }; Querystring: { period?: string } }>(
    '/stats/artist/:id',
    async (request, reply) => {
      const raw = firstString(request.query.period);
      if (raw !== undefined && !isStatsPeriod(raw)) {
        return reply.code(400).send({ error: 'invalid period; use 7d, 30d, 365d or all' });
      }
      const result = stats.artist(request.params.id, raw);
      return result ?? reply.code(404).send({ error: 'not found' });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { period?: string } }>(
    '/stats/album/:id',
    async (request, reply) => {
      const raw = firstString(request.query.period);
      if (raw !== undefined && !isStatsPeriod(raw)) {
        return reply.code(400).send({ error: 'invalid period; use 7d, 30d, 365d or all' });
      }
      const result = stats.album(request.params.id, raw);
      return result ?? reply.code(404).send({ error: 'not found' });
    },
  );

  return stats;
}

export type {
  AlbumStats,
  ArtistStats,
  DayStat,
  FormatShare,
  NewDiscovery,
  StatsPeriod,
  StatsSummary,
  TopAlbumStat,
  TopArtistStat,
  TopGenreStat,
  TopTrackStat,
} from './types.js';
