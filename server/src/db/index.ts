import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export type Db = Database.Database;

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

/** Open (or create) the database. Use ':memory:' in tests. */
export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  return db;
}

export function hash16(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

export const ids = {
  localTrack: (path: string, cueTrack?: number) =>
    'l:' + hash16(cueTrack == null ? path : `${path}#${cueTrack}`),
  localAlbum: (folder: string, groupKey?: string) =>
    'la:' + hash16(groupKey ? `${folder}#${groupKey}` : folder),
  artistByMbid: (mbid: string) => 'ar:' + mbid,
  artistByName: (name: string) => 'ar:n:' + hash16(normalizeName(name)),
};

/** Lowercase, strip diacritics/punctuation, collapse spaces, drop leading "the ". */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^the /, '');
}
