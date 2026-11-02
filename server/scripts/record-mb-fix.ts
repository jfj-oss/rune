// Record MusicBrainz fixtures for real-library albums that the OLD matcher
// failed to match. Network is allowed here (and ONLY here); the recorded JSON
// files are replayed offline by tests/match-fix.test.ts.
//
// Local metadata (titles, artists, years, track titles and durations) is read
// from a copy of the real library DB. The source DB is opened READ ONLY and is
// never written. Folder paths are stored with the library root replaced by
// /music so the fixtures do not embed the machine's mount path (the folder
// *name*, which drives cleanFolderName variants, is preserved).
//
// Usage:
//   pnpm -C server exec tsx scripts/record-mb-fix.ts [--db=/path/to/liner.db] [--out=dir]
//
// Default db: ~/.local/share/liner/liner.db
// Default out: server/tests/fixtures/mb-fix
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, ids } from '../src/db/index.js';
import type { Config } from '../src/config.js';
import {
  MbClient,
  RateLimiter,
  artistCreditName,
  flattenReleaseTracks,
  type FetchLike,
  type MbRelease,
} from '../src/match/mb.js';
import { createMatcher } from '../src/match/index.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const REAL_FETCH = globalThis.fetch.bind(globalThis);
const USER_AGENT = 'Liner/0.1 ( personal music player, self-hosted )';
const LIBRARY_ROOT = '/mnt/BIG data/Music';
const SANITIZED_ROOT = '/music';

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const sourceDbPath = arg('db', join(homedir(), '.local', 'share', 'liner', 'liner.db'));
const fixturesDir = arg('out', join(scriptDir, '..', 'tests', 'fixtures', 'mb-fix'));

/**
 * Albums that the pre-matchfix matcher left unmatched (verified against
 * ~/.local/share/liner/liner.db on 2026-11-01). Each covers a distinct failure
 * mode: exact-edition track count, unicode apostrophes, misspelled tags with a
 * correct folder, catalog/scene junk in the title, deluxe suffixes, soundtrack
 * artist mismatch, and a single disc of a multi-disc release.
 */
const ALBUMS: { slug: string; albumId: string; why: string }[] = [
  { slug: 'daft-punk-homework-25', albumId: 'la:befadc4991294c66', why: 'deluxe/anniversary track count (31)' },
  { slug: 'beatles-hard-days-night', albumId: 'la:0eff3e0988383869', why: 'unicode apostrophe U+00B4' },
  { slug: 'abba-voulez-vous', albumId: 'la:9d304acb5f09d532', why: 'misspelled tag, correct folder' },
  { slug: 'gerry-rafferty-city-to-city', albumId: 'la:f2c1b8019f8bfb1f', why: 'catalog number in title' },
  { slug: 'sting-ten-summoners-tales', albumId: 'la:68f5b522a7aedaa4', why: 'scene/quality junk in title' },
  { slug: 'chemical-brothers-born-in-the-echoes', albumId: 'la:4d7d52bd63d434a7', why: 'deluxe edition suffix' },
  { slug: 'sakamoto-love-is-the-devil', albumId: 'la:5ba9ca4a5db19060', why: 'soundtrack artist mismatch' },
  { slug: 'beatles-white-album-cd1', albumId: 'la:8c254411d4eaf18c', why: 'one disc of a multi-disc release' },
];

interface SourceRow {
  id: string;
  title: string;
  artist: string;
  year: number | null;
  format: string | null;
  label: string | null;
  folder_path: string;
  mb_release_id: string | null;
}

interface SourceAlbum extends Omit<SourceRow, 'folder_path'> {
  folder: string;
  tracks: { title: string; disc: number; number: number; duration_ms: number }[];
}

interface ManifestEntry {
  file: string;
  status: number;
  fetchedAt: number;
}
type Manifest = Record<string, ManifestEntry>;

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function sanitizeFolder(folder: string): string {
  if (folder.startsWith(`${LIBRARY_ROOT}/`)) return SANITIZED_ROOT + folder.slice(LIBRARY_ROOT.length);
  return `${SANITIZED_ROOT}/${basename(folder)}`;
}

function readSourceAlbum(src: Database.Database, albumId: string): SourceAlbum {
  const row = src
    .prepare(
      `SELECT al.id, al.title, ar.name AS artist, al.year, al.format, al.label,
              al.folder_path, al.mb_release_id
         FROM albums al LEFT JOIN artists ar ON ar.id = al.artist_id
        WHERE al.id = ?`,
    )
    .get(albumId) as SourceRow | undefined;
  if (!row) throw new Error(`album ${albumId} not found in ${sourceDbPath}`);
  if (!row.folder_path) throw new Error(`album ${albumId} has no folder_path`);
  const tracks = src
    .prepare(
      `SELECT title, disc, number, duration_ms
         FROM tracks WHERE album_id = ? ORDER BY disc, number`,
    )
    .all(albumId) as SourceAlbum['tracks'];
  if (tracks.length === 0) throw new Error(`album ${albumId} has no tracks`);
  const { folder_path, ...rest } = row;
  return { ...rest, folder: folder_path, tracks };
}

