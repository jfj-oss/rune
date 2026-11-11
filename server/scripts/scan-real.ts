// Developer self-check: scan the real library into a throwaway database and print
// a diagnostic report. Never writes to the library; dataDir is a temp directory.
//
//   pnpm -C server exec tsx scripts/scan-real.ts

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { createScanner } from '../src/scan/index.js';

const LIBRARY = process.env.LINER_LIBRARY ?? '/path/to/Music';

interface Row {
  [key: string]: unknown;
}

function section(title: string): void {
  console.log(`\n=== ${title}`);
}

async function main(): Promise<void> {
  const keepDb = process.env.LINER_SCAN_KEEP === '1';
  const tempRoot = mkdtempSync(join(tmpdir(), 'liner-scan-real-'));
  const dataDir = join(tempRoot, 'data');
  mkdirSync(dataDir, { recursive: true });

  const cfg: Config = {
    libraryRoots: [LIBRARY],
    dataDir,
    port: 0,
    audioDevice: 'pipewire',
    userAgent: 'Liner/0.1 scan-real self-check',
  };
  const db = openDb(join(tempRoot, 'scan.db'));
  const scanner = createScanner(db, cfg);

  try {
    console.log(`library: ${LIBRARY}`);
    console.log(`temp db: ${join(tempRoot, 'scan.db')}`);
    console.log(`temp dataDir: ${dataDir}`);

    section('scan 1');
    const first = await scanner.scan();
    console.log(
      `files=${first.filesSeen} albums=${first.albumsFound} changedFiles=${first.changedFiles} changedAlbums=${first.changedAlbums} errors=${first.errors}`,
    );
    console.log(
      `elapsed=${(first.elapsedMs / 1000).toFixed(2)}s vanishedFiles=${first.vanishedFiles} cueAlbums=${first.cueAlbums}`,
    );

    section('scan 2 (incremental)');
    const second = await scanner.scan();
    console.log(
      `files=${second.filesSeen} albums=${second.albumsFound} changedFiles=${second.changedFiles} changedAlbums=${second.changedAlbums} errors=${second.errors}`,
    );
    console.log(
      `elapsed=${(second.elapsedMs / 1000).toFixed(2)}s vanishedFiles=${second.vanishedFiles} trackDeletions=${second.deletedTracks}`,
    );

    section('totals');
    const count = (sql: string): number =>
      Number((db.prepare(sql).get() as { n: number }).n);
    console.log(`files (tracks on disk): ${first.filesSeen}`);
    console.log(`albums: ${count('SELECT COUNT(*) AS n FROM albums')}`);
    console.log(`tracks: ${count('SELECT COUNT(*) AS n FROM tracks')}`);
    console.log(`artists: ${count('SELECT COUNT(*) AS n FROM artists')}`);
    console.log(
      `cue albums (albums with cue_start_ms tracks): ${count(
        'SELECT COUNT(DISTINCT album_id) AS n FROM tracks WHERE cue_start_ms IS NOT NULL',
      )}`,
    );

    section('data quality');
    const noArtist = db
      .prepare(
        `SELECT a.id, a.title, ar.name, a.folder_path
           FROM albums a JOIN artists ar ON ar.id = a.artist_id
          WHERE a.title = '' OR ar.name = 'Unknown Artist' OR ar.name = ''`,
      )
      .all() as Row[];
    console.log(`albums lacking artist or title: ${noArtist.length}`);
    for (const row of noArtist.slice(0, 10)) console.log(`  - ${String(row.title)} | ${String(row.name)}`);

    const noCover = count('SELECT COUNT(*) AS n FROM albums WHERE cover_path IS NULL');
    console.log(`albums with no cover: ${noCover}`);

    const noYear = count('SELECT COUNT(*) AS n FROM albums WHERE year IS NULL');
    console.log(`albums with no year: ${noYear}`);
    const formatJunk = count(
      `SELECT COUNT(*) AS n FROM albums a JOIN artists ar ON ar.id = a.artist_id
        WHERE lower(a.title) GLOB '*flac*' OR lower(ar.name) GLOB '*flac*'
           OR lower(a.title) GLOB '*kbps*' OR lower(ar.name) GLOB '*kbps*'
           OR lower(a.title) GLOB '*pmedia*' OR lower(ar.name) GLOB '*pmedia*'`,
    );
    console.log(`albums with FLAC/kbps/PMEDIA junk in title/artist: ${formatJunk}`);
    const bracketed = db
      .prepare(
        `SELECT a.title, ar.name, a.folder_path
           FROM albums a JOIN artists ar ON ar.id = a.artist_id
          WHERE a.title GLOB '*[[{]*' OR ar.name GLOB '*[[{]*'
          ORDER BY a.folder_path`,
      )
      .all() as Row[];
    console.log(
      `albums whose *tag* title still contains brackets (edition names, not release junk): ${bracketed.length}`,
    );
    for (const row of bracketed) console.log(`  - ${String(row.name)} — ${String(row.title)}`);

    section('format breakdown');
    const formats = db
      .prepare('SELECT format, COUNT(*) AS n FROM albums GROUP BY format ORDER BY n DESC')
      .all() as { format: string | null; n: number }[];
    for (const row of formats) console.log(`${String(row.format ?? '(none)')}: ${row.n}`);

    section('single-file cue albums');
    const cueAlbums = db
      .prepare(
        `SELECT a.id, a.title, a.folder_path, COUNT(t.id) AS tracks
           FROM albums a JOIN tracks t ON t.album_id = a.id
          WHERE t.cue_start_ms IS NOT NULL
          GROUP BY a.id ORDER BY a.folder_path`,
      )
      .all() as { id: string; title: string; folder_path: string; tracks: number }[];
    for (const album of cueAlbums) {
      const rows = db
        .prepare(
          'SELECT disc, cue_start_ms FROM tracks WHERE album_id = ? ORDER BY disc, cue_start_ms',
        )
        .all(album.id) as { disc: number; cue_start_ms: number }[];
      const discs = new Map<number, number[]>();
      for (const row of rows) {
        const list = discs.get(row.disc) ?? [];
        list.push(row.cue_start_ms);
        discs.set(row.disc, list);
      }
      let increasing = true;
      const parts: string[] = [];
      for (const [disc, starts] of discs) {
        if (!starts.every((v, i) => i === 0 || v > starts[i - 1]!)) increasing = false;
        parts.push(`disc ${disc}: ${starts.length} tracks ${starts[0]}..${starts[starts.length - 1]}ms`);
      }
      console.log(
        `${album.title} — ${album.tracks} tracks, increasingPerDisc=${increasing} (${parts.join('; ')}) [${album.folder_path}]`,
      );
    }

    section('Daft Punk - Discovery (mult-FILE cue must be ignored)');
    const discovery = db
      .prepare(
        `SELECT a.title, a.folder_path, COUNT(t.id) AS tracks, SUM(t.cue_start_ms IS NOT NULL) AS cue_tracks
           FROM albums a JOIN tracks t ON t.album_id = a.id
          WHERE a.folder_path LIKE '%Daft Punk - Discovery (2001)%'
          GROUP BY a.id`,
      )
      .all() as { title: string; folder_path: string; tracks: number; cue_tracks: number }[];
    for (const row of discovery) {
      console.log(`${row.title}: ${row.tracks} tracks (cue tracks: ${row.cue_tracks}) [${row.folder_path}]`);
    }

    section('ABBA 24Bit Vinyl Pack');
    const abba = db
      .prepare(
        `SELECT a.title, a.folder_path, COUNT(t.id) AS tracks
           FROM albums a JOIN tracks t ON t.album_id = a.id
          WHERE a.folder_path LIKE '%ABBA - 24Bit Vinyl Pack%'
          GROUP BY a.id ORDER BY a.folder_path`,
      )
      .all() as { title: string; folder_path: string; tracks: number }[];
    console.log(`albums: ${abba.length}`);
    for (const row of abba) console.log(`  - ${row.title} (${row.tracks} tracks)`);

    section('40 random albums (artist — album (year) [format])');
    const sample = db
      .prepare(
        `SELECT ar.name AS artist, a.title, a.year, a.format
           FROM albums a JOIN artists ar ON ar.id = a.artist_id
          ORDER BY random() LIMIT 40`,
      )
      .all() as { artist: string; title: string; year: number | null; format: string | null }[];
    for (const row of sample) {
      console.log(
        `${row.artist} — ${row.title} (${row.year ?? '?'}) [${row.format ?? '?'}]`,
      );
    }

    console.log('\ndone.');
  } finally {
    db.close();
    if (keepDb) console.log(`kept temp dir: ${tempRoot}`);
    else rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
