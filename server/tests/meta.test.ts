import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import Fastify from 'fastify';
import type { AlbumDetails } from '@liner/shared';
import { openDb, type Db } from '../src/db/index.js';
import type { Config } from '../src/config.js';
import { CachedHttp } from '../src/meta/http.js';
import { createMeta, registerMetaRoutes, type MetaService } from '../src/meta/index.js';
import {
  fetchWikipedia,
  pickAlbumPage,
  wikipediaParseUrl,
  wikipediaSearchUrl,
  type WikiPage,
} from '../src/meta/wikipedia.js';
import { fetchMetacritic, metacriticSearchUrl, pickMetacriticItem, type McItem } from '../src/meta/metacritic.js';
import {
  fetchPitchfork,
  parsePitchforkReview,
  pickPitchforkLink,
  pickPitchforkReferenceUrl,
  reviewMatchesAlbum,
} from '../src/meta/pitchfork.js';
import { fetchAoty, parseAotyScore, pickAotyLink, aotySearchUrl } from '../src/meta/albumoftheyear.js';
import {
  fetchGenius,
  geniusAlbumUrl,
  geniusSearchUrl,
  parseGeniusAlbumPage,
  parseGeniusSongPage,
} from '../src/meta/genius.js';
import { namesMatch, titleSimilarity, truncateQuote } from '../src/meta/text.js';

const cfg: Config = {
  libraryRoots: [],
  dataDir: '/tmp/liner-meta-test',
  port: 0,
  audioDevice: 'null',
  userAgent: 'Liner/0.1 ( test )',
};

interface Fixture {
  url: string;
  status: number;
  contentType?: string;
  body: string;
  note?: string;
}

const fixtureDir = new URL('./fixtures/meta/', import.meta.url);

function loadFixtures(): Fixture[] {
  return readdirSync(fixtureDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(new URL(f, fixtureDir), 'utf8')) as Fixture);
}

const fixtures = loadFixtures();
const byName = new Map<string, Fixture>(
  readdirSync(fixtureDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f, JSON.parse(readFileSync(new URL(f, fixtureDir), 'utf8')) as Fixture]),
);

function fixtureNamed(slug: string, kind: string): Fixture {
  const f = byName.get(`${slug}--${kind}.json`);
  if (!f) throw new Error(`missing fixture ${slug}--${kind}.json`);
  return f;
}

function routesFrom(fixturesList: Fixture[]): Map<string, Fixture> {
  return new Map(fixturesList.map((f) => [f.url, f]));
}

function fakeFetch(routes: Map<string, Fixture>, calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const f = routes.get(url);
    if (!f) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response(f.body, { status: f.status, headers: { 'content-type': f.contentType ?? 'text/html' } });
  }) as unknown as typeof fetch;
}

function newDb(): Db {
  return openDb(':memory:');
}

