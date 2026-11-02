-- Loudness normalisation (ReplayGain-style). Applied by src/loudness/index.ts and
-- defensively by the PC zone / stream routes, after schema.sql has created the
-- tracks/albums tables. Idempotent: safe to run on every start.

CREATE TABLE IF NOT EXISTS track_loudness (
  track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  -- EBU R128 integrated loudness in LUFS (NULL = silent / unreadable file).
  lufs REAL,
  -- EBU R128 true peak in dBTP (NULL when unknown, e.g. derived from RG tags).
  true_peak_db REAL,
  -- Loudness of the whole album (energy-weighted mean of track lufs), or the
  -- REPLAYGAIN_ALBUM_GAIN tag when present.
  album_lufs REAL,
  analysed_at INTEGER NOT NULL,
  -- tracks.file_mtime at analysis time; a changed mtime makes the track pending again.
  file_mtime INTEGER NOT NULL,
  -- 'ffmpeg' | 'replaygain' | 'silent' | 'error'
  gain_source TEXT NOT NULL DEFAULT 'ffmpeg'
);

CREATE TABLE IF NOT EXISTS album_loudness (
  album_id TEXT PRIMARY KEY REFERENCES albums(id) ON DELETE CASCADE,
  lufs REAL,
  -- 'computed' (energy-weighted mean) | 'replaygain' (album gain tag wins).
  source TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- PlayerState-independent settings (currently just the normalize mode).
CREATE TABLE IF NOT EXISTS loudness_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
