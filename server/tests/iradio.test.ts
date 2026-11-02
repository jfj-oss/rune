import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import { openDb, type Db } from '../src/db/index.js';
import {
  createIradio,
  registerRadioStationRoutes,
  type Iradio,
} from '../src/iradio/index.js';
import { nowPlayingFromMetadata, parseIcyTitle } from '../src/iradio/nowplaying.js';
import { resetPlayedState } from '../src/iradio/playback.js';
import { getStation } from '../src/iradio/store.js';
import {
  parseM3u,
  parsePlaylist,
  parsePls,
  playlistKind,
  resolvePlaylistUrl,
} from '../src/iradio/stream.js';
import type { RadioBrowserStation } from '../src/iradio/types.js';
import { loadQueueItems, loadTrack, trackPath } from '../src/play/rows.js';
import {
  createFixtureFetch,
  imageFetch,
  loadFixture,
  PNG_BYTES,
  stationById,
  testConfig,
  type FixtureFetch,
} from './iradio-support.js';

const JAZZ = loadFixture<RadioBrowserStation[]>('search-jazz.json');
const BBC = loadFixture<RadioBrowserStation[]>('search-bbc.json');

interface Ctx {
  dir: string;
  db: Db;
  cfg: Config;
  fixtures: FixtureFetch;
  iradio: Iradio;
  app: FastifyInstance;
}

let ctx: Ctx | undefined;

async function setup(mediaFetch: typeof fetch = imageFetch()): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'liner-iradio-'));
  const db = openDb(':memory:');
  const cfg = testConfig(dir);
  const fixtures = createFixtureFetch();
  const iradio = createIradio(db, cfg, {
    baseUrl: 'https://radio.test',
    fetchImpl: fixtures.fetchImpl,
    mediaFetch,
    minRequestIntervalMs: 0,
  });
  const app = Fastify({ logger: false, forceCloseConnections: true });
  registerRadioStationRoutes(app, iradio);
  await app.ready();
  ctx = { dir, db, cfg, fixtures, iradio, app };
  return ctx;
}

afterEach(async () => {
  resetPlayedState();
  if (ctx) {
    await ctx.app.close();
    ctx.db.close();
    rmSync(ctx.dir, { recursive: true, force: true });
    ctx = undefined;
  }
});

describe('search', () => {
  it('maps jazz search results and calls radio-browser with a descriptive UA', async () => {
    const { iradio, fixtures } = await setup();
    const result = await iradio.search({ q: 'jazz' });

    expect(result.total).toBe(JAZZ.length);
    expect(result.items).toHaveLength(JAZZ.length);
    const first = result.items[0]!;
    const raw = JAZZ[0]!;
    expect(first.id).toBe(`rs:${raw.stationuuid}`);
    expect(first.stationuuid).toBe(raw.stationuuid);
    expect(first.name).toBe(raw.name);
    expect(first.urlResolved).toBe(raw.url_resolved);
    expect(first.tags).toContain('bebop');
    expect(first.countrycode).toBe('US');
    expect(first.bitrate).toBe(320);
    expect(first.votes).toBe(raw.votes);
    expect(first.favourite).toBe(false);
    expect(first.hls).toBe(false);

    const call = fixtures.calls.find((c) => c.url.pathname === '/json/stations/search');
    expect(call).toBeDefined();
    expect(call!.userAgent).toContain('Liner');
    expect(call!.userAgent).toContain('radio-browser');
    expect(call!.url.searchParams.get('name')).toBe('jazz');
    expect(call!.url.searchParams.get('hidebroken')).toBe('true');
    expect(call!.url.searchParams.get('order')).toBe('votes');
    expect(call!.url.searchParams.get('reverse')).toBe('true');
  });

  it('finds BBC stations and accepts tag/country/language/sort/limit filters', async () => {
    const { iradio, fixtures } = await setup();
    const bbc = await iradio.search({ q: 'BBC' });
    expect(bbc.items.map((s) => s.name)).toContain('BBC World Service');

    await iradio.search({
      q: 'jazz',
      tag: 'bebop',
      country: 'US',
      language: 'english',
      sort: 'clickcount',
      limit: 5,
    });
    const calls = fixtures.calls.filter((c) => c.url.pathname === '/json/stations/search');
    const params = calls[calls.length - 1]!.url.searchParams;
    expect(params.get('tag')).toBe('bebop');
    expect(params.get('countrycode')).toBe('US');
    expect(params.get('language')).toBe('english');
    expect(params.get('order')).toBe('clickcount');
    expect(params.get('limit')).toBe('5');
  });

  it('passes full country names through the country parameter', async () => {
    const { iradio, fixtures } = await setup();
    await iradio.search({ country: 'United Kingdom' });
    const calls = fixtures.calls.filter((c) => c.url.pathname === '/json/stations/search');
    const params = calls[calls.length - 1]!.url.searchParams;
    expect(params.get('country')).toBe('United Kingdom');
    expect(params.get('countrycode')).toBeNull();
  });

  it('caches repeated identical searches (radio-browser requests are expensive)', async () => {
    const { iradio, fixtures } = await setup();
    await iradio.search({ q: 'jazz' });
    const before = fixtures.calls.filter((c) => c.url.pathname === '/json/stations/search').length;
    await iradio.search({ q: 'jazz' });
    const after = fixtures.calls.filter((c) => c.url.pathname === '/json/stations/search').length;
    expect(after).toBe(before);
  });
});

