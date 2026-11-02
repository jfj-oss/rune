import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { openDb, type Db } from '../src/db/index.js';
import type { Config } from '../src/config.js';
import type { MbRelease } from '../src/match/mb.js';
import { SpotifyApi, type SpotifyAlbum, type SpotifyTrack } from '../src/spotify/api.js';
import {
  buildSearchQuery,
  createLinking,
  matchAlbumTracks,
  normalizeBarcode,
  registerLinkRoutes,
  type LinkSpotifyApi,
  type LocalTrackForLink,
  type MbBarcodeClient,
} from '../src/spotify/linking.js';
import type { FetchLike } from '../src/spotify/fetch.js';
import { fakeFetch, jsonResponse, paging } from './spotify-helpers.js';

const cfg: Config = {
  libraryRoots: [],
  dataDir: '/tmp/liner-splink-tests',
  port: 0,
  audioDevice: 'none',
  userAgent: 'liner-tests',
};

const BASE = 'http://api.test/v1';

// ---------- fixtures / seeding ----------

interface SeedTrack {
  id: string;
  title: string;
  number: number;
  durationMs: number;
  disc?: number;
}

interface SeedAlbum {
  id: string;
  title: string;
  artist: string;
  mbReleaseId?: string | null;
  addedAt?: number;
  tracks: SeedTrack[];
}

function seedAlbum(db: Db, album: SeedAlbum): void {
  const artistId = 'ar:' + album.artist.toLowerCase().replace(/\s+/g, '-');
  db.prepare('INSERT OR IGNORE INTO artists (id, name) VALUES (?, ?)').run(artistId, album.artist);
  db.prepare(
    `INSERT INTO albums (id, source, title, artist_id, mb_release_id, added_at)
     VALUES (?, 'local', ?, ?, ?, ?)`,
  ).run(album.id, album.title, artistId, album.mbReleaseId ?? null, album.addedAt ?? 1);
  const insert = db.prepare(
    `INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms)
     VALUES (?, ?, 'local', ?, ?, ?, ?)`,
  );
  for (const t of album.tracks) {
    insert.run(t.id, album.id, t.title, t.disc ?? 1, t.number, t.durationMs);
  }
}

function spTrack(id: string, name: string, number: number, durationMs: number, disc = 1): SpotifyTrack {
  return {
    id,
    name,
    artists: [],
    disc_number: disc,
    track_number: number,
    duration_ms: durationMs,
    uri: `spotify:track:${id}`,
  };
}

function spAlbum(id: string, name: string, artist: string, totalTracks: number): SpotifyAlbum {
  return {
    id,
    name,
    album_type: 'album',
    artists: [{ id: 'sp-artist', name: artist }],
    total_tracks: totalTracks,
    images: [],
  };
}

function tracksPage(tracks: SpotifyTrack[]) {
  return paging(tracks);
}

function fakeMb(barcodes: Record<string, string | null>): MbBarcodeClient {
  return {
    async getRelease(id: string): Promise<MbRelease & { barcode?: string | null }> {
      // Only the fields linking.ts reads are needed.
      return { id, title: '', barcode: barcodes[id] ?? null } as unknown as MbRelease & {
        barcode?: string | null;
      };
    },
  };
}

function makeSpotifyApi(fetchImpl: FetchLike): SpotifyApi {
  return new SpotifyApi({
    fetch: fetchImpl,
    baseUrl: BASE,
    getToken: async () => 'tok',
    sleep: async () => {},
  });
}

