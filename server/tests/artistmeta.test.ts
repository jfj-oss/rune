import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { Sourced } from '@liner/shared';
import { openDb, ids, type Db } from '../src/db/index.js';
import type { Config } from '../src/config.js';
import { MbClient } from '../src/match/mb.js';
import {
  artistMbid,
  artistTitleBase,
  commonsImageInfoUrl,
  createArtistMeta,
  ensureArtistMetaSchema,
  mbArtistUrlRelationsUrl,
  registerArtistMetaRoutes,
  sniffImageMime,
  stripWikiMarkup,
  wikidataSearchByMbIdUrl,
  wikipediaArtistSearchUrl,
  wikipediaArtistTitlesUrl,
  type ArtistInfo,
  type ArtistMeta,
} from '../src/meta/artist.js';

interface Fixture {
  url: string;
  status: number;
  contentType?: string;
  body?: string;
  bodyBase64?: string;
  note?: string;
}

const fixtureDir = new URL('./fixtures/artistmeta/', import.meta.url);

const fixtures: Fixture[] = readdirSync(fixtureDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(new URL(f, fixtureDir), 'utf8')) as Fixture);

const routes = new Map<string, Fixture>(fixtures.map((f) => [f.url, f]));

const cfg: Config = {
  libraryRoots: [],
  dataDir: '/tmp/liner-artistmeta-test', // replaced per harness
  port: 0,
  audioDevice: 'null',
  userAgent: 'Liner/0.1 ( test )',
};

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

interface Harness {
  db: Db;
  cfg: Config;
  meta: ArtistMeta;
  calls: string[];
  missing: string[];
  cleanup: () => void;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function makeHarness(extraFixtures: Fixture[] = []): Harness {
  const db = openDb(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'liner-artistmeta-'));
  const harnessCfg: Config = { ...cfg, dataDir };
  const calls: string[] = [];
  const missing: string[] = [];
  const localRoutes = new Map(routes);
  for (const fixture of extraFixtures) localRoutes.set(fixture.url, fixture);

  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = urlOf(input);
    calls.push(url);
    const fixture = localRoutes.get(url);
    if (!fixture) {
      missing.push(url);
      return new Response('fixture not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    const headers = { 'content-type': fixture.contentType ?? 'text/html' };
    if (fixture.bodyBase64) {
      return new Response(new Uint8Array(Buffer.from(fixture.bodyBase64, 'base64')), {
        status: fixture.status,
        headers,
      });
    }
    return new Response(fixture.body ?? '', { status: fixture.status, headers });
  }) as unknown as typeof fetch;

  const mb = new MbClient({
    userAgent: cfg.userAgent,
    db,
    fetch: fakeFetch,
    rateLimitMs: 0,
    sleep: async () => {},
  });
  const meta = createArtistMeta(db, harnessCfg, {
    fetch: fakeFetch,
    fetchBinary: fakeFetch,
    mbClient: mb,
    minIntervalMs: 0,
    sleep: async () => {},
    resizeImages: false,
  });

  const cleanup = (): void => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  cleanups.push(cleanup);
  return { db, cfg: harnessCfg, meta, calls, missing, cleanup };
}

function seedArtist(db: Db, opts: { id: string; name: string; mbid?: string }): void {
  db.prepare('INSERT INTO artists (id, name, mbid) VALUES (?, ?, ?)').run(
    opts.id,
    opts.name,
    opts.mbid ?? null,
  );
}

const MBID = {
  alice: '4bd95eea-b9f6-4d70-a36c-cfea77431553',
  daft: '056e4f3e-d505-4dad-8ec1-d04f521cbb56',
  bill: 'fd1a2d9d-9bb6-44de-83a3-41560658aba9',
  blue: 'c7423e0c-ab3e-4ab4-be10-cdff5a9d3062',
};

