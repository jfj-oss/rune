import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/spotify/fetch.js';
import { SpotifyApi } from '../src/spotify/api.js';
import { fakeFetch, jsonResponse, paging, sampleAlbum, sampleTrack } from './spotify-helpers.js';

const BASE = 'http://api.test/v1';

describe('SpotifyApi transport', () => {
  it('fills search params and the bearer header', async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.pathname === '/v1/search') {
        return jsonResponse(200, { albums: paging([sampleAlbum()]), artists: paging([]), tracks: paging([]) });
      }
      return jsonResponse(404, {});
    });
    const api = new SpotifyApi({ fetch, getToken: async () => 'tok-1', baseUrl: BASE });

    const res = await api.search('abbey road', { types: ['album'], limit: 5 });
    expect(res.albums?.items[0]?.name).toBe('Abbey Road');
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url.searchParams.get('q')).toBe('abbey road');
    expect(call.url.searchParams.get('type')).toBe('album');
    expect(call.url.searchParams.get('limit')).toBe('5');
    expect(call.init?.headers?.Authorization).toBe('Bearer tok-1');
    expect(call.init?.method).toBe('GET');
  });

  it('retries once after a 401 with a forced token refresh', async () => {
    const forces: (boolean | undefined)[] = [];
    const tokens: string[] = [];
    const { fetch, calls } = fakeFetch((url) => {
      if (url.pathname === '/v1/albums/abbey') {
        return calls.length === 1
          ? jsonResponse(401, { error: 'expired' })
          : jsonResponse(200, sampleAlbum());
      }
      return jsonResponse(404, {});
    });
    const api = new SpotifyApi({
      fetch,
      baseUrl: BASE,
      getToken: async (force) => {
        forces.push(force);
        const token = force ? 'tok-fresh' : 'tok-old';
        tokens.push(token);
        return token;
      },
    });

    const album = await api.album('abbey');
    expect(album.id).toBe('abbey');
    expect(forces).toEqual([false, true]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.init?.headers?.Authorization).toBe('Bearer tok-fresh');
    expect(tokens).toEqual(['tok-old', 'tok-fresh']);
  });

  it('gives up after a second 401', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(401, { error: 'nope' }));
    const api = new SpotifyApi({ fetch, baseUrl: BASE, getToken: async () => 'tok' });
    await expect(api.album('x')).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(2);
  });

  it('honours Retry-After for 429 responses', async () => {
    const slept: number[] = [];
    let n = 0;
    const { fetch } = fakeFetch(() => {
      n++;
      return n === 1
        ? jsonResponse(429, { error: 'rate' }, { 'Retry-After': '1' })
        : jsonResponse(200, sampleAlbum());
    });
    const api = new SpotifyApi({
      fetch,
      baseUrl: BASE,
      getToken: async () => 'tok',
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await expect(api.album('abbey')).resolves.toMatchObject({ id: 'abbey' });
    expect(slept).toEqual([1000]);
  });

  it('surfaces an excessive Retry-After and opens the circuit breaker', async () => {
    const { fetch } = fakeFetch(() => jsonResponse(429, {}, { 'Retry-After': '120' }));
    const api = new SpotifyApi({ fetch, baseUrl: BASE, getToken: async () => 'tok', sleep: async () => {} });
    const err = await api.album('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(429);
    expect((err as HttpError).retryAfterMs).toBe(120_000);
    expect(api.blockedUntil()).toBeTruthy();
  });

  it('blocks without calling fetch until the Retry-After has passed', async () => {
    let t = 1_000_000;
    const { fetch, calls } = fakeFetch(() => jsonResponse(429, {}, { 'Retry-After': '32400' }));
    const api = new SpotifyApi({
      fetch,
      baseUrl: BASE,
      getToken: async () => 'tok',
      sleep: async () => {},
      now: () => t,
      maxRetryAfterMs: 60_000,
    });

    await expect(api.album('x')).rejects.toMatchObject({ status: 429, retryAfterMs: 32_400_000 });
    expect(api.blockedUntil()).toBe(t + 32_400_000);
    expect(calls).toHaveLength(1);

    // Still blocked: immediate 429 with the remaining time, and no network at all.
    t += 3_600_000;
    const err = await api.album('y').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).retryAfterMs).toBe(32_400_000 - 3_600_000);
    expect(calls).toHaveLength(1);

    // The block expired: the next request goes out again.
    t += 32_400_000;
    expect(api.blockedUntil()).toBeNull();
    await expect(api.album('z')).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveLength(2);
  });

  it('counts real requests by normalized path and clock hour', async () => {
    let t = Date.UTC(2026, 10, 2, 10, 15);
    const hourly: { hourStart: number; total: number; topPaths: { path: string; count: number }[] }[] = [];
    const { fetch } = fakeFetch((url) => jsonResponse(200, { id: url.pathname.split('/').pop() ?? 'x', items: [], next: null }));
    const api = new SpotifyApi({
      fetch,
      baseUrl: BASE,
      getToken: async () => 'tok',
      now: () => t,
      onHourlyUsage: (u) => hourly.push(u),
    });

    await api.album('4uLU6hMCjMI75M1A2tKUQC'); // 22-char base62 id
    await api.album('0123456789abcdef0123456789abcdef'); // long hex id
    await api.track('ABCDEFGHIJKLMNOPQRSTUV'); // 22-char id
    await api.search('abbey road'); // query string is stripped

    expect(api.usage()).toMatchObject({
      sinceStart: 4,
      lastHour: 4,
      last24h: 4,
      blockedUntil: null,
      byPath: [
        { path: 'GET /albums/:id', count: 2 },
        { path: 'GET /search', count: 1 },
        { path: 'GET /tracks/:id', count: 1 },
      ],
    });

    // Next clock hour: the previous hour is logged once and the buckets move on.
    const firstHour = Math.floor(t / 3_600_000) * 3_600_000;
    t += 3_600_000;
    await api.album('abcdefabcdefabcdefabcd');
    expect(api.usage()).toMatchObject({ sinceStart: 5, lastHour: 1, last24h: 5 });
    expect(hourly).toEqual([
      {
        hourStart: firstHour,
        total: 4,
        topPaths: [
          { path: 'GET /albums/:id', count: 2 },
          { path: 'GET /search', count: 1 },
          { path: 'GET /tracks/:id', count: 1 },
        ],
      },
    ]);
  });

  it('follows pagination for saved albums', async () => {
    const { fetch, calls } = fakeFetch((url) => {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (url.pathname !== '/v1/me/albums') return jsonResponse(404, {});
      if (offset === 0) {
        return jsonResponse(
          200,
          paging(
            [
              { added_at: '2024-01-01T00:00:00Z', album: sampleAlbum({ id: 'a1', name: 'A1' }) },
              { added_at: '2024-01-02T00:00:00Z', album: sampleAlbum({ id: 'a2', name: 'A2' }) },
            ],
            { total: 3, offset: 0, next: 'http://api.test/v1/me/albums?offset=2&limit=50' },
          ),
        );
      }
      return jsonResponse(
        200,
        paging([{ added_at: '2024-01-03T00:00:00Z', album: sampleAlbum({ id: 'a3', name: 'A3' }) }], {
          total: 3,
          offset: 2,
        }),
      );
    });
    const api = new SpotifyApi({ fetch, baseUrl: BASE, getToken: async () => 'tok' });
    const saved = await api.allSavedAlbums();
    expect(saved.map((s) => s.album?.id)).toEqual(['a1', 'a2', 'a3']);
    expect(calls.map((c) => c.url.searchParams.get('offset'))).toEqual(['0', '2']);
  });

  it('looks tracks up one by one after Spotify refuses the batch endpoint', async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.pathname === '/v1/tracks') return jsonResponse(403, { error: { status: 403, message: 'Forbidden' } });
      const m = /^\/v1\/tracks\/(.+)$/.exec(url.pathname);
      if (m) return jsonResponse(200, { id: m[1], name: `T ${m[1]}` });
      return jsonResponse(404, {});
    });
    const api = new SpotifyApi({ fetch, baseUrl: BASE, getToken: async () => 'tok' });
    const got = await api.tracks(['a', 'b', 'c'], { maxSingles: 2 });
    expect(got.map((t) => t.id)).toEqual(['a', 'b']);
    // the refusal is remembered: no second batch attempt
    await api.tracks(['d']);
    expect(calls.filter((c) => c.url.pathname === '/v1/tracks')).toHaveLength(1);
  });

  it('pages artist albums with include_groups', async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.pathname === '/v1/artists/spbeatles/albums') {
        return jsonResponse(200, paging([sampleAlbum()], { next: null }));
      }
      return jsonResponse(404, {});
    });
    const api = new SpotifyApi({ fetch, baseUrl: BASE, getToken: async () => 'tok' });
    await expect(api.allArtistAlbums('spbeatles')).resolves.toHaveLength(1);
    expect(calls[0]?.url.searchParams.get('include_groups')).toBe('album,single');
    expect(calls[0]?.url.searchParams.get('limit')).toBe('10');
  });

  it('sends play bodies as JSON with the device query param', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(204, ''));
    const api = new SpotifyApi({ fetch, baseUrl: BASE, getToken: async () => 'tok' });
    await api.play({ uris: ['spotify:track:t1'], offset: { position: 1 } }, 'dev1');

    const call = calls[0]!;
    expect(call.url.pathname).toBe('/v1/me/player/play');
    expect(call.url.searchParams.get('device_id')).toBe('dev1');
    expect(call.init?.method).toBe('PUT');
    expect(call.init?.headers?.['Content-Type']).toBe('application/json');
    expect(JSON.parse(call.init?.body ?? '')).toEqual({
      uris: ['spotify:track:t1'],
      offset: { position: 1 },
    });
  });

  it('clamps seek, volume and search limits', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(204, ''));
    const api = new SpotifyApi({ fetch, baseUrl: BASE, getToken: async () => 'tok' });
    await api.seek(-50, 'dev');
    await api.setVolume(180, 'dev');
    expect(calls[0]?.url.searchParams.get('position_ms')).toBe('0');
    expect(calls[1]?.url.searchParams.get('volume_percent')).toBe('100');
  });

  it('chunks /tracks ids into groups of 50', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `t${i}`);
    const { fetch, calls } = fakeFetch((url) => {
      const requested = (url.searchParams.get('ids') ?? '').split(',');
      return jsonResponse(200, { tracks: requested.map((id) => sampleTrack(id)) });
    });
    const api = new SpotifyApi({ fetch, baseUrl: BASE, getToken: async () => 'tok' });
    const tracks = await api.tracks(ids);
    expect(tracks).toHaveLength(51);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url.searchParams.get('ids')?.split(',')).toHaveLength(50);
    expect(calls[1]?.url.searchParams.get('ids')?.split(',')).toHaveLength(1);
  });
});

describe('player endpoints with opaque 200 bodies', () => {
  it('treats a non-JSON 200 body (e.g. "TvJLfYpHJf") as no body', async () => {
    const { SpotifyApi } = await import('../src/spotify/api.js');
    const api = new SpotifyApi({
      fetch: (async () => new Response('TvJLfYpHJf', { status: 200 })) as never,
      getToken: async () => 'tok',
    });
    await expect(api.play({ uris: ['spotify:track:x'] }, 'dev')).resolves.toBeUndefined();
  });
});

describe('new playlist item shape', () => {
  it('maps { item } entries and items.total to the old track/tracks shape', async () => {
    const { normalizePlaylistEntry, normalizePlaylist } = await import('../src/spotify/api.js');
    const e = normalizePlaylistEntry({ added_at: 'x', is_local: false, item: { id: 't1', name: 'T' } } as never);
    expect((e as { track?: { id: string } }).track?.id).toBe('t1');
    expect(normalizePlaylist({ id: 'p', name: 'P', items: { total: 7 } } as never).tracks?.total).toBe(7);
  });
});
