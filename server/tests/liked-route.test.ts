import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb, type Db } from '../src/db/index.js';
import { registerLikedRoutes } from '../src/api/liked.js';
import { SpotifyApi } from '../src/spotify/api.js';
import { ensureSpotifySchema } from '../src/spotify/auth.js';
import { ensureSpotifyLibrarySchema } from '../src/spotify/library-schema.js';
import { fakeFetch, jsonResponse, type FetchCall } from './spotify-helpers.js';

process.env.LOG_LEVEL ??= 'silent';

const LIKED = 'pl:sp:liked';

interface SetupOptions {
  connected?: boolean;
  scopes?: string[];
  /** Fail the nth /me/tracks call with this status. */
  fail?: { method: string; status: number; retryAfter?: string };
}

function seed(db: Db): void {
  ensureSpotifySchema(db);
  ensureSpotifyLibrarySchema(db);
  db.prepare("INSERT INTO artists (id, name) VALUES ('ar:sp:a', 'A')").run();
  db.prepare(
    "INSERT INTO albums (id, source, title, artist_id, in_library, added_at) VALUES ('sp:al', 'spotify', 'Album', 'ar:sp:a', 0, 0)",
  ).run();
  const track = db.prepare(
    "INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms) VALUES (?, 'sp:al', 'spotify', ?, 1, 1, 1000)",
  );
  for (const id of ['t1', 't2', 't3', 't4']) track.run(`sp:${id}`, id);
  db.prepare(
    "INSERT INTO playlists (id, source, name, track_count, position, updated_at) VALUES (?, 'spotify', 'Liked Songs', 0, 0, 0)",
  ).run(LIKED);
}

