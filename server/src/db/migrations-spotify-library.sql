-- Worker F (Spotify library) migration. Applied after schema.sql by
-- ensureSpotifyLibrarySchema. Every statement is idempotent.
CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,             -- 'pl:sp:<spotify id>', or 'pl:sp:liked'
  source TEXT NOT NULL,            -- 'spotify' for now
  name TEXT NOT NULL,
  description TEXT,
  owner TEXT,
  image_url TEXT,                  -- Spotify image URL (proxy/redirect like album covers)
  snapshot_id TEXT,                -- Spotify playlist snapshot (unchanged = don't refetch tracks)
  track_count INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Deliberately no FK on track_id: re-syncing a saved album replaces its track rows
-- wholesale (DELETE + reinsert with the same ids). A cascade here would silently
-- empty the playlists that reference those tracks. Playlist rows are re-synced from
-- Spotify on the next snapshot change, so a genuinely vanished track just drops out.
CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,       -- order within the playlist, 0-based
  track_id TEXT NOT NULL,          -- 'sp:<id>'
  added_at INTEGER,                -- epoch ms, when Spotify reports it
  PRIMARY KEY (playlist_id, position)
);
CREATE INDEX IF NOT EXISTS playlist_tracks_track ON playlist_tracks(track_id);

-- Saved albums = 1. Albums that only exist because a playlist (or an on-demand
-- album view / search result) referenced them = 0. Library listings show only 1.
ALTER TABLE albums ADD COLUMN in_library INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS albums_in_library ON albums(in_library);