const CASES: { slug: string; name: string; mbid: string; bioStart: string }[] = [
  { slug: 'alice-in-chains', name: 'Alice in Chains', mbid: MBID.alice, bioStart: 'Alice in Chains (often abbreviated as AIC)' },
  { slug: 'daft-punk', name: 'Daft Punk', mbid: MBID.daft, bioStart: 'Daft Punk were a French electronic music duo' },
  { slug: 'bill-withers', name: 'Bill Withers', mbid: MBID.bill, bioStart: 'William Harrison Withers Jr.' },
  { slug: 'blue-oyster-cult', name: 'Blue Öyster Cult', mbid: MBID.blue, bioStart: 'Blue Öyster Cult' },
];

const WIKI_MARKUP = /\[\[|\]\]|\{\{|\}\}|<ref|<[a-z/][^>]*>|\{\||&amp;|&lt;|&gt;/i;

function expectCleanBio(bio: Sourced<string> | undefined): void {
  expect(bio).toBeDefined();
  if (!bio) return;
  expect(bio.source).toBe('Wikipedia');
  expect(bio.url).toMatch(/^https:\/\/en\.wikipedia\.org\/wiki\//);
  expect(bio.value.length).toBeGreaterThan(80);
  expect(bio.value.length).toBeLessThanOrEqual(1200);
  expect(bio.value).not.toMatch(WIKI_MARKUP);
}

describe('artist metadata (recorded fixtures, offline)', () => {
  for (const testCase of CASES) {
    it(`${testCase.name}: bio + Commons image + attribution`, async () => {
      const h = makeHarness();
      const artistId = ids.artistByMbid(testCase.mbid);
      seedArtist(h.db, { id: artistId, name: testCase.name, mbid: testCase.mbid });

      const info = await h.meta.getArtistInfo(artistId);
      expect(info).not.toBeNull();
      const result = info as ArtistInfo;

      expectCleanBio(result.bio);
      expect(result.bio?.value.startsWith(testCase.bioStart)).toBe(true);
      expect(h.missing).toEqual([]);

      expect(result.imagePath).toBeDefined();
      const imagePath = result.imagePath as string;
      expect(imagePath).toContain(join(h.cfg.dataDir, 'artists'));
      expect(imagePath.endsWith('.jpg')).toBe(true);
      expect(existsSync(imagePath)).toBe(true);
      expect(statSync(imagePath).size).toBeGreaterThan(10_000);
      expect(sniffImageMime(readFileSync(imagePath))).toBe('image/jpeg');

      expect(result.imageCredit).toBeDefined();
      expect(result.imageCredit?.url).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
      expect(result.imageCredit?.license?.length).toBeGreaterThan(0);
      expect(result.imageCredit?.author?.length).toBeGreaterThan(0);

      // The shared artists.image_path is filled so GET /artists/:id shows the picture.
      const artistRow = h.db.prepare('SELECT image_path FROM artists WHERE id = ?').get(artistId) as {
        image_path: string | null;
      };
      expect(artistRow.image_path).toBe(imagePath);
    });
  }

  it('caches results for 60 days and serves repeat requests without network', async () => {
    const h = makeHarness();
    const artistId = ids.artistByMbid(MBID.alice);
    seedArtist(h.db, { id: artistId, name: 'Alice in Chains', mbid: MBID.alice });

    const first = await h.meta.getArtistInfo(artistId);
    expect(first?.bio).toBeDefined();
    const callsAfterFirst = h.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await h.meta.getArtistInfo(artistId);
    expect(second?.bio?.value).toBe(first?.bio?.value);
    expect(h.calls.length).toBe(callsAfterFirst);

    const row = h.db.prepare('SELECT found, fetched_at FROM artist_info WHERE artist_id = ?').get(artistId) as {
      found: number;
      fetched_at: number;
    };
    expect(row.found).toBe(1);
    expect(Date.now() - row.fetched_at).toBeLessThan(60_000);
  });

  it('caches "nothing found" (obscure name) instead of re-searching', async () => {
    const h = makeHarness();
    const artistId = ids.artistByName('Xzzyq Fnord Trio');
    seedArtist(h.db, { id: artistId, name: 'Xzzyq Fnord Trio' });

    const info = await h.meta.getArtistInfo(artistId);
    expect(info).toEqual({});
    expect(h.missing).toEqual([]);
    expect(h.calls.length).toBeGreaterThan(0);

    const row = h.db.prepare('SELECT found, bio_json, image_path FROM artist_info WHERE artist_id = ?').get(artistId) as {
      found: number;
      bio_json: string | null;
      image_path: string | null;
    };
    expect(row).toEqual({ found: 0, bio_json: null, image_path: null });

    const calls = h.calls.length;
    expect(await h.meta.getArtistInfo(artistId)).toEqual({});
    expect(h.calls.length).toBe(calls);
  });

  it('falls back to Wikipedia for artists without an mbid and validates the page', async () => {
    const h = makeHarness();
    const artistId = ids.artistByName('Bill Withers');
    seedArtist(h.db, { id: artistId, name: 'Bill Withers' });

    const info = await h.meta.getArtistInfo(artistId);
    expect(info).not.toBeNull();
    expectCleanBio(info?.bio);
    expect(info?.bio?.value.startsWith('William Harrison Withers Jr.')).toBe(true);
    expect(info?.imagePath).toBeDefined();
    expect(existsSync(info?.imagePath as string)).toBe(true);
    expect(h.missing).toEqual([]);
  });

  it('returns null only for an unknown artist id', async () => {
    const h = makeHarness();
    expect(await h.meta.getArtistInfo('ar:n:does-not-exist')).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it('resolves an mbid embedded in an ar:<uuid> id when the column is empty', async () => {
    const h = makeHarness();
    const artistId = ids.artistByMbid(MBID.daft);
    seedArtist(h.db, { id: artistId, name: 'Daft Punk' });
    const info = await h.meta.getArtistInfo(artistId);
    expect(info?.bio?.value.startsWith('Daft Punk were a French')).toBe(true);
    expect(info?.imagePath).toBeDefined();
  });

  it('finds the QID via Wikidata P434 search when MusicBrainz has no wikidata relation', async () => {
    const fakeMbid = '11111111-2222-3333-4444-555555555555';
    const h = makeHarness([
      {
        url: mbArtistUrlRelationsUrl(fakeMbid),
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: fakeMbid, name: 'Alice in Chains', relations: [] }),
      },
      {
        url: wikidataSearchByMbIdUrl(fakeMbid),
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ query: { search: [{ title: 'Q484255' }] } }),
      },
    ]);
    const artistId = ids.artistByMbid(fakeMbid);
    seedArtist(h.db, { id: artistId, name: 'Alice in Chains', mbid: fakeMbid });

    const info = await h.meta.getArtistInfo(artistId);
    expect(info?.bio?.value.startsWith('Alice in Chains')).toBe(true);
    expect(info?.imagePath).toBeDefined();
    expect(h.calls).toContain(wikidataSearchByMbIdUrl(fakeMbid));
    expect(h.missing).toEqual([]);
  });

  it('supports refresh', async () => {
    const h = makeHarness();
    const artistId = ids.artistByMbid(MBID.blue);
    seedArtist(h.db, { id: artistId, name: 'Blue Öyster Cult', mbid: MBID.blue });
    const first = await h.meta.getArtistInfo(artistId);
    const storedAt = (
      h.db.prepare('SELECT fetched_at FROM artist_info WHERE artist_id = ?').get(artistId) as { fetched_at: number }
    ).fetched_at;
    const second = await h.meta.getArtistInfo(artistId, { refresh: true });
    const refreshedAt = (
      h.db.prepare('SELECT fetched_at FROM artist_info WHERE artist_id = ?').get(artistId) as { fetched_at: number }
    ).fetched_at;
    expect(second?.bio?.value).toBe(first?.bio?.value);
    expect(refreshedAt).toBeGreaterThanOrEqual(storedAt);
  });

  it('applies the migration idempotently', () => {
    const db = openDb(':memory:');
    cleanups.push(() => db.close());
    ensureArtistMetaSchema(db);
    ensureArtistMetaSchema(db);
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artist_info'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe('artist_info');
  });
});

