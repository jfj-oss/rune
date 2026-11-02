-- Worker V (album editions + artist discography). Applied after schema.sql by
-- ensureEditionsSchema() in src/editions/index.ts (idempotent).
--
-- Only the MusicBrainz-derived payload is stored here. Anything that depends on
-- the current library (other versions in the library, owned/not-owned flags) is
-- recomputed on every request, so a rescan/match does not have to invalidate
-- this cache. Rows are refreshed after 30 days (or when the album/artist's
-- MusicBrainz key changes).
CREATE TABLE IF NOT EXISTS editions_cache (
  kind TEXT NOT NULL,              -- 'album-editions' | 'artist-discography'
  ref_id TEXT NOT NULL,            -- local album id / artist id
  mb_key TEXT NOT NULL,            -- release id|release-group id, or artist mbid
  payload_json TEXT NOT NULL,      -- JSON, MB-derived only
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (kind, ref_id)
);
CREATE INDEX IF NOT EXISTS editions_cache_fetched ON editions_cache(kind, fetched_at);