function seedAlbum(
  db: Db,
  opts: { id: string; title: string; artist: string; year?: number; tracks?: string[] },
): void {
  const artistId = `ar:test:${opts.id}`;
  db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)').run(artistId, opts.artist);
  db.prepare(
    'INSERT INTO albums (id, source, title, artist_id, year, added_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(opts.id, 'local', opts.title, artistId, opts.year ?? null, 1_700_000_000_000);
  const stmt = db.prepare(
    'INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  (opts.tracks ?? []).forEach((title, i) => stmt.run(`l:${opts.id}:${i}`, opts.id, 'local', title, 1, i + 1, 240_000));
}

function namesFixtureAlbums(): { slug: string; title: string; artist: string; year: number }[] {
  return [
    { slug: 'discovery', title: 'Discovery', artist: 'Daft Punk', year: 2001 },
    { slug: 'jar-of-flies', title: 'Jar of Flies', artist: 'Alice In Chains', year: 1994 },
    { slug: 'still-bill', title: 'Still Bill', artist: 'Bill Withers', year: 1972 },
    { slug: 'uprising', title: 'Uprising', artist: 'Bob Marley & The Wailers', year: 1980 },
    { slug: 'fire-of-unknown-origin', title: 'Fire of Unknown Origin', artist: 'Blue Öyster Cult', year: 1981 },
  ];
}

describe('text helpers', () => {
  it('ignores release qualifiers when comparing titles', () => {
    expect(titleSimilarity('Discovery', 'Discovery (Deluxe Edition)')).toBe(1);
    expect(titleSimilarity('Uprising', 'Uprising (Bob Marley and the Wailers album)')).toBe(1);
    expect(titleSimilarity('Discovery', 'Homework')).toBeLessThan(0.5);
  });

  it('matches artist credit variations', () => {
    expect(namesMatch('Bob Marley & The Wailers', 'Bob Marley and the Wailers')).toBe(true);
    expect(namesMatch('Daft Punk', 'Daft Punk')).toBe(true);
    expect(namesMatch('Daft Punk', 'Alice In Chains')).toBe(false);
  });

  it('keeps pull quotes within 300 characters', () => {
    const long = 'This is a sentence about an album. '.repeat(30);
    const quote = truncateQuote(long, 300);
    expect(quote.length).toBeLessThanOrEqual(300);
    expect(quote.endsWith('…') || /[.!?]$/.test(quote)).toBe(true);
  });
});

describe('wikipedia', () => {
  it('selects the album page, not an artist page, for all fixture albums', () => {
    for (const album of namesFixtureAlbums()) {
      const search = JSON.parse(fixtureNamed(album.slug, 'wikipedia-search').body) as {
        query?: { pages?: Record<string, WikiPage> };
      };
      const pages = Object.values(search.query?.pages ?? {});
      const picked = pickAlbumPage(pages, { id: 'x', ...album });
      expect(picked?.title, album.slug).toBeTruthy();
      expect(titleSimilarity(album.title, picked?.title ?? ''), album.slug).toBeGreaterThanOrEqual(0.75);
    }
  });

  it('extracts reception, background, and scores for Discovery', async () => {
    const search = fixtureNamed('discovery', 'wikipedia-search');
    const parse = fixtureNamed('discovery', 'wikipedia-parse');
    const routes = routesFrom([search, parse]);
    const http = new CachedHttp(newDb(), cfg, { fetch: fakeFetch(routes), minIntervalMs: 0, sleep: async () => {} });
    const wiki = await fetchWikipedia(http, { id: 'la:discovery', title: 'Discovery', artist: 'Daft Punk', year: 2001 });

    expect(wiki?.pageTitle).toBe('Discovery (Daft Punk album)');
    expect(wiki?.reception?.value.length).toBeGreaterThan(200);
    expect(wiki?.reception?.value).toContain('Metacritic');
    expect(wiki?.reception?.source).toBe('Wikipedia');
    expect(wiki?.reception?.url).toContain('en.wikipedia.org/wiki/Discovery');
    expect(wiki?.background?.value.length).toBeGreaterThan(200);
    expect(wiki?.background?.value).toContain('Homework');
    expect(wiki?.scores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outlet: 'Metacritic', score: 74, scale: 100 }),
        expect.objectContaining({ outlet: 'Pitchfork', score: 6.4, scale: 10 }),
      ]),
    );
    expect(wiki?.referenceUrls.some((u) => u.includes('pitchfork.com/reviews/albums/2134-discovery'))).toBe(true);
  });

  it('finds reception on pages whose headings are not "Critical reception"', async () => {
    const expectations: Record<string, { background: boolean }> = {
      // "Release and reception" + "Background and recording"
      'jar-of-flies': { background: true },
      // "Reception"; the only "Production" section is a credits list, so there
      // is no background prose to extract.
      'still-bill': { background: false },
    };
    for (const [slug, expected] of Object.entries(expectations)) {
      const album = namesFixtureAlbums().find((a) => a.slug === slug)!;
      const routes = routesFrom([fixtureNamed(slug, 'wikipedia-search'), fixtureNamed(slug, 'wikipedia-parse')]);
      const http = new CachedHttp(newDb(), cfg, { fetch: fakeFetch(routes), minIntervalMs: 0, sleep: async () => {} });
      const wiki = await fetchWikipedia(http, { id: 'x', title: album.title, artist: album.artist, year: album.year });
      expect(wiki?.reception?.value.length, slug).toBeGreaterThan(100);
      expect(Boolean(wiki?.background?.value.length), slug).toBe(expected.background);
    }
  });

  it('returns null when the page cannot be found', async () => {
    const http = new CachedHttp(newDb(), cfg, {
      fetch: fakeFetch(new Map()),
      minIntervalMs: 0,
      sleep: async () => {},
    });
    const wiki = await fetchWikipedia(http, { id: 'x', title: 'Xqzzt Plorf', artist: 'Nobody Real' });
    expect(wiki).toBeNull();
  });
});

