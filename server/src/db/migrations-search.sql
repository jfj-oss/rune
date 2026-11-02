-- Worker T (search). Applied after schema.sql by ensureSearchSchema(); every
-- statement is idempotent.
--
-- search_docs is the canonical, already-folded representation of everything that
-- is searchable. Both FTS tables are derived from it, so one doc change is three
-- small writes (docs + word FTS + trigram FTS) and no base-table triggers.
-- `sig` is a signature of the source fields; reindex() only rewrites docs whose
-- signature changed (an unchanged full sweep is read-only).
CREATE TABLE IF NOT EXISTS search_docs (
  kind TEXT NOT NULL,              -- 'album' | 'artist' | 'track'
  ref_id TEXT NOT NULL,
  album_id TEXT,                   -- album id for albums/tracks; NULL for artists
  source TEXT NOT NULL DEFAULT 'local',
  title TEXT NOT NULL,             -- folded title / artist name
  artist TEXT NOT NULL DEFAULT '', -- folded artist names
  album TEXT NOT NULL DEFAULT '',  -- folded album title (tracks)
  credits TEXT NOT NULL DEFAULT '',-- folded credit artist names
  genre TEXT NOT NULL DEFAULT '',
  sig TEXT NOT NULL,
  PRIMARY KEY (kind, ref_id)
);
CREATE INDEX IF NOT EXISTS search_docs_album ON search_docs(album_id);
-- Result hydration looks docs up by ref_id alone (kind is selected, not filtered):
-- without this, every search scans the whole doc table.
CREATE INDEX IF NOT EXISTS search_docs_ref ON search_docs(ref_id);

-- Vocabulary used for typo correction (edit-distance candidate generation).
-- Deliberately append-only between full rebuilds: a stale term can only cost a
-- candidate that the FTS lookup then fails to find, never a wrong result.
CREATE TABLE IF NOT EXISTS search_terms (
  term TEXT PRIMARY KEY
);

-- Word/prefix index. Prefix lengths 2-4 keep short-token and prefix queries fast.
CREATE VIRTUAL TABLE IF NOT EXISTS search_word USING fts5(
  kind UNINDEXED,
  ref_id UNINDEXED,
  text,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3 4'
);

-- Trigram index: substring/typo recall ("acdc" in "ac dc").
CREATE VIRTUAL TABLE IF NOT EXISTS search_tri USING fts5(
  kind UNINDEXED,
  ref_id UNINDEXED,
  text,
  tokenize = 'trigram'
);