function count(db: Db, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

const DISCOVERY_LOCAL: SeedAlbum = {
  id: 'la:discovery',
  title: 'Discovery',
  artist: 'Daft Punk',
  mbReleaseId: 'mb-discovery',
  tracks: [
    { id: 'l:d1', title: 'One More Time', number: 1, durationMs: 320_000 },
    { id: 'l:d2', title: 'Aerodynamic', number: 2, durationMs: 212_000 },
  ],
};

const DISCOVERY_SP_TRACKS = [
  spTrack('sp-t1', 'One More Time', 1, 320_000),
  spTrack('sp-t2', 'Aerodynamic', 2, 212_000),
];

// ---------- pure matching ----------

describe('matchAlbumTracks', () => {
  const local: LocalTrackForLink[] = [
    { id: 'l:1', title: 'Come Together', disc: 1, number: 1, durationMs: 259_000 },
    { id: 'l:2', title: 'Something', disc: 1, number: 2, durationMs: 182_000 },
  ];

  it('accepts the same album and maps every track', () => {
    const m = matchAlbumTracks(local, [
      { id: 'sp-1', name: 'Come Together', disc_number: 1, track_number: 1, duration_ms: 259_500 },
      { id: 'sp-2', name: 'Something', disc_number: 1, track_number: 2, duration_ms: 181_700 },
    ]);
    expect(m.ok).toBe(true);
    expect(m.confidence).toBeGreaterThan(0.9);
    expect(m.mapping).toEqual([
      { localTrackId: 'l:1', spotifyTrackId: 'sp-1' },
      { localTrackId: 'l:2', spotifyTrackId: 'sp-2' },
    ]);
  });

  it('rejects a deluxe edition with a different track count', () => {
    const m = matchAlbumTracks(local, [
      { id: 'sp-1', name: 'Come Together', disc_number: 1, track_number: 1, duration_ms: 259_500 },
      { id: 'sp-2', name: 'Something', disc_number: 1, track_number: 2, duration_ms: 181_700 },
      { id: 'sp-3', name: 'Maxwell’s Silver Hammer', disc_number: 1, track_number: 3, duration_ms: 207_000 },
    ]);
    expect(m.ok).toBe(false);
    expect(m.mapping).toEqual([]);
  });

  it('rejects a same-length album whose tracks/durations do not agree', () => {
    const m = matchAlbumTracks(local, [
      { id: 'sp-x1', name: 'Unrelated Song', disc_number: 1, track_number: 1, duration_ms: 400_000 },
      { id: 'sp-x2', name: 'Another Song', disc_number: 1, track_number: 2, duration_ms: 420_000 },
    ]);
    expect(m.ok).toBe(false);
  });
});

describe('helpers', () => {
  it('normalizes UPC/EAN barcodes', () => {
    expect(normalizeBarcode(' 7243 8 49606 5 0 ')).toBe('724384960650');
    expect(normalizeBarcode('n/a')).toBeUndefined();
    expect(normalizeBarcode(null)).toBeUndefined();
  });

  it('builds the documented field-filter query', () => {
    expect(buildSearchQuery('Discovery', 'Daft Punk')).toBe('album:"Discovery" artist:"Daft Punk"');
    expect(buildSearchQuery('The "Best" Of', 'A\\B')).toBe('album:"The Best Of" artist:"A B"');
  });
});

// ---------- linking ----------

describe('createLinking — UPC path', () => {
  it('searches Spotify by the MusicBrainz barcode and stores the album + track map', async () => {
    const db = openDb(':memory:');
    seedAlbum(db, DISCOVERY_LOCAL);

    const { fetch, calls } = fakeFetch((url) => {
      if (url.pathname === '/v1/search') {
        const q = url.searchParams.get('q') ?? '';
        if (q === 'upc:724384960650') {
          return jsonResponse(200, { albums: paging([spAlbum('spot-discovery', 'Discovery', 'Daft Punk', 2)]) });
        }
        return jsonResponse(200, { albums: paging([]) });
      }
      if (url.pathname === '/v1/albums/spot-discovery/tracks') {
        return jsonResponse(200, tracksPage(DISCOVERY_SP_TRACKS));
      }
      return jsonResponse(404, {});
    });
    const api = makeSpotifyApi(fetch);
    const linking = createLinking(db, cfg, {
      api,
      mb: fakeMb({ 'mb-discovery': '724384960650' }),
      rateLimitMs: 0,
      sleep: async () => {},
      now: () => 1_000,
    });

    const result = await linking.linkPending();
    expect(result).toMatchObject({ total: 1, attempted: 1, linked: 1, notFound: 0, failed: 0 });

    const row = db
      .prepare('SELECT album_id, spotify_album_id, method, confidence, checked_at FROM album_links')
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      album_id: 'la:discovery',
      spotify_album_id: 'spot-discovery',
      method: 'upc',
      checked_at: 1_000,
    });
    expect(row.confidence as number).toBeGreaterThanOrEqual(0.95);

    expect(linking.getAlbumLink('la:discovery')).toMatchObject({
      albumId: 'la:discovery',
      spotifyAlbumId: 'spot-discovery',
      method: 'upc',
    });
    expect(linking.getTrackLink('l:d1')).toEqual({ trackId: 'l:d1', spotifyTrackId: 'sp-t1' });
    expect(linking.getTrackLink('l:d2')).toEqual({ trackId: 'l:d2', spotifyTrackId: 'sp-t2' });
    expect(count(db, 'SELECT count(*) AS n FROM track_links')).toBe(2);

    // search + one album-tracks fetch; no fallback title search.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url.searchParams.get('q')).toBe('upc:724384960650');
    expect(calls[0]?.url.searchParams.get('type')).toBe('album');
    expect(calls[1]?.url.pathname).toBe('/v1/albums/spot-discovery/tracks');
  });
});

