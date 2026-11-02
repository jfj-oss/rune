import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import * as cheerio from 'cheerio';
import Fastify from 'fastify';
import type { AlbumDetails, CriticScore } from '@liner/shared';
import { openDb, type Db } from '../src/db/index.js';
import type { Config } from '../src/config.js';
import { CachedHttp } from '../src/meta/http.js';
import { createMeta, registerMetaRoutes, type MetaService } from '../src/meta/index.js';
import {
  candidateTitles,
  fetchWikipedia,
  findAlbumPage,
  pickAlbumPage,
  pickBackgroundSection,
  pickReceptionSection,
  wikipediaParseUrl,
  wikipediaSearchUrl,
  wikipediaTitlesUrl,
  type Section,
  type WikiPage,
} from '../src/meta/wikipedia.js';
import {
  pageTitleFromRelations,
  releaseGroupUrlRelationsUrl,
  releaseGroupWikipediaTitle,
  wikidataIdFromUrl,
  wikidataSitelinksUrl,
  wikipediaTitleFromUrl,
} from '../src/meta/musicbrainz.js';
import { MbClient } from '../src/match/mb.js';
import { canonicalOutlet, parseRatingValue, parseRatings } from '../src/meta/ratings.js';
import { extractQuotes, splitSentences } from '../src/meta/quotes.js';
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
  geniusSongUrl,
  pickGeniusSong,
  songNoteVerified,
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

const allRoutes = routesFrom(fixtures);

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

function fakeFetch(routes: Map<string, Fixture>, calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = urlOf(input);
    calls.push(url);
    const f = routes.get(url);
    if (!f) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response(f.body, { status: f.status, headers: { 'content-type': f.contentType ?? 'text/html' } });
  }) as unknown as typeof fetch;
}

interface Harness {
  db: Db;
  http: CachedHttp;
  mb: MbClient;
  calls: string[];
}

function setup(routes: Map<string, Fixture>, calls: string[] = []): Harness {
  const db = openDb(':memory:');
  const fetchImpl = fakeFetch(routes, calls);
  const http = new CachedHttp(db, cfg, { fetch: fetchImpl, minIntervalMs: 0, sleep: async () => {} });
  const mb = new MbClient({ userAgent: cfg.userAgent, db, fetch: fetchImpl, rateLimitMs: 0, sleep: async () => {} });
  return { db, http, mb, calls };
}

function newDb(): Db {
  return openDb(':memory:');
}

