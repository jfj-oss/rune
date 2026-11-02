// Records real MusicBrainz responses for the offline editions/discography unit
// tests. Network access is allowed here only; the tests replay the JSON.
//
// Run: pnpm -C server exec tsx scripts/record-editions.ts
//
// Fixtures live in tests/fixtures/editions/ as { url, status, body } (deduped by
// URL). Three albums cover both discovery paths (release-group id already stored
// vs. release lookup -> release group) and two artists cover discography
// pagination / owned matching.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { openDb, ids, type Db } from '../src/db/index.js';
import { loadConfig, type Config } from '../src/config.js';
import { MbClient } from '../src/match/mb.js';
import { createEditions, type Editions } from '../src/editions/index.js';

const OUT = new URL('../tests/fixtures/editions/', import.meta.url);

interface AlbumTarget {
  slug: string;
  title: string;
  artist: string;
  /** Canonical artist mbid (so the seeded artist id matches production). */
  artistMbid: string;
  year: number;
  releaseId: string;
  /** Omit to exercise the release lookup -> release-group path. */
  releaseGroupId?: string;
  note: string;
}

interface ArtistTarget {
  slug: string;
  name: string;
  mbid: string;
  note: string;
}

// Real library ids (all present in ~/.local/share/liner/liner.db when recorded).
const albumTargets: AlbumTarget[] = [
  {
    slug: 'ok-computer',
    title: 'OK Computer',
    artist: 'Radiohead',
    artistMbid: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
    year: 1997,
    releaseId: '6a09041b-0f79-3278-88d9-0552dd28d37f',
    releaseGroupId: 'b1392450-e666-3926-a536-22c65f834433',
    note: 'release-group id stored — release lookup skipped',
  },
  {
    slug: 'nevermind',
    title: 'Nevermind',
    artist: 'Nirvana',
    artistMbid: '5b11f4ce-a62d-471e-81fc-a69a8278c7da',
    year: 1991,
    releaseId: '43d27d70-3e4f-46f0-b40e-ef4467145b0c',
    note: 'no release-group id — release lookup discovers it',
  },
  {
    slug: 'discovery',
    title: 'Discovery',
    artist: 'Daft Punk',
    artistMbid: '056e4f3e-d505-4dad-8ec1-d04f521cbb56',
    year: 2001,
    releaseId: 'c80cdcf0-0b8d-4c40-bbbb-54b286fd9a21',
    releaseGroupId: '48117b90-a16e-34ca-a514-19c702df1158',
    note: 'release-group id stored',
  },
];

const artistTargets: ArtistTarget[] = [
  {
    slug: 'smashing-pumpkins',
    name: 'The Smashing Pumpkins',
    mbid: 'ba0d6274-db14-4ef5-b28d-657ebde1a396',
    note: 'large discography: owned + missing albums',
  },
  {
    slug: 'daft-punk',
    name: 'Daft Punk',
    mbid: '056e4f3e-d505-4dad-8ec1-d04f521cbb56',
    note: 'small discography',
  },
];

interface Fixture {
  url: string;
  status: number;
  body: string;
  note?: string;
}

