// Self-check for Spotify album/track linking against a COPY of the real library
// database and a local fake Spotify Web API server.
//
// Run: pnpm -C server exec tsx scripts/selfcheck-linking.ts
//
// - The real DB is snapshotted with SQLite's `.backup` into a temp directory; the
//   original is never opened for writing.
// - Five matched local albums are taken from the copy. Two get a fake MusicBrainz
//   barcode (UPC path); three get none (title/artist fallback).
// - The fake Spotify server returns a "deluxe" candidate first for fallback
//   searches, so the track-count verification must reject it.
// - The fake server runs as a child process and is killed by PID afterwards.
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { openDb, type Db } from '../src/db/index.js';
import type { Config } from '../src/config.js';
import type { MbRelease } from '../src/match/mb.js';
import { SpotifyApi } from '../src/spotify/api.js';
import { createLinking, type MbBarcodeClient } from '../src/spotify/linking.js';

const here = dirname(fileURLToPath(import.meta.url));
const REAL_DB = join(homedir(), '.local/share/liner/liner.db');

const now = () => Date.now();
const tmp = mkdtempSync(join(tmpdir(), 'liner-splink-selfcheck-'));
const copy = join(tmp, 'liner.db');
console.log(`real db (read-only backup source): ${REAL_DB}`);
console.log(`temp copy:                         ${copy}`);

// SQLite's .backup snapshots the live DB (WAL included) without touching it.
execFileSync('sqlite3', [REAL_DB, `.backup '${copy}'`], { stdio: 'inherit' });
const db: Db = openDb(copy);

// ---------- pick five matched local albums ----------

interface LocalTrackRow {
  id: string;
  title: string;
  disc: number;
  number: number;
  duration_ms: number;
}

interface PickedAlbum {
  id: string;
  title: string;
  artist: string;
  mbReleaseId: string;
  tracks: LocalTrackRow[];
  barcode?: string;
}

const candidates = db
  .prepare(
    `SELECT a.id, a.title, ar.name AS artist, a.mb_release_id
       FROM albums a JOIN artists ar ON ar.id = a.artist_id
      WHERE a.source = 'local' AND a.mb_release_id IS NOT NULL
      ORDER BY a.added_at DESC, a.id
      LIMIT 60`,
  )
  .all() as { id: string; title: string; artist: string; mb_release_id: string }[];

const picked: PickedAlbum[] = [];
const seen = new Set<string>();
for (const row of candidates) {
  const key = `${row.title.toLowerCase()}|${row.artist.toLowerCase()}`;
  if (seen.has(key)) continue;
  const tracks = db
    .prepare('SELECT id, title, disc, number, duration_ms FROM tracks WHERE album_id = ? ORDER BY disc, number')
    .all(row.id) as LocalTrackRow[];
  if (tracks.length < 2 || tracks.length > 15) continue;
  if (tracks.some((t) => !t.duration_ms || t.duration_ms <= 0)) continue;
  seen.add(key);
  picked.push({
    id: row.id,
    title: row.title,
    artist: row.artist,
    mbReleaseId: row.mb_release_id,
    tracks,
  });
  if (picked.length === 5) break;
}
if (picked.length < 5) throw new Error(`only found ${picked.length} usable local albums in the copy`);

// First two go through the UPC path, the rest through title/artist search.
picked.forEach((album, i) => {
  if (i < 2) album.barcode = String(777_000_000_001 + i);
});

console.log('\nselected albums:');
for (const [i, album] of picked.entries()) {
  console.log(
    `  ${i + 1}. ${album.artist} — ${album.title} | ${album.tracks.length} tracks | ` +
      (album.barcode ? `barcode ${album.barcode} (UPC path)` : 'no barcode (search path)'),
  );
}

// ---------- fixture for the fake Spotify server ----------

const fixture = {
  albums: picked.map((album, i) => ({
    id: `sp-album-${i + 1}`,
    title: album.title,
    artist: album.artist,
    barcode: album.barcode ?? null,
    tracks: album.tracks.map((t, j) => ({
      id: `sp-track-${i + 1}-${j + 1}`,
      name: t.title,
      disc: t.disc,
      number: t.number,
      durationMs: t.duration_ms,
    })),
  })),
};
const fixturePath = join(tmp, 'spotify-fixture.json');
writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));

// ---------- fake Spotify server child ----------

const child = spawn(process.execPath, [join(here, 'fake-spotify-linking-server.mjs'), '0', fixturePath], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
const fakePort = await new Promise<number>((resolve, reject) => {
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (line.startsWith('LISTEN ')) {
      rl.close();
      resolve(Number(line.slice('LISTEN '.length)));
    }
  });
  child.on('error', reject);
  child.on('exit', (code) => {
    if (code) reject(new Error(`fake Spotify server exited with ${code}`));
  });
});
console.log(`\nfake Spotify server pid=${child.pid} on http://127.0.0.1:${fakePort}`);

