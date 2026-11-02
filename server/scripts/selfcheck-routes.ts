// Self-check (a): real Fastify app with only the Spotify routes on a random port.
import Fastify from 'fastify';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db/index.js';
import { registerSpotifyRoutes, SPOTIFY_SCOPES } from '../src/spotify/auth.js';

const cfg = {
  libraryRoots: [],
  dataDir: '/tmp/liner-selfcheck',
  port: 0,
  audioDevice: 'none',
  userAgent: 'liner-selfcheck',
  spotifyClientId: 'selfcheck-client-id',
};

const app = Fastify({ logger: false });
const db = openDb(':memory:');
registerSpotifyRoutes(app, db, cfg);
await app.listen({ port: 0, host: '127.0.0.1' });
const address = app.server.address() as AddressInfo;
cfg.port = address.port;
const base = `http://127.0.0.1:${address.port}`;

console.log(`(a) real Fastify app, only Spotify routes, listening on ${base}`);

const login = await fetch(`${base}/api/spotify/login`, { redirect: 'manual' });
const location = login.headers.get('location') ?? '';
const url = new URL(location);
const redacted = new URL(location);
redacted.searchParams.set('code_challenge', '<redacted>');
console.log(`GET /api/spotify/login -> ${login.status} ${login.statusText}`);
console.log(`  Location: ${redacted.toString()}`);
console.log(
  '  params: ' +
    JSON.stringify({
      client_id: url.searchParams.get('client_id'),
      redirect_uri: url.searchParams.get('redirect_uri'),
      response_type: url.searchParams.get('response_type'),
      code_challenge_method: url.searchParams.get('code_challenge_method'),
      code_challenge_is_43_chars: /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge') ?? ''),
      state_present: !!url.searchParams.get('state'),
      scope: url.searchParams.get('scope'),
      scope_matches_constant: url.searchParams.get('scope') === SPOTIFY_SCOPES,
    }),
);

const status = await fetch(`${base}/api/spotify/status`);
console.log(`GET /api/spotify/status -> ${status.status} ${await status.text()}`);

const token = await fetch(`${base}/api/spotify/token`);
console.log(`GET /api/spotify/token -> ${token.status} ${await token.text()}`);

const callback = await fetch(`${base}/api/spotify/callback`, { redirect: 'manual' });
console.log(`GET /api/spotify/callback (no params) -> ${callback.status} ${await callback.text()}`);

await app.close();
