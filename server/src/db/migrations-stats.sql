-- Worker X (listening statistics) migration. Applied after schema.sql *and*
-- migrations-history.sql (ensureStatsSchema calls ensureHistorySchema first),
-- because it indexes the history module's `plays` table.
--
-- The stats summary always restrict by started_at (except period=all) and then
-- aggregates by album/track and sums played_ms, so a covering index lets those
-- reads stay index-only. plays_started from history already serves the range
-- scan; this one adds the columns the aggregates need.
CREATE INDEX IF NOT EXISTS plays_started_stats
  ON plays(started_at, album_id, track_id, played_ms);

-- Artist statistics filter albums by artist; the base schema has no such index.
CREATE INDEX IF NOT EXISTS albums_artist_stats ON albums(artist_id);
