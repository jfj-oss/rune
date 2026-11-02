// Live self-check for album editions + artist discography. Network is allowed
// here only (unit tests replay tests/fixtures/editions/).
//
// Run: pnpm -C server exec tsx scripts/editions-selfcheck.ts
//
// The real library DB is copied with `sqlite3 -readonly <src> ".backup <tmp>"`;
// the original is never opened for writing. Prints every edition for 5 matched
// albums and the owned/missing discography for 3 artists, plus elapsed time.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';
import { createEditions, type AlbumEditions, type ArtistDiscography } from '../src/editions/index.js';

const REAL_DB = process.env.LINER_DB ?? join(homedir(), '.local/share/liner/liner.db');

interface AlbumRow {
  id: string;
  title: string;
  artist: string;
  year: number | null;
  release_date: string | null;
  mb_release_id: string;
  mb_release_group_id: string | null;
}

interface ArtistRow {
  id: string;
  name: string;
  mbid: string;
  albums: number;
}

// Releases the recording fixtures were made from, plus two more real albums.
const PREFERRED_RELEASES = [
  '6a09041b-0f79-3278-88d9-0552dd28d37f', // Radiohead — OK Computer
  '43d27d70-3e4f-46f0-b40e-ef4467145b0c', // Nirvana — Nevermind
  'c80cdcf0-0b8d-4c40-bbbb-54b286fd9a21', // Daft Punk — Discovery
  '22e5b621-7b7c-4168-a536-3090b79c17b6', // The Smashing Pumpkins — Siamese Dream
  '17c6d9f0-3d00-381e-892d-b40fdf995257', // ABBA — Arrival
];

const PREFERRED_ARTISTS = ['The Smashing Pumpkins', 'Radiohead', 'Daft Punk'];

const ALBUM_SELECT = `
  SELECT a.id, a.title, ar.name AS artist, a.year, a.release_date,
         a.mb_release_id, a.mb_release_group_id
    FROM albums a JOIN artists ar ON ar.id = a.artist_id`;

function copyRealDb(): { path: string; dir: string } {
  if (!existsSync(REAL_DB)) throw new Error(`real library db not found: ${REAL_DB}`);
  const dir = mkdtempSync(join(tmpdir(), 'liner-editions-selfcheck-'));
  const path = join(dir, 'liner.db');
  // -readonly + .backup = a consistent snapshot without touching the original.
  execFileSync('sqlite3', ['-readonly', REAL_DB, `.backup '${path}'`], { timeout: 120_000 });
  return { path, dir };
}

function pickAlbums(db: Db): AlbumRow[] {
  const byRelease = db.prepare(`${ALBUM_SELECT} WHERE a.mb_release_id = ? AND a.source = 'local'`);
  const picked: AlbumRow[] = [];
  const seen = new Set<string>();
  for (const releaseId of PREFERRED_RELEASES) {
    const row = byRelease.get(releaseId) as AlbumRow | undefined;
    if (row && !seen.has(row.id)) {
      picked.push(row);
      seen.add(row.id);
    }
  }
  if (picked.length < 5) {
    const fill = db
      .prepare(
        `${ALBUM_SELECT}
          WHERE a.mb_release_id IS NOT NULL AND a.source = 'local'
          ORDER BY ar.name COLLATE NOCASE, a.year, a.title`,
      )
      .all() as AlbumRow[];
    for (const row of fill) {
      if (picked.length >= 5) break;
      if (seen.has(row.id)) continue;
      picked.push(row);
      seen.add(row.id);
    }
  }
  return picked.slice(0, 5);
}

function pickArtists(db: Db): ArtistRow[] {
  const picked: ArtistRow[] = [];
  const byName = db.prepare(
    `SELECT ar.id, ar.name, ar.mbid, count(a.id) AS albums
       FROM artists ar LEFT JOIN albums a ON a.artist_id = ar.id
      WHERE ar.mbid IS NOT NULL AND lower(ar.name) = lower(?)
      GROUP BY ar.id ORDER BY albums DESC LIMIT 1`,
  );
  for (const name of PREFERRED_ARTISTS) {
    const row = byName.get(name) as ArtistRow | undefined;
    if (row && !picked.some((p) => p.id === row.id)) picked.push(row);
  }
  if (picked.length < 3) {
    const fill = db
      .prepare(
        `SELECT ar.id, ar.name, ar.mbid, count(a.id) AS albums
           FROM artists ar LEFT JOIN albums a ON a.artist_id = ar.id
          WHERE ar.mbid IS NOT NULL
          GROUP BY ar.id ORDER BY albums DESC, ar.name COLLATE NOCASE`,
      )
      .all() as ArtistRow[];
    for (const row of fill) {
      if (picked.length >= 3) break;
      if (!picked.some((p) => p.id === row.id)) picked.push(row);
    }
  }
  return picked.slice(0, 3);
}

