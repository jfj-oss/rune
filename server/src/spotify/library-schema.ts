// Applies db/migrations-spotify-library.sql after schema.sql. Idempotent, like
// applySpotifyMigration in ./schema.ts. Memoised per open Db so sync loops don't
// re-run the migration on every pass.
import { readFileSync } from 'node:fs';
import type { Db } from '../db/index.js';

const migrationSql = readFileSync(
  new URL('../db/migrations-spotify-library.sql', import.meta.url),
  'utf8',
);

// Statements are split on ';' (sqlite cannot run several in one statement call);
// strip -- comments first so prose semicolons don't split a statement in half.
const statements = migrationSql.replace(/--[^\n]*/g, '').split(';');

const applied = new WeakSet<Db>();

/** Safe to call many times. */
export function ensureSpotifyLibrarySchema(db: Db): void {
  if (applied.has(db)) return;
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
