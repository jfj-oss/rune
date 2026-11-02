-- Worker W (Spotify linking) migration. Applied after schema.sql by
-- ensureLinkSchema() in src/spotify/linking.ts. Every statement is idempotent.
--
-- One row per local album: the Spotify album it maps to, how the link was found
-- and how confident we are. `spotify_album_id` is NULL when we looked and found
-- nothing (method = 'not_found'), so linkPending() does not re-search the same
-- album on every run. It retries after a while.
CREATE TABLE IF NOT EXISTS album_links (
  album_id TEXT PRIMARY KEY REFERENCES albums(id) ON DELETE CASCADE,
  spotify_album_id TEXT,             -- bare Spotify album id (no 'sp:' prefix)
  method TEXT NOT NULL,              -- 'upc' | 'search' | 'not_found'
  confidence REAL NOT NULL DEFAULT 0,
  checked_at INTEGER NOT NULL        -- epoch ms
);
CREATE INDEX IF NOT EXISTS album_links_spotify ON album_links(spotify_album_id);

-- Local track -> Spotify track, so a local queue can be handed to a Spotify
-- Connect device (the phone's Spotify app). Populated when an album link is
-- accepted. Only pairs that actually agreed on title/duration are stored.
CREATE TABLE IF NOT EXISTS track_links (
  track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  spotify_track_id TEXT NOT NULL,    -- bare Spotify track id (no 'sp:' prefix)
  linked_at INTEGER NOT NULL         -- epoch ms
);
CREATE INDEX IF NOT EXISTS track_links_spotify ON track_links(spotify_track_id);
