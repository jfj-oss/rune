// Request counters + circuit breaker survive a restart. No real Spotify: a fake
// fetch, an in-memory store for the API tests and an in-memory SQLite DB for wiring.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpotifyApi, type SpotifyUsageState } from '../src/spotify/api.js';
import { createSpotify } from '../src/spotify/index.js';
import { openDb } from '../src/db/index.js';
import { ensureSpotifySchema } from '../src/spotify/schema.js';
import { TEST_CONFIG, fakeFetch, jsonResponse, sampleAlbum } from './spotify-helpers.js';

const BASE = 'http://api.test/v1';
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 2, 10, 15);
const HOUR_NOW = Math.floor(T0 / HOUR);

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe('Spotify usage persistence', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('restores counts from the last run while sinceStart starts over', async () => {
    let saved: SpotifyUsageState | undefined;
    const { fetch, calls } = fakeFetch(() => jsonResponse(200, sampleAlbum()));
    const opts = {
      fetch,
      getToken: async () => 'tok',
      baseUrl: BASE,
      now: () => T0,
      loadUsage: () => (saved ? clone(saved) : undefined),
      saveUsage: (usage: SpotifyUsageState) => {
        saved = clone(usage);
      },
    };

    const first = new SpotifyApi(opts);
    await first.album('4uLU6hMCjMI75M1A2tKUQC');
    await first.album('4uLU6hMCjMI75M1A2tKUQD');
    expect(calls).toHaveLength(2);
    // Throttled: nothing persisted yet.
    expect(saved).toBeUndefined();
    first.close(); // shutdown flush

    expect(saved?.buckets).toEqual([
      { hour: HOUR_NOW * HOUR, total: 2, byPath: { 'GET /albums/:id': 2 } },
    ]);

    const second = new SpotifyApi(opts);
    const usage = second.usage();
    expect(usage.sinceStart).toBe(0);
    expect(usage.lastHour).toBe(2);
    expect(usage.last24h).toBe(2);
    expect(usage.byPath).toEqual([{ path: 'GET /albums/:id', count: 2 }]);
    expect(usage.blockedUntil).toBeNull();
    second.close();
  });

  it('drops buckets older than 25 hours and ignores future ones on load', () => {
    const state: SpotifyUsageState = {
      buckets: [
        { hour: (HOUR_NOW - 25) * HOUR, total: 9, byPath: { 'GET /old': 9 } },
        { hour: (HOUR_NOW - 24) * HOUR, total: 2, byPath: { 'GET /edge': 2 } },
        { hour: HOUR_NOW * HOUR, total: 1, byPath: { 'GET /now': 1 } },
        { hour: (HOUR_NOW + 1) * HOUR, total: 5, byPath: { 'GET /future': 5 } },
      ],
      blockedUntil: null,
    };
    const { fetch } = fakeFetch(() => jsonResponse(200, sampleAlbum()));
    const api = new SpotifyApi({
      fetch,
      getToken: async () => 'tok',
      baseUrl: BASE,
      now: () => T0,
      loadUsage: () => state,
    });

    const usage = api.usage();
    expect(usage.last24h).toBe(3); // the 25-hour-old and future buckets are gone
    expect(usage.lastHour).toBe(1);
    expect(usage.byPath).toEqual([
      { path: 'GET /edge', count: 2 },
      { path: 'GET /now', count: 1 },
    ]);
    api.close();
  });

  it('a restored future blockedUntil blocks without a token or fetch', async () => {
    let tokenCalls = 0;
    const { fetch, calls } = fakeFetch(() => {
      throw new Error('must not reach the network while blocked');
    });
    const until = T0 + HOUR;
    const api = new SpotifyApi({
      fetch,
      getToken: async () => {
        tokenCalls++;
        return 'tok';
      },
      baseUrl: BASE,
      now: () => T0,
      loadUsage: () => ({ buckets: [], blockedUntil: until }),
    });

    expect(api.blockedUntil()).toBe(until);
    await expect(api.album('x')).rejects.toMatchObject({ status: 429, retryAfterMs: HOUR });
    expect(calls).toHaveLength(0);
    expect(tokenCalls).toBe(0);
    api.close();
  });

  it('saves at most once per 60 s and only when counts changed', async () => {
    vi.useFakeTimers();
    const saves: SpotifyUsageState[] = [];
    const { fetch } = fakeFetch(() => jsonResponse(200, sampleAlbum()));
    const api = new SpotifyApi({
      fetch,
      getToken: async () => 'tok',
      baseUrl: BASE,
      now: () => T0,
      saveUsage: (usage) => saves.push(clone(usage)),
    });

    await api.album('a');
    await api.album('b');
    expect(saves).toHaveLength(0);

    vi.advanceTimersByTime(59_000);
    expect(saves).toHaveLength(0);
    vi.advanceTimersByTime(1_000);
    expect(saves).toHaveLength(1);
    expect(saves[0]!.buckets.reduce((n, b) => n + b.total, 0)).toBe(2);

    // Nothing new: the next tick writes nothing.
    vi.advanceTimersByTime(60_000);
    expect(saves).toHaveLength(1);

    await api.album('c');
    vi.advanceTimersByTime(60_000);
    expect(saves).toHaveLength(2);
    expect(saves[1]!.buckets.reduce((n, b) => n + b.total, 0)).toBe(3);
    api.close();
  });

  it('saves immediately when the circuit breaker trips', async () => {
    const saves: SpotifyUsageState[] = [];
    const { fetch } = fakeFetch(() => jsonResponse(429, {}, { 'Retry-After': '32400' }));
    const api = new SpotifyApi({
      fetch,
      getToken: async () => 'tok',
      baseUrl: BASE,
      now: () => T0,
      sleep: async () => undefined,
      saveUsage: (usage) => saves.push(clone(usage)),
    });

    await expect(api.album('x')).rejects.toMatchObject({ status: 429 });
    expect(saves).toHaveLength(1);
    expect(saves[0]!.blockedUntil).toBe(T0 + 32_400_000);
    api.close();
  });

  it('wires the counters through the app_state table', async () => {
    const db = openDb(':memory:');
    ensureSpotifySchema(db);
    try {
      const { fetch } = fakeFetch(() => jsonResponse(200, sampleAlbum()));
      const opts = {
        fetch,
        endpoints: { api: BASE, accounts: 'http://accounts.test' },
        now: () => T0,
      };
      // An unexpired token, so the auth layer never tries to refresh.
      db.prepare(
        `INSERT INTO spotify_auth (id, access_token, refresh_token, token_type, scope, expires_at, user_name, user_product, updated_at)
         VALUES (1, 'access', 'refresh', 'Bearer', '', ?, NULL, NULL, 0)`,
      ).run(T0 + HOUR);
      const first = createSpotify(db, TEST_CONFIG, opts);
      await first.api.album('4uLU6hMCjMI75M1A2tKUQC');

      const row = () =>
        db.prepare("SELECT value FROM app_state WHERE key = 'spotify.usage'").get() as
          | { value: string }
          | undefined;
      expect(row()).toBeUndefined();
      first.close();

      const persisted = JSON.parse(row()!.value) as SpotifyUsageState;
      expect(persisted.buckets).toEqual([
        { hour: HOUR_NOW * HOUR, total: 1, byPath: { 'GET /albums/:id': 1 } },
      ]);

      // A new module on the same DB is what a restart looks like.
      const second = createSpotify(db, TEST_CONFIG, opts);
      expect(second.api.usage()).toMatchObject({
        sinceStart: 0,
        lastHour: 1,
        last24h: 1,
        budget: { used24h: 1 },
      });
      second.close();
    } finally {
      db.close();
    }
  });
});
