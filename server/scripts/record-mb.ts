// Records the real MusicBrainz WS/2 responses used by the matcher tests and the
// live end-to-end script into server/tests/fixtures/mb/.
//
// Network is allowed here (and ONLY here). The generated manifest maps every
// requested URL to a raw JSON file so tests can replay them through the injected
// fetch without touching the network.
//
// Usage: pnpm -C server exec tsx scripts/record-mb.ts
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, ids } from '../src/db/index.js';
import type { Config } from '../src/config.js';
import {
  MbClient,
  RateLimiter,
  artistCreditName,
  flattenReleaseTracks,
  searchItemTrackCount,
  yearFromDate,
  type FetchLike,
  type MbRelease,
  type MbSearchRelease,
} from '../src/match/mb.js';
import { createMatcher } from '../src/match/index.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(scriptDir, '..', 'tests', 'fixtures', 'mb');
const REAL_FETCH = globalThis.fetch.bind(globalThis);
const USER_AGENT = 'Liner/0.1 ( personal music player, self-hosted )';

interface AlbumDef {
  slug: string;
  title: string;
  artist: string;
  year: number;
  trackCount: number;
  format: string;
}

const ALBUMS: AlbumDef[] = [
  { slug: 'daft-punk-discovery', title: 'Discovery', artist: 'Daft Punk', year: 2001, trackCount: 14, format: 'FLAC 16/44.1' },
  { slug: 'alice-in-chains-jar-of-flies', title: 'Jar of Flies', artist: 'Alice In Chains', year: 1994, trackCount: 7, format: 'FLAC 16/44.1' },
  { slug: 'bill-withers-still-bill', title: 'Still Bill', artist: 'Bill Withers', year: 1972, trackCount: 10, format: 'FLAC 16/44.1' },
  {
    slug: 'bob-marley-uprising',
    title: 'Uprising',
    artist: 'Bob Marley & The Wailers',
    year: 1980,
    trackCount: 10,
    format: 'FLAC 16/44.1',
  },
  {
    slug: 'blue-oyster-cult-fire-of-unknown-origin',
    title: 'Fire of Unknown Origin',
    artist: 'Blue Öyster Cult',
    year: 1981,
    trackCount: 9,
    format: 'FLAC 16/44.1',
  },
];

interface ManifestEntry {
  file: string;
  status: number;
  fetchedAt: number;
}
type Manifest = Record<string, ManifestEntry>;

const manifest: Manifest = {};

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

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

function seedScore(item: MbSearchRelease, def: AlbumDef): number {
  const released = yearFromDate(item.date) ?? yearFromDate(item['release-group']?.['first-release-date']);
  const count = searchItemTrackCount(item);
  let score = (item.score ?? 0) / 100;
  score += count === def.trackCount ? 1 : -Math.abs(count - def.trackCount) * 0.3;
  if (released === def.year) score += 0.6;
  else score -= Math.abs((released ?? def.year) - def.year) * 0.1;
  if (item.status === 'Official') score += 0.1;
  const formats = (item.media ?? []).map((m) => m.format);
  if (formats.length > 0 && formats.every((f) => f === 'CD')) score += 0.05;
  return score;
}

