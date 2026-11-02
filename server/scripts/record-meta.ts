// Records real responses for the meta unit tests. Network is allowed here only.
// Run: pnpm -C server exec tsx scripts/record-meta.ts
//
// Fixtures are stored as { url, status, contentType, body } JSON files under
// tests/fixtures/meta/. Pitchfork pages are trimmed to the data the parser
// needs (preloaded review state + JSON-LD) because the raw pages are ~1 MB.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';
import { CachedHttp } from '../src/meta/http.js';
import { fetchWikipedia, findAlbumPage, wikipediaParseUrl, wikipediaSearchUrl, type WikiAlbumRef } from '../src/meta/wikipedia.js';
import { metacriticSearchUrl } from '../src/meta/metacritic.js';
import { pickPitchforkLink, pickPitchforkReferenceUrl, pitchforkSearchUrl } from '../src/meta/pitchfork.js';
import { aotySearchUrl } from '../src/meta/albumoftheyear.js';
import { geniusAlbumUrl, geniusSearchUrl } from '../src/meta/genius.js';

const OUT = new URL('../tests/fixtures/meta/', import.meta.url);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const albums: (WikiAlbumRef & { slug: string })[] = [
  { id: 'la:discovery', slug: 'discovery', title: 'Discovery', artist: 'Daft Punk', year: 2001 },
  { id: 'la:jar', slug: 'jar-of-flies', title: 'Jar of Flies', artist: 'Alice In Chains', year: 1994 },
  { id: 'la:still-bill', slug: 'still-bill', title: 'Still Bill', artist: 'Bill Withers', year: 1972 },
  { id: 'la:uprising', slug: 'uprising', title: 'Uprising', artist: 'Bob Marley & The Wailers', year: 1980 },
  { id: 'la:fire', slug: 'fire-of-unknown-origin', title: 'Fire of Unknown Origin', artist: 'Blue Öyster Cult', year: 1981 },
];

interface Fixture {
  url: string;
  status: number;
  contentType?: string;
  body: string;
  note?: string;
}

function save(slug: string, name: string, fixture: Fixture): void {
  const file = new URL(`${slug}--${name}.json`, OUT);
  writeFileSync(file, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`  saved ${slug}--${name}.json (${fixture.body.length} bytes, status ${fixture.status})`);
}

function fixture(url: string, res: { status: number; body: string; contentType?: string }, note?: string): Fixture {
  return { url, status: res.status, body: res.body, ...(res.contentType ? { contentType: res.contentType } : {}), ...(note ? { note } : {}) };
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
    const state = JSON.parse(stateMatch[1]) as {
      transformed?: { review?: Record<string, unknown> };
    };
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

async function main(): Promise<void> {
  const dir = OUT.pathname;
  mkdirSync(dir, { recursive: true });
  const cfg = loadConfig();
  const db = openDb(':memory:');
  const http = new CachedHttp(db, cfg);

  for (const album of albums) {
    console.log(`\n${album.artist} — ${album.title}`);

    // Wikipedia page discovery.
    const searchRes = await http.get(wikipediaSearchUrl(album), { accept: 'application/json' });
    if (searchRes) save(album.slug, 'wikipedia-search', fixture(wikipediaSearchUrl(album), searchRes));
    await sleep(1200);

    const pageTitle = await findAlbumPage(http, album);
    console.log(`  wikipedia page: ${pageTitle ?? '(none)'}`);
    if (pageTitle) {
      const parseRes = await http.get(wikipediaParseUrl(pageTitle), { accept: 'application/json' });
      if (parseRes) save(album.slug, 'wikipedia-parse', fixture(wikipediaParseUrl(pageTitle), parseRes));
      await sleep(1200);
    }

    // Metacritic frontend API (same query as fetchMetacritic).
    const mcUrl = metacriticSearchUrl(`${album.title} ${album.artist}`);
    const mcRes = await http.get(mcUrl, { accept: 'application/json' });
    if (mcRes) save(album.slug, 'metacritic-search', fixture(mcUrl, mcRes));
    await sleep(700);

    // Pitchfork: prefer the review URL cited by Wikipedia, then the search page.
    const wiki = await fetchWikipedia(http, album);
    const pfUrl = pitchforkSearchUrl(album);
    const pfRes = await http.get(pfUrl);
    if (pfRes) {
      save(album.slug, 'pitchfork-search', fixture(pfUrl, { ...pfRes, body: trimPitchforkSearch(pfRes.body) }, 'links-only'));
      const reviewUrl =
        (wiki ? pickPitchforkReferenceUrl(wiki.referenceUrls, album.title) : undefined) ??
        pickPitchforkLink(pfRes.body, album);
      console.log(`  pitchfork review: ${reviewUrl ?? '(none)'}`);
      if (reviewUrl) {
        const reviewRes = await http.get(reviewUrl);
        if (reviewRes) save(album.slug, 'pitchfork-review', fixture(reviewUrl, { ...reviewRes, body: trimPitchforkReview(reviewRes.body) }, 'trimmed'));
      }
      await sleep(700);
    }

    // Album of the Year (expected to be Cloudflare-blocked on many networks).
    const aotyRes = await http.get(aotySearchUrl(album));
    console.log(`  aoty: status ${aotyRes?.status ?? 'network-failure'}`);
    await sleep(500);

    // Genius (expected to be Cloudflare-blocked; record one 403 for the
    // graceful-degradation test).
    if (album.slug === 'discovery') {
      const gUrl = geniusSearchUrl(album);
      const gRes = await http.get(gUrl, { accept: 'application/json' });
      if (gRes) save(album.slug, 'genius-search', fixture(gUrl, gRes, 'blocked'));
      const albumUrl = geniusAlbumUrl(album);
      const gAlbum = await http.get(albumUrl);
      if (gAlbum) save(album.slug, 'genius-album', fixture(albumUrl, gAlbum, 'blocked'));
      await sleep(900);
    }
  }
  console.log('\nfixtures written to', dir);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
