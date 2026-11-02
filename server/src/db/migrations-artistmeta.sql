-- Worker H (artist metadata). Applied after schema.sql by ensureArtistMetaSchema().
-- One row per artist, including "nothing found" results (found = 0) so an
-- unknown artist is not re-searched on every page view. Refreshed after 60 days.
CREATE TABLE IF NOT EXISTS artist_info (
  artist_id TEXT PRIMARY KEY REFERENCES artists(id) ON DELETE CASCADE,
  bio_json TEXT,                   -- JSON Sourced<string> or NULL
  image_path TEXT,                 -- cached file under <dataDir>/artists or NULL
  image_mime TEXT,                 -- actual content type of the cached file
  image_credit_json TEXT,          -- JSON { author?, license?, url } or NULL
  wikidata_id TEXT,                -- resolved QID (debugging / refresh)
  wikipedia_title TEXT,            -- resolved enwiki article title
  found INTEGER NOT NULL DEFAULT 0,-- 1 when at least a bio or image was found
  fetched_at INTEGER NOT NULL
);
