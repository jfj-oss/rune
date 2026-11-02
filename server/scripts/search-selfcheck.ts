// Self-check: old /api/search vs new createSearch on a COPY of the real library.
//
//   sqlite3 "$HOME/.local/share/liner/liner.db" ".backup '$TMP/liner.db'"
//   pnpm -C server exec tsx scripts/search-selfcheck.ts "$TMP/liner.db"
//
// Never point this at the live database: openDb() writes schema/migrations.
import type { AlbumSummary, ArtistRef, Track } from '@liner/shared';
import { openDb, type Db } from '../src/db/index.js';
import { search as oldSearch } from '../src/api/library.js';
import { createSearch, type SearchResponse } from '../src/search/index.js';

const QUERIES = [
  'smashng pumpkns',
  'nutshel',
  'daft pnk discovery',
  'rafferty baker street',
  'oyster cult',
  'bjork',
  'acdc',
  'beatles',
  'abbey road',
  'radiohead',
  'kendrick lamar',
  'to pimp a butterfly',
  'fleetwood mac rumours',
  'kanye west 808s',
  'miles davis kind of blue',
  'toby wright',
  'smells like teen spirit',
  'bohemian rhapsody',
  'mellon collie',
  'nevermind',
  'modest mouse moon antarctica',
  'outkast hey ya',
  'pink floyd wish you were here',
  'jay z blueprint',
  'the national boxer',
];

const ITERATIONS = 5;

interface OldResult {
  albums: AlbumSummary[];
  artists: ArtistRef[];
  tracks: Track[];
}

function time<T>(fn: () => T): { value: T; ms: number } {
  let best = Infinity;
  let value!: T;
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    value = fn();
    best = Math.min(best, performance.now() - t0);
  }
  return { value, ms: best };
}

function short(parts: string[]): string {
  return parts.length ? parts.slice(0, 3).join('; ') : '—';
}

function fmtOld(r: OldResult): string {
  return [
    `albums: ${short(r.albums.map((a) => `${a.title} — ${a.artist.name}`))}`,
    `artists: ${short(r.artists.map((a) => a.name))}`,
    `tracks: ${short(r.tracks.map((t) => t.title))}`,
  ].join('\n      ');
}

function fmtNew(r: SearchResponse): string {
  const top =
    r.top == null
      ? '—'
      : r.top.kind === 'album'
        ? `album: ${r.top.album.title} — ${r.top.album.artist.name}`
        : r.top.kind === 'artist'
          ? `artist: ${r.top.artist.name}`
          : `track: ${r.top.track.title}`;
  return [
    `top: ${top}`,
    `albums: ${short(r.albums.map((a) => `${a.title} — ${a.artist.name}`))}`,
    `artists: ${short(r.artists.map((a) => a.name))}`,
    `tracks: ${short(r.tracks.map((t) => t.title))}`,
  ].join('\n      ');
}

function main(): void {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: tsx scripts/search-selfcheck.ts <db-copy-path>');
    process.exit(2);
  }
  const db: Db = openDb(path);
  const counts = {
    albums: (db.prepare('SELECT count(*) n FROM albums WHERE in_library = 1').get() as { n: number }).n,
    tracks: (db.prepare('SELECT count(*) n FROM tracks').get() as { n: number }).n,
    artists: (db.prepare('SELECT count(*) n FROM artists').get() as { n: number }).n,
    credits: (db.prepare('SELECT count(*) n FROM credits').get() as { n: number }).n,
    plays: (db.prepare('SELECT count(*) n FROM plays').get() as { n: number }).n,
  };
  console.log(`db copy: ${path}`);
  console.log(`library: ${counts.albums} albums, ${counts.tracks} tracks, ${counts.artists} artists, ${counts.credits} credits, ${counts.plays} plays`);

  const t0 = performance.now();
  const search = createSearch(db);
  const firstIndexMs = performance.now() - t0;
  const docs = (db.prepare('SELECT count(*) n FROM search_docs').get() as { n: number }).n;
  console.log(`first index (empty index -> rebuild): ${firstIndexMs.toFixed(0)} ms, ${docs} docs`);
  const t1 = performance.now();
  const sweep = search.reindex();
  console.log(`no-op reindex sweep: ${(performance.now() - t1).toFixed(0)} ms (indexed ${sweep.indexed}, removed ${sweep.removed})`);

  // warm both paths
  oldSearch(db, 'warmup');
  search.search('warmup');

  let failures = 0;
  let worstOld = 0;
  let worstNew = 0;
  console.log('\nquery                          old ms   new ms   (top 3 per section)');
  console.log('-'.repeat(78));
  for (const q of QUERIES) {
    const old = time(() => oldSearch(db, q));
    const neu = time(() => search.search(q));
    worstOld = Math.max(worstOld, old.ms);
    worstNew = Math.max(worstNew, neu.ms);
    if (neu.ms >= 30) failures++;
    console.log(`\n"${q}"  old ${old.ms.toFixed(1)} ms | new ${neu.ms.toFixed(1)} ms${neu.ms >= 30 ? '  ** >30ms **' : ''}`);
    console.log(`  old: ${fmtOld(old.value)}`);
    console.log(`  new: ${fmtNew(neu.value)}`);
  }
  console.log('\n' + '-'.repeat(78));
  console.log(`worst old ${worstOld.toFixed(1)} ms, worst new ${worstNew.toFixed(1)} ms; queries over 30 ms: ${failures}`);
  db.close();
  if (failures > 0) process.exitCode = 1;
}

main();
