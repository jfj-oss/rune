-- Worker E (Spotify) migration. Applied after schema.sql by ensureSpotifySchema().
-- Single row (id = 1) because Liner is a single-user, self-hosted player.
CREATE TABLE IF NOT EXISTS spotify_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT,
  refresh_token TEXT,
  token_type TEXT,
  scope TEXT,
  expires_at INTEGER NOT NULL DEFAULT 0, -- epoch ms
  user_name TEXT,
  user_product TEXT,
  updated_at INTEGER NOT NULL
);

-- Spotify's artist id, kept on the shared artist row so an artist that already
-- exists locally is reused (both catalogues then show up on one artist page).
ALTER TABLE artists ADD COLUMN spotify_id TEXT;

CREATE INDEX IF NOT EXISTS artists_spotify_id ON artists(spotify_id);
CREATE INDEX IF NOT EXISTS albums_spotify_id ON albums(spotify_id);