describe('metacritic', () => {
  it('picks the right album and score from the recorded search response', () => {
    const search = JSON.parse(fixtureNamed('discovery', 'metacritic-search').body) as { data: { items: McItem[] } };
    const item = pickMetacriticItem(search.data.items, { id: 'x', title: 'Discovery', artist: 'Daft Punk', year: 2001 });
    expect(item?.title).toBe('Discovery');
    expect(item?.criticScoreSummary?.score).toBe(74);
  });

  it('fetches Discovery through the cached client', async () => {
    const f = fixtureNamed('discovery', 'metacritic-search');
    const http = new CachedHttp(newDb(), cfg, {
      fetch: fakeFetch(routesFrom([f])),
      minIntervalMs: 0,
      sleep: async () => {},
    });
    const result = await fetchMetacritic(http, { id: 'x', title: 'Discovery', artist: 'Daft Punk', year: 2001 });
    expect(result.score).toEqual({
      outlet: 'Metacritic',
      score: 74,
      scale: 100,
      url: 'https://www.metacritic.com/music/discovery/daft-punk/critic-reviews/',
    });
  });

  it('does not match a gibberish album', () => {
    const search = JSON.parse(fixtureNamed('discovery', 'metacritic-search').body) as { data: { items: McItem[] } };
    expect(pickMetacriticItem(search.data.items, { id: 'x', title: 'Xqzzt Plorf', artist: 'Nobody Real' })).toBeNull();
  });

  it('does not invent scores for the other fixture albums', () => {
    for (const album of namesFixtureAlbums().filter((a) => a.slug !== 'discovery')) {
      const search = JSON.parse(fixtureNamed(album.slug, 'metacritic-search').body) as { data: { items: McItem[] } };
      expect(
        pickMetacriticItem(search.data.items, { id: 'x', title: album.title, artist: album.artist, year: album.year }),
        album.slug,
      ).toBeNull();
    }
  });

  it('builds the expected search URL', () => {
    expect(metacriticSearchUrl('Discovery Daft Punk')).toContain('mcoType=music');
  });
});

describe('pitchfork', () => {
  it('parses score, author, and a prose quote from the recorded review', () => {
    const f = fixtureNamed('discovery', 'pitchfork-review');
    const parsed = parsePitchforkReview(f.body, f.url);
    expect(parsed.score).toEqual({ outlet: 'Pitchfork', score: 6.4, scale: 10, url: f.url });
    expect(parsed.quote?.author).toBe('Ryan Schreiber');
    expect(parsed.quote?.quote.length).toBeLessThanOrEqual(300);
    expect(parsed.quote?.quote).toContain('brainwashing');
  });

  it('picks the album review link and rejects a mismatched review', () => {
    const search = fixtureNamed('discovery', 'pitchfork-search');
    expect(pickPitchforkLink(search.body, { id: 'x', title: 'Discovery', artist: 'Daft Punk' })).toBe(
      'https://pitchfork.com/reviews/albums/2134-discovery/',
    );
    const review = fixtureNamed('discovery', 'pitchfork-review');
    expect(reviewMatchesAlbum(review.body, { id: 'x', title: 'Discovery', artist: 'Daft Punk' })).toBe(true);
    expect(reviewMatchesAlbum(review.body, { id: 'x', title: 'Homework', artist: 'Daft Punk' })).toBe(false);
  });

  it('prefers the review URL cited by Wikipedia', () => {
    expect(
      pickPitchforkReferenceUrl(
        ['http://pitchfork.com/news/123-other/', 'http://pitchfork.com/reviews/albums/2134-discovery/'],
        'Discovery',
      ),
    ).toBe('https://pitchfork.com/reviews/albums/2134-discovery/');
  });

  it('fetches the review through the cached client', async () => {
    const f = fixtureNamed('discovery', 'pitchfork-review');
    const http = new CachedHttp(newDb(), cfg, {
      fetch: fakeFetch(routesFrom([f])),
      minIntervalMs: 0,
      sleep: async () => {},
    });
    const result = await fetchPitchfork(http, { id: 'x', title: 'Discovery', artist: 'Daft Punk' }, f.url);
    expect(result.score?.score).toBe(6.4);
    expect(result.quote).toBeTruthy();
  });
});

