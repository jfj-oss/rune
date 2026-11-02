// Live end-to-end check for the meta module. Network allowed here only.
// Run: pnpm -C server exec tsx scripts/meta-live.ts
//
// Uses an in-memory database (nothing touches the user's data dir or library)
// and the five albums from the other workers' fixtures.
import { openDb } from '../src/db/index.js';
import type { Config } from '../src/config.js';
import { createMeta } from '../src/meta/index.js';
import type { AlbumDetails } from '@liner/shared';

const cfg: Config = {
  libraryRoots: [],
  dataDir: '/tmp/liner-meta-live',
  port: 0,
  audioDevice: 'null',
  userAgent: 'Liner/0.1 ( personal music player, self-hosted )',
};

interface LiveAlbum {
  id: string;
  title: string;
  artist: string;
  year: number;
  tracks: string[];
}

const albums: LiveAlbum[] = [
  {
    id: 'la:discovery',
    title: 'Discovery',
    artist: 'Daft Punk',
    year: 2001,
    tracks: [
      'One More Time', 'Aerodynamic', 'Digital Love', 'Harder, Better, Faster, Stronger',
      'Crescendolls', 'Nightvision', 'Superheroes', 'High Life', 'Something About Us',
      'Voyager', 'Veridis Quo', 'Short Circuit', 'Face to Face', 'Too Long',
    ],
  },
  {
    id: 'la:jar',
    title: 'Jar of Flies',
    artist: 'Alice In Chains',
    year: 1994,
    tracks: ['Rotten Apple', 'Nutshell', 'I Stay Away', 'No Excuses', 'Whale & Wasp', "Don't Follow", 'Swing on This'],
  },
  {
    id: 'la:still-bill',
    title: 'Still Bill',
    artist: 'Bill Withers',
    year: 1972,
    tracks: ['Lonely Town, Lonely Street', 'Let Me in Your Life', 'Who Is He (And What Is He to You)?', 'Use Me', 'Lean on Me', 'Kissing My Love'],
  },
  {
    id: 'la:uprising',
    title: 'Uprising',
    artist: 'Bob Marley & The Wailers',
    year: 1980,
    tracks: ['Coming in from the Cold', 'Real Situation', 'Bad Card', 'We and Dem', 'Work', 'Zion Train', 'Could You Be Loved', 'Redemption Song'],
  },
  {
    id: 'la:fire',
    title: 'Fire of Unknown Origin',
    artist: 'Blue Öyster Cult',
    year: 1981,
    tracks: ['Fire of Unknown Origin', "Burnin' for You", 'Veteran of the Psychic Wars', 'Sole Survivor', 'After Dark', 'Joan Crawford'],
  },
];

const db = openDb(':memory:');
const insertArtist = db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)');
const insertAlbum = db.prepare(
  'INSERT INTO albums (id, source, title, artist_id, year, added_at) VALUES (?, ?, ?, ?, ?, ?)',
);
const insertTrack = db.prepare(
  'INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
);

for (const album of albums) {
  const artistId = `ar:live:${album.id}`;
  insertArtist.run(artistId, album.artist);
  insertAlbum.run(album.id, 'local', album.title, artistId, album.year, Date.now());
  album.tracks.forEach((title, i) => insertTrack.run(`l:${album.id}:${i}`, album.id, 'local', title, 1, i + 1, 240_000));
}

function summarise(details: AlbumDetails): string {
  const scores = details.scores.map((s) => `${s.outlet} ${s.score}/${s.scale}`).join(', ') || 'none';
  const quote = details.quotes[0];
  return [
    `  reception : ${details.reception ? `${details.reception.value.length} chars — "${details.reception.value.slice(0, 90)}…"` : 'none'}`,
    `  background: ${details.background ? `${details.background.value.length} chars` : 'none'}`,
    `  scores    : ${scores}`,
    `  quotes    : ${details.quotes.length}${quote ? ` — ${quote.outlet}${quote.author ? ` (${quote.author})` : ''}: "${quote.quote.slice(0, 80)}…"` : ''}`,
    `  artistNotes: ${details.artistNotes.length}${details.artistNotes[0] ? ` — first: "${details.artistNotes[0].value.slice(0, 70)}…" (verified=${details.artistNotes[0].verifiedArtist})` : ''}`,
  ].join('\n');
}

const meta = createMeta(db, cfg);
const started = Date.now();
const results: { album: LiveAlbum; details: AlbumDetails | null; ms: number }[] = [];

for (const album of albums) {
  const t0 = Date.now();
  process.stdout.write(`\n${album.artist} — ${album.title} (${album.year})\n`);
  const details = await meta.getDetails(album.id);
  const ms = Date.now() - t0;
  results.push({ album, details, ms });
  if (!details) {
    console.log('  NO ALBUM ROW');
    continue;
  }
  console.log(summarise(details));
  console.log(`  fetched in ${(ms / 1000).toFixed(1)} s`);
}

console.log('\n=== summary ===');
const header = ['album', 'reception', 'background', 'scores', 'quotes', 'notes', 'ms'];
const rows = results.map(({ album, details, ms }) => [
  `${album.artist} — ${album.title}`,
  details?.reception ? 'yes' : 'no',
  details?.background ? 'yes' : 'no',
  details?.scores.map((s) => `${s.outlet} ${s.score}/${s.scale}`).join('; ') || 'none',
  String(details?.quotes.length ?? 0),
  String(details?.artistNotes.length ?? 0),
  String(ms),
]);
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(' | ');
console.log(line(header));
console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));
for (const row of rows) console.log(line(row));

const cacheRows = db.prepare('SELECT key, status FROM http_cache').all() as { key: string; status: number }[];
const byHost = new Map<string, number>();
for (const row of cacheRows) {
  const host = new URL(row.key).host;
  byHost.set(host, (byHost.get(host) ?? 0) + 1);
}
console.log(`\nhttp_cache: ${cacheRows.length} responses — ${[...byHost].map(([h, n]) => `${h}=${n}`).join(', ')}`);
console.log(`total elapsed ${((Date.now() - started) / 1000).toFixed(1)} s`);
