-- Liner schema v1. Add new migrations as numbered blocks in db/index.ts; never edit applied ones.
CREATE TABLE IF NOT EXISTS artists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_name TEXT,
  mbid TEXT,
  image_path TEXT
);

CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,            -- 'local' | 'spotify'
  title TEXT NOT NULL,
  artist_id TEXT NOT NULL REFERENCES artists(id),
  year INTEGER,
  release_date TEXT,
  label TEXT,
  genres TEXT NOT NULL DEFAULT '[]', -- JSON array
  format TEXT,                     -- display string "FLAC 24/96"
  folder_path TEXT,
  cover_path TEXT,                 -- local file or cached download
  mb_release_id TEXT,
  mb_release_group_id TEXT,
  match_confidence REAL,
  match_locked INTEGER NOT NULL DEFAULT 0, -- 1 = user fixed match; matcher must not overwrite
  spotify_id TEXT,
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  disc INTEGER NOT NULL DEFAULT 1,
  number INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  path TEXT,                       -- local file (for cue tracks: the big audio file)
  cue_start_ms INTEGER,
  cue_end_ms INTEGER,
  format TEXT,
  sample_rate INTEGER,
  bit_depth INTEGER,
  bitrate_kbps INTEGER,
  file_mtime INTEGER,
  file_size INTEGER,
  mb_recording_id TEXT,
  spotify_uri TEXT
);
CREATE INDEX IF NOT EXISTS tracks_album ON tracks(album_id);
CREATE INDEX IF NOT EXISTS tracks_path ON tracks(path);

CREATE TABLE IF NOT EXISTS track_artists (
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  artist_id TEXT NOT NULL REFERENCES artists(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (track_id, artist_id)
);

CREATE TABLE IF NOT EXISTS credits (
  album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  artist_id TEXT NOT NULL REFERENCES artists(id),
  role TEXT NOT NULL,
  track_ids TEXT                   -- JSON array or NULL = whole album
);
CREATE INDEX IF NOT EXISTS credits_album ON credits(album_id);
CREATE INDEX IF NOT EXISTS credits_artist ON credits(artist_id);

-- Raw HTTP cache for external services (MusicBrainz, Wikipedia, Genius...)
CREATE TABLE IF NOT EXISTS http_cache (
  key TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  status INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- Phase 2: AlbumDetails JSON per album
CREATE TABLE IF NOT EXISTS album_details (
  album_id TEXT PRIMARY KEY REFERENCES albums(id) ON DELETE CASCADE,
  json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  kind UNINDEXED, ref_id UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2'
);

-- Pins: albums / playlists the user pinned to the top of their Library lists.
-- item_id is an album id (la:/sp:) or a playlist id (pl:...); no FK, so a pin outlives a rescan.
CREATE TABLE IF NOT EXISTS pins (
  item_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('album', 'playlist')),
  pinned_at INTEGER NOT NULL
);