describe('album of the year', () => {
  const searchHtml = `<html><body>
    <a href="/album/1279-daft-punk-discovery.php">Discovery</a>
    <a href="/album/999-unrelated-record.php">Unrelated</a>
  </body></html>`;
  const albumHtml = `<html><body>
    <script type="application/ld+json">{"@type":"MusicAlbum","aggregateRating":{"ratingValue":"79","ratingCount":1234}}</script>
  </body></html>`;

  it('picks the right album link', () => {
    expect(pickAotyLink(searchHtml, { id: 'x', title: 'Discovery', artist: 'Daft Punk' })).toBe(
      'https://www.albumoftheyear.org/album/1279-daft-punk-discovery.php',
    );
    expect(pickAotyLink(searchHtml, { id: 'x', title: 'Xqzzt Plorf', artist: 'Nobody Real' })).toBeNull();
  });

  it('parses the score from JSON-LD and text', () => {
    expect(parseAotyScore(albumHtml)).toBe(79);
    expect(parseAotyScore('<html><body><div>User Score: 82 / 100</div></body></html>')).toBe(82);
  });

  it('degrades gracefully when blocked (403)', async () => {
    const http = new CachedHttp(newDb(), cfg, {
      fetch: (async () => new Response('blocked', { status: 403 })) as unknown as typeof fetch,
      minIntervalMs: 0,
      sleep: async () => {},
    });
    await expect(fetchAoty(http, { id: 'x', title: 'Discovery', artist: 'Daft Punk' })).resolves.toEqual({});
  });

  it('uses the documented search URL', () => {
    expect(aotySearchUrl({ id: 'x', title: 'Discovery', artist: 'Daft Punk' })).toContain('albumoftheyear.org/search');
  });
});