describe('createLinking — title/artist fallback', () => {
  it('rejects a deluxe edition with a different track count and accepts the standard album', async () => {
    const db = openDb(':memory:');
    seedAlbum(db, { ...DISCOVERY_LOCAL, mbReleaseId: 'mb-no-barcode' });

    const deluxeTracks = [
      ...DISCOVERY_SP_TRACKS,
      spTrack('sp-x3', 'Digital Love (Bonus)', 3, 300_000),
      spTrack('sp-x4', 'Too Long (Deluxe)', 4, 600_000),
    ];

    const { fetch, calls } = fakeFetch((url) => {
      if (url.pathname === '/v1/search') {
        const q = url.searchParams.get('q') ?? '';
        if (q === 'upc:') return jsonResponse(200, { albums: paging([]) });
        if (q === 'album:"Discovery" artist:"Daft Punk"') {
          return jsonResponse(200, {
            albums: paging([
              spAlbum('spot-deluxe', 'Discovery (Deluxe Edition)', 'Daft Punk', deluxeTracks.length),
              spAlbum('spot-discovery', 'Discovery', 'Daft Punk', 2),
            ]),
          });
        }
        return jsonResponse(200, { albums: paging([]) });
      }
      if (url.pathname === '/v1/albums/spot-deluxe/tracks') {
        return jsonResponse(200, tracksPage(deluxeTracks));
      }
      if (url.pathname === '/v1/albums/spot-discovery/tracks') {
        return jsonResponse(200, tracksPage(DISCOVERY_SP_TRACKS));
      }
      return jsonResponse(404, {});
    });
    const api = makeSpotifyApi(fetch);
    const linking = createLinking(db, cfg, {
      api,
      mb: fakeMb({ 'mb-no-barcode': null }),
      rateLimitMs: 0,
      sleep: async () => {},
      now: () => 2_000,
    });

    const result = await linking.linkPending();
    expect(result).toMatchObject({ total: 1, linked: 1, notFound: 0, failed: 0 });

    expect(linking.getAlbumLink('la:discovery')).toMatchObject({
      spotifyAlbumId: 'spot-discovery',
      method: 'search',
      checkedAt: 2_000,
    });
    expect(count(db, 'SELECT count(*) AS n FROM track_links')).toBe(2);
    expect(linking.getTrackLink('l:d1')?.spotifyTrackId).toBe('sp-t1');

    // The deluxe candidate was fetched and rejected before the right one was tried.
    const trackPaths = calls.filter((c) => c.url.pathname.endsWith('/tracks')).map((c) => c.url.pathname);
    expect(trackPaths).toEqual(['/v1/albums/spot-deluxe/tracks', '/v1/albums/spot-discovery/tracks']);
    // No UPC search: the MusicBrainz release had no barcode.
    expect(calls.some((c) => (c.url.searchParams.get('q') ?? '').startsWith('upc:'))).toBe(false);
  });

  it('remembered "not found" albums are not re-searched on the next run', async () => {
    const db = openDb(':memory:');
    seedAlbum(db, { ...DISCOVERY_LOCAL, mbReleaseId: null });
    const { fetch } = fakeFetch(() => jsonResponse(200, { albums: paging([]) }));
    const api = makeSpotifyApi(fetch);
    let clock = 3_000;
    const linking = createLinking(db, cfg, {
      api,
      mb: null,
      rateLimitMs: 0,
      sleep: async () => {},
      now: () => clock,
    });

    const first = await linking.linkPending();
    expect(first).toMatchObject({ total: 1, linked: 0, notFound: 1 });
    expect(
      (db.prepare('SELECT method FROM album_links WHERE album_id = ?').get('la:discovery') as { method: string }).method,
    ).toBe('not_found');

    clock += 1000;
    const second = await linking.linkPending();
    expect(second.total).toBe(0);
  });
});

