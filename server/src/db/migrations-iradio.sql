-- Worker Y (internet radio). Applied after schema.sql by ensureRadioSchema().
--
-- One row per radio-browser station the user has seen (search results are cached
-- here too, so a station can be queued straight from the results page). The
-- favourite flag is what /radio/favourites selects on, so un-favouriting keeps the
-- cached snapshot (and its logo) for later.
CREATE TABLE IF NOT EXISTS radio_stations (
  id TEXT PRIMARY KEY,                   -- 'rs:' + radio-browser stationuuid
  stationuuid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,                     -- station.url from the API
  url_resolved TEXT,                     -- station.url_resolved from the API
  stream_url TEXT,                       -- direct stream after .pls/.m3u resolution
  homepage TEXT,
  favicon TEXT,                          -- remote favicon URL
  tags TEXT NOT NULL DEFAULT '[]',       -- JSON array of tag strings
  country TEXT,
  countrycode TEXT,
  state TEXT,
  language TEXT,
  codec TEXT,
  bitrate INTEGER,                       -- kbps, 0 when unknown
  votes INTEGER NOT NULL DEFAULT 0,
  clickcount INTEGER NOT NULL DEFAULT 0,
  clicktrend INTEGER NOT NULL DEFAULT 0,
  geo_lat REAL,
  geo_long REAL,
  lastcheckok INTEGER,                   -- 1 = the API's last stream check passed
  favourite INTEGER NOT NULL DEFAULT 0,
  logo_path TEXT,                        -- cached file under <dataDir>/radio-logos
  logo_mime TEXT,
  raw_json TEXT,                         -- full radio-browser object snapshot
  added_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS radio_stations_favourite ON radio_stations(favourite, name COLLATE NOCASE);
