// Offline MusicBrainz fixture replay + local album insertion helpers for tests.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../../src/db/index.js';
import { ids } from '../../src/db/index.js';
import type { FetchLike, MbRelease } from '../../src/match/mb.js';

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'mb');
/** Real-library albums that the old matcher failed on (recorded by scripts/record-mb-fix.ts). */
export const FIX_FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'mb-fix');

export interface FixtureAlbumTrack {
  id: string;
  title: string;
  disc: number;
  number: number;
  durationMs: number;
  index: number;
}

export interface FixtureAlbum {
  slug: string;
  albumId: string;
  title: string;
  artist: string;
  year: number;
  format: string;
  label: string | null;
  targetReleaseId: string;
  targetReleaseGroupId: string | null;
  targetTitle: string;
  targetArtist: string;
  targetDate: string | null;
  confidence: number;
  /** Real library folder (root sanitized to /music) used for folder-name variants. */
  folderPath?: string;
  tracks: FixtureAlbumTrack[];
}

interface ManifestEntry {
  file: string;
  status: number;
  fetchedAt: number;
}
type Manifest = Record<string, ManifestEntry>;

interface FixtureSet {
  dir: string;
  albums: FixtureAlbum[];
  manifest: Manifest;
}

const sets = new Map<string, FixtureSet>();

function loadSet(dir: string): FixtureSet {
  let set = sets.get(dir);
  if (!set) {
    set = {
      dir,
      albums: JSON.parse(readFileSync(join(dir, 'albums.json'), 'utf8')) as FixtureAlbum[],
      manifest: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest,
    };
    sets.set(dir, set);
  }
  return set;
}

export function loadFixtureAlbums(dir = FIXTURES_DIR): FixtureAlbum[] {
  return loadSet(dir).albums;
}

export function fixtureAlbum(slug: string, dir = FIXTURES_DIR): FixtureAlbum {
  const album = loadSet(dir).albums.find((a) => a.slug === slug);
  if (!album) throw new Error(`unknown fixture album: ${slug}`);
  return album;
}

export function loadRelease(id: string, dir = FIXTURES_DIR): MbRelease {
  const { manifest, dir: fixturesDir } = loadSet(dir);
  const entry = Object.entries(manifest).find(
    ([url]) => url.includes(`/ws/2/release/${id}?`) || url.includes(`/ws/2/release/${encodeURIComponent(id)}?`),
  );
  if (!entry) throw new Error(`release ${id} not in fixture manifest`);
  return JSON.parse(readFileSync(join(fixturesDir, entry[1].file), 'utf8')) as MbRelease;
}

export function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * Fetch implementation that serves every recorded URL from disk. Unrecorded
 * MusicBrainz URLs and Cover Art Archive URLs return 404 (offline default).
 */
export function fixtureFetch(dir = FIXTURES_DIR): FetchLike {
  const { manifest, dir: fixturesDir } = loadSet(dir);
  return async (input) => {
    const url = urlOf(input);
    const entry = manifest[url];
    if (!entry) {
      return new Response(JSON.stringify({ error: 'no fixture for ' + url }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(readFileSync(join(fixturesDir, entry.file), 'utf8'), {
      status: entry.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

export interface InsertOptions {
  title?: string;
  artist?: string;
  year?: number;
  locked?: boolean;
  coverPath?: string | null;
  addedAt?: number;
  /** Override the folder (real-library fixtures need their original folder name). */
  folderPath?: string;
}

/** Insert a local album + artist + tracks + track_artists exactly like the scanner would. */
export function insertLocalAlbum(db: Db, album: FixtureAlbum, options: InsertOptions = {}): string {
  const title = options.title ?? album.title;
  const artistName = options.artist ?? album.artist;
  const year = options.year ?? album.year;
  const folder =
    options.folderPath ??
    album.folderPath ??
    `/music/${album.slug}${options.title || options.artist ? '-custom' : ''}`;
  const albumId = ids.localAlbum(folder);
  const artistId = ids.artistByName(artistName);

  db.prepare('INSERT OR IGNORE INTO artists (id, name) VALUES (?, ?)').run(artistId, artistName);
  db.prepare(
    `INSERT INTO albums
       (id, source, title, artist_id, year, format, label, folder_path, cover_path, match_locked, added_at)
     VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    albumId,
    title,
    artistId,
    year,
    album.format,
    album.label,
    folder,
    options.coverPath ?? null,
    options.locked ? 1 : 0,
    options.addedAt ?? Date.now(),
  );

  const insertTrack = db.prepare(
    `INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms, path, format)
     VALUES (?, ?, 'local', ?, ?, ?, ?, ?, 'flac')`,
  );
  const insertTrackArtist = db.prepare(
    'INSERT OR IGNORE INTO track_artists (track_id, artist_id, position) VALUES (?, ?, ?)',
  );
  for (const track of album.tracks) {
    const trackId = `${albumId}:t${track.index}`;
    insertTrack.run(trackId, albumId, track.title, track.disc, track.number, track.durationMs, join(folder, `${track.index}.flac`));
    insertTrackArtist.run(trackId, artistId, 0);
  }
  return albumId;
}

/** Insert an arbitrary (non fixture) local album, used for the gibberish case. */
export function insertBespokeAlbum(
  db: Db,
  input: {
    slug: string;
    title: string;
    artist: string;
    year?: number;
    format?: string;
    tracks: { title: string; durationMs: number; disc?: number; number?: number }[];
  },
): string {
  const folder = `/music/${input.slug}`;
  const albumId = ids.localAlbum(folder);
  const artistId = ids.artistByName(input.artist);
  db.prepare('INSERT OR IGNORE INTO artists (id, name) VALUES (?, ?)').run(artistId, input.artist);
  db.prepare(
    `INSERT INTO albums (id, source, title, artist_id, year, format, folder_path, added_at)
     VALUES (?, 'local', ?, ?, ?, ?, ?, ?)`,
  ).run(albumId, input.title, artistId, input.year ?? null, input.format ?? 'FLAC 16/44.1', folder, Date.now());

  const insertTrack = db.prepare(
    `INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms, path, format)
     VALUES (?, ?, 'local', ?, ?, ?, ?, ?, 'flac')`,
  );
  input.tracks.forEach((track, index) => {
    insertTrack.run(
      `${albumId}:t${index}`,
      albumId,
      track.title,
      track.disc ?? 1,
      track.number ?? index + 1,
      track.durationMs,
      `${folder}/${index}.flac`,
    );
  });
  return albumId;
}
