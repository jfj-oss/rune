// Spotify budget: GET /api/zones lists every Connect device, but only the PC's own app, the account's active
// device and zones a tab said it views get a polling subscription. Offline: a fake fetch counts Spotify calls.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { PlayerState } from '@liner/shared';
import { buildApp } from '../src/api/server.js';
import { openDb, type Db } from '../src/db/index.js';
import { ensureSpotifySchema } from '../src/spotify/schema.js';
import { SIM_DEVICE, TEST_CONFIG, fakeFetch, jsonResponse, type FetchCall } from './spotify-helpers.js';

process.env.LOG_LEVEL = 'silent';

vi.mock('../src/play/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/play/index.js')>()),
  createPcZone: async () => ({
    zone: 'pc',
    socketPath: '',
    mpvPid: () => undefined,
    state: () => ({ zone: 'pc', status: 'stopped', queue: [], index: -1, positionMs: 0, volume: 100, shuffle: false, repeat: 'off', updatedAt: 0 }) as PlayerState,
    command: async () => ({}) as PlayerState,
    onChange: () => () => undefined,
    close: async () => undefined,
  }),
}));

const dev = (id: string, name: string, active = false) => ({ ...SIM_DEVICE, id, name, is_active: active });
const DEVICES = [dev('mypc1', 'MYPC'), dev('tv1', 'Living room TV', true), dev('phone1', 'iPhone'), dev('spk1', 'Kitchen speaker'), dev('spk2', 'Office speaker')];

let root: string;
let db: Db;
let app: FastifyInstance;
let built: Awaited<ReturnType<typeof buildApp>>;
let calls: FetchCall[];
let clock = 1_000_000;

const playerReads = () => calls.filter((c) => c.url.pathname === '/v1/me/player' && (c.init?.method ?? 'GET') === 'GET').length;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'rune-zones-polling-'));
  db = openDb(':memory:');
  ensureSpotifySchema(db);
  db.prepare(
    `INSERT INTO spotify_auth (id, access_token, refresh_token, token_type, scope, expires_at, user_name, user_product, updated_at)
     VALUES (1, 'access', 'refresh', 'Bearer', '', ?, NULL, NULL, 0)`,
  ).run(Date.now() + 3_600_000);
  const f = fakeFetch((url) => {
    if (url.pathname === '/v1/me/player/devices') return jsonResponse(200, { devices: DEVICES });
    if (url.pathname === '/v1/me/player') return jsonResponse(204, '');
    return jsonResponse(204, '');
  });
  calls = f.calls;
  built = await buildApp(db, { ...TEST_CONFIG, dataDir: join(root, 'data') }, {
    scanOnStart: false,
    spotifySyncOnStart: false,
    webDist: join(root, 'no-web-dist'),
    spotifyOptions: { fetch: f.fetch, now: () => clock, endpoints: { api: 'http://api.test/v1', accounts: 'http://accounts.test' } },
  });
  app = built.app;
  await app.ready();
});

afterAll(async () => {
  await built?.close();
  db?.close();
  rmSync(root, { recursive: true, force: true });
});

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

describe('GET /api/zones and Spotify polling', () => {
  it('lists all devices but subscribes only the PC app and the active device', async () => {
    clock += 121_000;
    const res = await app.inject({ method: 'GET', url: '/api/zones?refresh=1' });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { id: string; isActive?: boolean }[]).map((z) => z.id);
    // The picker still gets every device, with Spotify's own description.
    for (const d of DEVICES) expect(ids).toContain(`spotify:${d.id}`);
    expect(new Set(built.watchedSpotifyZones())).toEqual(new Set(['spotify:mypc1', 'spotify:tv1']));
  });

  it('costs the same number of Spotify reads for five devices as for the two that matter', async () => {
    const ws = await app.injectWS('/api/ws');
    await settle();
    // A tab that shows only one speaker: that zone joins; the others stay unsubscribed.
    ws.send(JSON.stringify({ type: 'viewing', zones: ['pc', 'spotify:spk1'] }));
    await settle();
    expect(new Set(built.watchedSpotifyZones())).toEqual(new Set(['spotify:mypc1', 'spotify:tv1', 'spotify:spk1']));

    // Repeated device-list reads and wakes (tab coming back to the foreground) with the clock moving on.
    const before = playerReads();
    for (let i = 0; i < 3; i++) {
      clock += 30_000;
      await app.inject({ method: 'GET', url: '/api/zones?refresh=1' });
      ws.send(JSON.stringify({ type: 'presence', visible: false }));
      ws.send(JSON.stringify({ type: 'presence', visible: true }));
      await settle();
    }
    const reads = playerReads() - before;
    // Concurrent zone polls share one /me/player read, so each wake costs at most one read; before this change the
    // three unviewed devices (phone, other speakers) were subscribed too.
    expect(reads).toBeLessThanOrEqual(3);
    expect(new Set(built.watchedSpotifyZones())).toEqual(new Set(['spotify:mypc1', 'spotify:tv1', 'spotify:spk1']));
    expect(built.watchedSpotifyZones()).not.toContain('spotify:phone1');
    expect(built.watchedSpotifyZones()).not.toContain('spotify:spk2');
    ws.terminate();
  });
});
