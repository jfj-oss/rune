-- Scanner state. Applied by src/scan/index.ts after schema.sql creates the base tables.
-- Caches the metadata of the last successful parse so incremental rescans can skip
-- files whose mtime+size are unchanged while still being able to group them.
CREATE TABLE IF NOT EXISTS scan_files (
  path TEXT PRIMARY KEY,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  meta TEXT NOT NULL
);