describe('station resolution', () => {
  it('fetches an uncached station by uuid and stores it for playback', async () => {
    const { iradio, db, fixtures } = await setup();
    const raw = JAZZ[0]!;
    const id = `rs:${raw.stationuuid}`;
    expect(getStation(db, id)).toBeUndefined();

    const station = await iradio.station(id);
    expect(station?.id).toBe(id);
    expect(station?.name).toBe(raw.name);
    expect(
      fixtures.calls.some(
        (c) => c.url.pathname === `/json/stations/byuuid/${raw.stationuuid}`,
      ),
    ).toBe(true);
    expect(getStation(db, id)?.name).toBe(raw.name);
    // The bare uuid form is accepted too.
    expect((await iradio.station(raw.stationuuid))?.stationuuid).toBe(raw.stationuuid);
    // Resolving a station must not count a click.
    expect(fixtures.clickCalls).toHaveLength(0);
  });

  it('returns undefined for an unknown station', async () => {
    const { iradio } = await setup();
    expect(await iradio.station('rs:00000000-0000-0000-0000-000000000000')).toBeUndefined();
  });
});

describe('favourites', () => {
  it('adds, lists, serves the cached logo, and removes a favourite', async () => {
    const { app, iradio, fixtures } = await setup();
    const raw = JAZZ[0]!;
    const id = `rs:${raw.stationuuid}`;
    await iradio.station(id);

    const post = await app.inject({
      method: 'POST',
      url: '/radio/favourites',
      payload: { id },
    });
    expect(post.statusCode).toBe(200);
    const station = post.json() as { favourite: boolean; logoUrl?: string };
    expect(station.favourite).toBe(true);
    expect(station.logoUrl).toBe(`/api/radio/${encodeURIComponent(id)}/logo`);

    // The favicon was downloaded into <dataDir>/radio-logos.
    const files = readdirSync(join(ctx!.dir, 'radio-logos'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.png$/);

    const list = await app.inject('/radio/favourites');
    expect(list.statusCode).toBe(200);
    expect((list.json() as { id: string }[]).map((s) => s.id)).toEqual([id]);

    const logo = await app.inject(`/radio/${id}/logo`);
    expect(logo.statusCode).toBe(200);
    expect(logo.headers['content-type']).toBe('image/png');
    expect(logo.rawPayload.equals(PNG_BYTES)).toBe(true);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/radio/favourites?id=${encodeURIComponent(id)}`,
    });
    expect(remove.statusCode).toBe(200);
    expect(remove.json()).toEqual({ removed: true });
    expect((await app.inject('/radio/favourites')).json()).toEqual([]);
    // Un-favouriting keeps the cached station row.
    expect(iradio.favourites()).toEqual([]);
    expect(getStation(ctx!.db, id)).toBeDefined();
    expect(fixtures.clickCalls).toHaveLength(0);
  });

  it('accepts a full station snapshot without another API call', async () => {
    const { app, fixtures } = await setup();
    const uuid = '11111111-2222-3333-4444-555555555555';
    const post = await app.inject({
      method: 'POST',
      url: '/radio/favourites',
      payload: {
        station: {
          stationuuid: uuid,
          name: 'Snapshot FM',
          url: 'http://example.test/stream',
          favicon: 'http://example.test/logo.png',
          tags: 'ambient,chill',
          country: 'Testland',
        },
      },
    });
    expect(post.statusCode).toBe(200);
    const station = post.json() as { id: string; name: string; tags: string[]; favourite: boolean };
    expect(station).toMatchObject({
      id: `rs:${uuid}`,
      name: 'Snapshot FM',
      tags: ['ambient', 'chill'],
      favourite: true,
    });
    expect(
      fixtures.calls.some((c) => c.url.pathname.startsWith('/json/stations/byuuid/')),
    ).toBe(false);
  });

  it('404s for unknown stations and a missing id', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'POST', url: '/radio/favourites', payload: {} })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/radio/favourites',
          payload: { id: 'rs:00000000-0000-0000-0000-000000000000' },
        })
      ).statusCode,
    ).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/radio/favourites' })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'DELETE', url: '/radio/favourites?id=rs:missing' })).statusCode,
    ).toBe(404);
  });
});

describe('routes', () => {
  it('GET /radio/stations forwards filters', async () => {
    const { app, fixtures } = await setup();
    const res = await app.inject('/radio/stations?q=jazz&limit=3&sort=clickcount&tag=bebop');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[]; total: number };
    expect(body.items).toHaveLength(JAZZ.length);
    expect(body.total).toBe(JAZZ.length);
    const calls = fixtures.calls.filter((c) => c.url.pathname === '/json/stations/search');
    const params = calls[calls.length - 1]!.url.searchParams;
    expect(params.get('limit')).toBe('3');
    expect(params.get('order')).toBe('clickcount');
    expect(params.get('tag')).toBe('bebop');
  });

  it('ignores an unknown sort and falls back to votes', async () => {
    const { app, fixtures } = await setup();
    await app.inject('/radio/stations?q=jazz&sort=bogus');
    const calls = fixtures.calls.filter((c) => c.url.pathname === '/json/stations/search');
    expect(calls[calls.length - 1]!.url.searchParams.get('order')).toBe('votes');
  });

  it('GET /radio/:id resolves and 404s unknown stations', async () => {
    const { app } = await setup();
    const raw = JAZZ[1]!;
    const ok = await app.inject(`/radio/rs:${raw.stationuuid}`);
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { name: string }).name).toBe(raw.name);
    expect((await app.inject('/radio/rs:nope')).statusCode).toBe(404);
    expect((await app.inject('/radio/rs:nope/stream')).statusCode).toBe(404);
    expect((await app.inject({ method: 'HEAD', url: '/radio/rs:nope/stream' })).statusCode).toBe(404);
  });

  it('HEAD /radio/:id/stream reports an unseekable live stream', async () => {
    const { app, iradio } = await setup();
    const id = `rs:${JAZZ[0]!.stationuuid}`;
    await iradio.station(id);
    const res = await app.inject({ method: 'HEAD', url: `/radio/${id}/stream` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['accept-ranges']).toBe('none');
    expect(res.rawPayload.length).toBe(0);
  });

  it('502s when radio-browser is unreachable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'liner-iradio-'));
    const db = openDb(':memory:');
    const cfg = testConfig(dir);
    const iradio = createIradio(db, cfg, {
      baseUrl: 'https://radio.test',
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as typeof fetch,
      minRequestIntervalMs: 0,
    });
    const app = Fastify({ logger: false, forceCloseConnections: true });
    registerRadioStationRoutes(app, iradio);
    await app.ready();
    try {
      const res = await app.inject('/radio/stations?q=jazz');
      expect(res.statusCode).toBe(502);
      expect((res.json() as { error: string }).error).toContain('offline');
    } finally {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('queue integration', () => {
  it('loads a radio station as a live QueueItem', async () => {
    const { iradio, db } = await setup();
    const raw = JAZZ[0]!;
    const id = `rs:${raw.stationuuid}`;
    await iradio.station(id);

    const items = loadQueueItems(db, [id]);
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect((item.track as { source: string }).source).toBe('radio');
    expect(item.track.id).toBe(id);
    expect(item.track.durationMs).toBe(0);
    expect(item.track.title).toBe(raw.name);
    expect((item.track as { bitrateKbps?: number }).bitrateKbps).toBe(320);
    expect(trackPath(item.track)).toBe(raw.url_resolved);
    expect(item.album.title).toBe(raw.name);
    expect(item.album.coverUrl).toBe(`/api/radio/${encodeURIComponent(id)}/logo`);
    expect(loadTrack(db, id)?.title).toBe(raw.name);
  });

  it('keeps requested order when mixing radio and local ids', async () => {
    const { iradio, db } = await setup();
    db.prepare("INSERT INTO artists (id, name) VALUES ('ar:x', 'X')").run();
    db.prepare(
      "INSERT INTO albums (id, source, title, artist_id, added_at) VALUES ('la:x', 'local', 'Album', 'ar:x', 0)",
    ).run();
    db.prepare(
      `INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms, path)
       VALUES ('l:x', 'la:x', 'local', 'Local', 1, 1, 1000, '/tmp/x.flac')`,
    ).run();
    const raw = JAZZ[2]!;
    const radioId = `rs:${raw.stationuuid}`;
    await iradio.station(radioId);

    const items = loadQueueItems(db, ['l:x', radioId]);
    expect(items.map((i) => i.track.id)).toEqual(['l:x', radioId]);
  });
});

describe('click counting', () => {
  it('counts a play once (deduped) and never on search/resolve', async () => {
    const { iradio, fixtures } = await setup();
    const raw = JAZZ[0]!;
    const id = `rs:${raw.stationuuid}`;
    await iradio.search({ q: 'jazz' });
    await iradio.station(id);
    expect(fixtures.clickCalls).toHaveLength(0);

    await iradio.markPlayed(id);
    await iradio.markPlayed(id); // PC-zone respawn within the dedupe window
    expect(fixtures.clickCalls).toEqual([raw.stationuuid]);

    await iradio.markPlayed('rs:unknown'); // unknown stations are ignored
    expect(fixtures.clickCalls).toEqual([raw.stationuuid]);
  });
});

describe('ICY now-playing parsing', () => {
  it('parses Artist - Title and Title by Artist', () => {
    expect(parseIcyTitle('Portishead - Roads')).toEqual({ artist: 'Portishead', title: 'Roads' });
    expect(parseIcyTitle('Sinnerman by Nina Simone')).toEqual({
      title: 'Sinnerman',
      artist: 'Nina Simone',
    });
    expect(parseIcyTitle('Just A Title')).toEqual({ title: 'Just A Title' });
  });

  it('strips the station branding suffix', () => {
    expect(
      parseIcyTitle(
        'Over the Rainbow by Pasquale Grasso - Adroit Jazz Underground on walmradio.com',
        'Adroit Jazz Underground',
      ),
    ).toEqual({ title: 'Over the Rainbow', artist: 'Pasquale Grasso' });
  });

  it('builds PlayerState.nowPlaying from mpv metadata with fallbacks', () => {
    expect(
      nowPlayingFromMetadata(
        { 'icy-name': 'Adroit Jazz', 'icy-title': 'Portishead - Roads' },
        undefined,
        'Station',
      ),
    ).toEqual({ station: 'Adroit Jazz', artist: 'Portishead', title: 'Roads' });

    expect(
      nowPlayingFromMetadata({}, 'Bill Evans - Waltz for Debby', 'WQXR'),
    ).toEqual({ station: 'WQXR', artist: 'Bill Evans', title: 'Waltz for Debby' });

    // Nothing but a station name is not "now playing" yet.
    expect(nowPlayingFromMetadata(undefined, 'WQXR', 'WQXR')).toBeUndefined();
    expect(nowPlayingFromMetadata(undefined, undefined, 'WQXR')).toBeUndefined();
  });

  it('ignores mpv placeholder titles derived from the stream URL', () => {
    expect(
      nowPlayingFromMetadata(
        { 'icy-name': 'Adroit Jazz Underground' },
        'jazz',
        'Adroit Jazz Underground',
        'https://icecast.example:8443/jazz',
      ),
    ).toBeUndefined();
    expect(
      nowPlayingFromMetadata(
        { 'icy-name': 'Adroit Jazz Underground', 'icy-title': 'Frank Mantooth - You Do' },
        'jazz',
        'Adroit Jazz Underground',
        'https://icecast.example:8443/jazz',
      ),
    ).toEqual({
      station: 'Adroit Jazz Underground',
      artist: 'Frank Mantooth',
      title: 'You Do',
    });
  });
});

describe('playlist resolution', () => {
  it('detects only .pls/.m3u (HLS .m3u8 is left alone)', () => {
    expect(playlistKind('http://host/listen.pls?token=1')).toBe('pls');
    expect(playlistKind('http://host/listen.M3U')).toBe('m3u');
    expect(playlistKind('http://host/live.m3u8')).toBeUndefined();
    expect(playlistKind('http://host/stream')).toBeUndefined();
  });

  it('parses PLS and M3U bodies', () => {
    expect(parsePls('[playlist]\nFile2=http://b/stream\nFile1="http://a/stream"\n')).toBe(
      'http://a/stream',
    );
    expect(parseM3u('#EXTM3U\n#EXTINF:-1,Radio\n  http://a/stream  \n')).toBe('http://a/stream');
    expect(parseM3u('#EXTM3U\n# nothing\n')).toBeUndefined();
  });

  it('resolves relative playlist entries and sniffs extensionless playlists', () => {
    expect(parsePlaylist('File1=/stream', 'http://host/listen.pls')).toBe('http://host/stream');
    expect(parsePlaylist('[playlist]\nFile1=/stream', 'http://host/noext')).toBe(
      'http://host/stream',
    );
    expect(parsePlaylist('#!/usr/bin/mpv\n/stream', 'http://host/noext')).toBe('http://host/stream');
  });

  it('follows playlist → playlist chains', async () => {
    const seen: string[] = [];
    const mediaFetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.push(url);
      if (url.endsWith('/a.pls')) {
        return new Response('File1=/b.m3u', { headers: { 'content-type': 'audio/x-scpls' } });
      }
      if (url.endsWith('/b.m3u')) return new Response('/stream\n');
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
    const resolved = await resolvePlaylistUrl('http://host/a.pls', {
      userAgent: 'test',
      fetchImpl: mediaFetch,
    });
    expect(resolved).toBe('http://host/stream');
    expect(seen).toEqual(['http://host/a.pls', 'http://host/b.m3u']);
  });

  it('does not fetch non-playlist URLs', async () => {
    let fetched = 0;
    const mediaFetch = (async () => {
      fetched += 1;
      return new Response('x');
    }) as typeof fetch;
    expect(
      await resolvePlaylistUrl('http://host/live.mp3', {
        userAgent: 'test',
        fetchImpl: mediaFetch,
      }),
    ).toBe('http://host/live.mp3');
    expect(fetched).toBe(0);
  });
});

describe('fixtures', () => {
  it('recorded jazz and BBC stations resolve by uuid', async () => {
    const { iradio } = await setup();
    for (const id of [JAZZ[0]!.stationuuid, JAZZ[1]!.stationuuid, BBC[0]!.stationuuid]) {
      const station = await iradio.station(`rs:${id}`);
      expect(station?.stationuuid).toBe(id);
    }
    expect(stationById(JAZZ, `rs:${JAZZ[0]!.stationuuid}`).name).toBe(JAZZ[0]!.name);
  });
});
