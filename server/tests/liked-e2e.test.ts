// Liked Songs end to end against a fake Spotify: the heart / "Save to Liked Songs" (POST /api/tracks/liked) must
// reach Spotify once, land in the Liked Songs mirror newest first, answer the heart query, and show on the Liked
// Songs page (GET /api/playlists/pl:sp:liked) — and unliking must undo all of it. Built with buildApp, so the
// routes, the scope check and the status route are the real ones. No network, no real database.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/server.js';
import { openDb, type Db } from '../src/db/index.js';
import { ensureSpotifySchema } from '../src/spotify/auth.js';
import { ensureSpotifyLibrarySchema } from '../src/spotify/library-schema.js';
import { TEST_CONFIG, fakeFetch, jsonResponse, sampleTrack, type FetchCall } from './spotify-helpers.js';

process.env.LOG_LEVEL ??= 'silent';

const LIKED = 'pl:sp:liked';
const TMP = join(process.env.HOME ?? '/tmp', 'data/agent-tmp/rune-bugs/tmp');

let root: string;
let db: Db;
let app: FastifyInstance;
let closeApp: () => Promise<void>;
let calls: FetchCall[];
let scopes = 'user-library-read user-library-modify playlist-modify-private playlist-modify-public';
let clock = 1_700_000_000_000;

function seed(d: Db): void {
  ensureSpotifySchema(d);
  ensureSpotifyLibrarySchema(d);
  d.prepare(
    `INSERT INTO spotify_auth (id, access_token, refresh_token, token_type, scope, expires_at, user_id, user_name, user_product, updated_at)
     VALUES (1, 'access', 'refresh', 'Bearer', ?, ?, 'me', 'Me', 'premium', 0)`,
  ).run(scopes, Date.now() + 3_600_000);
  d.prepare("INSERT INTO artists (id, name) VALUES ('ar:sp:a', 'A')").run();
  d.prepare("INSERT INTO albums (id, source, title, artist_id, in_library, added_at) VALUES ('sp:al', 'spotify', 'Album', 'ar:sp:a', 0, 0)").run();
  const track = d.prepare("INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms) VALUES (?, 'sp:al', 'spotify', ?, 1, 1, 1000)");
  for (const id of ['t1', 't2']) track.run(`sp:${id}`, id);
  d.prepare("INSERT INTO playlists (id, source, name, owner, track_count, position, updated_at) VALUES (?, 'spotify', 'Liked Songs', 'Me', 1, 0, 0)").run(LIKED);
  d.prepare('INSERT INTO playlist_tracks (playlist_id, position, track_id, added_at) VALUES (?, 0, ?, 500)').run(LIKED, 'sp:t2');
}

