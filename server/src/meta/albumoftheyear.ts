// Album of the Year (albumoftheyear.org). The site is Cloudflare-protected in
// some networks, so misses degrade gracefully; the Wikipedia ratings table is a
// second source for the same score. Parsers are exported for fixture tests.
import * as cheerio from 'cheerio';
import type { CriticScore } from '@liner/shared';
import type { CachedHttp } from './http.js';
import { cleanText, titleSimilarity } from './text.js';
import type { ReviewAlbumRef } from './metacritic.js';

export interface AotyResult {
  score?: CriticScore;
}

export function aotySearchUrl(album: ReviewAlbumRef): string {
  return `https://www.albumoftheyear.org/search/?q=${encodeURIComponent(`${album.title} ${album.artist}`)}`;
}

/** Extract /album/<id>-<slug>.php links from a search page. */
export function pickAotyLink(html: string, album: ReviewAlbumRef): string | null {
  const $ = cheerio.load(html);
  const links = new Set<string>();
  $('a[href*="/album/"]').each((_, a) => {
    const href = $(a).attr('href');
    if (href && /\/album\/\d+-[^/?#"]+\.php/.test(href)) links.add(href);
  });
  // Fall back to a raw regex for trimmed fixtures / non-standard markup.
  for (const m of html.matchAll(/href="(\/album\/\d+-[^"?#]+\.php)"/g)) if (m[1]) links.add(m[1]);

  let best: { href: string; score: number } | null = null;
  for (const href of links) {
    const slug = href.split('/').pop() ?? '';
    const words = slug.replace(/\.php$/, '').replace(/^\d+-/, '').replace(/-/g, ' ');
    const sim = titleSimilarity(album.title, words);
    if (sim < 0.45) continue;
    if (!best || sim > best.score) best = { href, score: sim };
  }
  if (!best) return null;
  const base = 'https://www.albumoftheyear.org';
  return best.href.startsWith('http') ? best.href : `${base}${best.href}`;
}

/** Extract the primary /100 score from an AOTY album page. */
export function parseAotyScore(html: string): number | null {
  const $ = cheerio.load(html);

  // 1. Schema.org aggregate rating, when present.
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    const raw = $(el).text();
    try {
      const parsed = JSON.parse(raw) as unknown;
      const value = findAggregateRating(parsed);
      if (value !== null) return clampScore(value);
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  }

  // 2. itemprop/meta rating values.
  const itemProp = $('[itemprop="ratingValue"]').first();
  const itemValue = Number(itemProp.attr('content') ?? itemProp.text());
  if (Number.isFinite(itemValue) && itemValue > 0) return clampScore(itemValue);

  // 3. Explicit "79 / 100" text anywhere on the page.
  const text = cleanText($('body').text());
  const slash = text.match(/\b(\d{2,3})\s*\/\s*100\b/);
  if (slash) return clampScore(Number(slash[1]));

  // 4. Score boxes: a class containing "score" whose text is a 1-3 digit number.
  const scoreBoxes = $('[class*="score" i]').toArray();
  for (const box of scoreBoxes) {
    const value = cleanText($(box).text()).match(/^(\d{1,3})(?:\.\d+)?$/);
    if (value) {
      const n = Number(value[1]);
      if (n >= 1 && n <= 100) return n;
    }
  }
  return null;
}

function clampScore(value: number): number | null {
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function findAggregateRating(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const rating = obj.aggregateRating;
  if (rating && typeof rating === 'object') {
    const rv = (rating as Record<string, unknown>).ratingValue;
    const n = typeof rv === 'string' ? Number(rv) : typeof rv === 'number' ? rv : NaN;
    if (Number.isFinite(n)) return n;
  }
  for (const v of Object.values(obj)) {
    const found = findAggregateRating(v);
    if (found !== null) return found;
  }
  return null;
}

export async function fetchAoty(http: CachedHttp, album: ReviewAlbumRef): Promise<AotyResult> {
  const search = await http.get(aotySearchUrl(album));
  if (!search || search.status !== 200) return {};
  const link = pickAotyLink(search.body, album);
  if (!link) return {};
  const page = await http.get(link);
  if (!page || page.status !== 200) return {};
  const score = parseAotyScore(page.body);
  if (score === null) return {};
  return { score: { outlet: 'Album of the Year', score, scale: 100, url: link } };
}
