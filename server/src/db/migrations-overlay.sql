-- Worker AA (playlist overlay) migration. Applied after schema.sql by
-- ensureOverlaySchema (src/myplaylists/overlay.ts), after the Spotify-library and
-- rune-playlist migrations because it references the playlists table those create.
-- Every statement is idempotent.
--
-- Spotify's Web API cannot store local files in a Spotify playlist. rune therefore
-- keeps the user's local additions in this side table and merges them into the
-- synced Spotify track list at read time. Spotify itself is never written to.
--
-- An entry is anchored AFTER one specific Spotify entry, identified by the track id
-- plus which occurrence of that track in the playlist (a song can appear twice).
-- anchor_track_id NULL means "at the top". Positions are resolved on every read, so
-- an overlay survives a resync that inserts/removes/reorders Spotify tracks; if its
-- anchor disappears it falls back to the nearest previous surviving anchor.
CREATE TABLE IF NOT EXISTS playlist_overlay (
  id TEXT PRIMARY KEY,                    -- stable entry id used by DELETE / move
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL,                 -- local track id ('l:…')
  anchor_track_id TEXT,                   -- Spotify track id to insert after; NULL = top
  anchor_occurrence INTEGER NOT NULL DEFAULT 0, -- 0-based occurrence of the anchor
  added_at INTEGER NOT NULL               -- epoch ms, insertion order
);
CREATE INDEX IF NOT EXISTS playlist_overlay_playlist ON playlist_overlay(playlist_id, added_at);
CREATE INDEX IF NOT EXISTS playlist_overlay_track ON playlist_overlay(track_id);
