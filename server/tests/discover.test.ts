// Offline tests for the Discover module. LB/MB responses are recorded fixtures
// (scripts/record-discover.ts); Spotify is an injected fake fetch.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { openDb, type Db } from '../src/db/index.js';
import type { Config } from '../src/config.js';
import { ensureSpotifyLibrarySchema } from '../src/spotify/library-schema.js';
import { SpotifyApi, type SpotifyTrack } from '../src/spotify/api.js';
import { MbClient } from '../src/match/mb.js';
import {
  DISCOVER_BLOCKED_KEY,
  DiscoverBlockedError,
  SpotifyDiscoverBudget,
} from '../src/discover/budget.js';
import { loadOwned, isOwned } from '../src/discover/exclusions.js';
import { LastFm } from '../src/discover/lastfm.js';
import { ListenBrainz } from '../src/discover/listenbrainz.js';
import { artistMatches, titleMatches } from '../src/discover/match.js';
import { DiscoverMb, pickArtist, pickRecording } from '../src/discover/mb.js';
import { SpotifyGateway } from '../src/discover/gateway.js';
import { DiscoverCache, ensureDiscoverSchema } from '../src/discover/schema.js';
import { createDiscover, type DiscoverSpotify } from '../src/discover/service.js';
import { fakeFetch, jsonResponse, paging } from './spotify-helpers.js';

const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const WEEKND = 'e4c5a4e0-1c4b-4f7a-9d0d-6f2f7a1c3b2e';
const DAFT = '056e4f3e-d505-4dad-8bfa-52a2e5f4e2c0';
const BLINDING_LIGHTS = '1a67e215-a19e-40c9-9b12-732de134bf5f';
const NOW = 1_700_000_000_000;

const CFG: Config = {
  libraryRoots: [],
  dataDir: '/tmp/liner-discover-tests',
  port: 4545,
  audioDevice: 'none',
  userAgent: 'liner-discover-tests',
  spotifyClientId: 'client-abc',
};

function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/discover/${name}`, import.meta.url), 'utf8'),
  ) as T;
}

function lbFake() {
  return fakeFetch((url) => {
    if (url.pathname.endsWith('/similar-artists/json')) {
      return jsonResponse(200, fixture('lb-similar-artists.json'));
    }
    if (url.pathname.endsWith('/similar-recordings/json')) {
      return jsonResponse(200, fixture('lb-similar-recordings.json'));
    }
    return jsonResponse(404, { error: 'not found' });
  });
}

function mbFake(now: () => number) {
  const fl = fakeFetch((url) => {
    if (url.pathname.startsWith('/ws/2/isrc/')) return jsonResponse(200, fixture('mb-isrc.json'));
    if (url.pathname.startsWith('/ws/2/recording')) {
      return jsonResponse(200, fixture('mb-recording-search.json'));
    }
    if (url.pathname.startsWith('/ws/2/artist')) return jsonResponse(200, fixture('mb-artist-search.json'));
    return jsonResponse(404, { error: 'not found' });
  });
  const client = new MbClient({
    userAgent: 'liner-discover-tests',
    fetch: fl.fetch as unknown as typeof globalThis.fetch,
    sleep: async () => undefined,
    rateLimitMs: 0,
    now,
  });
  return { client, calls: fl.calls };
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function spotifyTrack(id: string, title: string, artist: string, index = 0): SpotifyTrack {
  const albumId = `alb-${slug(artist)}-${index}`;
  return {
    id,
    name: title,
    artists: [{ id: `art-${slug(artist)}`, name: artist }],
    album: {
      id: albumId,
      name: `${title} Album`,
      artists: [{ id: `art-${slug(artist)}`, name: artist }],
      images: [{ url: `http://img.test/${albumId}.jpg`, width: 640, height: 640 }],
      release_date: '2020-01-01',
    },
    disc_number: 1,
    track_number: index + 1,
    duration_ms: 200_000,
    uri: `spotify:track:${id}`,
  };
}