function seedAlbum(
  db: Db,
  opts: {
    id: string;
    title: string;
    artist: string;
    year?: number;
    mbReleaseGroupId?: string;
    tracks?: string[];
  },
): void {
  const artistId = `ar:test:${opts.id}`;
  db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)').run(artistId, opts.artist);
  db.prepare(
    `INSERT INTO albums (id, source, title, artist_id, year, mb_release_group_id, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    'local',
    opts.title,
    artistId,
    opts.year ?? null,
    opts.mbReleaseGroupId ?? null,
    1_700_000_000_000,
  );
  const stmt = db.prepare(
    'INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  (opts.tracks ?? []).forEach((title, i) => stmt.run(`l:${opts.id}:${i}`, opts.id, 'local', title, 1, i + 1, 240_000));
}

interface FixtureAlbum {
  slug: string;
  title: string;
  artist: string;
  year: number;
  releaseGroupId: string;
  pageTitle: string;
  tracks: string[];
}

const fixtureAlbums: FixtureAlbum[] = [
  {
    slug: 'discovery',
    title: 'Discovery',
    artist: 'Daft Punk',
    year: 2001,
    releaseGroupId: '48117b90-a16e-34ca-a514-19c702df1158',
    pageTitle: 'Discovery (Daft Punk album)',
    tracks: ['One More Time', 'Aerodynamic'],
  },
  {
    slug: 'jar-of-flies',
    title: 'Jar of Flies',
    artist: 'Alice In Chains',
    year: 1994,
    releaseGroupId: '3b6b7688-c97b-3d11-9334-3158468074f7',
    pageTitle: 'Jar of Flies',
    tracks: ['Rotten Apple', 'Nutshell', 'I Stay Away', 'No Excuses', 'Whale & Wasp', "Don't Follow", 'Swing on This'],
  },
  {
    slug: 'still-bill',
    title: 'Still Bill',
    artist: 'Bill Withers',
    year: 1972,
    releaseGroupId: '63544e97-de86-3096-8702-250590ae5f90',
    pageTitle: 'Still Bill',
    tracks: [
      'Lonely Town, Lonely Street',
      'Let Me in Your Life',
      'Who Is He (And What Is He to You)?',
      'Use Me',
      'Lean on Me',
      'Kissing My Love',
      'Another Day to Run',
      "I Don't Want You on My Mind",
      'Take It All in Stride',
      'Let It Be',
    ],
  },
  {
    slug: 'uprising',
    title: 'Uprising',
    artist: 'Bob Marley & The Wailers',
    year: 1980,
    releaseGroupId: '6dd29c00-7539-319d-98e0-b2f07e861497',
    pageTitle: 'Uprising (Bob Marley and the Wailers album)',
    tracks: ['Coming in from the Cold', 'Redemption Song'],
  },
  {
    slug: 'fire-of-unknown-origin',
    title: 'Fire of Unknown Origin',
    artist: 'Blue Öyster Cult',
    year: 1981,
    releaseGroupId: 'cf3efe8c-3963-30c2-a9ba-a1b1117a5b1a',
    pageTitle: 'Fire of Unknown Origin',
    tracks: ['Fire of Unknown Origin', "Burnin' for You", 'Joan Crawford'],
  },
];

function wikiAlbum(album: FixtureAlbum): { id: string; title: string; artist: string; year: number } {
  return { id: `la:${album.slug}`, title: album.title, artist: album.artist, year: album.year };
}

function scoreFor(scores: CriticScore[], outlet: string): CriticScore | undefined {
  return scores.find((s) => s.outlet === outlet);
}

/** Values shown in the UI must be plain text. */
const WIKI_MARKUP = /\{\{|\[\[|<ref\b|&nbsp;|'''/;

function expectClean(value: string): void {
  expect(value).not.toMatch(WIKI_MARKUP);
}

function parseFixtureScores(slug: string): CriticScore[] {
  const f = fixtureNamed(slug, 'wikipedia-parse');
  const parsed = JSON.parse(f.body) as { parse: { title: string; text: { '*': string } } };
  const $ = cheerio.load(parsed.parse.text['*']);
  return parseRatings($, { id: 'x', title: slug, artist: 'x' }, parsed.parse.title);
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

  it('splits prose into sentences', () => {
    expect(splitSentences('One. Two! Three?')).toEqual(['One.', 'Two!', 'Three?']);
  });
});

describe('ratings parsing', () => {
  it('parses every rendered score shape', () => {
    expect(parseRatingValue('4.5/5')).toEqual({ score: 4.5, scale: 5 });
    expect(parseRatingValue('8.1/10')).toEqual({ score: 8.1, scale: 10 });
    expect(parseRatingValue('74/100')).toEqual({ score: 74, scale: 100 });
    expect(parseRatingValue('3/4')).toEqual({ score: 3, scale: 4 });
    expect(parseRatingValue('4.5 out of 5 stars')).toEqual({ score: 4.5, scale: 5 });
    expect(parseRatingValue('89%')).toEqual({ score: 89, scale: 100 });
    // A− uses U+2212 MINUS SIGN in Wikipedia's rendered output.
    expect(parseRatingValue('A−')).toEqual({ score: 4.5, scale: 5 });
    expect(parseRatingValue('A-')).toEqual({ score: 4.5, scale: 5 });
    expect(parseRatingValue('B+')).toEqual({ score: 4.25, scale: 5 });
    expect(parseRatingValue('★★★★½')).toEqual({ score: 4.5, scale: 5 });
    expect(parseRatingValue('4/5')).toEqual({ score: 4, scale: 5 });
    // Bare number with a known outlet scale.
    expect(parseRatingValue('74', 100)).toEqual({ score: 74, scale: 100 });
    expect(parseRatingValue('not a score')).toBeNull();
  });

  it('normalises outlet labels and rejects structural rows', () => {
    expect(canonicalOutlet(' Metacritic ')).toBe('Metacritic');
    expect(canonicalOutlet('Album of the Year')).toBe('Album of the Year');
    expect(canonicalOutlet('Pitchfork Media')).toBe('Pitchfork');
    expect(canonicalOutlet('Source')).toBeNull();
    expect(canonicalOutlet('Rating')).toBeNull();
    expect(canonicalOutlet('Review scores')).toBeNull();
  });

  it('parses the rendered {{Album ratings}} / {{Music ratings}} table', () => {
    const html = `<html><body>
      <table class="wikitable">
        <caption>Professional ratings</caption>
        <tr><th colspan="2">Review scores</th></tr>
        <tr><th>Source</th><th>Rating</th></tr>
        <tr><td>AllMusic</td><td><span title="4.5/5 stars">★★★★½</span><sup class="reference"><a href="#cite_note-1">[1]</a></sup></td></tr>
        <tr><td>Pitchfork</td><td>8.1/10</td></tr>
        <tr><td>Robert Christgau</td><td>A−</td></tr>
        <tr><td>Some Zine</td><td>89%</td></tr>
        <tr><td>Metacritic</td><td>74/100</td></tr>
        <tr><td>Another Zine</td><td>3/4</td></tr>
        <tr><td>Star Zine</td><td><span title="4/5 stars"></span></td></tr>
      </table>
      <ol><li id="cite_note-1"><a href="http://www.allmusic.com/album/test">allmusic</a></li></ol>
    </body></html>`;
    const $ = cheerio.load(html);
    const scores = parseRatings($, { id: 'x', title: 'Test', artist: 'Artist' }, 'Test Album');

    expect(scores).toHaveLength(7);
    expect(scoreFor(scores, 'AllMusic')).toMatchObject({
      score: 4.5,
      scale: 5,
      url: 'https://www.allmusic.com/album/test',
    });
    expect(scoreFor(scores, 'Pitchfork')).toMatchObject({ score: 8.1, scale: 10 });
    expect(scoreFor(scores, 'Robert Christgau')).toMatchObject({ score: 4.5, scale: 5 });
    expect(scoreFor(scores, 'Some Zine')).toMatchObject({ score: 89, scale: 100 });
    expect(scoreFor(scores, 'Metacritic')).toMatchObject({ score: 74, scale: 100 });
    expect(scoreFor(scores, 'Another Zine')).toMatchObject({ score: 3, scale: 4 });
    expect(scoreFor(scores, 'Star Zine')).toMatchObject({ score: 4, scale: 5 });
    expect(scoreFor(scores, 'Metacritic')?.url).toContain('metacritic.com/search');
    for (const score of scores) expectClean(score.outlet);
  });

  it('reads retrospective "professional reviews" captions (Still Bill)', () => {
    const scores = parseFixtureScores('still-bill');
    expect(scores).toHaveLength(10);
    expect(scoreFor(scores, 'AllMusic')).toMatchObject({ score: 5, scale: 5 });
    expect(scoreFor(scores, "Christgau's Record Guide")).toMatchObject({ score: 4.75, scale: 5 });
  });

  it('parses the other fixture albums without inventing scales', () => {
    const expected: Record<string, { count: number; outlet: string; score: number; scale: number }> = {
      discovery: { count: 11, outlet: 'Metacritic', score: 74, scale: 100 },
      'jar-of-flies': { count: 19, outlet: 'AllMusic', score: 4, scale: 5 },
      uprising: { count: 3, outlet: 'Rolling Stone', score: 4.5, scale: 5 },
      'fire-of-unknown-origin': { count: 2, outlet: 'AllMusic', score: 4.5, scale: 5 },
    };
    for (const [slug, want] of Object.entries(expected)) {
      const scores = parseFixtureScores(slug);
      expect(scores, slug).toHaveLength(want.count);
      expect(scoreFor(scores, want.outlet), slug).toMatchObject({ score: want.score, scale: want.scale });
      for (const score of scores) expectClean(score.outlet);
    }
  });
});

describe('article selection', () => {
  it('builds candidate titles, including disambiguated ones', () => {
    const titles = candidateTitles({ id: 'x', title: 'Uprising', artist: 'Bob Marley & The Wailers', year: 1980 });
    expect(titles).toContain('Uprising (Bob Marley & The Wailers album)');
    expect(titles).toContain('Uprising (Bob Marley and The Wailers album)');
    expect(titles).toContain('Uprising (album)');
    expect(titles).toContain('Uprising');
  });

  it('finds every fixture album through the direct title lookup', async () => {
    for (const album of fixtureAlbums) {
      const { http } = setup(routesFrom([fixtureNamed(album.slug, 'wikipedia-titles')]));
      const title = await findAlbumPage(http, wikiAlbum(album));
      expect(title, album.slug).toBe(album.pageTitle);
    }
  });

  it('rejects song pages and artist pages', () => {
    const album = { id: 'x', title: 'Discovery', artist: 'Daft Punk', year: 2001 };
    const pages: WikiPage[] = [
      {
        title: 'Discovery (song)',
        extract: '"Discovery" is a song by Daft Punk.',
        categories: [{ title: 'Category:2001 songs' }],
      },
    ];
    expect(pickAlbumPage(pages, album)).toBeNull();

    const artistPage: WikiPage[] = [
      { title: 'Daft Punk', extract: 'Daft Punk are a French electronic music duo.', categories: [] },
    ];
    // Similar title? "Discovery" vs "Daft Punk" is below the threshold; use an
    // extract that is clearly an artist page with a matching title instead.
    expect(pickAlbumPage(artistPage, album)).toBeNull();
    expect(
      pickAlbumPage(
        [
          {
            title: 'Discovery',
            extract: 'Discovery is a genus of beetles.',
            categories: [{ title: 'Category:Beetle genera' }],
          },
        ],
        album,
      ),
    ).toBeNull();
  });

  it('resolves the release group to the enwiki sitelink', async () => {
    for (const album of fixtureAlbums) {
      const { db, http, mb } = setup(allRoutes);
      const title = await releaseGroupWikipediaTitle(http, mb, album.releaseGroupId);
      expect(title, album.slug).toBe(album.pageTitle);
      db.close();
    }
  });

  it('parses MusicBrainz and Wikidata URL relations', () => {
    expect(wikipediaTitleFromUrl('https://en.wikipedia.org/wiki/Jar_of_Flies')).toBe('Jar of Flies');
    expect(wikidataIdFromUrl('https://www.wikidata.org/wiki/Q912288')).toBe('Q912288');
    expect(
      pageTitleFromRelations([
        { type: 'wikidata', 'target-type': 'url', url: { resource: 'https://www.wikidata.org/wiki/Q1' } },
        { type: 'wikipedia', 'target-type': 'url', url: { resource: 'https://en.wikipedia.org/wiki/Test_(album)' } },
      ]),
    ).toEqual({ wikipedia: 'Test (album)', wikidata: 'Q1' });
  });

  it('uses MusicBrainz -> Wikidata before search and does not search', async () => {
    for (const album of fixtureAlbums) {
      const { http, mb, calls } = setup(allRoutes);
      const wiki = await fetchWikipedia(http, wikiAlbum(album), {
        mb,
        releaseGroupId: album.releaseGroupId,
      });
      expect(wiki?.pageTitle, album.slug).toBe(album.pageTitle);
      const wikiCalls = calls.filter((u) => u.startsWith('https://en.wikipedia.org/'));
      expect(wikiCalls, album.slug).toHaveLength(1);
      expect(new URL(wikiCalls[0]!).searchParams.get('action'), album.slug).toBe('parse');
    }
  });

  it('falls back to title search when a Wikidata sitelink is stale', async () => {
    const album = { id: 'la:fallback', title: 'Fallback Album', artist: 'Fallback Artist', year: 2001 };
    const page = 'Fallback Album (Fallback Artist album)';
    const titles = {
      query: {
        pages: {
          1: {
            pageid: 1,
            ns: 0,
            title: page,
            categories: [{ title: 'Category:2001 albums' }],
            extract: 'Fallback Album is an album by Fallback Artist.',
          },
        },
      },
    };
    const parseHtml = `<div class="mw-parser-output">
      <p>Fallback Album is the debut album by Fallback Artist.</p>
      <div class="mw-heading"><h2 id="Reception">Reception</h2></div>
      <p>Critics gave Fallback Album positive reviews and praised its songwriting.</p>
    </div>`;
    const routes = new Map<string, Fixture>([
      [
        releaseGroupUrlRelationsUrl('rg-stale'),
        {
          url: releaseGroupUrlRelationsUrl('rg-stale'),
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'rg-stale',
            relations: [{ type: 'wikidata', 'target-type': 'url', url: { resource: 'https://www.wikidata.org/wiki/Q999' } }],
          }),
        },
      ],
      [
        wikidataSitelinksUrl('Q999'),
        {
          url: wikidataSitelinksUrl('Q999'),
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ entities: { Q999: { sitelinks: { enwiki: { title: 'Stale Title' } } } } }),
        },
      ],
      [
        wikipediaTitlesUrl(candidateTitles(album)),
        { url: wikipediaTitlesUrl(candidateTitles(album)), status: 200, contentType: 'application/json', body: JSON.stringify(titles) },
      ],
      [
        wikipediaParseUrl(page),
        { url: wikipediaParseUrl(page), status: 200, contentType: 'application/json', body: JSON.stringify({ parse: { title: page, text: { '*': parseHtml } } }) },
      ],
    ]);
    const { http, mb } = setup(routes);
    const wiki = await fetchWikipedia(http, album, { mb, releaseGroupId: 'rg-stale' });
    expect(wiki?.pageTitle).toBe(page);
    expect(wiki?.reception?.value).toContain('positive reviews');
  });
});

describe('wikipedia sections and prose', () => {
  it('accepts all reception heading variants', () => {
    const headings = [
      'Critical reception',
      'Critical reception and legacy',
      'Reception',
      'Critical response',
      'Reception and legacy',
      'Release and reception',
      'Legacy',
    ];
    for (const heading of headings) {
      const section: Section = { heading, level: 2, nodes: [] };
      expect(pickReceptionSection([section])?.heading, heading).toBe(heading);
    }
    for (const heading of ['Commercial performance', 'Charts', 'Track listing', 'References']) {
      expect(pickReceptionSection([{ heading, level: 2, nodes: [] }]), heading).toBeUndefined();
    }
  });

  it('accepts all background heading variants', () => {
    const headings = [
      'Background',
      'Background and recording',
      'Recording',
      'Recording and production',
      'Production',
      'Composition',
      'Music and lyrics',
      'Writing and recording',
    ];
    for (const heading of headings) {
      const section: Section = { heading, level: 2, nodes: [] };
      expect(pickBackgroundSection([section])?.heading, heading).toBe(heading);
    }
    for (const heading of ['Release', 'Legacy', 'Track listing', 'Personnel', 'Charts']) {
      expect(pickBackgroundSection([{ heading, level: 2, nodes: [] }]), heading).toBeUndefined();
    }
  });

  it('prefers an exact reception heading over a lower-scoring one', () => {
    const sections: Section[] = [
      { heading: 'Reception and legacy', level: 2, nodes: [] },
      { heading: 'Critical reception', level: 2, nodes: [] },
    ];
    expect(pickReceptionSection(sections)?.heading).toBe('Critical reception');
  });

  it('extracts reception and background for the five recorded articles', async () => {
    const expected: Record<string, { reception: boolean; background: boolean; scores: number; quotes: number }> = {
      discovery: { reception: true, background: true, scores: 11, quotes: 4 },
      'jar-of-flies': { reception: true, background: true, scores: 19, quotes: 1 },
      'still-bill': { reception: true, background: false, scores: 10, quotes: 3 },
      uprising: { reception: false, background: false, scores: 3, quotes: 0 },
      'fire-of-unknown-origin': { reception: false, background: false, scores: 2, quotes: 0 },
    };
    for (const album of fixtureAlbums) {
      const want = expected[album.slug]!;
      const { http, mb } = setup(allRoutes);
      const wiki = await fetchWikipedia(http, wikiAlbum(album), {
        mb,
        releaseGroupId: album.releaseGroupId,
      });
      expect(wiki?.pageTitle, album.slug).toBe(album.pageTitle);
      expect(Boolean(wiki?.reception), `${album.slug} reception`).toBe(want.reception);
      expect(Boolean(wiki?.background), `${album.slug} background`).toBe(want.background);
      expect(wiki?.scores.length, `${album.slug} scores`).toBe(want.scores);
      expect(wiki?.quotes.length, `${album.slug} quotes`).toBe(want.quotes);
      if (wiki?.reception) {
        expect(wiki.reception.source).toBe('Wikipedia');
        expect(wiki.reception.url).toContain('en.wikipedia.org/wiki/');
        expect(wiki.reception.value.length).toBeGreaterThan(100);
        expectClean(wiki.reception.value);
      }
      if (album.slug === 'jar-of-flies') {
        // "Release and reception" opens with release/chart prose; the first
        // review paragraph must win even though it lacks the word "review".
        expect(wiki?.reception?.value).toMatch(/^Paul Evans of Rolling Stone/);
      }
      if (wiki?.background) {
        expect(wiki.background.value.length).toBeGreaterThan(100);
        expectClean(wiki.background.value);
      }
      for (const score of wiki?.scores ?? []) expectClean(score.outlet);
      for (const quote of wiki?.quotes ?? []) {
        expect(quote.quote.length).toBeLessThanOrEqual(300);
        expect(quote.url).toMatch(/^https:\/\//);
        expectClean(quote.quote);
      }
    }
  });

  it('uses the expected AllMusic scale for each album', async () => {
    const expected: Record<string, { score: number }> = {
      discovery: { score: 5 },
      'jar-of-flies': { score: 4 },
      'still-bill': { score: 5 },
      uprising: { score: 4.5 },
      'fire-of-unknown-origin': { score: 4.5 },
    };
    for (const album of fixtureAlbums) {
      const { http, mb } = setup(allRoutes);
      const wiki = await fetchWikipedia(http, wikiAlbum(album), {
        mb,
        releaseGroupId: album.releaseGroupId,
      });
      expect(scoreFor(wiki?.scores ?? [], 'AllMusic'), album.slug).toMatchObject({
        score: expected[album.slug]!.score,
        scale: 5,
      });
    }
  });

  it('matches Discovery and Still Bill reception prose', async () => {
    const discovery = setup(allRoutes);
    const d = await fetchWikipedia(discovery.http, wikiAlbum(fixtureAlbums[0]!), {
      mb: discovery.mb,
      releaseGroupId: fixtureAlbums[0]!.releaseGroupId,
    });
    expect(d?.reception?.value).toContain('Metacritic');
    expect(d?.reception?.value).toContain('74');
    expect(d?.background?.value).toContain('Homework');

    const still = setup(allRoutes);
    const s = await fetchWikipedia(still.http, wikiAlbum(fixtureAlbums[2]!), {
      mb: still.mb,
      releaseGroupId: fixtureAlbums[2]!.releaseGroupId,
    });
    expect(s?.reception?.value).toContain('positive reviews');
  });

  it('extracts a quote from a non-fixture article and falls back to lead prose', async () => {
    const album = { id: 'la:synthetic', title: 'Synthetic', artist: 'Test Artist', year: 2020 };
    const page = 'Synthetic (Test Artist album)';
    const titles = {
      query: {
        pages: {
          1: {
            pageid: 1,
            ns: 0,
            title: page,
            categories: [{ title: 'Category:2020 albums' }],
            extract: 'Synthetic is an album by Test Artist.',
          },
        },
      },
    };
    const html = `<div class="mw-parser-output">
      <p>Synthetic is the debut album by Test Artist.</p>
      <div class="mw-heading"><h2 id="Reception_and_legacy">Reception and legacy</h2></div>
      <p>Critics praised Synthetic; AllMusic's Jane Doe wrote that it was a confident debut with memorable songs.</p>
      <div class="mw-heading"><h2 id="Background_and_recording">Background and recording</h2></div>
      <p>Test Artist recorded Synthetic in a home studio during 2019, after touring the previous year.</p>
    </div>`;
    const routes = new Map<string, Fixture>([
      [
        wikipediaTitlesUrl(candidateTitles(album)),
        { url: wikipediaTitlesUrl(candidateTitles(album)), status: 200, contentType: 'application/json', body: JSON.stringify(titles) },
      ],
      [
        wikipediaParseUrl(page),
        { url: wikipediaParseUrl(page), status: 200, contentType: 'application/json', body: JSON.stringify({ parse: { title: page, text: { '*': html } } }) },
      ],
    ]);
    const { http } = setup(routes);
    const wiki = await fetchWikipedia(http, album);
    expect(wiki?.reception?.value).toContain('Critics praised');
    expect(wiki?.background?.value).toContain('recorded Synthetic');
    expect(wiki?.quotes).toHaveLength(1);
    expect(wiki?.quotes[0]).toMatchObject({ outlet: 'AllMusic', author: 'Jane Doe' });

    // No reception section at all: the lead paragraph that mentions reviews wins.
    const leadHtml = `<div class="mw-parser-output">
      <p>Synthetic is the debut album by Test Artist.</p>
      <p>The album received positive reviews from critics, who praised its production and songwriting.</p>
      <div class="mw-heading"><h2 id="Track_listing">Track listing</h2></div>
    </div>`;
    const leadRoutes = new Map<string, Fixture>([
      [
        wikipediaTitlesUrl(candidateTitles(album)),
        { url: wikipediaTitlesUrl(candidateTitles(album)), status: 200, contentType: 'application/json', body: JSON.stringify(titles) },
      ],
      [
        wikipediaParseUrl(page),
        { url: wikipediaParseUrl(page), status: 200, contentType: 'application/json', body: JSON.stringify({ parse: { title: page, text: { '*': leadHtml } } }) },
      ],
    ]);
    const lead = setup(leadRoutes);
    const leadWiki = await fetchWikipedia(lead.http, album);
    expect(leadWiki?.reception?.value).toContain('positive reviews');
    expect(leadWiki?.background).toBeUndefined();
  });

  it('returns null when no article exists', async () => {
    const { http } = setup(new Map());
    const wiki = await fetchWikipedia(http, { id: 'x', title: 'Xqzzt Plorf', artist: 'Nobody Real' });
    expect(wiki).toBeNull();
  });

  it('builds the documented Wikipedia URLs', () => {
    expect(wikipediaSearchUrl({ id: 'x', title: 'Discovery', artist: 'Daft Punk' })).toContain('generator=search');
    expect(wikipediaParseUrl('Discovery (Daft Punk album)')).toContain('action=parse');
  });
});

describe('quotes', () => {
  it('extracts attributed critic statements with outlet URLs', () => {
    const paragraphs = [
      {
        text:
          "AllMusic's Steve Huey wrote that the album was a bold departure for the band. " +
          'Robert Christgau called it a masterpiece of its genre. ' +
          'Rolling Stone said that the group had matured considerably on this record.',
        urls: [
          'https://www.allmusic.com/album/x',
          'https://www.robertchristgau.com/get_album.php?id=1',
          'https://www.rollingstone.com/music/albumreviews/x',
        ],
      },
    ];
    const quotes = extractQuotes(paragraphs, 'https://en.wikipedia.org/wiki/X');
    expect(quotes.map((q) => q.outlet)).toEqual(['AllMusic', 'Robert Christgau', 'Rolling Stone']);
    expect(quotes[0]).toMatchObject({ author: 'Steve Huey', url: 'https://www.allmusic.com/album/x' });
    expect(quotes[1]).toMatchObject({ author: 'Robert Christgau', url: 'https://www.robertchristgau.com/get_album.php?id=1' });
    expect(quotes[2]?.url).toBe('https://www.rollingstone.com/music/albumreviews/x');
  });

  it('caps at four, dedupes, and truncates to 300 chars', () => {
    const long = `AllMusic's Jane Doe wrote that ${'the record was excellent and ambitious '.repeat(20)}.`;
    const paragraphs = [
      {
        text:
          `${long} Rolling Stone said that it was a triumph of production and songwriting. ` +
          'Q wrote that the record was an instant classic in its genre. ' +
          'NME called it an essential album for anyone interested in the band. ' +
          'Spin praised the production and the songwriting throughout the record.',
        urls: ['https://www.allmusic.com/x'],
      },
    ];
    const quotes = extractQuotes(paragraphs, 'https://en.wikipedia.org/wiki/X');
    expect(quotes.length).toBe(4);
    for (const quote of quotes) expect(quote.quote.length).toBeLessThanOrEqual(300);
  });

  it('ignores unattributed prose', () => {
    expect(
      extractQuotes([{ text: 'The album was released in 1994 and sold well in the United States.', urls: [] }], 'https://x'),
    ).toEqual([]);
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
    const { http } = setup(routesFrom([f]));
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
    const { http } = setup(new Map());
    const blocked = new CachedHttp(newDb(), cfg, {
      fetch: (async () => new Response('blocked', { status: 403 })) as unknown as typeof fetch,
      minIntervalMs: 0,
      sleep: async () => {},
    });
    void http;
    await expect(fetchAoty(blocked, { id: 'x', title: 'Discovery', artist: 'Daft Punk' })).resolves.toEqual({});
  });

  it('uses the documented search URL', () => {
    expect(aotySearchUrl({ id: 'x', title: 'Discovery', artist: 'Daft Punk' })).toContain('albumoftheyear.org/search');
  });
});

