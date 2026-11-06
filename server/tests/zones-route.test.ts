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

/** The device list is cached for 5 s: step past that before each read. */
const zones = async () => {
  clock += 6_000;
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
});