function topTracks(name: string, count = 10): SpotifyTrack[] {
  return Array.from({ length: count }, (_, i) =>
    spotifyTrack(`top-${slug(name)}-${i}`, `${name} Song ${i}`, name, i),
  );
}

interface FakeSpotify {
  spotify: DiscoverSpotify;
  calls: ReturnType<typeof fakeFetch>['calls'];
  limit(): void;
}

function fakeSpotify(): FakeSpotify {
  const artistNames = new Map<string, string>();
  const state = { limited: false };
  const fl = fakeFetch((url) => {
    if (state.limited) {
      return jsonResponse(429, { error: 'rate limited' }, { 'Retry-After': '7200' });
    }
    if (url.pathname === '/v1/search') {
      const q = url.searchParams.get('q') ?? '';
      const type = url.searchParams.get('type') ?? '';
      const artistName = /artist:"([^"]+)"/.exec(q)?.[1];
      const trackName = /track:"([^"]+)"/.exec(q)?.[1];
      if (type === 'artist') {
        if (!artistName) return jsonResponse(200, { artists: paging([]) });
        const id = slug(artistName);
        artistNames.set(id, artistName);
        return jsonResponse(200, {
          artists: paging([{ id, name: artistName, images: [], uri: `spotify:artist:${id}` }]),
        });
      }
      if (type === 'track') {
        if (trackName) {
          // Deliberate wrong-artist result: verification must drop it.
          if (trackName === 'Dance Monkey') {
            return jsonResponse(200, {
              tracks: paging([spotifyTrack('cover-dance-monkey', trackName, 'Some Cover Band')]),
            });
          }
          const artist = artistName ?? 'Unknown';
          return jsonResponse(200, {
            tracks: paging([spotifyTrack(`rec-${slug(artist)}-${slug(trackName)}`, trackName, artist)]),
          });
        }
        if (artistName) return jsonResponse(200, { tracks: paging(topTracks(artistName)) });
      }
      return jsonResponse(200, {});
    }

    const top = /^\/v1\/artists\/([^/]+)\/top-tracks$/.exec(url.pathname);
    if (top) {
      const id = decodeURIComponent(top[1]!);
      const name = artistNames.get(id);
      if (!name) return jsonResponse(404, { error: 'unknown artist' });
      return jsonResponse(200, { tracks: topTracks(name) });
    }

    const single = /^\/v1\/tracks\/([^/]+)$/.exec(url.pathname);
    if (single) {
      return jsonResponse(200, {
        ...spotifyTrack(decodeURIComponent(single[1]!), 'Creep', 'Radiohead'),
        external_ids: { isrc: 'USUG11904206' },
      });
    }
    return jsonResponse(404, { error: 'not found' });
  });
  const api = new SpotifyApi({
    fetch: fl.fetch,
    getToken: async () => 'tok',
    baseUrl: 'http://api.test/v1',
    sleep: async () => undefined,
    maxRateLimitRetries: 0,
  });
  return {
    spotify: { api, auth: { status: () => ({ connected: true }) } },
    calls: fl.calls,
    limit: () => {
      state.limited = true;
    },
  };
}

// ---------------------------------------------------------------- DB seed