// ---------- routes ----------

describe('registerLinkRoutes', () => {
  async function linkedDb(): Promise<{ db: Db; linking: ReturnType<typeof createLinking> }> {
    const db = openDb(':memory:');
    seedAlbum(db, DISCOVERY_LOCAL);
    const { fetch } = fakeFetch((url) => {
      if (url.pathname === '/v1/search') {
        return jsonResponse(200, { albums: paging([spAlbum('spot-discovery', 'Discovery', 'Daft Punk', 2)]) });
      }
      if (url.pathname === '/v1/albums/spot-discovery/tracks') {
        return jsonResponse(200, tracksPage(DISCOVERY_SP_TRACKS));
      }
      return jsonResponse(404, {});
    });
    const linking = createLinking(db, cfg, {
      api: makeSpotifyApi(fetch),
      mb: fakeMb({ 'mb-discovery': '724384960650' }),
      rateLimitMs: 0,
      sleep: async () => {},
    });
    await linking.linkPending();
    return { db, linking };
  }

  it('serves the album link and the per-track Spotify mapping', async () => {
    const { linking } = await linkedDb();
    const app = Fastify({ logger: false });
    registerLinkRoutes(app, linking, { prefix: '/api' });

    const album = await app.inject({ method: 'GET', url: '/api/albums/la:discovery/links' });
    expect(album.statusCode).toBe(200);
    expect(album.json()).toEqual({
      spotify: {
        id: 'sp:spot-discovery',
        url: 'https://open.spotify.com/album/spot-discovery',
        confidence: 0.98,
      },
    });

    const track = await app.inject({ method: 'GET', url: '/api/tracks/l:d1/spotify' });
    expect(track.statusCode).toBe(200);
    expect(track.json()).toEqual({
      spotify: {
        id: 'sp:sp-t1',
        uri: 'spotify:track:sp-t1',
        url: 'https://open.spotify.com/track/sp-t1',
      },
    });

    const unlinked = await app.inject({ method: 'GET', url: '/api/tracks/nope/spotify' });
    expect(unlinked.statusCode).toBe(404);
    const unknownAlbum = await app.inject({ method: 'GET', url: '/api/albums/la:nope/links' });
    expect(unknownAlbum.statusCode).toBe(404);
  });

  it('returns an empty object for an existing but unlinked album/track', async () => {
    const { db, linking } = await linkedDb();
    seedAlbum(db, {
      id: 'la:other',
      title: 'Other',
      artist: 'Someone',
      tracks: [{ id: 'l:o1', title: 'Song', number: 1, durationMs: 1000 }],
    });
    const app = Fastify({ logger: false });
    registerLinkRoutes(app, linking);

    const album = await app.inject({ method: 'GET', url: '/albums/la:other/links' });
    expect(album.statusCode).toBe(200);
    expect(album.json()).toEqual({});
    const track = await app.inject({ method: 'GET', url: '/tracks/l:o1/spotify' });
    expect(track.statusCode).toBe(200);
    expect(track.json()).toEqual({});
  });
});

