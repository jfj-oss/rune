// GET /api/artists/:id for a local artist linked to Spotify: Spotify may add to the page, never hold it up.
// Offline: a fake fetch stands in for Spotify.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/server.js';
import { openDb, type Db } from '../src/db/index.js';
import { ensureSpotifySchema } from '../src/spotify/schema.js';
import { ensureSpotifyLibrarySchema } from '../src/spotify/library-schema.js';
import { TEST_CONFIG, fakeFetch, jsonResponse, paging, sampleAlbum } from './spotify-helpers.js';
import type { FetchCall } from './spotify-helpers.js';

process.env.LOG_LEVEL = 'silent';

const HOUR_MS = 3_600_000;

let root: string;
let db: Db;
let app: FastifyInstance;
let closeApp: () => Promise<void>;
let calls: FetchCall[];
/** What the fake Spotify does with /artists/*: answer, or leave the page hanging. */
let answer: () => ReturnType<typeof jsonResponse> | Promise<ReturnType<typeof jsonResponse>>;
const hung = () => new Promise<never>(() => {});
const good = () => jsonResponse(200, { id: 'sp1', name: 'Local Band', images: [] });

const page = async (id: string) => {
  const res = await app.inject({ method: 'GET', url: `/api/artists/${encodeURIComponent(id)}` });
  return { status: res.statusCode, body: res.json() as { name: string; albums: { id: string }[] } };
};
const spotifyCalls = () => calls.filter((c) => c.url.pathname.startsWith('/v1/artists')).length;

async function start(usedToday = 0, dailyBudget = 100) {
  root = mkdtempSync(join(tmpdir(), 'liner-artist-route-'));
  db = openDb(':memory:');
  ensureSpotifySchema(db);
  ensureSpotifyLibrarySchema(db);
  db.prepare(
    `INSERT INTO spotify_auth (id, access_token, refresh_token, token_type, scope, expires_at, user_name, user_product, updated_at)
     VALUES (1, 'access', 'refresh', 'Bearer', '', ?, NULL, NULL, 0)`,
  ).run(Date.now() + HOUR_MS);
  db.exec('CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  if (usedToday > 0) {
    db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?)').run(
      'spotify.usage',
      JSON.stringify({ buckets: [{ hour: Date.now(), byPath: { 'GET /me/player': usedToday } }], blockedUntil: null }),
    );
  }
  const artist = db.prepare('INSERT INTO artists (id, name, sort_name, mbid, image_path, spotify_id) VALUES (?, ?, NULL, NULL, NULL, ?)');
  artist.run('ar:l1', 'Local Band', 'sp1');
  artist.run('ar:l2', 'Other Band', 'sp2');

  const fake = fakeFetch((url) => {
    if (!url.pathname.startsWith('/v1/artists')) return jsonResponse(204, '');
    if (url.pathname.endsWith('/albums')) return Promise.resolve(answer()).then((r) => (r.ok ? jsonResponse(200, paging([sampleAlbum({ id: 'spalbum' })])) : r));
    return answer();
  });
  calls = fake.calls;
  const built = await buildApp(db, { ...TEST_CONFIG, dataDir: join(root, 'data'), spotify: { dailyBudget } }, {
    pcZone: false,
    scanOnStart: false,
    spotifySyncOnStart: false,
    webDist: join(root, 'no-web-dist'),
    artistWaitMs: 40,
    spotifyOptions: { fetch: fake.fetch, endpoints: { api: 'http://api.test/v1', accounts: 'http://accounts.test' } },
  });
  app = built.app;
  closeApp = built.close;
}

afterEach(async () => {
  await closeApp?.();
  db?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('a linked local artist page', () => {
  describe('with the budget fine', () => {
    beforeEach(() => start());

    it('adds the Spotify discography when Spotify answers in time', async () => {
      answer = good;
      const { body } = await page('ar:l1');
      expect(body.albums.map((a) => a.id)).toContain('sp:spalbum');
    });

    it('answers with the local artist when Spotify is slow', async () => {
      answer = hung;
      const { status, body } = await page('ar:l1');
      expect(status).toBe(200);
      expect(body.name).toBe('Local Band');
      expect(body.albums).toEqual([]);
    });

    it('a slow answer still lands in the cache for the next visit', async () => {
      let release = (_: ReturnType<typeof jsonResponse>) => {};
      const held = new Promise<ReturnType<typeof jsonResponse>>((r) => { release = r; });
      answer = () => held;
      expect((await page('ar:l1')).body.albums).toEqual([]);
      release(good());
      await new Promise((r) => setTimeout(r, 5));
      expect((await page('ar:l1')).body.albums.map((a) => a.id)).toContain('sp:spalbum');
    });

    it('remembers a failure instead of asking again on every page', async () => {
      answer = () => jsonResponse(500, { error: 'boom' });
      expect((await page('ar:l1')).body.name).toBe('Local Band');
      const asked = spotifyCalls();
      expect(asked).toBeGreaterThan(0);

      expect((await page('ar:l1')).status).toBe(200);
      expect(spotifyCalls()).toBe(asked);

      await page('ar:l2'); // another artist is asked as usual
      expect(spotifyCalls()).toBeGreaterThan(asked);
    });

    it('a failure after the page was answered is remembered too, and hurts nothing', async () => {
      let fail = (_: ReturnType<typeof jsonResponse>) => {};
      const held = new Promise<ReturnType<typeof jsonResponse>>((r) => { fail = r; });
      answer = () => held;
      await page('ar:l1');
      fail(jsonResponse(500, { error: 'boom' }));
      await new Promise((r) => setTimeout(r, 5));
      const asked = spotifyCalls();
      await page('ar:l1');
      expect(spotifyCalls()).toBe(asked);
    });

    it('a Spotify-only artist has no page of its own, so it still waits for Spotify', async () => {
      let release = (_: ReturnType<typeof jsonResponse>) => {};
      const held = new Promise<ReturnType<typeof jsonResponse>>((r) => { release = r; });
      answer = () => held;
      const pending = page('ar:sp:sp9');
      await new Promise((r) => setTimeout(r, 80)); // past the 40 ms a local page would wait
      release(good());
      expect((await pending).status).toBe(200);
    });
  });

  it('still asks Spotify at low budget: someone opened this page', async () => {
    await start(90, 100);
    answer = good;
    const { status, body } = await page('ar:l1');
    expect(status).toBe(200);
    expect(body.name).toBe('Local Band');
    expect(spotifyCalls()).toBeGreaterThan(0);
  });
});
