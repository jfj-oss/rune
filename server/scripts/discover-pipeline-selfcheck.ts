// Full Discover pipeline self-check against a LOCAL fake Spotify server.
//
//   pnpm -C server exec tsx scripts/discover-pipeline-selfcheck.ts
//
// Uses a TEMP COPY of the real library (never writes the real DB) and a fake
// Spotify/ListenBrainz/MusicBrainz HTTP server on 127.0.0.1. The fake server is
// killed by PID when the script finishes. No real Spotify traffic.
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { setDefaultResultOrder } from 'node:dns';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { createDiscover } from '../src/discover/index.js';
import { isDismissed, isOwned, loadOwned } from '../src/discover/exclusions.js';
import { MbClient } from '../src/match/mb.js';
import { SpotifyApi } from '../src/spotify/api.js';

setDefaultResultOrder('ipv4first');

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(homedir(), '.local/share/liner/liner.db');
const FAKE = join(HERE, 'fake-discover-spotify.mjs');

function backupDb(dir: string): string {
  const copy = join(dir, 'liner.db');
  execFileSync('sqlite3', [DB_PATH, `.backup '${copy.replace(/'/g, "''")}'`]);
  return copy;
}

function pickSeeds(dbPath: string): string[] {
  return execFileSync(
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
}

function startFake(): Promise<{ child: ChildProcessWithoutNullStreams; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FAKE], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buffered = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('fake server did not start in time'));
    }, 10_000);
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      const match = /LISTEN (\d+)/.exec(buffered);
      if (match) {
        clearTimeout(timer);
        resolve({ child, port: Number(match[1]) });
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fake server exited early (${code})`));
    });
    child.on('error', reject);
  });
}

function stopFake(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve();
    }, 3000);
  });
}

function rewriteFetch(prefix: string, replacement: string): typeof fetch {
  return (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = raw.startsWith(prefix) ? replacement + raw.slice(prefix.length) : raw;
    return fetch(url, init);
  };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rune-discover-pipeline-'));
  let fake: { child: ChildProcessWithoutNullStreams; port: number } | undefined;
  try {
    const copy = backupDb(dir);
    const seeds = pickSeeds(copy);
    if (seeds.length === 0) throw new Error('no suitable local seeds in the library copy');

    fake = await startFake();
    const base = `http://127.0.0.1:${fake.port}`;

    const cfg: Config = { ...loadConfig(), dataDir: dir };
    const db = openDb(copy);
    const mb = new MbClient({
      userAgent: cfg.userAgent,
      db,
      fetch: rewriteFetch('https://musicbrainz.org/ws/2', `${base}/mb`),
      rateLimitMs: 0,
      cacheTtlMs: 30 * 24 * 60 * 60 * 1000,
    });
    const api = new SpotifyApi({ baseUrl: `${base}/v1`, getToken: async () => 'fake-token' });
    const discover = createDiscover(
      db,
      cfg,
      { api },
      {
        fetch: rewriteFetch('https://labs.api.listenbrainz.org', `${base}/labs`),
        mb,
        budget: { minIntervalMs: 0, hourlyLimit: 1000 },
        radioMappings: 12,
        backgroundRefresh: false,
        onWarn: (msg, err) => console.error('[warn]', msg, err instanceof Error ? err.message : err),
      },
    );

    console.log('Seeds:', seeds.join(', '));
    const radioSeeds = [...seeds, 'sp:seed-spotify'];
    const seen = new Set<string>();
    let radioItems = 0;
    for (const id of radioSeeds) {
      const res = await discover.similar(id, { limit: 20 });
      const radioSeen = new Set<string>();
      console.log('\n============================================================');
      console.log(`RADIO ${id}`);
      console.log(`  status=${res.status} cached=${res.cached} generatedAt=${new Date(res.generatedAt).toISOString()}`);
      if (res.seed) {
        console.log(
          `  seed: ${res.seed.artist} — ${res.seed.title}` +
            `  rec=${res.seed.recordingMbid ?? '—'} artist=${res.seed.artistMbid ?? '—'}`,
        );
      }
      if (res.message) console.log(`  message: ${res.message}`);
      for (const item of res.items) {
        radioItems++;
        if (radioSeen.has(item.track.id)) throw new Error(`duplicate track within radio ${id}: ${item.track.id}`);
        radioSeen.add(item.track.id);
        seen.add(item.track.id);
        if (!item.track.id.startsWith('sp:')) throw new Error(`non-Spotify id: ${item.track.id}`);
        console.log(
          `   • ${item.track.artists.map((a) => a.name).join(', ')} — ${item.track.title}` +
            `  [${item.spotifyTrackId}]  ${item.reason}`,
        );
      }
      if (res.status === 'ok') {
        if (res.items.length === 0) throw new Error(`status ok with no items for ${id}`);
        if (res.items.length > 20) throw new Error(`limit ignored for ${id}`);
      }
    }

    // Second identical call must come from cache (no further Spotify calls).
    const before = (await (await fetch(`${base}/__requests`)).json()) as { count: number };
    const again = await discover.similar(seeds[0]!, { limit: 5 });
    const after = (await (await fetch(`${base}/__requests`)).json()) as { count: number };
    console.log(`\nRADIO cache re-read: cached=${again.cached} items=${again.items.length} newRequests=${after.count - before.count}`);
    if (!again.cached) throw new Error('second radio call was not cached');
    if (after.count !== before.count) throw new Error('cached radio still made HTTP requests');

    const feed = await discover.feed({ limit: 30, refresh: true });
    console.log('\n============================================================');
    console.log(`FEED status=${feed.status} cached=${feed.cached} groups=${feed.groups.length}`);
    if (feed.message) console.log(`  message: ${feed.message}`);
    const feedIds = new Set<string>();
    for (const group of feed.groups) {
      console.log(`  ${group.title}  (${group.items.length})`);
      for (const item of group.items) {
        if (feedIds.has(item.track.id)) throw new Error(`duplicate track in feed: ${item.track.id}`);
        feedIds.add(item.track.id);
        console.log(
          `   • ${item.track.artists.map((a) => a.name).join(', ')} — ${item.track.title}  ${item.reason}`,
        );
      }
    }

    // Ownership: nothing returned may already be in likes/playlists/library or dismissed.
    const owned = loadOwned(db);
    for (const id of [...seen, ...feedIds]) {
      if (isDismissed(owned, id)) throw new Error(`dismissed track returned: ${id}`);
      const row = db
        .prepare(
          `SELECT t.title, t.mb_recording_id FROM tracks t WHERE t.id = ?`,
        )
        .get(id) as { title: string; mb_recording_id: string | null } | undefined;
      if (!row) throw new Error(`returned track was not stored: ${id}`);
      const artists = (
        db
          .prepare(
            `SELECT ar.name FROM track_artists ta JOIN artists ar ON ar.id = ta.artist_id
             WHERE ta.track_id = ? ORDER BY ta.position`,
          )
          .all(id) as { name: string }[]
      ).map((r) => r.name);
      if (
        isOwned(owned, {
          spotifyId: id,
          recordingMbid: row.mb_recording_id ?? undefined,
          title: row.title,
          artists,
        })
      ) {
        throw new Error(`owned track returned: ${id}`);
      }
    }

    const allIds = [...seen, ...feedIds];
    const stored = db
      .prepare(
        `SELECT count(*) AS n, sum(CASE WHEN a.in_library = 0 THEN 1 ELSE 0 END) AS discoverOnly
         FROM tracks t JOIN albums a ON a.id = t.album_id
         WHERE t.id IN (${allIds.map(() => '?').join(',')})`,
      )
      .get(...allIds) as { n: number; discoverOnly: number };
    console.log(
      `\nStored: ${stored.n}/${new Set(allIds).size} returned tracks in the DB, ` +
        `${stored.discoverOnly} marked in_library = 0 (playable but not owned).`,
    );

    const stats = (await (await fetch(`${base}/__requests`)).json()) as { count: number; urls: string[] };
    const groups = { spotify: 0, listenbrainz: 0, musicbrainz: 0 };
    for (const path of stats.urls) {
      if (path.startsWith('/v1/')) groups.spotify++;
      else if (path.startsWith('/labs/')) groups.listenbrainz++;
      else if (path.startsWith('/mb/')) groups.musicbrainz++;
    }
    console.log(
      `Fake HTTP requests: ${stats.count} total — Spotify ${groups.spotify}, ` +
        `ListenBrainz ${groups.listenbrainz}, MusicBrainz ${groups.musicbrainz}.`,
    );
    if (radioItems === 0) throw new Error('every radio came back empty');
    if (feedIds.size === 0) throw new Error('feed came back empty');
    console.log('\nPIPELINE SELF-CHECK PASSED');
    db.close();
  } finally {
    if (fake) await stopFake(fake.child);
    rmSync(dir, { recursive: true, force: true });
  }
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