describe('genius', () => {
  const albumHtml = `<html><body>
    <div class="AlbumDescription__Content">
      <p>Discovery is the second studio album by the French electronic music duo Daft Punk, released in 2001.</p>
    </div>
    <span class="verified-artist-badge">Verified Artist</span>
    <a href="/Daft-punk-one-more-time-lyrics">One More Time</a>
    <a href="/Daft-punk-aerodynamic-lyrics">Aerodynamic</a>
  </body></html>`;
  const songHtml = `<html><body>
    <div class="SongDescription__Content">
      <p>Thomas Bangalter said the vocoder on this track was inspired by their love of late-1970s funk records.</p>
    </div>
    <span class="verified-artist-badge">Verified Artist</span>
  </body></html>`;
  const searchJson = {
    response: {
      sections: [
        {
          hits: [
            {
              result: {
                type: 'album',
                title: 'Discovery',
                artist_names: 'Daft Punk',
                url: 'https://genius.com/albums/Daft-Punk/Discovery',
              },
            },
          ],
        },
      ],
    },
  };

  it('parses album and song descriptions with verified flags', () => {
    const album = parseGeniusAlbumPage(albumHtml, 'https://genius.com/albums/Daft-punk/Discovery');
    expect(album.description).toContain('second studio album');
    expect(album.verified).toBe(true);
    expect(album.tracks.map((t) => t.title)).toEqual(['One More Time', 'Aerodynamic']);
    const song = parseGeniusSongPage(songHtml);
    expect(song.description).toContain('Thomas Bangalter');
    expect(song.verified).toBe(true);
  });

  it('maps song notes to track ids', async () => {
    const routes = new Map<string, Fixture>([
      [
        geniusSearchUrl({ id: 'x', title: 'Discovery', artist: 'Daft Punk' }),
        { url: geniusSearchUrl({ id: 'x', title: 'Discovery', artist: 'Daft Punk' }), status: 200, body: JSON.stringify(searchJson) },
      ],
      [
        geniusAlbumUrl({ id: 'x', title: 'Discovery', artist: 'Daft Punk' }),
        { url: geniusAlbumUrl({ id: 'x', title: 'Discovery', artist: 'Daft Punk' }), status: 200, body: albumHtml },
      ],
      [
        'https://genius.com/Daft-punk-one-more-time-lyrics',
        { url: 'https://genius.com/Daft-punk-one-more-time-lyrics', status: 200, body: songHtml },
      ],
    ]);
    const db = newDb();
    const http = new CachedHttp(db, cfg, { fetch: fakeFetch(routes), minIntervalMs: 0, sleep: async () => {} });
    const notes = await fetchGenius(
      http,
      { id: 'x', title: 'Discovery', artist: 'Daft Punk' },
      [
        { id: 'l:one-more-time', title: 'One More Time' },
        { id: 'l:aerodynamic', title: 'Aerodynamic' },
      ],
    );
    expect(notes.length).toBe(2);
    expect(notes[0]?.trackId).toBeUndefined();
    expect(notes[0]?.verifiedArtist).toBe(true);
    expect(notes[1]?.trackId).toBe('l:one-more-time');
    expect(notes[1]?.source).toBe('Genius');
  });

  it('returns [] when Genius is blocked', async () => {
    const db = newDb();
    const http = new CachedHttp(db, cfg, {
      fetch: (async () => new Response('blocked', { status: 403 })) as unknown as typeof fetch,
      minIntervalMs: 0,
      sleep: async () => {},
    });
    await expect(
      fetchGenius(http, { id: 'x', title: 'Discovery', artist: 'Daft Punk' }, [{ id: 'l:1', title: 'One More Time' }]),
    ).resolves.toEqual([]);
  });
});

describe('cached http', () => {
  it('caches successful responses and expires them by time', async () => {
    let clock = 1_000_000;
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const http = new CachedHttp(newDb(), cfg, {
      fetch: fetchImpl,
      now: () => clock,
      sleep: async () => {},
      minIntervalMs: 0,
      ttlMs: 1000,
    });
    const first = await http.getJson<{ ok: boolean }>('https://example.com/a');
    const second = await http.getJson<{ ok: boolean }>('https://example.com/a');
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(calls).toBe(1);
    clock += 1001;
    await http.getJson('https://example.com/a');
    expect(calls).toBe(2);
  });

  it('retries 429 with backoff and does not cache the error', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '1' } });
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    const http = new CachedHttp(newDb(), cfg, {
      fetch: fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      minIntervalMs: 0,
    });
    const res = await http.get('https://example.com/retry');
    expect(res?.status).toBe(200);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([1000]);
  });

  it('spaces requests to the same host', async () => {
    let clock = 5000;
    const sleeps: number[] = [];
    const fetchImpl = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
    const http = new CachedHttp(newDb(), cfg, {
      fetch: fetchImpl,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      minIntervalMs: 1000,
    });
    await http.get('https://example.com/one');
    await http.get('https://example.com/two');
    expect(sleeps).toEqual([1000]);
  });
});