function maxCacheRowid(db: Db): number {
  return (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM http_cache').get() as { n: number }).n;
}

function kindFor(url: string): string | null {
  if (url.startsWith('https://musicbrainz.org/ws/2/release-group/')) return 'release-group';
  if (url.startsWith('https://musicbrainz.org/ws/2/release/?') && url.includes('artist=')) {
    return `discography-releases-p${pageOf(url)}`;
  }
  if (url.startsWith('https://musicbrainz.org/ws/2/release/?') && url.includes('release-group=')) {
    return `releases-p${pageOf(url)}`;
  }
  if (url.startsWith('https://musicbrainz.org/ws/2/release/')) return 'release-lookup';
  return null;
}

function pageOf(url: string): number {
  const offset = Number(new URL(url).searchParams.get('offset') ?? '0');
  return Math.floor(offset / 100) + 1;
}

function writeFixture(dir: string, base: string, fixture: Fixture, used: Set<string>): void {
  if (used.has(fixture.url)) return;
  let file = `${base}.json`;
  let n = 2;
  while (readdirSync(dir).includes(file)) file = `${base}-${n++}.json`;
  writeFileSync(new URL(file, OUT), `${JSON.stringify(fixture, null, 1)}\n`);
  used.add(fixture.url);
  console.log(`  saved ${file} (${fixture.body.length} bytes, status ${fixture.status})`);
}

function capture(db: Db, since: number, dir: string, base: string, used: Set<string>): number {
  const rows = db
    .prepare('SELECT key, body, status FROM http_cache WHERE rowid > ? ORDER BY rowid')
    .all(since) as { key: string; body: string; status: number }[];
  let written = 0;
  for (const row of rows) {
    const kind = kindFor(row.key);
    if (!kind) continue;
    writeFixture(dir, `${base}--${kind}`, { url: row.key, status: row.status, body: row.body }, used);
    written++;
  }
  return written;
}

async function main(): Promise<void> {
  const dir = OUT.pathname;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const cfg: Config = loadConfig();
  const db = openDb(':memory:');

  const realFetch = globalThis.fetch.bind(globalThis);
  const mb = new MbClient({ userAgent: cfg.userAgent, db, fetch: realFetch, rateLimitMs: 1000 });
  const editions: Editions = createEditions(db, cfg, { mbClient: mb, now: Date.now });

  const used = new Set<string>();
  let failures = 0;

  try {
    for (const target of albumTargets) {
      console.log(`\n${target.artist} — ${target.title} (${target.note})`);
      const artistId = ids.artistByMbid(target.artistMbid);
      db.prepare('INSERT OR REPLACE INTO artists (id, name, mbid) VALUES (?, ?, ?)').run(
        artistId,
        target.artist,
        target.artistMbid,
      );
      const albumId = ids.localAlbum(`/music/rec/${target.slug}`);
      db.prepare(
        `INSERT OR REPLACE INTO albums
           (id, source, title, artist_id, year, release_date, mb_release_id, mb_release_group_id, added_at)
         VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        albumId,
        target.title,
        artistId,
        target.year,
        String(target.year),
        target.releaseId,
        target.releaseGroupId ?? null,
        Date.now(),
      );

      const since = maxCacheRowid(db);
      const result = await editions.getAlbumEditions(albumId, { refresh: true });
      if (!result || result.editions.length === 0) {
        console.log('  !! no editions');
        failures++;
        continue;
      }
      const current = result.editions.filter((e) => e.isThisOne).length;
      console.log(
        `  ${result.editions.length} editions, original=${result.originalReleaseDate ?? '?'} type=${result.releaseGroupType ?? '?'} current=${current}`,
      );
      if (current !== 1) {
        console.log('  !! expected exactly one isThisOne edition');
        failures++;
      }
      const written = capture(db, since, dir, target.slug, used);
      if (written === 0) {
        console.log('  !! no MB responses captured');
        failures++;
      }
    }

    for (const target of artistTargets) {
      console.log(`\n${target.name} (${target.note})`);
      const artistId = ids.artistByMbid(target.mbid);
      db.prepare('INSERT OR REPLACE INTO artists (id, name, mbid) VALUES (?, ?, ?)').run(artistId, target.name, target.mbid);

      const since = maxCacheRowid(db);
      const result = await editions.getArtistDiscography(artistId, { refresh: true });
      if (!result || result.releaseGroups.length === 0) {
        console.log('  !! empty discography');
        failures++;
        continue;
      }
      console.log(`  ${result.releaseGroups.length} release groups`);
      const written = capture(db, since, dir, target.slug, used);
      if (written === 0) {
        console.log('  !! no MB responses captured');
        failures++;
      }
    }

    console.log(`\nfixtures written to ${dir}`);
    console.log(`files: ${readdirSync(dir).length}, failures: ${failures}`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