function seedDb(db: Db): void {
  ensureSpotifyLibrarySchema(db);
  ensureDiscoverSchema(db);
  const artist = db.prepare('INSERT INTO artists (id, name, mbid) VALUES (?, ?, ?)');
  artist.run('ar:rh', 'Radiohead', RADIOHEAD);
  artist.run('ar:weeknd', 'The Weeknd', WEEKND);
  artist.run('ar:daft', 'Daft Punk', DAFT);
  artist.run('ar:nirvana', 'Nirvana', null);

  const album = db.prepare(
    `INSERT INTO albums (id, source, title, artist_id, year, genres, format, added_at, in_library)
     VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?)`,
  );
  album.run('la:rh', 'local', 'OK Computer', 'ar:rh', 1997, 'FLAC', NOW, 1);
  album.run('la:weeknd', 'local', 'After Hours', 'ar:weeknd', 2020, 'FLAC', NOW - 1, 1);
  album.run('la:daft', 'local', 'Discovery', 'ar:daft', 2001, 'FLAC', NOW - 2, 1);
  album.run('la:nirvana', 'local', 'Nevermind', 'ar:nirvana', 1991, 'FLAC', NOW - 3, 1);
  album.run('sp:alb-saved', 'spotify', 'Saved Album', 'ar:nirvana', 2021, 'Spotify', NOW, 1);
  album.run('sp:alb-discover-only', 'spotify', 'Discover Only', 'ar:nirvana', 2022, 'Spotify', NOW, 0);

  const track = db.prepare(
    `INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms, path, mb_recording_id, spotify_uri)
     VALUES (?, ?, ?, ?, 1, ?, 200000, ?, ?, ?)`,
  );
  track.run('l:seed', 'la:rh', 'local', 'Creep', 1, '/music/creep.flac', BLINDING_LIGHTS, null);
  track.run('l:weeknd', 'la:weeknd', 'local', 'Blinding Lights', 2, '/music/blinding.flac', BLINDING_LIGHTS, null);
  track.run('l:daft', 'la:daft', 'local', 'One More Time', 3, '/music/one-more.flac', null, null);
  track.run('l:nirvana-owned', 'la:nirvana', 'local', 'Nirvana Song 1', 4, '/music/nirvana.flac', null, null);
  track.run('sp:saved', 'sp:alb-saved', 'spotify', 'Saved Song', 1, null, null, 'spotify:track:saved');
  track.run(
    'sp:discover-only',
    'sp:alb-discover-only',
    'spotify',
    'Discover Only Song',
    1,
    null,
    null,
    'spotify:track:discover-only',
  );

  const ta = db.prepare('INSERT INTO track_artists (track_id, artist_id, position) VALUES (?, ?, 0)');
  ta.run('l:seed', 'ar:rh');
  ta.run('l:weeknd', 'ar:weeknd');
  ta.run('l:daft', 'ar:daft');
  ta.run('l:nirvana-owned', 'ar:nirvana');
  ta.run('sp:saved', 'ar:nirvana');
  ta.run('sp:discover-only', 'ar:nirvana');

  const playlist = db.prepare(
    `INSERT INTO playlists (id, source, name, track_count, position, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  playlist.run('pl:sp:liked', 'spotify', 'Liked Songs', 3, 0, NOW);
  playlist.run('pl:rune:1', 'rune', 'Mix', 1, 0, NOW);
  const pt = db.prepare(
    'INSERT INTO playlist_tracks (playlist_id, position, track_id, added_at) VALUES (?, ?, ?, ?)',
  );
  pt.run('pl:sp:liked', 0, 'l:seed', NOW);
  pt.run('pl:sp:liked', 1, 'l:weeknd', NOW);
  pt.run('pl:sp:liked', 2, 'l:daft', NOW);
  pt.run('pl:rune:1', 0, 'sp:top-nirvana-0', NOW);
}

function service(db: Db, spotify: DiscoverSpotify | undefined, now = () => NOW) {
  const lb = lbFake();
  const mb = mbFake(now);
  const discover = createDiscover(db, CFG, spotify, {
    fetch: lb.fetch as unknown as typeof globalThis.fetch,
    mb: mb.client,
    now,
    sleep: async () => undefined,
    budget: { minIntervalMs: 0, hourlyLimit: 1000 },
    radioMappings: 12,
    ownedTtlMs: 0,
    backgroundRefresh: false,
    onWarn: () => undefined,
  });
  return { discover, lbCalls: lb.calls, mbCalls: mb.calls };
}

// ---------------------------------------------------------------- tests

describe('matching helpers', () => {
  it('accepts decorated titles but not different songs', () => {
    expect(titleMatches('Creep', 'Creep (Remastered)')).toBe(true);
    expect(titleMatches('Creep', 'Creepin’')).toBe(false);
    expect(titleMatches('Blinding Lights', 'Blinding Lights')).toBe(true);
  });

  it('accepts join credits but not longer artist names', () => {
    expect(artistMatches('Daft Punk, Pharrell Williams', ['Daft Punk', 'Pharrell Williams'])).toBe(true);
    expect(artistMatches('The Beatles', ['Beatles'])).toBe(true);
    expect(artistMatches('Nirvana', ['Nirvana UK'])).toBe(false);
    expect(artistMatches('Nirvana', ['Some Cover Band'])).toBe(false);
  });
});

describe('DiscoverBudget', () => {
  it('serialises requests and enforces the hourly cap', async () => {
    const db = openDb(':memory:');
    ensureDiscoverSchema(db);
    let now = 1_000_000;
    const sleeps: number[] = [];
    const budget = new SpotifyDiscoverBudget(db, {
      minIntervalMs: 1000,
      hourlyLimit: 2,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    await budget.take();
    await budget.take();
    expect(sleeps).toEqual([1000]);
    await expect(budget.take()).rejects.toMatchObject({ reason: 'budget' });
  });

  it('obeys both the global block and its own 429 block', async () => {
    const db = openDb(':memory:');
    ensureDiscoverSchema(db);
    let now = 2_000_000;
    db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?)').run(
      'spotify.blockedUntil',
      String(now + 5000),
    );
    const budget = new SpotifyDiscoverBudget(db, { now: () => now, sleep: async () => undefined });
    await expect(budget.take()).rejects.toBeInstanceOf(DiscoverBlockedError);
    db.prepare('DELETE FROM app_state WHERE key = ?').run('spotify.blockedUntil');

    const until = budget.block(120_000);
    expect(until).toBe(now + 120_000);
    expect(
      (db.prepare('SELECT value FROM app_state WHERE key = ?').get(DISCOVER_BLOCKED_KEY) as {
        value: string;
      }).value,
    ).toBe(String(until));
    await expect(budget.take()).rejects.toMatchObject({ until });
  });
});

describe('gateway trackInfo', () => {
  it('uses GET /tracks/{id} and caches hits and refusals', async () => {
    const db = openDb(':memory:');
    const fl = fakeFetch((url) => {
      if (url.pathname === '/v1/tracks/known') {
        return jsonResponse(200, {
          ...spotifyTrack('known', 'Known Song', 'Artist'),
          external_ids: { isrc: 'ISRC-1' },
        });
      }
      if (url.pathname === '/v1/tracks/refused') return jsonResponse(403, { error: 'forbidden' });
      if (url.pathname === '/v1/tracks/missing') return jsonResponse(404, { error: 'not found' });
      return jsonResponse(500, { error: 'unexpected' });
    });
    const api = new SpotifyApi({
      fetch: fl.fetch,
      getToken: async () => 'tok',
      baseUrl: 'http://api.test/v1',
      sleep: async () => undefined,
      maxRateLimitRetries: 0,
    });
    const budget = new SpotifyDiscoverBudget(db, {
      minIntervalMs: 0,
      hourlyLimit: 1000,
      now: () => NOW,
      sleep: async () => undefined,
    });
    const gateway = new SpotifyGateway(api, budget, new DiscoverCache(db, () => NOW));

    expect((await gateway.trackInfo('known'))?.external_ids?.isrc).toBe('ISRC-1');
    expect(await gateway.trackInfo('refused')).toBeUndefined();
    expect(await gateway.trackInfo('missing')).toBeUndefined();

    // Every one of them, including the 403/404 refusals, is cached: no repeat requests.
    expect((await gateway.trackInfo('known'))?.id).toBe('known');
    expect(await gateway.trackInfo('refused')).toBeUndefined();
    expect(await gateway.trackInfo('missing')).toBeUndefined();

    expect(fl.calls.map((c) => c.url.pathname)).toEqual([
      '/v1/tracks/known',
      '/v1/tracks/refused',
      '/v1/tracks/missing',
    ]);
    expect(fl.calls.some((c) => c.url.pathname === '/v1/tracks')).toBe(false);
  });
});

describe('ListenBrainz client', () => {
  it('parses, sorts and caches responses', async () => {
    const db = openDb(':memory:');
    const cache = new DiscoverCache(db, () => NOW);
    const lb = lbFake();
    const client = new ListenBrainz({
      userAgent: 'test',
      cache,
      fetch: lb.fetch as unknown as typeof globalThis.fetch,
      now: () => NOW,
    });
    const artists = await client.similarArtists(RADIOHEAD, 5);
    expect(artists).toHaveLength(5);
    expect(artists[0]?.name).toBe('Nirvana');
    const requestCount = lb.calls.length;
    await client.similarArtists(RADIOHEAD, 5);
    expect(lb.calls.length).toBe(requestCount);
    expect(artists.every((a, i) => i === 0 || (a.score ?? 0) <= (artists[i - 1]?.score ?? 0))).toBe(true);
  });

  it('returns [] for invalid MBIDs without a request', async () => {
    const db = openDb(':memory:');
    const lb = lbFake();
    const client = new ListenBrainz({
      userAgent: 'test',
      cache: new DiscoverCache(db),
      fetch: lb.fetch as unknown as typeof globalThis.fetch,
    });
    expect(await client.similarRecordings('not-an-mbid')).toEqual([]);
    expect(lb.calls).toHaveLength(0);
  });
});

describe('Last.fm fallback', () => {
  it('parses similar tracks/artists and caches successful responses', async () => {
    const db = openDb(':memory:');
    const cache = new DiscoverCache(db, () => NOW);
    const fl = fakeFetch((url) => {
      if (url.searchParams.get('method') === 'track.getsimilar') {
        return jsonResponse(200, {
          similartracks: {
            track: [
              { name: 'Creep', artist: { name: 'Radiohead' }, mbid: 'rec-1', match: 1 },
              { name: '', artist: { name: 'Nobody' }, match: 0.2 },
              { name: 'Karma Police', artist: { name: 'Radiohead' }, match: 0.8 },
            ],
          },
        });
      }
      return jsonResponse(200, {
        similarartists: {
          artist: [
            { name: 'Nirvana', mbid: 'art-1', match: 0.9 },
            { name: '', match: 0.1 },
            { name: 'Muse', match: 0.7 },
          ],
        },
      });
    });
    const lastfm = new LastFm('secret', {
      cache,
      fetch: fl.fetch as unknown as typeof globalThis.fetch,
      userAgent: 'liner-tests',
    });

    const tracks = await lastfm.similarTracks('Radiohead', 'Creep', 5);
    expect(tracks).toEqual([
      { title: 'Creep', artist: 'Radiohead', recordingMbid: 'rec-1', match: 1 },
      { title: 'Karma Police', artist: 'Radiohead', match: 0.8 },
    ]);
    expect(fl.calls[0]?.url.searchParams.get('api_key')).toBe('secret');
    expect(fl.calls[0]?.url.searchParams.get('format')).toBe('json');

    const artists = await lastfm.similarArtists('Radiohead', 5);
    expect(artists.map((a) => a.name)).toEqual(['Nirvana', 'Muse']);
    expect(artists[0]?.score).toBe(90);

    const calls = fl.calls.length;
    await lastfm.similarTracks('Radiohead', 'Creep', 5);
    await lastfm.similarArtists('Radiohead', 5);
    expect(fl.calls.length).toBe(calls); // both cached for a week
  });

  it('does nothing without an API key', async () => {
    const db = openDb(':memory:');
    const fl = fakeFetch(() => jsonResponse(200, {}));
    const lastfm = new LastFm(undefined, {
      cache: new DiscoverCache(db),
      fetch: fl.fetch as unknown as typeof globalThis.fetch,
    });
    expect(await lastfm.similarTracks('Radiohead', 'Creep')).toEqual([]);
    expect(await lastfm.similarArtists('Radiohead')).toEqual([]);
    expect(fl.calls).toHaveLength(0);
  });
});

describe('MusicBrainz helpers', () => {
  it('resolves ISRC → recording and verifies searches', async () => {
    const now = () => NOW;
    const mb = mbFake(now);
    const client = new DiscoverMb(mb.client);
    expect(await client.recordingByIsrc('US-UG1-19-04206')).toBe(BLINDING_LIGHTS);
    expect(await client.recordingByIsrc('nope')).toBeUndefined();

    const recordSearch = fixture<Parameters<typeof pickRecording>[0]>('mb-recording-search.json');
    const hit = pickRecording(recordSearch, 'Blinding Lights', 'The Weeknd');
    expect(hit).toBeTruthy();
    expect(pickRecording(recordSearch, 'Blinding Lights', 'A Completely Different Artist')).toBeUndefined();

    const artistSearch = fixture<Parameters<typeof pickArtist>[0]>('mb-artist-search.json');
    expect(pickArtist(artistSearch, 'Radiohead')).toBe(RADIOHEAD);
  });
});

describe('exclusions', () => {
  it('owns likes, playlists, saved albums and the local library — but not discover-only rows', () => {
    const db = openDb(':memory:');
    seedDb(db);
    const owned = loadOwned(db);
    expect(owned.spotifyIds.has('sp:saved')).toBe(true);
    expect(owned.spotifyIds.has('sp:top-nirvana-0')).toBe(true);
    expect(owned.spotifyIds.has('sp:discover-only')).toBe(false);
    expect(owned.recordingMbids.has(BLINDING_LIGHTS)).toBe(true);
    expect(owned.keys.has(`${'nirvana'}\u0000${'nirvana song 1'}`)).toBe(true);

    expect(isOwned(owned, { spotifyId: 'sp:saved', title: 'Saved Song', artists: ['Nirvana'] })).toBe(true);
    expect(
      isOwned(owned, {
        recordingMbid: BLINDING_LIGHTS,
        title: 'Something Else',
        artists: ['Nobody'],
      }),
    ).toBe(true);
    expect(
      isOwned(owned, { spotifyId: 'sp:some-other-id', title: 'Nirvana Song 1', artists: ['Nirvana'] }),
    ).toBe(true); // by normalized artist+title against the local library
    expect(
      isOwned(owned, { spotifyId: 'sp:fresh', title: 'Fresh Song', artists: ['Nirvana'] }),
    ).toBe(false);
  });
});

describe('song radio', () => {
  it('returns owned-free Spotify tracks with reasons and stores them', async () => {
    const db = openDb(':memory:');
    seedDb(db);
    const fake = fakeSpotify();
    const { discover } = service(db, fake.spotify);
    const res = await discover.similar('l:seed', { limit: 12 });

    expect(res.status).toBe('ok');
    expect(res.seed?.recordingMbid).toBe(BLINDING_LIGHTS);
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.cached).toBe(false);

    const idsOut = res.items.map((i) => i.track.id);
    expect(new Set(idsOut).size).toBe(idsOut.length);
    expect(idsOut).not.toContain('sp:top-nirvana-0'); // rune playlist
    expect(idsOut).not.toContain('sp:top-nirvana-1'); // local "Nirvana Song 1"
    expect(res.items.some((i) => i.track.title === 'Dance Monkey')).toBe(false); // wrong artist
    for (const item of res.items) {
      expect(item.track.id.startsWith('sp:')).toBe(true);
      expect(item.track.spotifyUri).toBe(`spotify:track:${item.spotifyTrackId}`);
      expect(item.album.id.startsWith('sp:')).toBe(true);
      expect(item.reason.length).toBeGreaterThan(3);
    }
    expect(res.items.some((i) => i.reason.includes('Similar to “Creep”'))).toBe(true);
    expect(res.items.some((i) => i.reason.includes('is similar to Radiohead'))).toBe(true);

    const stored = db.prepare('SELECT source, album_id FROM tracks WHERE id = ?').get(idsOut[0]!) as {
      source: string;
      album_id: string;
    };
    expect(stored.source).toBe('spotify');
    const album = db
      .prepare('SELECT in_library, cover_path FROM albums WHERE id = ?')
      .get(stored.album_id) as { in_library: number; cover_path: string | null };
    expect(album.in_library).toBe(0);
    expect(album.cover_path).toContain('http://img.test/');
  });

  it('serves a cached radio without touching Spotify, and filters dismissals', async () => {
    const db = openDb(':memory:');
    seedDb(db);
    const fake = fakeSpotify();
    const { discover } = service(db, fake.spotify);
    const first = await discover.similar('l:seed', { limit: 8 });
    const calls = fake.calls.length;
    const firstId = first.items[0]!.track.id;
    await discover.dismiss(firstId);

    const second = await discover.similar('l:seed', { limit: 8 });
    expect(second.cached).toBe(true);
    expect(fake.calls.length).toBe(calls);
    expect(second.items.map((i) => i.track.id)).not.toContain(firstId);
  });

  it('reports rate limiting and persists the discovery block', async () => {
    const db = openDb(':memory:');
    seedDb(db);
    const fake = fakeSpotify();
    fake.limit();
    const { discover } = service(db, fake.spotify);
    const res = await discover.similar('l:seed');

    expect(res.status).toBe('rate_limited');
    expect(res.blockedUntil).toBeGreaterThan(NOW);
    expect(res.message).toContain('rate-limiting');
    const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(DISCOVER_BLOCKED_KEY) as {
      value: string;
    };
    expect(Number(row.value)).toBe(res.blockedUntil);
  });

  it('resolves a Spotify-only seed via ISRC when it is not stored', async () => {
    const db = openDb(':memory:');
    seedDb(db);
    const fake = fakeSpotify();
    const { discover } = service(db, fake.spotify);
    const res = await discover.similar('sp:seed-spotify', { limit: 5 });
    expect(res.status).toBe('ok');
    expect(res.seed?.recordingMbid).toBe(BLINDING_LIGHTS);
  });

  it('falls back to Last.fm similar tracks when ListenBrainz has nothing', async () => {
    const db = openDb(':memory:');
    seedDb(db);
    const fake = fakeSpotify();
    const fl = fakeFetch((url) => {
      if (url.pathname.endsWith('/similar-artists/json') || url.pathname.endsWith('/similar-recordings/json')) {
        return jsonResponse(200, []);
      }
      if (url.pathname === '/2.0' || url.pathname === '/2.0/') {
        if (url.searchParams.get('method') === 'track.getsimilar') {
          return jsonResponse(200, {
            similartracks: { track: [{ name: 'LFM Only Song', artist: { name: 'LFM Artist' }, match: 1 }] },
          });
        }
        return jsonResponse(200, { similarartists: { artist: [] } });
      }
      return jsonResponse(404, { error: 'not found' });
    });
    const discover = createDiscover(db, { ...CFG, lastfmApiKey: 'key' }, fake.spotify, {
      fetch: fl.fetch as unknown as typeof globalThis.fetch,
      mb: mbFake(() => NOW).client,
      now: () => NOW,
      sleep: async () => undefined,
      budget: { minIntervalMs: 0, hourlyLimit: 1000 },
      radioMappings: 12,
      ownedTtlMs: 0,
      backgroundRefresh: false,
      onWarn: () => undefined,
    });
    const res = await discover.similar('l:seed', { limit: 5 });
    expect(res.status).toBe('ok');
    expect(
      res.items.some((i) => i.track.title === 'LFM Only Song' && i.reason.includes('Creep')),
    ).toBe(true);
    expect(fl.calls.some((c) => c.url.searchParams.get('method') === 'track.getsimilar')).toBe(true);
  });

  it('rejects unknown local ids with DiscoverNotFoundError', async () => {
    const db = openDb(':memory:');
    seedDb(db);
    const fake = fakeSpotify();
    const { discover } = service(db, fake.spotify);
    await expect(discover.similar('l:missing')).rejects.toMatchObject({ name: 'DiscoverNotFoundError' });
  });
});

describe('discover feed', () => {
  it('groups by seed artist, diversifies and excludes owned tracks', async () => {
    const db = openDb(':memory:');
    seedDb(db);
    const fake = fakeSpotify();
    const { discover } = service(db, fake.spotify);
    const res = await discover.feed({ limit: 15 });

    expect(res.status).toBe('ok');
    expect(res.groups.length).toBeGreaterThanOrEqual(2);
    for (const group of res.groups) {
      expect(group.title).toMatch(/^Because you listen to /);
      expect(group.items.length).toBeGreaterThan(0);
    }
    const items = res.groups.flatMap((g) => g.items);
    const idsOut = items.map((i) => i.track.id);
    expect(new Set(idsOut).size).toBe(idsOut.length);
    expect(idsOut).not.toContain('sp:top-nirvana-0');
    expect(items.some((i) => i.track.title === 'Nirvana Song 1')).toBe(false);

    const perArtist = new Map<string, number>();
    for (const item of items) {
      const key = item.track.artists[0]?.name ?? '';
      perArtist.set(key, (perArtist.get(key) ?? 0) + 1);
    }
    for (const count of perArtist.values()) expect(count).toBeLessThanOrEqual(2);

    const cachedCalls = fake.calls.length;
    const again = await discover.feed({ limit: 15 });
    expect(again.cached).toBe(true);
    expect(fake.calls.length).toBe(cachedCalls);
  });

  it('is unavailable without Spotify', async () => {
    const db = openDb(':memory:');
    seedDb(db);
    const { discover } = service(db, undefined);
    const res = await discover.feed();
    expect(res.status).toBe('unavailable');
    expect(res.message).toContain('not connected');
  });

  it('defers the background feed refresh when the Spotify daily budget is low', async () => {
    const db = openDb(':memory:');
    // A stale cached feed: a page load would normally trigger a background rebuild.
    const cache = new DiscoverCache(db, () => NOW);
    cache.set('feed:v2', { groups: [] });
    db.prepare('UPDATE discover_cache SET fetched_at = ? WHERE key = ?').run(
      NOW - 7 * 60 * 60_000,
      'feed:v2',
    );

    const fake = fakeSpotify();
    // The real API, but its rolling budget already reports 'low'.
    Object.assign(fake.spotify.api, { budgetLevel: () => 'low' });
    const infos: string[] = [];
    const discover = createDiscover(db, CFG, fake.spotify, {
      fetch: lbFake().fetch as unknown as typeof globalThis.fetch,
      mb: mbFake(() => NOW).client,
      now: () => NOW,
      sleep: async () => undefined,
      budget: { minIntervalMs: 0, hourlyLimit: 1000 },
      backgroundRefresh: true,
      onInfo: (m) => infos.push(m),
      onWarn: () => undefined,
    });

    const res = await discover.feed({ limit: 10 });
    expect(res.cached).toBe(true);
    expect(infos).toEqual(['spotify budget low: deferring discover feed refresh']);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('debug candidates (LB/MB only)', () => {
  it('lists raw candidates with reasons and makes no Spotify calls', async () => {
    const db = openDb(':memory:');
    seedDb(db);
    const fake = fakeSpotify();
    const { discover, lbCalls } = service(db, fake.spotify);
    const debug = await discover.debugCandidates('l:seed');
    expect(debug.seed.artistMbid).toBe(RADIOHEAD);
    expect(debug.candidates.some((c) => c.kind === 'recording' && c.reason.includes('Creep'))).toBe(true);
    expect(debug.candidates.some((c) => c.kind === 'artist' && c.reason.includes('Radiohead'))).toBe(true);
    expect(fake.calls).toHaveLength(0);
    expect(lbCalls.length).toBeGreaterThan(0);
  });
});
