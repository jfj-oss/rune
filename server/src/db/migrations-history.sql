-- Worker I (listening history) migration. Applied by createHistory() after
-- schema.sql has run. Idempotent: every statement uses IF NOT EXISTS.
--
-- One row = one counted play (>= 30 s or >= 50% of the track heard). Partial
-- skips are deliberately not stored, so `plays` can be summed directly.
-- No foreign keys: history should survive an album/spotify item leaving the
-- library. Read queries join `albums` so removed albums do not surface in
-- "Recently played" / "Rediscover".
CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL,
  album_id TEXT NOT NULL,
  zone TEXT NOT NULL,
  started_at INTEGER NOT NULL,   -- epoch ms
  played_ms INTEGER NOT NULL,    -- actually heard, not final position
  completed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS plays_album_started ON plays(album_id, started_at DESC);
CREATE INDEX IF NOT EXISTS plays_track_started ON plays(track_id, started_at DESC);
CREATE INDEX IF NOT EXISTS plays_started ON plays(started_at DESC);
