// Self-check for the browse routes against a COPY of the real library db.
// The original is opened read-only and snapshotted with SQLite's backup API;
// every route below runs on the copy, never on the user's database.
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/index.js';
import { registerBrowseRoutes, type BrowseTrack, type GenreFacet } from '../src/api/browse.js';

const srcPath = process.argv[2] ?? join(homedir(), '.local/share/liner/liner.db');
const tmp = mkdtempSync(join(tmpdir(), 'liner-browse-'));
const copy = join(tmp, 'liner.db');

const src = new Database(srcPath, { readonly: true, fileMustExist: true });
await src.backup(copy);
src.close();
console.log(`source (read-only): ${srcPath}`);
console.log(`temp copy:          ${copy}`);

const db = openDb(copy);
const app = Fastify({ logger: false });
registerBrowseRoutes(app, db);
await app.ready();

const albumCount = (db.prepare('SELECT count(*) AS n FROM albums').get() as { n: number }).n;
const trackCount = (db.prepare('SELECT count(*) AS n FROM tracks').get() as { n: number }).n;
const cols = (db.prepare('PRAGMA table_info(albums)').all() as { name: string }[]).map((c) => c.name);
console.log(`albums: ${albumCount}, tracks: ${trackCount}, albums.in_library: ${cols.includes('in_library') ? 'yes' : 'no'}`);

async function get<T>(url: string): Promise<T> {
  const res = await app.inject({ method: 'GET', url });
  if (res.statusCode !== 200) throw new Error(`${url} → ${res.statusCode} ${res.body}`);
  return res.json() as T;
}

// ---- genres
const genres = await get<GenreFacet[]>('/genres');
console.log(`\nGET /genres → ${genres.length} genres; top 15:`);
for (const g of genres.slice(0, 15)) {
  console.log(`  ${String(g.albumCount).padStart(4)}  ${g.genre}  [covers: ${g.coverAlbumIds.length}]`);
}

// ---- tracks sorted by artist
const tracks = await get<{ items: BrowseTrack[]; total: number }>('/tracks?sort=artist&dir=asc&limit=5');
console.log(`\nGET /tracks?sort=artist&dir=asc&limit=5 → total ${tracks.total}; first 5:`);
for (const t of tracks.items) {
  const artists = t.artists.map((a) => a.name).join(', ') || '—';
  console.log(`  ${artists} — ${t.title} (${t.album.title})`);
}

// ---- timing (warm once, then 5 runs)
async function timed<T>(url: string): Promise<{ body: T; min: number; median: number; max: number }> {
  await get<T>(url);
  const times: number[] = [];
  let body!: T;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    body = await get<T>(url);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return {
    body,
    min: times[0]!,
    median: times[Math.floor(times.length / 2)]!,
    max: times[times.length - 1]!,
  };
}

const trackTiming = await timed<{ items: BrowseTrack[]; total: number; }>('/tracks?limit=200');
const genreTiming = await timed<GenreFacet[]>('/genres');

// ---- leak check
const raw = JSON.stringify({ tracks: trackTiming.body, genres: genreTiming.body });
const leak = /"path"|"folderPath"|\/mnt\/|\/home\//.test(raw);

console.log('\ntiming (5 runs after 1 warmup):');
const fmt = (t: { min: number; median: number; max: number }) => `min ${t.min.toFixed(2)} ms, median ${t.median.toFixed(2)} ms, max ${t.max.toFixed(2)} ms`;
console.log(`  GET /tracks?limit=200 → ${trackTiming.body.items.length} items, total ${trackTiming.body.total}: ${fmt(trackTiming)}`);
console.log(`  GET /genres            → ${genreTiming.body.length} genres: ${fmt(genreTiming)}`);
console.log(`  under 50 ms each:      ${trackTiming.median < 50 && genreTiming.median < 50 ? 'PASS' : 'FAIL'}`);
console.log(`  file paths in payload: ${leak ? 'FOUND (FAIL)' : 'none (PASS)'}`);

if (trackTiming.median >= 50 || genreTiming.median >= 50 || leak) process.exitCode = 1;

await app.close();
db.close();
rmSync(tmp, { recursive: true, force: true });
