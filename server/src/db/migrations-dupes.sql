-- Worker M (duplicates) migration. Applied by ensureDupesSchema() in
-- src/library/dupes.ts after schema.sql has run. Idempotent: IF NOT EXISTS.
--
-- User decisions about duplicate albums. One row per album the user has touched.
--   hidden       = 1 -> album is excluded from the library grid and search
--   preferred_over = album id that album_id should be preferred over (A row says
--                    "A is the keeper, prefer it over B"). NULL = no preference.
-- Rows survive nothing else: deleting an album cascades its preference row.
CREATE TABLE IF NOT EXISTS album_prefs (
  album_id TEXT PRIMARY KEY REFERENCES albums(id) ON DELETE CASCADE,
  hidden INTEGER NOT NULL DEFAULT 0,
  preferred_over TEXT REFERENCES albums(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS album_prefs_preferred_over ON album_prefs(preferred_over);
