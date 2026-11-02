// Records real responses for the meta unit tests. Network is allowed here only.
// Run: pnpm -C server exec tsx scripts/record-meta.ts
//
// Fixtures are stored as { url, status, contentType, body } JSON files under
// tests/fixtures/meta/. The Genius token is read from server/config.json and
// sent only in the Authorization header — it never appears in a fixture URL or
// body, and this script asserts that before writing.
//
// Pitchfork pages are trimmed to the data the parser needs (preloaded review
// state + JSON-LD) because raw pages are ~1 MB. Genius responses are trimmed to
// the fields the client reads (no avatar blobs).
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';
import { CachedHttp } from '../src/meta/http.js';
import { MbClient, RateLimiter } from '../src/match/mb.js';
import {
  candidateTitles,
  fetchWikipedia,
  findAlbumPage,
  wikipediaTitlesUrl,
  wikipediaParseUrl,
  type WikiAlbumRef,
} from '../src/meta/wikipedia.js';
import { releaseGroupWikipediaTitle } from '../src/meta/musicbrainz.js';
import { pickPitchforkLink, pickPitchforkReferenceUrl, pitchforkSearchUrl } from '../src/meta/pitchfork.js';
import { aotySearchUrl } from '../src/meta/albumoftheyear.js';
import { fetchGenius, type TrackRef } from '../src/meta/genius.js';

const OUT = new URL('../tests/fixtures/meta/', import.meta.url);

interface FixtureAlbum extends WikiAlbumRef {
  slug: string;
  releaseGroupId: string;
  tracks: string[];
}

const albums: FixtureAlbum[] = [
  {
    id: 'la:discovery',
    slug: 'discovery',
    title: 'Discovery',
    artist: 'Daft Punk',
    year: 2001,
    releaseGroupId: '48117b90-a16e-34ca-a514-19c702df1158',
    tracks: [
      'One More Time', 'Aerodynamic', 'Digital Love', 'Harder, Better, Faster, Stronger',
      'Crescendolls', 'Nightvision', 'Superheroes', 'High Life', 'Something About Us',
      'Voyager', 'Verdis Quo', 'Short Circuit', 'Face to Face', 'Too Long',
    ],
  },
  {
    id: 'la:jar',
    slug: 'jar-of-flies',
    title: 'Jar of Flies',
    artist: 'Alice In Chains',
    year: 1994,
    releaseGroupId: '3b6b7688-c97b-3d11-9334-3158468074f7',
    tracks: ['Rotten Apple', 'Nutshell', 'I Stay Away', 'No Excuses', 'Whale & Wasp', "Don't Follow", 'Swing on This'],
  },
  {
    id: 'la:still-bill',
    slug: 'still-bill',
    title: 'Still Bill',
    artist: 'Bill Withers',
    year: 1972,
    releaseGroupId: '63544e97-de86-3096-8702-250590ae5f90',
    tracks: [
      'Lonely Town, Lonely Street', 'Let Me in Your Life', 'Who Is He (And What Is He to You)?',
      'Use Me', 'Lean on Me', 'Kissing My Love', 'Another Day to Run', 'I Don\'t Want You on My Mind',
      'Take It All in Stride', 'Let It Be',
    ],
  },
  {
    id: 'la:uprising',
    slug: 'uprising',
    title: 'Uprising',
    artist: 'Bob Marley & The Wailers',
    year: 1980,
    releaseGroupId: '6dd29c00-7539-319d-98e0-b2f07e861497',
    tracks: [
      'Coming in from the Cold', 'Real Situation', 'Bad Card', 'We and Dem', 'Work', 'Zion Train',
      'Could You Be Loved', 'Forever Loving Jah', 'Pimper\'s Paradise', 'Redemption Song',
    ],
  },
  {
    id: 'la:fire',
    slug: 'fire-of-unknown-origin',
    title: 'Fire of Unknown Origin',
    artist: 'Blue Öyster Cult',
    year: 1981,
    releaseGroupId: 'cf3efe8c-3963-30c2-a9ba-a1b1117a5b1a',
    tracks: [
      'Fire of Unknown Origin', "Burnin' for You", 'Veteran of the Psychic Wars', 'Sole Survivor',
      'After Dark', 'Joan Crawford', 'Vengeance (The Pact)', 'Hot Rails to Hell',
    ],
  },
];

