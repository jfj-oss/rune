// GET /api/zones with a PC zone: what it says about the Spotify app on this PC. Offline: a fake fetch stands in for
// Spotify and a stub for the PC zone, so no mpv is started.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { PlayerState } from '@liner/shared';
import { buildApp } from '../src/api/server.js';
import { openDb, type Db } from '../src/db/index.js';
import { ensureSpotifySchema } from '../src/spotify/schema.js';
import { SIM_DEVICE, TEST_CONFIG, fakeFetch, jsonResponse } from './spotify-helpers.js';

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

const HORSE = { ...SIM_DEVICE, id: 'horse1', name: 'HORSE' };

let root: string;
let db: Db;
let app: FastifyInstance;
let closeApp: () => Promise<void>;
let clock = 1_000_000;
let devices: () => ReturnType<typeof jsonResponse> = () => jsonResponse(200, { devices: [HORSE] });

/** With no page open the device list is reused for an hour: step past that before each read. */
const zones = async () => {
  clock += 3_601_000;
  const res = await app.inject({ method: 'GET', url: '/api/zones' });
  expect(res.statusCode).toBe(200);
  return (res.json() as { id: string; spotifyDeviceId?: string; spotifyDeviceName?: string }[]).find((z) => z.id === 'pc')!;
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'liner-zones-route-'));
  db = openDb(':memory:');
  ensureSpotifySchema(db);
  db.prepare(
    `INSERT INTO spotify_auth (id, access_token, refresh_token, token_type, scope, expires_at, user_name, user_product, updated_at)
     VALUES (1, 'access', 'refresh', 'Bearer', '', ?, NULL, NULL, 0)`,
  ).run(Date.now() + 3_600_000);
  const { fetch } = fakeFetch((url) => (url.pathname === '/v1/me/player/devices' ? devices() : jsonResponse(204, '')));
  const built = await buildApp(db, { ...TEST_CONFIG, dataDir: join(root, 'data') }, {
    scanOnStart: false,
    spotifySyncOnStart: false,
    webDist: join(root, 'no-web-dist'),
    spotifyOptions: { fetch, now: () => clock, endpoints: { api: 'http://api.test/v1', accounts: 'http://accounts.test' } },
  });
  app = built.app;
  closeApp = built.close;
});

afterAll(async () => {
  await closeApp?.();
  db?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('GET /api/zones and the Spotify app on the PC', () => {
  it('names the device, keeps it when the list fails, and drops it once a good list lacks it', async () => {
    expect(await zones()).toMatchObject({ spotifyDeviceId: 'horse1', spotifyDeviceName: 'HORSE' });

    devices = () => jsonResponse(500, { error: 'boom' });
    expect(await zones()).toMatchObject({ spotifyDeviceId: 'horse1', spotifyDeviceName: 'HORSE' });

    devices = () => jsonResponse(200, { devices: [SIM_DEVICE] });
    const gone = await zones();
    expect(gone.spotifyDeviceId).toBeUndefined();
    expect(gone.spotifyDeviceName).toBeUndefined();
  });

  it('lists phones with what the picker needs, and refreshes on demand', async () => {
    let calls = 0;
    devices = () => {
      calls++;
      return jsonResponse(200, {
        devices: [{ ...SIM_DEVICE, id: 'phone1', name: 'iPhone', type: 'Smartphone', is_active: false, is_restricted: false }],
      });
    };

    clock += 3_601_000; // the previous test's device list is still cached
    const first = await app.inject({ method: 'GET', url: '/api/zones' });
    expect(first.statusCode).toBe(200);
    const phone = (first.json() as { id: string; deviceType?: string; isActive?: boolean; isRestricted?: boolean }[])
      .find((z) => z.id === 'spotify:phone1');
    expect(phone).toMatchObject({ deviceType: 'Smartphone', isActive: false, isRestricted: false });
    expect(calls).toBe(1);

    clock += 2_000; // inside the cache, outside the 1.5 s fresh window
    await app.inject({ method: 'GET', url: '/api/zones' });
    expect(calls).toBe(1); // an ordinary read keeps the cache
    await app.inject({ method: 'GET', url: '/api/zones?refresh=1' });
    expect(calls).toBe(2); // the picker opening asks again
  });

  it('a probe every minute with no page open costs one device read an hour (it was one every two minutes)', async () => {
    let calls = 0;
    devices = () => { calls++; return jsonResponse(200, { devices: [HORSE] }); };
    clock += 3_601_000;
    for (let minute = 0; minute < 60; minute++) {
      clock += 60_000;
      const res = await app.inject({ method: 'GET', url: '/api/zones' });
      expect(res.statusCode).toBe(200);
    }
    expect(calls).toBeLessThanOrEqual(2);
  });

  it('during a Spotify lockout the Connect devices stay listed, their zones answer, and /status says until when', async () => {
    devices = () => jsonResponse(200, { devices: [HORSE, { ...SIM_DEVICE, id: 'phone1', name: 'iPhone', type: 'Smartphone', is_active: false, is_restricted: false }] });
    clock += 3_601_000;
    await app.inject({ method: 'GET', url: '/api/zones?refresh=1' });

    // Spotify locks the app out for two hours: the breaker trips on the first read and answers every later one itself.
    devices = () => jsonResponse(429, '', { 'retry-after': '7200' });
    clock += 3_601_000;
    const list = (await app.inject({ method: 'GET', url: '/api/zones?refresh=1' })).json() as { id: string }[];
    expect(list.map((z) => z.id)).toEqual(expect.arrayContaining(['spotify:horse1', 'spotify:phone1']));

    const status = (await app.inject({ method: 'GET', url: '/api/spotify/status' })).json() as { connected: boolean; restingUntil: number | null };
    expect(status.connected).toBe(true);
    expect(status.restingUntil).toBe(clock + 7_200_000);

    // A page that remembers a device can still read it (no 404 "unknown zone"), even one never listed.
    expect((await app.inject({ method: 'GET', url: '/api/player/spotify:phone1' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/player/spotify:0123456789abcdef0123456789abcdef01234567' })).statusCode).toBe(200);
    // Garbage is still unknown.
    expect((await app.inject({ method: 'GET', url: '/api/player/spotify:nope' })).statusCode).toBe(404);
    // A play during the lockout gets the plain-words reason, not a crash.
    const play = await app.inject({ method: 'POST', url: '/api/player/spotify:phone1', payload: { type: 'play', trackIds: ['sp:abc'], startIndex: 0 } });
    expect(play.statusCode).toBe(429);
    expect((play.json() as { error: string }).error).toMatch(/daily limit/);
  });
});