describe('genius', () => {
  const jar = fixtureAlbums[1]!;
  const still = fixtureAlbums[2]!;

  interface SeenRequest {
    url: string;
    auth?: string;
  }

  function geniusSetup(routes: Map<string, Fixture>): { http: CachedHttp; seen: SeenRequest[] } {
    const seen: SeenRequest[] = [];
    const base = fakeFetch(routes);
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: urlOf(input), auth: (init?.headers as Record<string, string> | undefined)?.authorization });
      return base(input, init);
    }) as unknown as typeof fetch;
    const http = new CachedHttp(newDb(), cfg, {
      fetch: fetchImpl,
      minIntervalMs: 0,
      sleep: async () => {},
    });
    return { http, seen };
  }

  it('never contains the real Genius token in fixtures', () => {
    for (const fixture of fixtures) {
      expect(fixture.url).not.toMatch(/Bearer\s/i);
      expect(fixture.body).not.toMatch(/Bearer\s[A-Za-z0-9_-]{20,}/);
    }
  });

  it('fetches album and song descriptions from the official API for Jar of Flies', async () => {
    const { http, seen } = geniusSetup(allRoutes);
    const notes = await fetchGenius(
      http,
      wikiAlbum(jar),
      jar.tracks.map((title, i) => ({ id: `l:${i}`, title })),
      { token: 'fixture-token' },
    );

    expect(notes).toHaveLength(8);
    expect(notes[0]?.trackId).toBeUndefined();
    expect(notes[0]?.url).toBe('https://genius.com/albums/Alice-in-chains/Jar-of-flies');
    expect(notes[0]?.value).toContain('Alice in Chains');
    expect(notes.map((n) => n.trackId).filter(Boolean)).toEqual(['l:0', 'l:1', 'l:2', 'l:3', 'l:4', 'l:5', 'l:6']);
    expect(notes.every((n) => n.source === 'Genius')).toBe(true);
    expect(notes.every((n) => n.verifiedArtist === false)).toBe(true);
    for (const note of notes) {
      expect(note.value.length).toBeGreaterThan(10);
      expect(note.value).not.toBe('?');
      expect(note.url).toMatch(/^https:\/\/genius\.com\//);
    }

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.url.startsWith('https://api.genius.com/'))).toBe(true);
    expect(seen.every((r) => r.auth === 'Bearer fixture-token')).toBe(true);
  });

  it('drops a Genius song that belongs to a different album (Still Bill)', async () => {
    const { http } = geniusSetup(allRoutes);
    const notes = await fetchGenius(
      http,
      wikiAlbum(still),
      still.tracks.map((title, i) => ({ id: `l:${i}`, title })),
      { token: 'fixture-token' },
    );
    expect(notes).toHaveLength(4);
    expect(notes[0]?.trackId).toBeUndefined();
    expect(notes[0]?.verifiedArtist).toBe(false);
    expect(notes.map((n) => n.trackId).filter(Boolean)).toEqual(['l:2', 'l:3', 'l:4']);
  });

  it('makes no requests without a token', async () => {
    const { http, seen } = geniusSetup(allRoutes);
    await expect(
      fetchGenius(http, wikiAlbum(jar), [{ id: 'l:0', title: 'Nutshell' }]),
    ).resolves.toEqual([]);
    expect(seen).toEqual([]);
  });

  it('validates search hits by artist and normalized track title', () => {
    const f = fixtureNamed('jar-of-flies', 'genius-search-alice-in-chains-nutshell');
    const response = JSON.parse(f.body) as Parameters<typeof pickGeniusSong>[0];
    expect(pickGeniusSong(response, 'Alice In Chains', 'Nutshell')?.id).toBe(185169);
    expect(pickGeniusSong(response, 'Bill Withers', 'Nutshell')).toBeNull();

    const noisy = {
      response: {
        hits: [
          { result: { title: 'Rock Albums That Mention Depression', primary_artist: { name: 'Trigger Genius' } } },
          { result: { title: 'Nutshell', primary_artist: { name: 'Some Cover Band' } } },
        ],
      },
    } as Parameters<typeof pickGeniusSong>[0];
    expect(pickGeniusSong(noisy, 'Alice In Chains', 'Nutshell')).toBeNull();
  });

  it('skips "?" descriptions and empty notes', async () => {
    const album = { id: 'la:synth', title: 'Synthetic Album', artist: 'Synthetic Artist' };
    const track = { id: 'l:0', title: 'Song One' };
    const routes = new Map<string, Fixture>([
      [
        geniusSearchUrl(album, track.title),
        {
          url: geniusSearchUrl(album, track.title),
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            response: {
              hits: [
                { result: { id: 7, title: 'Song One', primary_artist: { name: 'Synthetic Artist' } } },
              ],
            },
          }),
        },
      ],
      [
        geniusSongUrl(7),
        {
          url: geniusSongUrl(7),
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            response: {
              song: {
                id: 7,
                title: 'Song One',
                url: 'https://genius.com/Synthetic-artist-song-one-lyrics',
                primary_artist: { name: 'Synthetic Artist' },
                description: { plain: '?' },
                description_annotation: { annotations: [{ body: { plain: '?' } }] },
              },
            },
          }),
        },
      ],
    ]);
    const { http } = geniusSetup(routes);
    await expect(fetchGenius(http, album, [track], { token: 't' })).resolves.toEqual([]);
  });

  it('marks notes verified only when a verified credited artist wrote them', async () => {
    const verifiedSong = {
      primary_artist: { name: 'A-Trak' },
      writer_artists: [{ name: 'A-Trak' }],
      verified_contributors: [
        { contributions: ['annotations'], artist: { name: 'A-Trak', is_verified: true } },
      ],
    } as Parameters<typeof songNoteVerified>[0];
    expect(songNoteVerified(verifiedSong)).toBe(true);

    const verifiedAnnotation = {
      primary_artist: { name: 'Kanye West' },
      description_annotation: {
        verified: true,
        annotations: [{ verified: true, authors: [{ user: { name: 'Kanye West' } }] }],
      },
    } as Parameters<typeof songNoteVerified>[0];
    expect(songNoteVerified(verifiedAnnotation)).toBe(true);

    const uncredited = {
      primary_artist: { name: 'Artist' },
      verified_contributors: [
        { contributions: ['annotations'], artist: { name: 'Some Editor', is_verified: true } },
      ],
    } as Parameters<typeof songNoteVerified>[0];
    expect(songNoteVerified(uncredited)).toBe(false);

    const unverifiedAnnotation = {
      primary_artist: { name: 'Artist' },
      description_annotation: {
        annotations: [{ authors: [{ user: { name: 'Artist' } }] }],
      },
    } as Parameters<typeof songNoteVerified>[0];
    expect(songNoteVerified(unverifiedAnnotation)).toBe(false);

    // A verified artist account alone is not enough: the description must be
    // authored by them.
    const verifiedAccountOnly = {
      primary_artist: { name: 'Artist', is_verified: true },
    } as Parameters<typeof songNoteVerified>[0];
    expect(songNoteVerified(verifiedAccountOnly)).toBe(false);
  });

  it('unshifts a verified album description from the official API', async () => {
    const album = { id: 'la:synth', title: 'Synthetic Album', artist: 'Synthetic Artist' };
    const track = { id: 'l:0', title: 'Song One' };
    const routes = new Map<string, Fixture>([
      [
        geniusSearchUrl(album, track.title),
        {
          url: geniusSearchUrl(album, track.title),
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            response: {
              hits: [
                { result: { id: 7, title: 'Song One', primary_artist: { name: 'Synthetic Artist' } } },
              ],
            },
          }),
        },
      ],
      [
        geniusSongUrl(7),
        {
          url: geniusSongUrl(7),
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            response: {
              song: {
                id: 7,
                title: 'Song One',
                url: 'https://genius.com/Synthetic-artist-song-one-lyrics',
                primary_artist: { name: 'Synthetic Artist' },
                writer_artists: [{ name: 'Synthetic Artist' }],
                verified_contributors: [
                  { contributions: ['annotations'], artist: { name: 'Synthetic Artist', is_verified: true } },
                ],
                description: { plain: 'An official song note written by the artist about this track.' },
                album: {
                  id: 55,
                  name: 'Synthetic Album',
                  url: 'https://genius.com/albums/Synthetic-artist/Synthetic-album',
                },
              },
            },
          }),
        },
      ],
      [
        geniusAlbumUrl(55),
        {
          url: geniusAlbumUrl(55),
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            response: {
              album: {
                id: 55,
                name: 'Synthetic Album',
                artist: { name: 'Synthetic Artist' },
                description_annotation: {
                  verified: true,
                  annotations: [
                    {
                      verified: true,
                      body: { plain: 'An official album note written by the artist about the record.' },
                      authors: [{ user: { name: 'Synthetic Artist' } }],
                    },
                  ],
                },
              },
            },
          }),
        },
      ],
    ]);
    const { http } = geniusSetup(routes);
    const notes = await fetchGenius(http, album, [track], { token: 't' });
    expect(notes).toHaveLength(2);
    expect(notes[0]?.trackId).toBeUndefined();
    expect(notes[0]?.value).toContain('official album note');
    expect(notes[0]?.verifiedArtist).toBe(true);
    expect(notes[1]).toMatchObject({ trackId: 'l:0', verifiedArtist: true });
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
  const discovery = fixtureAlbums[0]!;
  const still = fixtureAlbums[2]!;
  const geniusCfg = { ...cfg, geniusToken: 'fixture-token' } as Config;

  it('builds and stores AlbumDetails, then serves it from the database', async () => {
    const db = newDb();
    seedAlbum(db, {
      id: 'la:discovery',
      title: discovery.title,
      artist: discovery.artist,
      year: discovery.year,
      mbReleaseGroupId: discovery.releaseGroupId,
      tracks: discovery.tracks,
    });
    const calls: string[] = [];
    const meta = createMeta(db, cfg, {
      fetch: fakeFetch(allRoutes, calls),
      minIntervalMs: 0,
      mbRateLimitMs: 0,
      sleep: async () => {},
    });

    const details = await meta.getDetails('la:discovery');
    expect(details).not.toBeNull();
    expect(details?.albumId).toBe('la:discovery');
    expect(details?.reception?.value.length).toBeGreaterThan(200);
    expect(details?.reception?.value).toContain('Metacritic');
    expect(details?.reception?.url).toContain('en.wikipedia.org/wiki/Discovery');
    expect(details?.background?.value.length).toBeGreaterThan(200);
    expect(details?.scores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outlet: 'Metacritic', score: 74, scale: 100 }),
        expect.objectContaining({ outlet: 'Pitchfork', score: 6.4, scale: 10 }),
        expect.objectContaining({ outlet: 'AllMusic', score: 5, scale: 5 }),
      ]),
    );
    expect(details?.quotes).toHaveLength(4);
    expect(details?.quotes[0]?.outlet).toBe('AllMusic');
    expect(details?.artistNotes).toEqual([]);
    expect(details?.fetchedAt).toBeGreaterThan(0);

    // We never scrape metacritic.com or genius.com web pages.
    expect(calls.some((u) => new URL(u).host.endsWith('metacritic.com'))).toBe(false);
    expect(calls.some((u) => new URL(u).host.endsWith('genius.com') && !new URL(u).host.startsWith('api.'))).toBe(false);

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
    const meta = createMeta(newDb(), cfg, {
      fetch: fakeFetch(allRoutes, calls),
      minIntervalMs: 0,
      mbRateLimitMs: 0,
      sleep: async () => {},
    });
    expect(await meta.getDetails('la:nope')).toBeNull();
    expect(await meta.fetchDetails('la:nope')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('keeps Wikipedia data when individual sources fail', async () => {
    const db = newDb();
    seedAlbum(db, { id: 'la:still-bill', title: still.title, artist: still.artist, year: still.year });
    const routes = routesFrom([
      fixtureNamed('still-bill', 'wikipedia-titles'),
      fixtureNamed('still-bill', 'wikipedia-parse'),
    ]);
    const meta = createMeta(db, cfg, {
      fetch: fakeFetch(routes),
      minIntervalMs: 0,
      mbRateLimitMs: 0,
      sleep: async () => {},
    });
    const details = await meta.getDetails('la:still-bill');
    expect(details?.reception?.value).toContain('positive reviews');
    expect(details?.scores).toHaveLength(10);
    expect(details?.quotes).toHaveLength(3);
    expect(details?.background).toBeUndefined();
    expect(details?.artistNotes).toEqual([]);
  });

  it('integrates Genius notes when a token is configured', async () => {
    const db = newDb();
    seedAlbum(db, {
      id: 'la:still-bill',
      title: still.title,
      artist: still.artist,
      year: still.year,
      mbReleaseGroupId: still.releaseGroupId,
      tracks: still.tracks,
    });
    const calls: string[] = [];
    const meta = createMeta(db, geniusCfg, {
      fetch: fakeFetch(allRoutes, calls),
      minIntervalMs: 0,
      mbRateLimitMs: 0,
      sleep: async () => {},
    });
    const details = await meta.getDetails('la:still-bill');
    expect(details?.scores).toHaveLength(10);
    expect(details?.artistNotes).toHaveLength(4);
    expect(details?.artistNotes[0]?.trackId).toBeUndefined();
    expect(details?.artistNotes[0]?.value).toContain('Still Bill');
    expect(details?.artistNotes.every((n) => n.source === 'Genius')).toBe(true);
    // Genius API calls carry the token; no genius.com web page is fetched.
    expect(calls.some((u) => u.startsWith('https://api.genius.com/'))).toBe(true);
    expect(calls.some((u) => new URL(u).host === 'genius.com')).toBe(false);
  });

  it('reuses the HTTP cache after invalidating album details', async () => {
    const db = newDb();
    seedAlbum(db, {
      id: 'la:discovery',
      title: discovery.title,
      artist: discovery.artist,
      year: discovery.year,
      mbReleaseGroupId: discovery.releaseGroupId,
      tracks: discovery.tracks,
    });
    const calls: string[] = [];
    const meta = createMeta(db, cfg, {
      fetch: fakeFetch(allRoutes, calls),
      minIntervalMs: 0,
      mbRateLimitMs: 0,
      sleep: async () => {},
    });
    await meta.getDetails('la:discovery');
    const firstCalls = [...calls];
    meta.invalidate('la:discovery');
    await meta.getDetails('la:discovery');

    const secondBatch = calls.slice(firstCalls.length);
    expect(secondBatch.some((u) => u.includes('en.wikipedia.org'))).toBe(false);
    expect(secondBatch.some((u) => u.includes('musicbrainz.org'))).toBe(false);
    expect(secondBatch.some((u) => u.includes('wikidata.org'))).toBe(false);
    expect(secondBatch.some((u) => u.includes('pitchfork.com'))).toBe(false);
    expect(secondBatch.some((u) => u.includes('metacritic.com'))).toBe(false);
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