try {
  // ---------- wire the linker ----------

  const barcodes = new Map(picked.filter((a) => a.barcode).map((a) => [a.mbReleaseId, a.barcode!]));
  const mb: MbBarcodeClient = {
    async getRelease(id: string): Promise<MbRelease & { barcode?: string | null }> {
      return { id, title: '', barcode: barcodes.get(id) ?? null } as unknown as MbRelease & {
        barcode?: string | null;
      };
    },
  };
  const cfg: Config = {
    libraryRoots: [],
    dataDir: tmp,
    port: 0,
    audioDevice: 'none',
    userAgent: 'liner-splink-selfcheck',
  };
  const api = new SpotifyApi({
    fetch: (url, init) => globalThis.fetch(url, init),
    baseUrl: `http://127.0.0.1:${fakePort}/v1`,
    getToken: async () => 'sim-token',
  });
  const linking = createLinking(db, cfg, {
    api,
    mb,
    now,
    // Production cadence is 1 req/s; keep it here so the run exercises the real limiter.
    rateLimitMs: 1000,
  });

  // Link exactly the five chosen albums (the full pending set in the real library
  // is ~300 albums, which would make this check take minutes at 1 req/s).
  const started = Date.now();
  const result = { total: picked.length, attempted: 0, linked: 0, notFound: 0, failed: 0, rateLimited: false };
  for (const [i, album] of picked.entries()) {
    const link = await linking.linkAlbum(album.id);
    result.attempted++;
    if (link) result.linked++;
    else result.notFound++;
    console.log(
      `  ${i + 1}/${picked.length} ${album.artist} — ${album.title} -> ` +
        (link ? `${link.method} ${link.spotifyAlbumId} (${link.confidence})` : 'no match'),
    );
  }
  console.log(`\nlink 5 albums -> ${JSON.stringify(result)} in ${Date.now() - started} ms`);

  // ---------- print the links table ----------

  const rows = db
    .prepare(
      `SELECT l.album_id,
              al.title,
              ar.name AS artist,
              l.spotify_album_id,
              l.method,
              round(l.confidence, 4) AS confidence,
              (SELECT count(*) FROM track_links tl
                 JOIN tracks t ON t.id = tl.track_id
                WHERE t.album_id = l.album_id) AS mapped_tracks,
              (SELECT count(*) FROM tracks t WHERE t.album_id = l.album_id) AS local_tracks
         FROM album_links l
         JOIN albums al ON al.id = l.album_id
         LEFT JOIN artists ar ON ar.id = al.artist_id
        ORDER BY al.title`,
    )
    .all() as Record<string, unknown>[];

  console.log('\nalbum_links (joined):');
  console.table(rows);

  const totalTrackLinks = (db.prepare('SELECT count(*) AS n FROM track_links').get() as { n: number }).n;
  console.log(`track_links rows: ${totalTrackLinks}`);

  // ---------- request trace ----------

  const requests = (await (await fetch(`http://127.0.0.1:${fakePort}/__requests`)).json()) as {
    method: string;
    path: string;
    query: Record<string, string>;
  }[];
  const searches = requests.filter((r) => r.path === '/v1/search');
  const trackFetches = requests.filter((r) => r.path.endsWith('/tracks'));
  console.log(`\nSpotify requests: ${requests.length} (${searches.length} searches, ${trackFetches.length} track lists)`);
  for (const search of searches) console.log(`  search q=${search.query.q}`);
  console.log(
    `  deluxe candidates rejected: ${trackFetches.filter((r) => r.path.includes('/deluxe%3A') || r.path.includes('/deluxe:')).length}`,
  );

  // ---------- assertions ----------

  let ok = result.linked === 5 && result.notFound === 0 && result.failed === 0;
  for (const album of picked) {
    const row = rows.find((r) => r.album_id === album.id);
    if (!row) {
      console.error(`FAIL: ${album.title} has no album_links row`);
      ok = false;
      continue;
    }
    if (row.method !== (album.barcode ? 'upc' : 'search')) {
      console.error(`FAIL: ${album.title} method ${String(row.method)}`);
      ok = false;
    }
    if (row.mapped_tracks !== row.local_tracks) {
      console.error(`FAIL: ${album.title} mapped ${row.mapped_tracks}/${row.local_tracks} tracks`);
      ok = false;
    }
  }
  if (trackFetches.length < 5) {
    console.error('FAIL: expected at least one track-list fetch per album plus the rejected deluxe candidates');
    ok = false;
  }
  if (!ok) throw new Error('Spotify linking self-check FAILED');
  console.log('\nself-check PASSED: all 5 albums linked with a complete track map');
} finally {
  child.kill('SIGTERM');
  await once(child, 'exit');
  console.log(`\nfake Spotify server stopped (killed PID ${child.pid})`);
}
