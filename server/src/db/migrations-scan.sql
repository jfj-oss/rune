-- Scanner state. Applied by src/scan/index.ts after schema.sql creates the base tables.
-- Caches the metadata of the last successful parse so incremental rescans can skip
-- files whose mtime+size are unchanged while still being able to group them.
CREATE TABLE IF NOT EXISTS scan_files (
  path TEXT PRIMARY KEY,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  meta TEXT NOT NULL
);

-- Signature of the file-derived album model the scanner last wrote. Comparing against
-- this (not the live albums row) keeps matcher edits from looking like file changes.
CREATE TABLE IF NOT EXISTS scan_albums (
  album_id TEXT PRIMARY KEY,
  sig TEXT NOT NULL
);

-- Files/folders the last scan could not read, with a short reason. Replaced at the
-- end of each scan so Settings can show exactly which files the error count means.
CREATE TABLE IF NOT EXISTS scan_errors (
  path TEXT PRIMARY KEY,
  reason TEXT NOT NULL
);