beforeAll(async () => {
  mkdirSync(TMP, { recursive: true });
  root = join(TMP, `liked-e2e-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  db = openDb(':memory:');
  seed(db);
  const fake = fakeFetch((url, init) => {
    const method = init?.method ?? 'GET';
    if (url.pathname === '/v1/me/library') return jsonResponse(method === 'PUT' || method === 'DELETE' ? 200 : 405, '');
    if (url.pathname === '/v1/tracks') {
      // a song from search / Discover that rune has not stored yet
      const ids = (url.searchParams.get('ids') ?? '').split(',');
      return jsonResponse(200, { tracks: ids.map((id) => sampleTrack(id, 1, `Song ${id}`)) });
    }
    if (url.pathname === '/v1/me/player/devices') return jsonResponse(200, { devices: [] });
    return jsonResponse(404, { error: `unexpected ${method} ${url.pathname}` });
  });
  calls = fake.calls;
  const built = await buildApp(db, { ...TEST_CONFIG, dataDir: join(root, 'data') }, {
    scanOnStart: false,
    spotifySyncOnStart: false,
    webDist: join(root, 'no-web-dist'),
    spotifyOptions: { fetch: fake.fetch, now: () => clock, endpoints: { api: 'http://api.test/v1', accounts: 'http://accounts.test' } },
  });
  app = built.app;
  closeApp = built.close;
});

afterAll(async () => {
  await closeApp?.();
  db?.close();
  rmSync(root, { recursive: true, force: true });
});

const libraryCalls = (method: string) => calls.filter((c) => (c.init?.method ?? 'GET') === method && c.url.pathname === '/v1/me/library');
const likedPage = async () => {
  const res = await app.inject({ method: 'GET', url: `/api/playlists/${encodeURIComponent(LIKED)}` });
  expect(res.statusCode).toBe(200);
  return res.json() as { trackCount: number; canEdit?: boolean; tracks: { id: string; title: string; addedAt?: number }[] };
};
const heart = async (ids: string[]) => ((await app.inject({ method: 'GET', url: `/api/tracks/liked?ids=${ids.join(',')}` })).json() as { liked: Record<string, boolean> }).liked;

describe('Liked Songs, end to end', () => {
  it('reports the granted permissions by name only on /spotify/status', async () => {
    const st = (await app.inject({ method: 'GET', url: '/api/spotify/status' })).json() as Record<string, unknown>;
    expect(st.connected).toBe(true);
    expect(st.scopes).toEqual(scopes.split(' '));
    expect(JSON.stringify(st)).not.toMatch(/access|refresh/);
  });

  it('liking from the heart reaches Spotify once and shows at the top of Liked Songs with the heart on', async () => {
    expect(await heart(['sp:t1', 'sp:t2'])).toEqual({ 'sp:t1': false, 'sp:t2': true });
    const t0 = Date.now();
    const res = await app.inject({ method: 'POST', url: '/api/tracks/liked', payload: { ids: ['sp:t1'] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ liked: true, changed: 1 });
    expect(libraryCalls('PUT')).toHaveLength(1);
    expect(libraryCalls('PUT')[0]!.url.searchParams.get('uris')).toBe('spotify:track:t1');

    expect(await heart(['sp:t1', 'sp:t2'])).toEqual({ 'sp:t1': true, 'sp:t2': true });
    const page = await likedPage();
    expect(page.canEdit).toBe(true);
    expect(page.trackCount).toBe(2);
    expect(page.tracks.map((t) => t.id)).toEqual(['sp:t1', 'sp:t2']);
    // the like's date is now (the page sorts newest first by it)
    expect(page.tracks[0]!.addedAt).toBeGreaterThanOrEqual(t0);
    // pressing the heart again costs nothing
    expect((await app.inject({ method: 'POST', url: '/api/tracks/liked', payload: { ids: ['sp:t1'] } })).json()).toEqual({ liked: true, changed: 0 });
    expect(libraryCalls('PUT')).toHaveLength(1);
  });

  it('likes a song rune has never stored (search / Discover): fetched, stored and listed', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/tracks/liked', payload: { ids: ['sp:new1'] } });
    expect(res.statusCode).toBe(200);
    expect(calls.filter((c) => c.url.pathname === '/v1/tracks')).toHaveLength(1);
    const page = await likedPage();
    expect(page.tracks.map((t) => t.id)).toEqual(['sp:new1', 'sp:t1', 'sp:t2']);
    expect(page.tracks[0]!.title).toBe('Song new1');
    expect(await heart(['sp:new1'])).toEqual({ 'sp:new1': true });
  });

  it('removing from Liked Songs (the page or the heart) unlikes on Spotify and the row is gone', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/tracks/liked', payload: { ids: ['sp:t1'] } });
    expect(res.json()).toEqual({ liked: false, changed: 1 });
    expect(libraryCalls('DELETE')).toHaveLength(1);
    expect(libraryCalls('DELETE')[0]!.url.searchParams.get('uris')).toBe('spotify:track:t1');
    expect((await likedPage()).tracks.map((t) => t.id)).toEqual(['sp:new1', 'sp:t2']);
    expect(await heart(['sp:t1'])).toEqual({ 'sp:t1': false });

    // the Liked Songs page's own remove goes through the playlist route with the same effect
    const viaPage = await app.inject({ method: 'DELETE', url: `/api/playlists/${encodeURIComponent(LIKED)}/tracks`, payload: { positions: [0] } });
    expect(viaPage.statusCode).toBe(200);
    expect((viaPage.json() as { tracks: { id: string }[] }).tracks.map((t) => t.id)).toEqual(['sp:t2']);
    expect(libraryCalls('DELETE')).toHaveLength(2);
  });

  it('says to reconnect, and sends nothing, when the login never granted user-library-modify', async () => {
    const before = calls.length;
    db.prepare("UPDATE spotify_auth SET scope = 'user-library-read playlist-read-private' WHERE id = 1").run();
    const st = (await app.inject({ method: 'GET', url: '/api/spotify/status' })).json() as { scopes: string[] };
    expect(st.scopes).not.toContain('user-library-modify');
    const res = await app.inject({ method: 'POST', url: '/api/tracks/liked', payload: { ids: ['sp:t1'] } });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/Reconnect Spotify/);
    const viaPage = await app.inject({ method: 'DELETE', url: `/api/playlists/${encodeURIComponent(LIKED)}/tracks`, payload: { positions: [0] } });
    expect(viaPage.statusCode).toBeGreaterThanOrEqual(400);
    expect((viaPage.json() as { error: string }).error).toMatch(/Reconnect Spotify/);
    expect(calls.length).toBe(before);
    db.prepare('UPDATE spotify_auth SET scope = ? WHERE id = 1').run(scopes);
  });
});
