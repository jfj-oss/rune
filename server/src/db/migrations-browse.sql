-- Browse-page indexes. Applied by src/api/browse.ts after schema.sql (idempotent).
--
-- EXPLAIN QUERY PLAN on the real library (5 008 tracks / 380 albums) shows the
-- title index is used when the albums table has no in_library column (plain
-- album scan), and the track/position index removes the inner temp B-tree for
-- the primary-artist sort key. Everything else is driven by the album index and
-- is fast enough without another index (whole endpoint ~4 ms).
CREATE INDEX IF NOT EXISTS tracks_title_nocase ON tracks(title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS track_artists_track_position ON track_artists(track_id, position);