function insertLocalAlbum(
  db: ReturnType<typeof openDb>,
  def: AlbumDef,
  release: MbRelease,
  overrides: { title?: string; artist?: string } = {},
): string {
  const title = overrides.title ?? def.title;
  const artist = overrides.artist ?? def.artist;
  const folder = `/music/${def.slug}${overrides.title || overrides.artist ? '-weak' : ''}`;
  const albumId = ids.localAlbum(folder);
  const artistId = ids.artistByName(artist);
  db.prepare('INSERT OR IGNORE INTO artists (id, name) VALUES (?, ?)').run(artistId, artist);

  const label = release['label-info']?.find((info) => info.label?.name)?.label?.name ?? null;
  db.prepare(
    `INSERT INTO albums (id, source, title, artist_id, year, format, label, folder_path, added_at)
     VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(albumId, title, artistId, def.year, def.format, label, folder, Date.now());

  const insertTrack = db.prepare(
    `INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms, path, format)
     VALUES (?, ?, 'local', ?, ?, ?, ?, ?, 'flac')`,
  );
  const insertTrackArtist = db.prepare(
    'INSERT OR IGNORE INTO track_artists (track_id, artist_id, position) VALUES (?, ?, ?)',
  );

  const flat = flattenReleaseTracks(release);
  for (const item of flat) {
    const length = item.track.length ?? item.recording?.length ?? 200000;
    const trackId = ids.localTrack(`${folder}/${item.medium}-${item.position}.flac`);
    insertTrack.run(
      trackId,
      albumId,
      item.track.title,
      item.medium,
      item.position,
      length,
      `${folder}/${item.medium}-${item.position}.flac`,
    );
    insertTrackArtist.run(trackId, artistId, 0);
  }
  return albumId;
}

async function main(): Promise<void> {
  rmSync(fixturesDir, { recursive: true, force: true });
  mkdirSync(fixturesDir, { recursive: true });
  writeFileSync(join(fixturesDir, 'manifest.json'), '{}\n');

  const dataDir = mkdtempSync(join(tmpdir(), 'liner-record-mb-'));
  const db = openDb(join(dataDir, 'record.db'));
  const limiter = new RateLimiter(1000);
  const cfg: Config = {
    libraryRoots: [],
    dataDir,
    port: 0,
    audioDevice: 'pipewire',
    userAgent: USER_AGENT,
  };

  const client = new MbClient({
    userAgent: USER_AGENT,
    db,
    fetch: recordingFetch,
    limiter,
  });

  const matcher = createMatcher(db, cfg, {
    fetch: recordingFetch,
    limiter,
    downloadCovers: false,
    now: () => Date.now(),
  });

  const albumSummaries: unknown[] = [];

  for (const def of ALBUMS) {
    console.log(`\n=== ${def.artist} — ${def.title} (${def.trackCount} tracks, ${def.year}) ===`);

    const results = await client.searchRelease(def.title, def.artist, 15);
    if (results.length === 0) throw new Error(`no search results for ${def.title}`);
    const seed = [...results].sort((a, b) => seedScore(b, def) - seedScore(a, def))[0]!;
    console.log(
      `  seed: ${seed.id} "${seed.title}" ${seed.date ?? '?'} ${seed.country ?? '?'} ` +
        `tracks=${searchItemTrackCount(seed)} formats=${(seed.media ?? []).map((m) => m.format).join('/')}`,
    );

    const seedRelease = await client.getRelease(seed.id);
    const albumId = insertLocalAlbum(db, def, seedRelease);

    const before = Date.now();
    await matcher.matchPending((done, total) => {
      if (total) console.log(`  matched ${done}/${total}`);
    });
    console.log(`  matcher took ${Date.now() - before} ms`);

    const row = db
      .prepare('SELECT mb_release_id, match_confidence FROM albums WHERE id = ?')
      .get(albumId) as { mb_release_id: string | null; match_confidence: number | null } | undefined;
    if (!row?.mb_release_id) throw new Error(`matcher did not match ${def.title}`);
    const selected = await client.getRelease(row.mb_release_id);
    const selectedTracks = flattenReleaseTracks(selected);
    console.log(
      `  selected: ${selected.id} "${selected.title}" ${selected.date ?? '?'} ` +
        `tracks=${selectedTracks.length} confidence=${row.match_confidence}`,
    );
    if (selectedTracks.length !== def.trackCount) {
      throw new Error(`selected release has ${selectedTracks.length} tracks, expected ${def.trackCount}`);
    }
    if ((row.match_confidence ?? 0) < 0.8) {
      throw new Error(`low confidence ${row.match_confidence} for ${def.title}`);
    }

    // Record the weak-tag fallback path once (Discovery is enough for the tests):
    // missing/garbage album titles must be found via the first few track titles.
    if (def.slug === 'daft-punk-discovery') {
      const weakDb = openDb(join(dataDir, `weak-${def.slug}.db`));
      const weakId = insertLocalAlbum(weakDb, def, seedRelease, { title: 'Unknown Album' });
      const weakMatcher = createMatcher(weakDb, cfg, {
        fetch: recordingFetch,
        limiter,
        downloadCovers: false,
        now: () => Date.now(),
      });
      await weakMatcher.matchPending();
      const weakRow = weakDb
        .prepare('SELECT mb_release_id, match_confidence FROM albums WHERE id = ?')
        .get(weakId) as { mb_release_id: string | null; match_confidence: number | null } | undefined;
      console.log(
        `  weak-tag pass: selected=${weakRow?.mb_release_id ?? 'none'} confidence=${weakRow?.match_confidence ?? 'none'}`,
      );
      weakDb.close();
    }

    albumSummaries.push({
      slug: def.slug,
      albumId,
      title: def.title,
      artist: def.artist,
      year: def.year,
      format: def.format,
      label: seedRelease['label-info']?.find((i) => i.label?.name)?.label?.name ?? null,
      targetReleaseId: selected.id,
      targetReleaseGroupId: selected['release-group']?.id ?? null,
      targetTitle: selected.title,
      targetArtist: artistCreditName(selected['artist-credit']),
      targetDate: selected.date ?? null,
      confidence: row.match_confidence,
      tracks: flattenReleaseTracks(seedRelease).map((t, index) => ({
        id: ids.localTrack(`/music/${def.slug}/${t.medium}-${t.position}.flac`),
        title: t.track.title,
        disc: t.medium,
        number: t.position,
        durationMs: t.track.length ?? t.recording?.length ?? 200000,
        index,
      })),
    });
  }

  writeFileSync(join(fixturesDir, 'albums.json'), JSON.stringify(albumSummaries, null, 2) + '\n');
  const fileCount = Object.keys(manifest).length;
  console.log(`\nWrote ${fileCount} raw responses + albums.json to ${fixturesDir}`);
  console.log(`Seed DB kept at ${join(dataDir, 'record.db')}`);

  // Sanity: everything the tests need is present.
  const albumsJson = JSON.parse(readFileSync(join(fixturesDir, 'albums.json'), 'utf8')) as unknown[];
  if (albumsJson.length !== ALBUMS.length) throw new Error('albums.json incomplete');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
