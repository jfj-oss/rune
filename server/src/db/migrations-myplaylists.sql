-- Worker P (rune's own playlists) migration. Applied after schema.sql and after
-- migrations-spotify-library.sql (this file reuses the playlists / playlist_tracks
-- tables created there rather than duplicating them).
--
-- Every statement is idempotent: ALTER TABLE ADD COLUMN re-application is caught
-- by ensureMyPlaylistSchema (SQLite has no ADD COLUMN IF NOT EXISTS).
--
-- Rune playlists are stored in the same tables as Spotify playlists:
--   source = 'local', id = 'pl:rune:<uuid>'
-- Spotify rows keep source = 'spotify', id = 'pl:sp:<spotify id>'.
ALTER TABLE playlists ADD COLUMN kind TEXT NOT NULL DEFAULT 'static'; -- 'static' | 'smart'
ALTER TABLE playlists ADD COLUMN rules TEXT;                          -- smart: JSON array of {field,op,value}
ALTER TABLE playlists ADD COLUMN match_mode TEXT NOT NULL DEFAULT 'all'; -- smart: 'all' | 'any'
ALTER TABLE playlists ADD COLUMN sort TEXT;                           -- smart: "field:asc" / "field:desc"
ALTER TABLE playlists ADD COLUMN limit_count INTEGER;                 -- smart: max tracks (NULL = no limit)
ALTER TABLE playlists ADD COLUMN created_at INTEGER;                  -- epoch ms (Spotify rows may be NULL)

CREATE INDEX IF NOT EXISTS playlists_source_position ON playlists(source, position);

-- A picture the user chose for a playlist (the file is <dataDir>/playlist-images/; see myplaylists/image.ts).
CREATE TABLE IF NOT EXISTS playlist_images (
  playlist_id TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL
);
