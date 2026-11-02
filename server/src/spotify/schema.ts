// Applies db/migrations-spotify.sql after schema.sql. Kept separate from auth.ts
// so every entry point (routes, sync, tests) can make the schema idempotently ready.
import { readFileSync } from 'node:fs';
import type { Db } from '../db/index.js';

const migrationSql = readFileSync(new URL('../db/migrations-spotify.sql', import.meta.url), 'utf8');

/** Safe to call many times. */
export function ensureSpotifySchema(db: Db): void {
  for (const statement of migrationSql.split(';')) {
    const sql = statement.trim();
    if (!sql) continue;
    try {
      db.exec(sql);
    } catch (err) {
      // SQLite has no ALTER TABLE ... ADD COLUMN IF NOT EXISTS; re-application is fine.
      if (!/duplicate column name/i.test(String(err))) throw err;
    }
  }
}