describe('artist routes', () => {
  async function routeHarness(): Promise<{ h: Harness; app: ReturnType<typeof Fastify> }> {
    const h = makeHarness();
    const app = Fastify();
    registerArtistMetaRoutes(app, h.meta);
    cleanups.push(() => void app.close());
    return { h, app };
  }

  it('GET /artists/:id/info returns bio, image URL and credit', async () => {
    const { h, app } = await routeHarness();
    const artistId = ids.artistByMbid(MBID.alice);
    seedArtist(h.db, { id: artistId, name: 'Alice in Chains', mbid: MBID.alice });

    const res = await app.inject({ method: 'GET', url: `/artists/${encodeURIComponent(artistId)}/info` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      bio: Sourced<string>;
      imageUrl: string;
      imageCredit: { author?: string; license?: string; url: string };
    };
    expect(body.bio.source).toBe('Wikipedia');
    expect(body.bio.value.startsWith('Alice in Chains')).toBe(true);
    expect(body.imageUrl).toBe(`/api/artist-image/${encodeURIComponent(artistId)}`);
    expect(body.imageCredit.url).toContain('commons.wikimedia.org');
    expect(body).not.toHaveProperty('imagePath');
  });

  it('GET /artist-image/:id serves the cached JPEG', async () => {
    const { h, app } = await routeHarness();
    const artistId = ids.artistByMbid(MBID.daft);
    seedArtist(h.db, { id: artistId, name: 'Daft Punk', mbid: MBID.daft });

    const res = await app.inject({ method: 'GET', url: `/artist-image/${encodeURIComponent(artistId)}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(res.rawPayload.length).toBeGreaterThan(10_000);
  });

  it('404s for unknown artists and for artists with no image', async () => {
    const { h, app } = await routeHarness();
    seedArtist(h.db, { id: 'ar:n:obscure', name: 'Xzzyq Fnord Trio' });

    const unknown = await app.inject({ method: 'GET', url: `/artists/${encodeURIComponent('ar:n:nope')}/info` });
    expect(unknown.statusCode).toBe(404);

    const empty = await app.inject({ method: 'GET', url: `/artists/${encodeURIComponent('ar:n:obscure')}/info` });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({});

    const image = await app.inject({ method: 'GET', url: `/artist-image/${encodeURIComponent('ar:n:obscure')}` });
    expect(image.statusCode).toBe(404);
  });
});

describe('helpers', () => {
  it('strips references, templates, links and entities', () => {
    const input =
      '<span class="x">Alice</span> in Chains<ref name="a">{{cite web|url=x}}</ref> are a [[Rock music|rock]] band.[1] ' +
      'Known for &amp; hits &quot;No Excuses&quot;.';
    expect(stripWikiMarkup(input)).toBe('Alice in Chains are a rock band. Known for & hits "No Excuses".');
  });

  it('strips trailing disambiguators', () => {
    expect(artistTitleBase('Alice in Chains (band)')).toBe('Alice in Chains');
    expect(artistTitleBase('Blue Öyster Cult')).toBe('Blue Öyster Cult');
  });

  it('finds the mbid from the column or an ar:<uuid> id', () => {
    expect(artistMbid(`ar:${MBID.alice}`, null)).toBe(MBID.alice);
    expect(artistMbid('ar:n:1234', MBID.daft)).toBe(MBID.daft);
    expect(artistMbid('ar:n:1234', null)).toBeUndefined();
    expect(artistMbid('ar:not-a-uuid', null)).toBeUndefined();
  });

  it('sniffs image content types', () => {
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
  });

  it('builds deterministic source URLs', () => {
    const titlesUrl = new URL(wikipediaArtistTitlesUrl('Bill Withers'));
    expect(titlesUrl.searchParams.get('titles')).toBe(
      'Bill Withers (band)|Bill Withers (musician)|Bill Withers',
    );
    expect(wikipediaArtistSearchUrl('X Y')).toContain('generator=search');
    expect(commonsImageInfoUrl('File:A b.jpg', 600)).toContain('iiurlwidth=600');
  });

  it('never records a lyrics or Genius URL', () => {
    for (const fixture of fixtures) {
      expect(fixture.url).not.toMatch(/lyrics|genius\.com/i);
    }
  });
});
