// Worker I — listening history shared by every zone/device.
//
//   createHistory(db, opts?) -> HistoryService
//   registerHistoryRoutes(app, history) adds:
//     GET  /history/recent?limit=
//     GET  /history/rediscover?limit=&olderThanDays=
//     GET  /history/stats/:id
//     POST /history/played   { trackId, zone, startedAt?, playedMs, completed? }
//
// The plays table lives in db/migrations-history.sql and is applied here (after
// schema.sql) so every entry point gets it idempotently.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type {
  HistoryPlayRequest,
  HistoryPlayResponse,
  HistoryStats,
  PlayerState,
  RecentAlbum,
  RediscoverAlbum,
} from '@liner/shared';
import type { Db } from '../db/index.js';
import { PlayCounter, playThreshold, type RecordedPlay } from './plays.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RECENT_LIMIT = 20;
const DEFAULT_REDISCOVER_LIMIT = 8;
const DEFAULT_OLDER_THAN_DAYS = 90;
const MAX_LIMIT = 200;

const migration = readFileSync(new URL('../db/migrations-history.sql', import.meta.url), 'utf8');

export interface PlayInput {
  trackId: string;
  albumId: string;
  zone: string;
  startedAt: number;
  playedMs: number;
  completed: boolean;
}

/** Album/duration lookup for the browser-zone POST route. */
export interface TrackInfo {
  albumId: string;
  durationMs: number;
}

export interface HistoryService {
  /** Derive counted plays from successive PlayerState snapshots of a zone. */
  recordFromState(prev: PlayerState, next: PlayerState): void;
  /** Insert a play directly (already-qualified input, e.g. a browser zone). */
  record(e: PlayInput): void;
  /** Albums ordered by most recent play, newest first. */
  recentAlbums(limit?: number): RecentAlbum[];
  /** Albums played before `olderThanDays` ago, plus never-played albums. */
  rediscover(limit?: number, olderThanDays?: number): RediscoverAlbum[];
  /** Plays for an album id or a track id. */
  stats(id: string): HistoryStats;
  /** Resolve a track for POST /history/played (null when unknown). */
  trackInfo(trackId: string): TrackInfo | null;
}

export interface HistoryOptions {
  /** Injectable clock (tests / deterministic rediscover). Default Date.now. */
  now?: () => number;
  /** Forwarded to PlayCounter: pauses longer than this split a play. */
  pauseSplitMs?: number;
}

/** Idempotently create the history schema. Safe to call many times. */
export function ensureHistorySchema(db: Db): void {
  db.exec(migration);
}

