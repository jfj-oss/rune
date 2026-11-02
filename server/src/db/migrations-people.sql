-- Worker U (people pages) migration. Applied after schema.sql by ensurePeopleSchema().
-- One row per MusicBrainz artist. `data_json` holds a normalised WS/2 artist-rels
-- response ({ type?, isPerson, memberOf[], members[] }) so "member of <band>" can be
-- shown without a network call per page view. `found = 0` caches a failed lookup.
CREATE TABLE IF NOT EXISTS people_rels (
  artist_id TEXT PRIMARY KEY REFERENCES artists(id) ON DELETE CASCADE,
  mbid TEXT,                        -- MusicBrainz artist id the row was fetched for
  data_json TEXT NOT NULL,          -- JSON MbRelations
  found INTEGER NOT NULL DEFAULT 0, -- 1 = a valid WS/2 response was stored
  fetched_at INTEGER NOT NULL
);

-- GET /people?role=... filters by role; without this it scans the credits table.
CREATE INDEX IF NOT EXISTS credits_role ON credits(role);
