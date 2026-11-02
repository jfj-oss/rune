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

  it('surfaces an excessive Retry-After instead of blocking', async () => {
    const { fetch } = fakeFetch(() => jsonResponse(429, {}, { 'Retry-After': '120' }));
    const api = new SpotifyApi({ fetch, baseUrl: BASE, getToken: async () => 'tok', sleep: async () => {} });
    const err = await api.album('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(429);
    expect((err as HttpError).retryAfterMs).toBe(120_000);
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