export function createHistory(db: Db, opts: HistoryOptions = {}): HistoryService {
  ensureHistorySchema(db);

  const insert = db.prepare(
    `INSERT INTO plays (track_id, album_id, zone, started_at, played_ms, completed)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const write = (p: RecordedPlay): void => {
    insert.run(p.trackId, p.albumId, p.zone, p.startedAt, p.playedMs, p.completed ? 1 : 0);
  };
  const counter = new PlayCounter(write, { pauseSplitMs: opts.pauseSplitMs });
  const now = opts.now ?? Date.now;

  const recentStmt = db.prepare(
    `SELECT p.album_id AS albumId,
            MAX(p.started_at) AS lastPlayedAt,
            COUNT(*) AS plays
       FROM plays p
       JOIN albums a ON a.id = p.album_id
      GROUP BY p.album_id
      ORDER BY lastPlayedAt DESC, p.album_id
      LIMIT ?`,
  );

  const rediscoverStmt = db.prepare(
    `SELECT a.id AS albumId,
            MAX(p.started_at) AS lastPlayedAt,
            COUNT(p.id) AS plays
       FROM albums a
       LEFT JOIN plays p ON p.album_id = a.id
      GROUP BY a.id
     HAVING MAX(p.started_at) IS NULL OR MAX(p.started_at) < ?`,
  );

  const statsStmt = db.prepare(
    `SELECT COUNT(*) AS plays, MAX(started_at) AS lastPlayedAt
       FROM plays
      WHERE album_id = ? OR track_id = ?`,
  );

  const trackStmt = db.prepare('SELECT album_id, duration_ms FROM tracks WHERE id = ?');

  return {
    recordFromState(prev, next) {
      counter.recordFromState(prev, next);
    },

    record(e) {
      write({
        trackId: e.trackId,
        albumId: e.albumId,
        zone: e.zone,
        startedAt: Math.round(e.startedAt),
        playedMs: Math.max(0, Math.round(e.playedMs)),
        completed: e.completed === true,
      });
    },

    recentAlbums(limit) {
      return recentStmt.all(clampLimit(limit, DEFAULT_RECENT_LIMIT)) as RecentAlbum[];
    },

    rediscover(limit, olderThanDays = DEFAULT_OLDER_THAN_DAYS) {
      const at = now();
      const days = Number.isFinite(olderThanDays)
        ? Math.max(0, olderThanDays)
        : DEFAULT_OLDER_THAN_DAYS;
      const cutoff = at - days * DAY_MS;
      const rows = rediscoverStmt.all(cutoff) as RediscoverAlbum[];
      // Deterministic shuffle: same set/order for the whole UTC day, changes at
      // midnight. Never-played albums (lastPlayedAt null) take part too.
      const day = Math.floor(at / DAY_MS);
      const score = new Map<string, string>();
      for (const row of rows) {
        score.set(row.albumId, createHash('sha1').update(`${day}:${row.albumId}`).digest('hex'));
      }
      rows.sort(
        (a, b) =>
          (score.get(a.albumId) ?? '').localeCompare(score.get(b.albumId) ?? '') ||
          a.albumId.localeCompare(b.albumId),
      );
      return rows.slice(0, clampLimit(limit, DEFAULT_REDISCOVER_LIMIT));
    },

    stats(id) {
      const row = statsStmt.get(id, id) as { plays: number; lastPlayedAt: number | null };
      return { plays: row.plays, lastPlayedAt: row.lastPlayedAt ?? null };
    },

    trackInfo(trackId) {
      const row = trackStmt.get(trackId) as
        | { album_id: string; duration_ms: number }
        | undefined;
      if (!row) return null;
      return { albumId: row.album_id, durationMs: row.duration_ms ?? 0 };
    },
  };
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Routes are registered under /api by the caller, like the other modules. */
export function registerHistoryRoutes(app: FastifyInstance, history: HistoryService): void {
  app.get<{ Querystring: { limit?: string } }>('/history/recent', async (request) => {
    return history.recentAlbums(parseNumber(request.query.limit));
  });

  app.get<{ Querystring: { limit?: string; olderThanDays?: string } }>(
    '/history/rediscover',
    async (request) => {
      return history.rediscover(
        parseNumber(request.query.limit),
        parseNumber(request.query.olderThanDays),
      );
    },
  );

  app.get<{ Params: { id: string } }>('/history/stats/:id', async (request) => {
    return history.stats(request.params.id);
  });

  app.post<{ Body: HistoryPlayRequest }>('/history/played', async (request, reply) => {
    const body = request.body;
    if (!body || typeof body.trackId !== 'string' || !body.trackId) {
      return reply.code(400).send({ error: 'trackId required' });
    }
    if (typeof body.zone !== 'string' || !body.zone) {
      return reply.code(400).send({ error: 'zone required' });
    }
    const playedMs = Number(body.playedMs);
    if (!Number.isFinite(playedMs) || playedMs < 0) {
      return reply.code(400).send({ error: 'playedMs required' });
    }

    const info = history.trackInfo(body.trackId);
    if (!info) return reply.code(404).send({ error: 'unknown track' });

    // The browser reports what it actually heard; apply the same rule as the
    // server-side state tracker so a short skip does not inflate play counts.
    const recorded = playedMs >= playThreshold(info.durationMs);
    if (recorded) {
      history.record({
        trackId: body.trackId,
        albumId: info.albumId,
        zone: body.zone,
        startedAt:
          typeof body.startedAt === 'number' && Number.isFinite(body.startedAt)
            ? body.startedAt
            : Date.now(),
        playedMs,
        completed: body.completed === true,
      });
    }
    return { recorded } satisfies HistoryPlayResponse;
  });
}

// Re-export the counting primitives for unit tests / wiring helpers.
export { PlayCounter, playThreshold };
export type { RecordedPlay };