/** Store a liked entry at the next position (as the sync does), keeping the count in step. */
function like(db: Db, trackId: string, position: number, addedAt = 1_000): void {
  db.prepare('INSERT INTO playlist_tracks (playlist_id, position, track_id, added_at) VALUES (?, ?, ?, ?)').run(
    LIKED,
    position,
    trackId,
    addedAt,
  );
  db.prepare('UPDATE playlists SET track_count = track_count + 1 WHERE id = ?').run(LIKED);
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function setup(opts: SetupOptions = {}) {
  const db = openDb(':memory:');
  seed(db);
  const { fetch, calls } = fakeFetch((url, init) => {
    const method = init?.method ?? 'GET';
    if (url.pathname === '/v1/me/tracks') {
      const fail = opts.fail;
      if (fail && fail.method === method) {
        return jsonResponse(fail.status, { error: 'no' }, fail.retryAfter ? { 'retry-after': fail.retryAfter } : {});
      }
      return jsonResponse(204, '');
    }
    return jsonResponse(404, { error: `unexpected ${method} ${url.pathname}` });
  });
  const api = new SpotifyApi({ fetch, getToken: async () => 'token', baseUrl: 'http://api.test/v1' });
  let changes = 0;
  app = Fastify();
  await app.register(
    async (r) =>
      registerLikedRoutes(r, db, {
        api,
        connected: async () => opts.connected !== false,
        grantedScopes: () => opts.scopes ?? ['user-library-modify'],
        onChange: () => {
          changes++;
        },
      }),
    { prefix: '/api' },
  );
  return { db, calls, api, changes: () => changes };
}

const likedWrites = (calls: FetchCall[], method: string) =>
  calls.filter((c) => (c.init?.method ?? 'GET') === method && c.url.pathname === '/v1/me/tracks');

const entries = (db: Db) =>
  db
    .prepare('SELECT position, track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position')
    .all(LIKED) as { position: number; track_id: string }[];

const trackCount = (db: Db) =>
  (db.prepare('SELECT track_count FROM playlists WHERE id = ?').get(LIKED) as { track_count: number }).track_count;

describe('GET /tracks/liked', () => {
  it('answers from the synced Liked Songs table without touching Spotify', async () => {
    const s = await setup();
    like(s.db, 'sp:t1', 0);
    like(s.db, 'sp:t3', 1);
    like(s.db, 'la:local', 2); // never happens in practice, but must not be reported as sp liked

    const res = await app!.inject({
      method: 'GET',
      url: '/api/tracks/liked?ids=sp:t1,sp:t2,sp:t3,la:local',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      liked: { 'sp:t1': true, 'sp:t2': false, 'sp:t3': true, 'la:local': false },
    });
    expect(s.calls).toHaveLength(0);
  });

  it('rejects an empty or oversized id list', async () => {
    await setup();
    expect((await app!.inject({ method: 'GET', url: '/api/tracks/liked' })).statusCode).toBe(400);
    const many = Array.from({ length: 501 }, (_, i) => `sp:${i}`).join(',');
    expect((await app!.inject({ method: 'GET', url: `/api/tracks/liked?ids=${many}` })).statusCode).toBe(400);
  });
});

describe('POST/DELETE /tracks/liked', () => {
  it('likes a batch with one request, puts them newest first and counts the change', async () => {
    const s = await setup();
    like(s.db, 'sp:t3', 0);

    const res = await app!.inject({ method: 'POST', url: '/api/tracks/liked', payload: { ids: ['sp:t1', 'sp:t2'] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ liked: true, changed: 2 });

    expect(likedWrites(s.calls, 'PUT')).toHaveLength(1);
    expect(JSON.parse(String(likedWrites(s.calls, 'PUT')[0]!.init!.body))).toEqual({ ids: ['t1', 't2'] });
    expect(entries(s.db)).toEqual([
      { position: 0, track_id: 'sp:t1' },
      { position: 1, track_id: 'sp:t2' },
      { position: 2, track_id: 'sp:t3' },
    ]);
    expect(trackCount(s.db)).toBe(3);
    expect(s.changes()).toBe(1);
  });

  it('costs no request when the songs are already liked', async () => {
    const s = await setup();
    like(s.db, 'sp:t1', 0);
    like(s.db, 'sp:t2', 1);

    const res = await app!.inject({ method: 'POST', url: '/api/tracks/liked', payload: { ids: ['sp:t1', 'sp:t2'] } });
    expect(res.json()).toEqual({ liked: true, changed: 0 });
    expect(s.calls).toHaveLength(0);
    expect(s.changes()).toBe(0);
  });

  it('unlikes in one request, removes the rows and keeps positions dense', async () => {
    const s = await setup();
    like(s.db, 'sp:t1', 0);
    like(s.db, 'sp:t2', 1);
    like(s.db, 'sp:t3', 2);

    const res = await app!.inject({ method: 'DELETE', url: '/api/tracks/liked', payload: { ids: ['sp:t2'] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ liked: false, changed: 1 });
    expect(likedWrites(s.calls, 'DELETE')).toHaveLength(1);
    expect(JSON.parse(String(likedWrites(s.calls, 'DELETE')[0]!.init!.body))).toEqual({ ids: ['t2'] });
    expect(entries(s.db)).toEqual([
      { position: 0, track_id: 'sp:t1' },
      { position: 1, track_id: 'sp:t3' },
    ]);
    expect(trackCount(s.db)).toBe(2);

    await app!.inject({ method: 'DELETE', url: '/api/tracks/liked', payload: { ids: ['sp:t1', 'sp:t3'] } });
    expect(entries(s.db)).toEqual([]);
    expect(trackCount(s.db)).toBe(0);
  });

  it('unlikes only what is actually liked', async () => {
    const s = await setup();
    like(s.db, 'sp:t1', 0);
    const res = await app!.inject({ method: 'DELETE', url: '/api/tracks/liked', payload: { ids: ['sp:t1', 'sp:t9'] } });
    expect(res.json()).toEqual({ liked: false, changed: 1 });
    expect(JSON.parse(String(likedWrites(s.calls, 'DELETE')[0]!.init!.body))).toEqual({ ids: ['t1'] });
    expect(entries(s.db)).toEqual([]);
  });

  it('needs Spotify connected and the library-modify scope', async () => {
    let s = await setup({ connected: false });
    let res = await app!.inject({ method: 'POST', url: '/api/tracks/liked', payload: { ids: ['sp:t1'] } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'not_connected' });
    expect(s.calls).toHaveLength(0);
    await app!.close();

    s = await setup({ scopes: ['user-read-private'] });
    res = await app!.inject({ method: 'POST', url: '/api/tracks/liked', payload: { ids: ['sp:t1'] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Reconnect Spotify/);
    expect(s.calls).toHaveLength(0);
    expect(entries(s.db)).toEqual([]);
  });

  it('reports a Spotify rate limit as 429 and leaves the mirror alone', async () => {
    const s = await setup({ fail: { method: 'DELETE', status: 429, retryAfter: '120' } });
    like(s.db, 'sp:t1', 0);

    const res = await app!.inject({ method: 'DELETE', url: '/api/tracks/liked', payload: { ids: ['sp:t1'] } });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toMatch(/rate limit/);
    expect(entries(s.db)).toEqual([{ position: 0, track_id: 'sp:t1' }]);
    expect(trackCount(s.db)).toBe(1);
    expect(s.changes()).toBe(0);
  });

  it('rejects ids that are not Spotify tracks', async () => {
    const s = await setup();
    const res = await app!.inject({ method: 'POST', url: '/api/tracks/liked', payload: { ids: ['la:1'] } });
    expect(res.statusCode).toBe(400);
    expect(s.calls).toHaveLength(0);
  });
});
