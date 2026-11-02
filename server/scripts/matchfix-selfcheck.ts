// Self-check the matcher against a copy of the real library database.
//
//   pnpm -C server exec tsx scripts/matchfix-selfcheck.ts <db> [--threshold=0.8] [--max-ms=...] [--out=...]
//
// Network is allowed here (like record-mb.ts); the matcher reuses the DB's
// http_cache, so re-running a partially finished pass is cheap. Never point
// this at the live DB directly — back it up first.
import { writeFileSync } from 'node:fs';
import type { Config } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { createMatcher } from '../src/match/index.js';

const argv = process.argv.slice(2);
const dbPath = argv.find((a) => !a.startsWith('--'));
if (!dbPath) {
  console.error('usage: matchfix-selfcheck.ts <db> [--threshold=0.8] [--max-ms=N] [--out=file.json]');
  process.exit(2);
}
const arg = (name: string, fallback: string): string => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const threshold = Number(arg('threshold', '0.8'));
const maxMs = Number(arg('max-ms', '0'));
const limit = Number(arg('limit', '0'));
const outPath = argv.find((a) => a.startsWith('--out='))?.slice('--out='.length);

interface Row {
  id: string;
  title: string;
  artist: string | null;
  year: number | null;
  mb_release_id: string | null;
  match_confidence: number | null;
  track_count: number;
}

const db = openDb(dbPath);
const before = db
  .prepare(
    `SELECT al.id, al.title, ar.name AS artist, al.year,
            al.mb_release_id, al.match_confidence,
            (SELECT count(*) FROM tracks t WHERE t.album_id = al.id) AS track_count
       FROM albums al LEFT JOIN artists ar ON ar.id = al.artist_id
      WHERE al.source = 'local'`,
  )
  .all() as Row[];
const beforeById = new Map(before.map((row) => [row.id, row]));

const cfg: Config = {
  libraryRoots: [],
  dataDir: '/tmp/matchfix/data',
  port: 0,
  audioDevice: 'pipewire',
  userAgent: 'Liner/0.1 ( personal music player, self-hosted )',
};
const matcher = createMatcher(db, cfg, { downloadCovers: false, rateLimitMs: 1000 });

let lastLog = Date.now();
const stats = await matcher.rematchWeak(threshold, {
  ...(maxMs > 0 ? { maxMs } : {}),
  ...(limit > 0 ? { limit } : {}),
  onProgress: (done, total) => {
    if (done % 5 === 0 || done === total || Date.now() - lastLog > 15000) {
      console.log(`  ${done}/${total} albums (${Math.round((Date.now() - lastLog) / 1000)}s since last)`);
      lastLog = Date.now();
    }
  },
});

const after = db
  .prepare(
    `SELECT al.id, al.title, ar.name AS artist, al.year,
            al.mb_release_id, al.match_confidence,
            (SELECT count(*) FROM tracks t WHERE t.album_id = al.id) AS track_count
       FROM albums al LEFT JOIN artists ar ON ar.id = al.artist_id
      WHERE al.source = 'local'`,
  )
  .all() as Row[];

const count = (rows: Row[], pred: (r: Row) => boolean): number => rows.filter(pred).length;
const summary = (rows: Row[]) => ({
  albums: rows.length,
  matched: count(rows, (r) => r.mb_release_id != null),
  unmatched: count(rows, (r) => r.mb_release_id == null),
  belowThreshold: count(rows, (r) => r.mb_release_id != null && (r.match_confidence ?? 0) < threshold),
});

const newlyMatched = after
  .filter((r) => r.mb_release_id && !beforeById.get(r.id)?.mb_release_id)
  .map((r) => {
    const old = beforeById.get(r.id)!;
    return {
      albumId: r.id,
      localTitle: old.title,
      localArtist: old.artist,
      localYear: old.year,
      localTracks: old.track_count,
      mbReleaseId: r.mb_release_id,
      mbTitle: r.title,
      mbArtist: r.artist,
      mbYear: r.year,
      confidence: r.match_confidence,
    };
  })
  .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));

const improved = after
  .filter((r) => {
    const old = beforeById.get(r.id);
    return old?.mb_release_id && r.mb_release_id && (r.match_confidence ?? 0) > (old.match_confidence ?? 0) + 0.005;
  })
  .map((r) => {
    const old = beforeById.get(r.id)!;
    return {
      albumId: r.id,
      title: r.title,
      artist: r.artist,
      before: old.match_confidence,
      after: r.match_confidence,
      mbReleaseId: r.mb_release_id,
    };
  })
  .sort((a, b) => (b.after ?? 0) - (a.after ?? 0));

console.log('\nBEFORE', JSON.stringify(summary(before)));
console.log('AFTER ', JSON.stringify(summary(after)));
console.log('RUN   ', JSON.stringify(stats));
console.log(`\nNewly matched (${newlyMatched.length}):`);
for (const row of newlyMatched) {
  console.log(
    `  ${row.confidence?.toFixed(4)} | ${row.localArtist} — ${row.localTitle} (${row.localTracks} tr) -> ` +
      `${row.mbArtist} — ${row.mbTitle} [${row.mbReleaseId}]`,
  );
}
console.log(`\nImproved (${improved.length}):`);
for (const row of improved) {
  console.log(`  ${row.before?.toFixed(4)} -> ${row.after?.toFixed(4)} | ${row.artist} — ${row.title}`);
}

if (outPath) {
  writeFileSync(
    outPath,
    JSON.stringify({ before: summary(before), after: summary(after), stats, newlyMatched, improved }, null, 2) + '\n',
  );
  console.log(`\nwrote ${outPath}`);
}
db.close();
