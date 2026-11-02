// GET /api/spotify/usage + the 429 message on POST /api/player/:zone.
// Fully offline: a seeded auth row and a fake fetch stand in for Spotify.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/server.js';
import { openDb, type Db } from '../src/db/index.js';
import { ensureSpotifySchema } from '../src/spotify/schema.js';
import { SIM_DEVICE, TEST_CONFIG, fakeFetch, jsonResponse, playbackState, sampleTrack } from './spotify-helpers.js';

process.env.LOG_LEVEL = 'silent';

let root: string;
let db: Db;
let app: FastifyInstance;
let closeApp: () => Promise<void>;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'liner-spotify-usage-'));
  db = openDb(':memory:');
  ensureSpotifySchema(db);
  // A valid (unexpired) token: the auth layer never needs to refresh during the test.
  db.prepare(
    `INSERT INTO spotify_auth (id, access_token, refresh_token, token_type, scope, expires_at, user_name, user_product, updated_at)
     VALUES (1, 'access', 'refresh', 'Bearer', '', ?, NULL, NULL, 0)`,
  ).run(Date.now() + 3_600_000);

  const { fetch } = fakeFetch((url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.pathname === '/v1/me/player/devices') {
      return jsonResponse(200, { devices: [SIM_DEVICE] });
    }
    if (method === 'GET' && url.pathname === '/v1/me/player') {
      return jsonResponse(200, playbackState(sampleTrack('t1')));
    }
    if (method === 'PUT' && url.pathname === '/v1/me/player/play') {
      // Spotify's current answer: nine hours of quota left, if that.
      return jsonResponse(429, { reason: 'QUOTA_EXCEEDED' }, { 'Retry-After': '32400' });
    }
    return jsonResponse(404, { error: `unexpected ${method} ${url.pathname}` });
  });

  const built = await buildApp(db, { ...TEST_CONFIG, dataDir: join(root, 'data') }, {
    pcZone: false,
    scanOnStart: false,
    spotifySyncOnStart: false,
    webDist: join(root, 'no-web-dist'),
    spotifyOptions: {
      fetch,
      endpoints: { api: 'http://api.test/v1', accounts: 'http://accounts.test' },
    },
  });
  app = built.app;
  closeApp = built.close;
});

afterAll(async () => {
  await closeApp?.();
  db?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('Spotify quota reporting', () => {
  it('exposes request counters and answers a rate-limited command with 429 and a clear message', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/spotify/usage' });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({
      sinceStart: expect.any(Number),
      lastHour: expect.any(Number),
      last24h: expect.any(Number),
      byPath: expect.any(Array),
      blockedUntil: null,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/player/spotify:dev1',
      payload: { type: 'play', trackIds: ['sp:t1'] },
    });
    expect(res.statusCode).toBe(429);
    const { error } = res.json() as { error: string };
    expect(error).toMatch(
      /^Spotify's daily limit is used up — Spotify songs play again around \d{2}:\d{2}\. Local music still works\.$/,
    );

    const after = await app.inject({ method: 'GET', url: '/api/spotify/usage' });
    expect(after.statusCode).toBe(200);
    const usage = after.json() as {
      sinceStart: number;
      lastHour: number;
      last24h: number;
      byPath: { path: string; count: number }[];
      blockedUntil: number | null;
    };
    expect(usage.sinceStart).toBeGreaterThanOrEqual(2); // devices + the refused play
    expect(usage.lastHour).toBeGreaterThanOrEqual(2);
    expect(usage.last24h).toBeGreaterThanOrEqual(usage.lastHour);
    expect(usage.byPath.some((p) => p.path === 'PUT /me/player/play')).toBe(true);
    expect(usage.byPath.some((p) => p.path === 'GET /me/player/devices')).toBe(true);
    expect(usage.blockedUntil).toBeGreaterThan(Date.now());
  });
});
