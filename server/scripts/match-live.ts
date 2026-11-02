// Live end-to-end check: real MusicBrainz + Cover Art Archive on a temp DB.
//
// Builds the five fixture albums from the recorded local metadata (realistic
// durations), runs the real matcher, and prints what was chosen/applied.
//
// Usage: pnpm -C server exec tsx scripts/match-live.ts
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, ids } from '../src/db/index.js';
import type { Config } from '../src/config.js';
import { MbClient, artistCreditName } from '../src/match/mb.js';
import { createMatcher } from '../src/match/index.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(scriptDir, '..', 'tests', 'fixtures', 'mb');
const USER_AGENT = 'Liner/0.1 ( personal music player, self-hosted )';

interface FixtureTrack {
  id: string;
  title: string;
  disc: number;
  number: number;
  durationMs: number;
  index: number;
}
interface FixtureAlbum {
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
  tracks: FixtureTrack[];
}

const albums = JSON.parse(readFileSync(join(fixturesDir, 'albums.json'), 'utf8')) as FixtureAlbum[];

function insertAlbum(db: ReturnType<typeof openDb>, album: FixtureAlbum): void {
  const folder = `/music/${album.slug}`;
  const artistId = ids.artistByName(album.artist);
  db.prepare('INSERT OR IGNORE INTO artists (id, name) VALUES (?, ?)').run(artistId, album.artist);
  db.prepare(
    `INSERT INTO albums (id, source, title, artist_id, year, format, label, folder_path, added_at)
     VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(album.albumId, album.title, artistId, album.year, album.format, album.label, folder, Date.now());

  const insertTrack = db.prepare(
    `INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms, path, format)
     VALUES (?, ?, 'local', ?, ?, ?, ?, ?, 'flac')`,
  );
  const insertTrackArtist = db.prepare(
    'INSERT OR IGNORE INTO track_artists (track_id, artist_id, position) VALUES (?, ?, ?)',
  );
  for (const track of album.tracks) {
    insertTrack.run(
      track.id,
      album.albumId,
      track.title,
      track.disc,
      track.number,
      track.durationMs,
      `${folder}/${track.disc}-${track.number}.flac`,
    );
    insertTrackArtist.run(track.id, artistId, 0);
  }
}

async function main(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), 'liner-match-live-'));
  const cfg: Config = {
    libraryRoots: [],
    dataDir: workDir,
    port: 0,
    audioDevice: 'pipewire',
    userAgent: USER_AGENT,
  };
  const db = openDb(join(workDir, 'live.db'));
  for (const album of albums) insertAlbum(db, album);

  const matcher = createMatcher(db, cfg);
  console.log(`Live matching ${albums.length} albums (temp dir ${workDir})\n`);
  await matcher.matchPending((done, total) => {
    if (done > 0) console.log(`  progress ${done}/${total}`);
  });

  const infoClient = new MbClient({ userAgent: USER_AGENT, db });
  let allHighConfidence = true;
  let daftPunkMembers = false;
  let coversSaved = 0;

  for (const album of albums) {
    const row = db
      .prepare(
        `SELECT al.*, ar.name AS artist_name, ar.mbid AS artist_mbid
           FROM albums al JOIN artists ar ON ar.id = al.artist_id
          WHERE al.id = ?`,
      )
      .get(album.albumId) as Record<string, any>;

    console.log(`\n=== ${album.artist} — ${album.title} ===`);
    if (!row.mb_release_id) {
      console.log('  NO MATCH');
      allHighConfidence = false;
      continue;
    }

    const release = await infoClient.getRelease(row.mb_release_id as string);
    const labelInfo = (release['label-info'] ?? [])
      .map((i) => i.label?.name)
      .filter((name): name is string => Boolean(name));
    const label = [...new Set(labelInfo)].join(', ') || row.label || '—';

    console.log(`  chosen release : ${release.title} — ${artistCreditName(release['artist-credit'])}`);
    console.log(`  release date   : ${release.date ?? row.release_date ?? '—'}`);
    console.log(`  label          : ${label}`);
    console.log(`  confidence     : ${row.match_confidence}`);
    if ((row.match_confidence ?? 0) < 0.8) allHighConfidence = false;

    const totalTracks = (
      db.prepare('SELECT count(*) AS c FROM tracks WHERE album_id = ?').get(album.albumId) as { c: number }
    ).c;
    const mappedTracks = (
      db
        .prepare('SELECT count(*) AS c FROM tracks WHERE album_id = ? AND mb_recording_id IS NOT NULL')
        .get(album.albumId) as { c: number }
    ).c;
    console.log(`  tracks mapped  : ${mappedTracks}/${totalTracks}`);

    const credits = db
      .prepare(
        `SELECT ar.name AS artist, c.role AS role, c.track_ids AS track_ids
           FROM credits c JOIN artists ar ON ar.id = c.artist_id
          WHERE c.album_id = ?
          ORDER BY (c.track_ids IS NULL) DESC, c.role, ar.name`,
      )
      .all(album.albumId) as { artist: string; role: string; track_ids: string | null }[];
    console.log(`  credits        : ${credits.length}`);
    for (const credit of credits.slice(0, 5)) {
      const scope = credit.track_ids
        ? `${(JSON.parse(credit.track_ids) as string[]).length} track(s)`
        : 'whole album';
      console.log(`    - ${credit.artist} — ${credit.role} (${scope})`);
    }

    if (album.slug === 'daft-punk-discovery') {
      const names = credits.map((c) => c.artist);
      daftPunkMembers =
        names.some((n) => n.includes('Bangalter')) && names.some((n) => n.includes('Homem'));
      console.log(
        `  Daft Punk members in credits: Thomas Bangalter=${names.some((n) => n.includes('Bangalter'))}, ` +
          `Guy-Manuel de Homem-Christo=${names.some((n) => n.includes('Homem'))}`,
      );
    }

    const genres = JSON.parse(row.genres as string) as string[];
    console.log(`  genres         : ${genres.length > 0 ? genres.join(', ') : '—'}`);

    const coverSaved = Boolean(row.cover_path) && existsSync(row.cover_path as string);
    if (coverSaved) coversSaved++;
    console.log(`  cover          : ${coverSaved ? `yes (${row.cover_path})` : 'no'}`);
    console.log(`  mb release id  : ${row.mb_release_id}`);
  }

  const fk = db.pragma('foreign_key_check') as unknown[];
  console.log('\n--- checks ---');
  console.log(`albums matched with confidence >= 0.8: ${allHighConfidence ? 'yes' : 'NO'}`);
  console.log(`Daft Punk credits include both members: ${daftPunkMembers ? 'yes' : 'NO'}`);
  console.log(`covers saved: ${coversSaved}/${albums.length}`);
  console.log(`PRAGMA foreign_key_check: ${fk.length === 0 ? 'clean' : JSON.stringify(fk)}`);
  console.log(`temp db: ${join(workDir, 'live.db')}`);

  if (!allHighConfidence || !daftPunkMembers || fk.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
