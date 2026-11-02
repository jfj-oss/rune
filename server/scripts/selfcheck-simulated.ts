// Self-check (b): full simulated flow against a local fake Spotify server:
// callback -> token -> refresh -> saved-albums sync -> play on a Connect device.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { createSpotify } from '../src/spotify/index.js';
import { pkceChallenge } from '../src/spotify/auth.js';

const here = dirname(fileURLToPath(import.meta.url));

const child = spawn(process.execPath, [join(here, 'fake-spotify-server.mjs'), '0'], {
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
    if (code) reject(new Error(`fake server exited with ${code}`));
  });
});
console.log(`fake Spotify server pid=${child.pid} on http://127.0.0.1:${fakePort}`);

const accounts = `http://127.0.0.1:${fakePort}`;
const apiBase = `${accounts}/v1`;
const cfg = {
  libraryRoots: [],
  dataDir: '/tmp/liner-selfcheck',
  port: 4545,
  audioDevice: 'none',
  userAgent: 'liner-selfcheck',
  spotifyClientId: 'sim-client-id',
};

const db: Db = openDb(':memory:');
const spotify = createSpotify(db, cfg, {
  endpoints: { accounts, api: apiBase },
  redirectUri: 'http://127.0.0.1:4545/api/spotify/callback',
});

const loginUrl = new URL(spotify.auth.loginUrl());
const state = loginUrl.searchParams.get('state') ?? '';
const challenge = loginUrl.searchParams.get('code_challenge') ?? '';

const status = await spotify.auth.handleCallback('sim-code', state);
console.log(`1. callback -> status ${JSON.stringify(status)}`);

const access = await spotify.auth.getAccessToken();
console.log(`2. access token -> ${access}`);

const refreshed = await spotify.auth.getAccessToken(true);
console.log(`3. forced refresh -> ${refreshed} | refresh_token retained: ${spotify.auth.hasRefreshToken()}`);

const sync = await spotify.syncSavedAlbums();
console.log(`4. syncSavedAlbums -> ${JSON.stringify(sync)}`);
printCounts(db);

const zones = await spotify.zones.listZones();
console.log(`   zones -> ${JSON.stringify(zones)}`);
const zone = spotify.zones.get('spotify:dev1');
if (!zone) throw new Error('spotify:dev1 zone was not created');

const played = await zone.command({ type: 'play', trackIds: ['sp:t1', 'sp:t2'], startIndex: 1 });
console.log(
  `5. play on Spotify Connect -> ${JSON.stringify({
    zone: played.zone,
    status: played.status,
    index: played.index,
    queue: played.queue.map((q) => q.track.id),
    albumOfFirst: played.queue[0]?.album,
    positionMs: played.positionMs,
    volume: played.volume,
    shuffle: played.shuffle,
    repeat: played.repeat,
  })}`,
);
printCounts(db);
await spotify.zones.close();

const requests = (await (await fetch(`${accounts}/__requests`)).json()) as {
  method: string;
  path: string;
  query: Record<string, string>;
  body: string;
}[];
const tokenRequests = requests.filter((r) => r.path === '/api/token');
const verifier = new URLSearchParams(tokenRequests[0]?.body ?? '').get('code_verifier') ?? '';
console.log(
  `   PKCE round-trip (sha256 received verifier == authorize challenge): ${pkceChallenge(verifier) === challenge}`,
);
console.log(
  `   token grants: ${tokenRequests
    .map((r) => new URLSearchParams(r.body).get('grant_type'))
    .join(', ')}`,
);
const playRequest = requests.find((r) => r.path === '/v1/me/player/play');
console.log(
  `   play HTTP request: ${playRequest?.method} ${playRequest?.path}?${new URLSearchParams(playRequest?.query ?? {}).toString()} body=${playRequest?.body}`,
);

child.kill('SIGTERM');
await once(child, 'exit');
console.log(`fake Spotify server stopped (killed PID ${child.pid})`);

function printCounts(database: Db): void {
  const tables = ['albums', 'tracks', 'artists', 'track_artists', 'search_fts', 'spotify_auth'];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    counts[table] = (database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
  counts.spotify_albums = (
    database.prepare(`SELECT COUNT(*) AS n FROM albums WHERE source = 'spotify'`).get() as { n: number }
  ).n;
  console.log(`   db row counts -> ${JSON.stringify(counts)}`);
}