interface Fixture {
  url: string;
  status: number;
  contentType?: string;
  body: string;
  note?: string;
}

function save(slug: string, name: string, fixture: Fixture, token?: string): void {
  if (token && (fixture.url.includes(token) || fixture.body.includes(token))) {
    throw new Error(`refusing to write ${name}: Genius token present`);
  }
  const file = new URL(`${slug}--${name}.json`, OUT);
  writeFileSync(file, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`  saved ${slug}--${name}.json (${fixture.body.length} bytes, status ${fixture.status})`);
}

function toFixture(url: string, res: { status: number; body: string; contentType?: string }, note?: string): Fixture {
  return {
    url,
    status: res.status,
    body: res.body,
    ...(res.contentType ? { contentType: res.contentType } : {}),
    ...(note ? { note } : {}),
  };
}

/** Keep only the search result links; the raw search page is not needed. */
function trimPitchforkSearch(html: string): string {
  const links = new Set<string>();
  for (const m of html.matchAll(/href="(\/reviews\/albums\/[^"?#]+)"/g)) if (m[1]) links.add(m[1]);
  for (const m of html.matchAll(/"url":"(\/reviews\/albums\/[^"]+)"/g)) if (m[1]) links.add(m[1].replace(/\\\//g, '/'));
  return `<html><body>${[...links].map((l) => `<a href="${l}"></a>`).join('\n')}</body></html>`;
}

/** Keep preloaded review state + JSON-LD; drop the rest of the 1 MB page. */
function trimPitchforkReview(html: string): string {
  const scripts: string[] = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    scripts.push(`<script type="application/ld+json">${m[1]}</script>`);
  }
  const stateMatch = html.match(/window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
  let stateScript = '';
  if (stateMatch?.[1]) {
    const state = JSON.parse(stateMatch[1]) as { transformed?: { review?: Record<string, unknown> } };
    const review = state.transformed?.review ?? {};
    const headerProps = (review.headerProps ?? {}) as Record<string, unknown>;
    const multi = (review.multiReviewHeaderProps ?? {}) as Record<string, unknown>;
    const trimmed = {
      transformed: {
        review: {
          rating: review.rating,
          body: review.body,
          contributors: review.contributors,
          headerProps: {
            dangerousHed: headerProps.dangerousHed,
            artists: headerProps.artists,
            musicRating: headerProps.musicRating,
            contributors: headerProps.contributors,
            infoSliceFields: headerProps.infoSliceFields,
          },
          multiReviewHeaderProps: multi,
        },
      },
    };
    stateScript = `<script>window.__PRELOADED_STATE__ = ${JSON.stringify(trimmed)};</script>`;
  }
  return `<html><head>${scripts.join('\n')}</head><body>${stateScript}</body></html>`;
}

// ---------- Genius response trimming ----------

interface RawJson {
  [key: string]: unknown;
}

function pickArtist(artist: RawJson | undefined): RawJson | undefined {
  if (!artist) return undefined;
  return {
    id: artist.id,
    name: artist.name,
    login: artist.login,
    is_verified: artist.is_verified,
    role_for_display: artist.role_for_display,
  };
}

function trimGenius(url: string, body: string): string {
  try {
    const data = JSON.parse(body) as RawJson;
    if (url.includes('/search?')) {
      const response = (data.response ?? {}) as RawJson;
      const hits = ((response.hits ?? []) as { result?: RawJson }[]).map((hit) => {
        const result = hit.result ?? {};
        return {
          result: {
            id: result.id,
            title: result.title,
            url: result.url,
            api_path: result.api_path,
            artist_names: result.artist_names,
            primary_artist: pickArtist(result.primary_artist as RawJson | undefined),
          },
        };
      });
      return JSON.stringify({ response: { hits } });
    }
    if (url.includes('/songs/')) {
      const response = (data.response ?? {}) as RawJson;
      const song = (response.song ?? {}) as RawJson;
      const album = (song.album ?? undefined) as RawJson | undefined;
      return JSON.stringify({
        response: {
          song: {
            id: song.id,
            title: song.title,
            url: song.url,
            artist_names: song.artist_names,
            description: song.description,
            description_annotation: song.description_annotation,
            primary_artist: pickArtist(song.primary_artist as RawJson | undefined),
            primary_artists: (song.primary_artists as RawJson[] | undefined)?.map(pickArtist),
            featured_artists: (song.featured_artists as RawJson[] | undefined)?.map(pickArtist),
            writer_artists: (song.writer_artists as RawJson[] | undefined)?.map(pickArtist),
            producer_artists: (song.producer_artists as RawJson[] | undefined)?.map(pickArtist),
            album: album
              ? {
                  id: album.id,
                  name: album.name,
                  url: album.url,
                  artist: pickArtist(album.artist as RawJson | undefined),
                  primary_artists: (album.primary_artists as RawJson[] | undefined)?.map(pickArtist),
                }
              : undefined,
            verified_contributors: song.verified_contributors,
            verified_annotations_by: (song.verified_annotations_by as RawJson[] | undefined)?.map(pickArtist),
            verified_lyrics_by: song.verified_lyrics_by,
          },
        },
      });
    }
    if (url.includes('/albums/')) {
      const response = (data.response ?? {}) as RawJson;
      const album = (response.album ?? {}) as RawJson;
      return JSON.stringify({
        response: {
          album: {
            id: album.id,
            name: album.name,
            artist: pickArtist(album.artist as RawJson | undefined),
            primary_artists: (album.primary_artists as RawJson[] | undefined)?.map(pickArtist),
            description_annotation: album.description_annotation,
            verified_contributors: album.verified_contributors,
          },
        },
      });
    }
    return body;
  } catch {
    return body;
  }
}

/** Highest implicit rowid in the HTTP cache; used to isolate one album's requests. */
function maxCacheRowid(db: Db): number {
  const row = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM http_cache').get() as { n: number };
  return row.n;
}

/** Cached responses written since `since` (i.e. during this album). */
function saveCached(
  db: Db,
  slug: string,
  since: number,
  opts: { prefix: string; kind: (url: string) => string | null; transform?: (url: string, body: string) => string; token?: string },
): void {
  const rows = db
    .prepare('SELECT key, body, status FROM http_cache WHERE key LIKE ? AND rowid > ? ORDER BY rowid')
    .all(`${opts.prefix}%`, since) as { key: string; body: string; status: number }[];
  for (const row of rows) {
    const kind = opts.kind(row.key);
    if (!kind) continue;
    const body = opts.transform ? opts.transform(row.key, row.body) : row.body;
    save(slug, kind, { url: row.key, status: row.status, body }, opts.token);
  }
}

function wikipediaKind(url: string): string | null {
  if (!url.startsWith('https://en.wikipedia.org/w/api.php')) return null;
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return null;
  }
  if (params.get('action') === 'parse') return 'wikipedia-parse';
  if (params.get('titles')) return 'wikipedia-titles';
  if (params.get('generator') === 'search') return 'wikipedia-search';
  if (params.get('list') === 'search') return 'wikipedia-list-search';
  return null;
}

function geniusKind(url: string): string | null {
  if (!url.startsWith('https://api.genius.com/')) return null;
  if (url.includes('/search?')) {
    const q = new URL(url).searchParams.get('q') ?? 'search';
    return `genius-search-${q.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}`;
  }
  const id = /\/(?:songs|albums)\/(\d+)/.exec(url)?.[1];
  return id ? `genius-${url.includes('/songs/') ? 'song' : 'album'}-${id}` : null;
}

async function main(): Promise<void> {
  const dir = OUT.pathname;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const cfg = loadConfig() as ReturnType<typeof loadConfig> & { geniusToken?: string };
  const token = cfg.geniusToken?.trim();
  if (!token) throw new Error('server/config.json has no geniusToken');
  const db = openDb(':memory:');
  const http = new CachedHttp(db, cfg);
  const limiter = new RateLimiter(1000);
  const mb = new MbClient({ userAgent: cfg.userAgent, db, limiter });

  try {
    for (const album of albums) {
      console.log(`\n${album.artist} — ${album.title}`);
      // Everything cached after this rowid belongs to this album's requests.
      const since = maxCacheRowid(db);

      // MusicBrainz release-group -> Wikidata -> enwiki sitelink.
      const mbTitle = await releaseGroupWikipediaTitle(http, mb, album.releaseGroupId).catch((error: unknown) => {
        console.log(`  mb/wiki path failed: ${String(error)}`);
        return null;
      });
      console.log(`  mb release-group -> wikipedia: ${mbTitle ?? '(none)'}`);

      // Article discovery (direct candidate titles in one query).
      const titlesUrl = wikipediaTitlesUrl(candidateTitles(album));
      const titlesRes = await http.get(titlesUrl, { accept: 'application/json' });
      console.log(`  wikipedia titles: status ${titlesRes?.status ?? 'network-failure'}`);
      const pageTitle = await findAlbumPage(http, album);
      console.log(`  wikipedia page: ${pageTitle ?? '(none)'}`);
      if (pageTitle) {
        const parseRes = await http.get(wikipediaParseUrl(pageTitle), { accept: 'application/json' });
        console.log(`  wikipedia parse: status ${parseRes?.status ?? 'network-failure'}`);
      }
      saveCached(db, album.slug, since, { prefix: 'https://en.wikipedia.org/w/api.php', kind: wikipediaKind });

      // MusicBrainz / Wikidata fixtures (only the URLs we actually used).
      saveCached(db, album.slug, since, {
        prefix: 'https://musicbrainz.org/ws/2/release-group/',
        kind: () => 'mb-release-group',
      });
      saveCached(db, album.slug, since, {
        prefix: 'https://www.wikidata.org/w/api.php',
        kind: () => 'wikidata-sitelinks',
      });

      // Full fetch (also exercises section + ratings + quote parsing).
      const wiki = await fetchWikipedia(http, album, { mb, releaseGroupId: album.releaseGroupId });
      console.log(
        `  parsed: page=${wiki?.pageTitle ?? 'none'} reception=${wiki?.reception?.value.length ?? 0} background=${wiki?.background?.value.length ?? 0} scores=${wiki?.scores.length ?? 0} quotes=${wiki?.quotes.length ?? 0}`,
      );

      // Pitchfork: prefer the review URL cited by Wikipedia, then the search page.
      const pfUrl = pitchforkSearchUrl(album);
      const pfRes = await http.get(pfUrl);
      if (pfRes?.status === 200) {
        save(album.slug, 'pitchfork-search', toFixture(pfUrl, { ...pfRes, body: trimPitchforkSearch(pfRes.body) }, 'links-only'));
        const reviewUrl =
          (wiki ? pickPitchforkReferenceUrl(wiki.referenceUrls, album.title) : undefined) ?? pickPitchforkLink(pfRes.body, album);
        console.log(`  pitchfork review: ${reviewUrl ?? '(none)'}`);
        if (reviewUrl) {
          const reviewRes = await http.get(reviewUrl);
          if (reviewRes?.status === 200) {
            save(
              album.slug,
              'pitchfork-review',
              toFixture(reviewUrl, { ...reviewRes, body: trimPitchforkReview(reviewRes.body) }, 'trimmed'),
            );
          }
        }
      } else {
        console.log(`  pitchfork search: status ${pfRes?.status ?? 'network-failure'}`);
      }

      // Album of the Year (VPN exit node often gets Cloudflare 403 — expected).
      const aotyRes = await http.get(aotySearchUrl(album));
      console.log(`  aoty: status ${aotyRes?.status ?? 'network-failure'}`);

      // Genius: real API fixtures for Jar of Flies and Still Bill.
      if (album.slug === 'jar-of-flies' || album.slug === 'still-bill') {
        const tracks: TrackRef[] = album.tracks.map((title, i) => ({ id: `l:${album.id}:${i}`, title }));
        const notes = await fetchGenius(http, album, tracks, { token });
        console.log(`  genius: ${notes.length} notes (verified ${notes.filter((n) => n.verifiedArtist).length})`);
        saveCached(db, album.slug, since, {
          prefix: 'https://api.genius.com/',
          kind: geniusKind,
          transform: trimGenius,
          token,
        });
      }
    }
    console.log('\nfixtures written to', dir);
    console.log(`files: ${readdirSync(dir).length}`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
