// Discover schema: a small JSON cache, a dismiss list and the app_state row(s)
// used by the Spotify discovery budget. Idempotent and memoised per Db.
import type { Db } from '../db/index.js';

const SQL = `
CREATE TABLE IF NOT EXISTS discover_cache (
  key TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS discover_dismissed (
  track_id TEXT PRIMARY KEY,
  dismissed_at INTEGER NOT NULL
);
-- server.ts creates this too; the module must work in tests without it.
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const applied = new WeakSet<Db>();

export function ensureDiscoverSchema(db: Db): void {
  if (applied.has(db)) return;
  db.exec(SQL);
  applied.add(db);
}

export interface CacheEntry<T> {
  value: T;
  fetchedAt: number;
}

/** Tiny persisted JSON cache. Keys are namespaced by caller ("lb:", "sp:", "radio:"). */
export class DiscoverCache {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    ensureDiscoverSchema(db);
  }

  get<T>(key: string, ttlMs: number): CacheEntry<T> | undefined {
    const row = this.db
      .prepare('SELECT body, fetched_at FROM discover_cache WHERE key = ?')
      .get(key) as { body: string; fetched_at: number } | undefined;
    if (!row) return undefined;
    if (ttlMs >= 0 && this.now() - row.fetched_at > ttlMs) return undefined;
    try {
      return { value: JSON.parse(row.body) as T, fetchedAt: row.fetched_at };
    } catch {
      return undefined;
    }
  }

  set<T>(key: string, value: T): void {
    this.db
      .prepare(
        `INSERT INTO discover_cache (key, body, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at`,
      )
      .run(key, JSON.stringify(value), this.now());
  }

  /** Raw timestamp even when the entry is too old to use (feed refresh policy). */
  fetchedAt(key: string): number | undefined {
    const row = this.db
      .prepare('SELECT fetched_at FROM discover_cache WHERE key = ?')
      .get(key) as { fetched_at: number } | undefined;
    return row?.fetched_at;
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM discover_cache WHERE key = ?').run(key);
  }
}

export const TTL = {
  /** ListenBrainz similarity data changes slowly; a week is plenty. */
  similar: 7 * 24 * 60 * 60 * 1000,
  /** Spotify search→track mappings are stable for a long time. */
  spotifyMapping: 7 * 24 * 60 * 60 * 1000,
  /** A generated song radio. */
  radio: 12 * 60 * 60 * 1000,
  /** The Discover feed is refreshed at most every 6 hours. */
  feed: 6 * 60 * 60 * 1000,
  /** Resolved Spotify→ISRC→MB recording id. */
  isrc: 30 * 24 * 60 * 60 * 1000,
  /** Artist top tracks / feed artist ids. */
  topTracks: 7 * 24 * 60 * 60 * 1000,
} as const;