async function main(): Promise<void> {
  const src = new Database(sourceDbPath, { readonly: true, fileMustExist: true });

  // Read everything up front; close the real DB before any network/DB work.
  const sources = ALBUMS.map((entry) => ({ entry, album: readSourceAlbum(src, entry.albumId) }));
  src.close();

  for (const { entry, album } of sources) {
    if (album.mb_release_id) {
      throw new Error(`${entry.slug} (${entry.albumId}) is already matched in the source DB; pick an unmatched album`);
    }
  }

  rmSync(fixturesDir, { recursive: true, force: true });
  mkdirSync(fixturesDir, { recursive: true });
  const manifest: Manifest = {};
  writeFileSync(join(fixturesDir, 'manifest.json'), '{}\n');

  const recordingFetch: FetchLike = async (input, init) => {
    const url = urlOf(input);
    const res = await REAL_FETCH(input as RequestInfo | URL, init);
    if (url.startsWith('https://musicbrainz.org/')) {
      const body = await res.clone().text();
      const file = `${createHash('sha1').update(url).digest('hex')}.json`;
      writeFileSync(join(fixturesDir, file), body);
      manifest[url] = { file, status: res.status, fetchedAt: Date.now() };
      writeFileSync(join(fixturesDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      console.log(`  recorded [${res.status}] ${url}`);
    }
    return res;
  };

  const limiter = new RateLimiter(1000);
  const dataDir = mkdtempSync(join(tmpdir(), 'liner-record-fix-'));
  const db = openDb(join(dataDir, 'record.db'));
  const cfg: Config = {
    libraryRoots: [],
    dataDir,
    port: 0,
    audioDevice: 'pipewire',
    userAgent: USER_AGENT,
  };
  const client = new MbClient({ userAgent: USER_AGENT, db, fetch: recordingFetch, limiter });
  const matcher = createMatcher(db, cfg, {
    fetch: recordingFetch,
    limiter,
    downloadCovers: false,
    now: () => Date.now(),
  });

  const insertAlbum = db.prepare(
    `INSERT INTO albums
       (id, source, title, artist_id, year, format, label, folder_path, added_at)
     VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertTrack = db.prepare(
    `INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms, path, format)
     VALUES (?, ?, 'local', ?, ?, ?, ?, ?, 'flac')`,
  );
  const insertTrackArtist = db.prepare(
    'INSERT OR IGNORE INTO track_artists (track_id, artist_id, position) VALUES (?, ?, 0)',
  );

  const folderById = new Map<string, string>();
  for (const { album } of sources) {
    const folder = sanitizeFolder(album.folder);
    folderById.set(album.id, folder);
    const albumId = ids.localAlbum(folder);
    const artistId = ids.artistByName(album.artist);
    db.prepare('INSERT OR IGNORE INTO artists (id, name) VALUES (?, ?)').run(artistId, album.artist);
    insertAlbum.run(albumId, album.title, artistId, album.year, album.format, album.label, folder, Date.now());
    album.tracks.forEach((track, index) => {
      const path = join(folder, `${String(track.disc).padStart(2, '0')}-${String(track.number).padStart(2, '0')}-${index}.flac`);
      insertTrack.run(
        ids.localTrack(path),
        albumId,
        track.title,
        track.disc,
        track.number,
        track.duration_ms,
        path,
      );
      insertTrackArtist.run(ids.localTrack(path), artistId);
    });
  }

  console.log(`\nMatching ${sources.length} previously-failing real albums...`);
  await matcher.matchPending((done, total) => console.log(`  matched ${done}/${total}`));

  const summaries: unknown[] = [];
  for (const { entry, album } of sources) {
    const folder = folderById.get(album.id)!;
    const albumId = ids.localAlbum(folder);
    const row = db
      .prepare('SELECT mb_release_id, match_confidence, title FROM albums WHERE id = ?')
      .get(albumId) as { mb_release_id: string | null; match_confidence: number | null; title: string } | undefined;
    if (!row?.mb_release_id) throw new Error(`matcher did not match ${entry.slug}`);
    if ((row.match_confidence ?? 0) < 0.8) {
      throw new Error(`low confidence ${row.match_confidence} for ${entry.slug}`);
    }

    const release: MbRelease = await client.getRelease(row.mb_release_id);
    const releaseTracks = flattenReleaseTracks(release);
    const releaseGroupId = release['release-group']?.id ?? null;
    console.log(
      `  ${entry.slug}: ${album.title} (${album.tracks.length} tr) -> ` +
        `${release.title} [${releaseTracks.length} tr] confidence=${row.match_confidence} (${entry.why})`,
    );

    summaries.push({
      slug: entry.slug,
      albumId,
      title: album.title,
      artist: album.artist,
      year: album.year,
      format: album.format ?? 'FLAC 16/44.1',
      label: album.label,
      folderPath: folder,
      targetReleaseId: release.id,
      targetReleaseGroupId: releaseGroupId,
      targetTitle: release.title,
      targetArtist: artistCreditName(release['artist-credit']),
      targetDate: release.date ?? null,
      targetTrackCount: releaseTracks.length,
      confidence: row.match_confidence,
      tracks: album.tracks.map((track, index) => ({
        id: ids.localTrack(join(folder, `${String(track.disc).padStart(2, '0')}-${String(track.number).padStart(2, '0')}-${index}.flac`)),
        title: track.title,
        disc: track.disc,
        number: track.number,
        durationMs: track.duration_ms,
        index,
      })),
    });
  }

  writeFileSync(join(fixturesDir, 'albums.json'), JSON.stringify(summaries, null, 2) + '\n');
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  console.log(`\nWrote ${Object.keys(manifest).length} raw responses + albums.json to ${fixturesDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