describe('createMeta', () => {
  function discoveryRoutes(calls: string[] = []): { routes: Map<string, Fixture>; fetch: typeof fetch } {
    const routes = routesFrom(fixtures);
    return { routes, fetch: fakeFetch(routes, calls) };
  }

  it('builds and stores AlbumDetails, then serves it from the database', async () => {
    const db = newDb();
    seedAlbum(db, {
      id: 'la:discovery',
      title: 'Discovery',
      artist: 'Daft Punk',
      year: 2001,
      tracks: ['One More Time', 'Aerodynamic'],
    });
    const calls: string[] = [];
    const { fetch } = discoveryRoutes(calls);
    const meta = createMeta(db, cfg, { fetch, minIntervalMs: 0, sleep: async () => {} });

    const details = await meta.getDetails('la:discovery');
    expect(details).not.toBeNull();
    expect(details?.albumId).toBe('la:discovery');
    expect(details?.reception?.value.length).toBeGreaterThan(200);
    expect(details?.background?.value.length).toBeGreaterThan(200);
    expect(details?.scores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outlet: 'Metacritic', score: 74, scale: 100 }),
        expect.objectContaining({ outlet: 'Pitchfork', score: 6.4, scale: 10 }),
      ]),
    );
    expect(details?.quotes).toHaveLength(1);
    expect(details?.quotes[0]?.outlet).toBe('Pitchfork');
    expect(details?.artistNotes).toEqual([]); // Genius 403 fixture
    expect(details?.fetchedAt).toBeGreaterThan(0);

    const row = db.prepare('SELECT json FROM album_details WHERE album_id = ?').get('la:discovery') as
      | { json: string }
      | undefined;
    expect(row).toBeTruthy();
    expect(JSON.parse(row!.json).albumId).toBe('la:discovery');

    const callsAfterFirst = calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    const again = await meta.getDetails('la:discovery');
    expect(again?.fetchedAt).toBe(details?.fetchedAt);
    expect(calls.length).toBe(callsAfterFirst); // served from album_details
  });

  it('returns null for an unknown album and makes no requests', async () => {
    const calls: string[] = [];
    const { fetch } = discoveryRoutes(calls);
    const meta = createMeta(newDb(), cfg, { fetch, minIntervalMs: 0, sleep: async () => {} });
    expect(await meta.getDetails('la:nope')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('keeps Wikipedia data when individual sources fail', async () => {
    const db = newDb();
    seedAlbum(db, { id: 'la:still-bill', title: 'Still Bill', artist: 'Bill Withers', year: 1972 });
    const routes = routesFrom([
      fixtureNamed('still-bill', 'wikipedia-search'),
      fixtureNamed('still-bill', 'wikipedia-parse'),
    ]);
    const meta = createMeta(db, cfg, { fetch: fakeFetch(routes), minIntervalMs: 0, sleep: async () => {} });
    const details = await meta.getDetails('la:still-bill');
    expect(details?.reception?.value).toContain('positive reviews');
    expect(details?.scores).toEqual([]);
    expect(details?.quotes).toEqual([]);
    expect(details?.artistNotes).toEqual([]);
  });

  it('reuses the HTTP cache after invalidating album details', async () => {
    const db = newDb();
    seedAlbum(db, { id: 'la:discovery', title: 'Discovery', artist: 'Daft Punk', year: 2001 });
    const calls: string[] = [];
    const { fetch } = discoveryRoutes(calls);
    const meta = createMeta(db, cfg, { fetch, minIntervalMs: 0, sleep: async () => {} });
    await meta.getDetails('la:discovery');
    const firstCalls = [...calls];
    meta.invalidate('la:discovery');
    await meta.getDetails('la:discovery');

    const secondBatch = calls.slice(firstCalls.length);
    // 200 responses are served from http_cache; only the non-cached 403/404
    // (AOTY/Genius) requests are retried.
    expect(secondBatch.some((u) => u.includes('en.wikipedia.org'))).toBe(false);
    expect(secondBatch.some((u) => u.includes('backend.metacritic.com'))).toBe(false);
    expect(secondBatch.some((u) => u.includes('pitchfork.com/reviews'))).toBe(false);
  });
});

describe('GET /albums/:id/details', () => {
  it('returns AlbumDetails or 404', async () => {
    const details: AlbumDetails = {
      albumId: 'la:known',
      scores: [{ outlet: 'Metacritic', score: 84, scale: 100, url: 'https://www.metacritic.com/x' }],
      quotes: [],
      artistNotes: [],
      fetchedAt: 123,
    };
    const stub: MetaService = {
      getDetails: async (id) => (id === 'la:known' ? details : null),
      fetchDetails: async () => details,
      invalidate: () => {},
    };
    const app = Fastify();
    registerMetaRoutes(app, stub);
    const ok = await app.inject({ method: 'GET', url: '/albums/la:known/details' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ albumId: 'la:known', fetchedAt: 123 });
    const missing = await app.inject({ method: 'GET', url: '/albums/la:missing/details' });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
