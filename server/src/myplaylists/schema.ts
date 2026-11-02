// Applies db/migrations-myplaylists.sql after schema.sql + the Spotify-library
// migration (which creates the playlists / playlist_tracks tables we reuse).
// Idempotent and memoised per open Db, like src/spotify/library-schema.ts.
import { readFileSync } from 'node:fs';
import type { Db } from '../db/index.js';
import { ensureSpotifyLibrarySchema } from '../spotify/library-schema.js';

const migrationSql = readFileSync(
  new URL('../db/migrations-myplaylists.sql', import.meta.url),
  'utf8',
);

// Strip -- comments first so prose semicolons don't split a statement in half.
const statements = migrationSql.replace(/--[^\n]*/g, '').split(';');

const applied = new WeakSet<Db>();

/** Safe to call many times; also creates the Spotify library tables we build on. */
export function ensureMyPlaylistSchema(db: Db): void {
  if (applied.has(db)) return;
  ensureSpotifyLibrarySchema(db);
  for (const statement of statements) {
    const sql = statement.trim();
    if (!sql) continue;
    try {
      db.exec(sql);
    } catch (err) {
      // SQLite has no ALTER TABLE ... ADD COLUMN IF NOT EXISTS; re-application is fine.
      if (!/duplicate column name/i.test(String(err))) throw err;
    }
  }
  applied.add(db);
}

/** True when a table exists in this database (e.g. plays, owned by history). */
export function hasTable(db: Db, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}
