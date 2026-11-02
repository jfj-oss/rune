// Applies db/migrations-people.sql after schema.sql. Idempotent and memoised per
// open Db, like the other worker migrations.
import { readFileSync } from 'node:fs';
import type { Db } from '../db/index.js';

const migrationSql = readFileSync(new URL('../db/migrations-people.sql', import.meta.url), 'utf8');

// Strip comments before splitting on ';' so prose semicolons do not cut a statement.
const statements = migrationSql.replace(/--[^\n]*/g, '').split(';');

const applied = new WeakSet<Db>();

/** Safe to call many times. */
export function ensurePeopleSchema(db: Db): void {
  if (applied.has(db)) return;
  for (const statement of statements) {
    const sql = statement.trim();
    if (!sql) continue;
    try {
      db.exec(sql);
    } catch (err) {
      // SQLite has no ADD COLUMN IF NOT EXISTS; re-application is fine.
      if (!/duplicate column name/i.test(String(err))) throw err;
    }
  }
  applied.add(db);
}
