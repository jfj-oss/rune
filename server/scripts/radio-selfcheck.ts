// Self-check for rune radio against a COPY of the real library db.
//
// The original is opened read-only and snapshotted with SQLite's backup API;
// the radio, routes and all queries run on the copy, never the user's database.
//
// Run: pnpm -C server exec tsx scripts/radio-selfcheck.ts [dbPath] [rngSeed]
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/index.js';
import { createRadio, type RadioPick } from '../src/radio/index.js';

const srcPath = process.argv[2] ?? join(homedir(), '.local/share/liner/liner.db');
const rngSeed = Number(process.argv[3] ?? 7);
const tmp = mkdtempSync(join(tmpdir(), 'liner-radio-'));
const copy = join(tmp, 'liner.db');

const src = new Database(srcPath, { readonly: true, fileMustExist: true });
await src.backup(copy);
src.close();
const db = openDb(copy);
console.log(`source (read-only): ${srcPath}`);
console.log(`temp copy:          ${copy}`);
console.log(`rng seed:           ${rngSeed}\n`);

interface SeedPick {
  id: string;
  title: string;
  artist: string;
}

function findTrack(title: string, artist: string): SeedPick | null {
  const row = db
    .prepare(
      `SELECT t.id AS id, t.title AS title, ar.name AS artist
         FROM tracks t
         JOIN albums a ON a.id = t.album_id
         JOIN artists ar ON ar.id = a.artist_id
        WHERE lower(t.title) = lower(?) AND ar.name LIKE ?
        ORDER BY t.source = 'local' DESC, t.id
        LIMIT 1`,
    )
    .get(title, `%${artist}%`) as SeedPick | undefined;
  return row ?? null;
}

interface TrackRow {
  id: string;
  title: string;
  albumTitle: string;
  year: number | null;
  artist: string;
  durationMs: number;
}

function trackInfo(id: string): TrackRow {
  const row = db
    .prepare(
      `SELECT t.id AS id, t.title AS title, a.title AS albumTitle, a.year AS year,
              ar.name AS artist, t.duration_ms AS durationMs
         FROM tracks t JOIN albums a ON a.id = t.album_id
         LEFT JOIN artists ar ON ar.id = a.artist_id
        WHERE t.id = ?`,
    )
    .get(id) as TrackRow | undefined;
  return row ?? { id, title: '(missing)', albumTitle: '', year: null, artist: '', durationMs: 0 };
}

function printSession(label: string, picks: RadioPick[]): void {
  console.log(`=== ${label} — ${picks.length} tracks ===`);
  picks.forEach((p, i) => {
    const t = trackInfo(p.trackId);
    const year = t.year != null ? String(t.year) : '?';
    console.log(
      `${String(i + 1).padStart(2)}. ${t.artist} — ${t.title} (${t.albumTitle}, ${year})  [${p.reason}]`,
    );
  });
  console.log('');
}

/** Honest sanity checks on the generated sequence itself. */
function audit(label: string, picks: RadioPick[]): void {
  const rows = picks.map((p) => trackInfo(p.trackId));
  // Same folding the radio uses: album title + artist, editions collapsed.
  const albumKey = (r: TrackRow): string =>
    (r.albumTitle + '|' + r.artist)
      .toLowerCase()
      .replace(/\[[^\]]*\]|\([^)]*\)|\s+-\s+.*$/g, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  let albumViolations = 0;
  for (let i = 0; i < rows.length; i++) {
    const window = rows.slice(Math.max(0, i - 9), i + 1);
    const album = albumKey(rows[i]!);
    if (window.filter((r) => albumKey(r) === album).length > 2) albumViolations++;
  }
  let artistAdjacent = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.artist === rows[i - 1]!.artist) artistAdjacent++;
  }
  const repeats = rows.length - new Set(rows.map((r) => r.id)).size;
  const short = rows.filter((r) => r.durationMs < 60_000).length;
  console.log(
    `${label}: album-cap violations=${albumViolations}, same-artist back-to-back=${artistAdjacent}, repeats=${repeats}, short=${short}`,
  );
}

const SEEDS: [string, string][] = [
  ['Nutshell', 'Alice in Chains'],
  ['Digital Love', 'Daft Punk'],
  ['Lean on Me', 'Bill Withers'],
];

let failed = 0;
for (const [title, artist] of SEEDS) {
  const seed = findTrack(title, artist);
  if (!seed) {
    console.log(`seed not found: ${title} — ${artist}\n`);
    failed++;
    continue;
  }
  const radio = createRadio(db, { randomSeed: rngSeed });
  const picks = radio.planFromTrack(seed.id, 20);
  printSession(`${seed.artist} — ${seed.title}`, picks);
  audit(`${seed.artist} — ${seed.title}`, picks);
  // A quick variety probe: continue one more batch as next() would.
  const more = radio.planNext(
    { trackIds: picks.map((p) => p.trackId).slice(-5), recentTrackIds: picks.map((p) => p.trackId) },
    10,
  );
  console.log(`  next 10: ${more.map((p) => trackInfo(p.trackId).title).join(' · ')}`);
  console.log('');
}

console.log(failed === 0 ? 'all seeds resolved' : `${failed} seed(s) missing`);
db.close();
rmSync(tmp, { recursive: true, force: true });