// ---------- rate limiting ----------

describe('rate limiting', () => {
  it('spaces Spotify requests at least rateLimitMs apart', async () => {
    const db = openDb(':memory:');
    seedAlbum(db, { ...DISCOVERY_LOCAL, mbReleaseId: null });

    let clock = 0;
    const slept: number[] = [];
    const callTimes: number[] = [];
    const api: LinkSpotifyApi = {
      async search() {
        callTimes.push(clock);
        return { albums: paging([spAlbum('spot-discovery', 'Discovery', 'Daft Punk', 2)]) };
      },
      async albumTracks() {
        callTimes.push(clock);
        return tracksPage(DISCOVERY_SP_TRACKS);
      },
    };
    const linking = createLinking(db, cfg, {
      api,
      mb: null,
      rateLimitMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });

    await linking.linkPending();
    expect(callTimes).toEqual([0, 1000]);
    expect(slept).toEqual([1000]);
  });

  it('honours 429 Retry-After before retrying the search', async () => {
    const db = openDb(':memory:');
    seedAlbum(db, { ...DISCOVERY_LOCAL, mbReleaseId: null });

    let searches = 0;
    const { fetch } = fakeFetch((url) => {
      if (url.pathname === '/v1/search') {
        searches++;
        if (searches === 1) return jsonResponse(429, { error: 'rate_limited' }, { 'Retry-After': '2' });
        return jsonResponse(200, { albums: paging([spAlbum('spot-discovery', 'Discovery', 'Daft Punk', 2)]) });
      }
      if (url.pathname === '/v1/albums/spot-discovery/tracks') {
        return jsonResponse(200, tracksPage(DISCOVERY_SP_TRACKS));
      }
      return jsonResponse(404, {});
    });
    const apiSleeps: number[] = [];
    const api = new SpotifyApi({
      fetch,
      baseUrl: BASE,
      getToken: async () => 'tok',
      sleep: async (ms) => {
        apiSleeps.push(ms);
      },
    });
    const linking = createLinking(db, cfg, {
      api,
      mb: null,
      rateLimitMs: 0,
      sleep: async () => {},
    });

    const result = await linking.linkPending();
    expect(result.linked).toBe(1);
    expect(apiSleeps).toEqual([2000]);
    expect(searches).toBe(2);
    expect(linking.getAlbumLink('la:discovery')?.spotifyAlbumId).toBe('spot-discovery');
  });

  it('stops the batch (without caching a negative result) when Retry-After is too long', async () => {
    const db = openDb(':memory:');
    seedAlbum(db, { ...DISCOVERY_LOCAL, mbReleaseId: null });
    seedAlbum(db, {
      ...DISCOVERY_LOCAL,
      id: 'la:second',
      title: 'Homework',
      mbReleaseId: null,
      addedAt: 0,
      tracks: [{ id: 'l:h1', title: 'Daftendirekt', number: 1, durationMs: 100_000 }],
    });

    const { fetch } = fakeFetch(() => jsonResponse(429, {}, { 'Retry-After': '120' }));
    const api = new SpotifyApi({
      fetch,
      baseUrl: BASE,
      getToken: async () => 'tok',
      sleep: async () => {},
    });
    const linking = createLinking(db, cfg, {
      api,
      mb: null,
      rateLimitMs: 0,
      sleep: async () => {},
    });

    const result = await linking.linkPending();
    expect(result.rateLimited).toBe(true);
    expect(result.failed).toBe(1);
    expect(result.attempted).toBe(1);
    // A rate limit is not evidence that the album is absent.
    expect(count(db, 'SELECT count(*) AS n FROM album_links')).toBe(0);
  });
});
