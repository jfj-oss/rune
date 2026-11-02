// Offline-ish musical sanity check for song radio: runs the LB/MB half of the
// pipeline against a TEMP COPY of the real library and prints candidate artists
// and recordings with the reason the radio would show. Never writes the real DB
// and never calls Spotify.
//
//   pnpm -C server exec tsx scripts/discover-selfcheck.ts [l:trackId ...]
//
// Without ids it picks three recent local tracks with MB recording + artist ids,
// from three different artists.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { setDefaultResultOrder } from 'node:dns';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { createDiscover } from '../src/discover/index.js';

setDefaultResultOrder('ipv4first');

const DB_PATH = join(homedir(), '.local/share/liner/liner.db');

function pickSeeds(dbPath: string): string[] {
  const rows = execFileSync(
    'sqlite3',
    [
      dbPath,
      `SELECT t.id FROM tracks t
       JOIN albums a ON a.id = t.album_id
       JOIN track_artists ta ON ta.track_id = t.id AND ta.position = 0
       JOIN artists ar ON ar.id = ta.artist_id
       WHERE t.source = 'local' AND t.mb_recording_id IS NOT NULL AND t.mb_recording_id != ''
         AND ar.mbid IS NOT NULL AND ar.mbid != ''
       GROUP BY ar.id
       ORDER BY max(t.rowid) DESC
       LIMIT 3;`,
    ],
    { encoding: 'utf8' },
  )
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return rows;
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const dir = mkdtempSync(join(tmpdir(), 'rune-discover-check-'));
  const copy = join(dir, 'liner.db');
  try {
    // .backup is the only safe way to read a WAL database without touching it.
    execFileSync('sqlite3', [DB_PATH, `.backup '${copy.replace(/'/g, "''")}'`]);
    const ids = requested.length > 0 ? requested : pickSeeds(copy);
    if (ids.length === 0) {
      console.log('No suitable local seeds found.');
      return;
    }

    const cfg: Config = { ...loadConfig(), dataDir: dir };
    const db = openDb(copy);
    // No Spotify: the module stays usable for debugCandidates (LB/MB only).
    const discover = createDiscover(db, cfg, undefined, {
      onWarn: (msg, err) => console.error('[warn]', msg, err instanceof Error ? err.message : err),
    });

    for (const id of ids) {
      const debug = await discover.debugCandidates(id);
      console.log('\n============================================================');
      console.log(`SEED: ${debug.seed.artist} — ${debug.seed.title}  (${debug.seed.trackId})`);
      console.log(`  artist MBID:    ${debug.seed.artistMbid ?? '— (no similar artists)'}`);
      console.log(`  recording MBID: ${debug.seed.recordingMbid ?? '— (no similar recordings)'}`);
      const recordings = debug.candidates.filter((c) => c.kind === 'recording').slice(0, 12);
      const artists = debug.candidates.filter((c) => c.kind === 'artist').slice(0, 12);
      console.log(`\n  Similar recordings (${recordings.length}):`);
      for (const c of recordings) console.log(`   • ${c.artist} — ${c.title}  [${c.score}]  ${c.reason}`);
      console.log(`\n  Similar artists (${artists.length}):`);
      for (const c of artists) console.log(`   • ${c.title}  [${c.score}]  ${c.reason}`);
    }
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

void main();