function printAlbum(row: AlbumRow, result: AlbumEditions): number {
  console.log(
    `\n== ${row.artist} — ${row.title} (${row.year ?? '?'})  ${row.id}\n` +
      `   original=${result.originalReleaseDate ?? '?'}  type=${result.releaseGroupType ?? '?'}  ` +
      `secondary=[${result.secondaryTypes.join(', ')}]  editions=${result.editions.length}  ` +
      `otherVersions=${result.otherVersionsInLibrary.length}`,
  );
  for (const edition of result.editions) {
    const marker = edition.isThisOne ? '*' : ' ';
    const fields = [
      edition.date ?? '?',
      (edition.country ?? '??').padEnd(2),
      edition.title,
      edition.label ?? '-',
      edition.catalogNumber ?? '-',
      edition.format ?? '-',
      `${edition.trackCount} tr`,
      edition.mbReleaseId,
    ];
    console.log(`   ${marker} ${fields.join(' | ')}`);
  }
  for (const other of result.otherVersionsInLibrary) {
    console.log(`   + other in library: ${other.title} (${other.year ?? '?'})  ${other.id}`);
  }
  return result.editions.length;
}

function printDiscography(row: ArtistRow, result: ArtistDiscography): { owned: number; missing: number } {
  const owned = result.releaseGroups.filter((g) => g.owned);
  const missing = result.releaseGroups.filter((g) => !g.owned);
  console.log(
    `\n== ${row.name}  ${row.mbid}\n` +
      `   library albums=${row.albums}  releaseGroups=${result.releaseGroups.length}  ` +
      `owned=${owned.length}  missing=${missing.length}`,
  );
  for (const group of result.releaseGroups) {
    const tag = group.owned ? '[owned  ]' : '[missing]';
    const date = group.date ?? String(group.year ?? '?');
    console.log(
      `   ${tag} ${date.padEnd(10)} ${(group.type ?? '?').padEnd(12)} ${group.title}` +
        (group.albumIds.length > 0 ? `  -> ${group.albumIds.join(', ')}` : ''),
    );
  }
  return { owned: owned.length, missing: missing.length };
}

async function main(): Promise<void> {
  const started = Date.now();
  const copy = copyRealDb();
  const db = openDb(copy.path);
  const copyMs = Date.now() - started;
  try {
    const cfg = loadConfig();
    const editions = createEditions(db, cfg);

    const albums = pickAlbums(db);
    console.log(`real db: ${REAL_DB}`);
    console.log(`temp copy: ${copy.path} (${copyMs} ms)`);
    console.log(`albums: ${albums.length}, artists: ${PREFERRED_ARTISTS.length}`);

    let editionTotal = 0;
    for (const album of albums) {
      const result = await editions.getAlbumEditions(album.id);
      if (!result) {
        console.log(`\n== ${album.artist} — ${album.title}: NOT FOUND`);
        continue;
      }
      editionTotal += printAlbum(album, result);
    }

    const artists = pickArtists(db);
    let ownedTotal = 0;
    let missingTotal = 0;
    for (const artist of artists) {
      const result = await editions.getArtistDiscography(artist.id);
      if (!result) {
        console.log(`\n== ${artist.name}: NOT FOUND`);
        continue;
      }
      const counts = printDiscography(artist, result);
      ownedTotal += counts.owned;
      missingTotal += counts.missing;
    }

    console.log(
      `\nSUMMARY albums=${albums.length} editions=${editionTotal} ` +
        `artists=${artists.length} ownedReleaseGroups=${ownedTotal} missingReleaseGroups=${missingTotal}`,
    );
    console.log(`elapsed: ${Date.now() - started} ms`);
  } finally {
    db.close();
    rmSync(copy.dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
