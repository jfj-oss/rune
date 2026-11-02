// Pitchfork reviews. Search pages and review pages carry preloaded state, which
// we read for the numeric score, author, and body paragraphs (quotes are real
// excerpts from the review, never generated).
import * as cheerio from 'cheerio';
import type { CriticQuote, CriticScore } from '@liner/shared';
import type { CachedHttp } from './http.js';
import { cleanText, namesMatch, titleSimilarity, truncateQuote } from './text.js';
import type { ReviewAlbumRef } from './metacritic.js';

export interface PitchforkResult {
  score?: CriticScore;
  quote?: CriticQuote;
}

interface PitchforkState {
  transformed?: {
    review?: {
      rating?: unknown;
      body?: unknown;
      contributors?: { author?: { items?: { name?: string }[] } };
      headerProps?: {
        dangerousHed?: string;
        artists?: { name?: string }[];
        musicRating?: { score?: unknown };
        contributors?: { author?: { items?: { name?: string }[] } };
        infoSliceFields?: { releaseYear?: string };
      };
      multiReviewHeaderProps?: { itemsReviewed?: { dangerousHed?: string; musicRating?: { score?: unknown } }[] };
    };
  };
}

export function pitchforkSearchUrl(album: ReviewAlbumRef): string {
  // Artist-first queries return server-rendered results; title-first often does
  // not (the search page hydrates client-side).
  return `https://pitchfork.com/search/?query=${encodeURIComponent(`${album.artist} ${album.title}`)}`;
}

/**
 * Pick a Pitchfork review URL cited by Wikipedia. This is more reliable than
 * the JS search page for older albums.
 */
export function pickPitchforkReferenceUrl(urls: string[], albumTitle: string): string | undefined {
  let best: { url: string; score: number } | null = null;
  for (const raw of urls) {
    let url = raw;
    try {
      const u = new URL(raw);
      if (!/(^|\.)pitchfork\.com$/.test(u.host)) continue;
      if (!u.pathname.startsWith('/reviews/albums/')) continue;
      u.protocol = 'https:';
      url = u.toString();
    } catch {
      continue;
    }
    const slug = url.replace(/\/$/, '').split('/').pop() ?? '';
    const words = slug.replace(/^\d+-/, '').replace(/-/g, ' ');
    const sim = titleSimilarity(albumTitle, words);
    if (sim < 0.6) continue;
    if (!best || sim > best.score) best = { url, score: sim };
  }
  return best?.url;
}

/** Pick the best review link from a Pitchfork search page. */
export function pickPitchforkLink(html: string, album: ReviewAlbumRef): string | null {
  const links = new Set<string>();
  for (const m of html.matchAll(/href="(\/reviews\/albums\/[^"?#]+)"/g)) if (m[1]) links.add(m[1]);
  for (const m of html.matchAll(/"url":"(\/reviews\/albums\/[^"]+)"/g)) if (m[1]) links.add(m[1].replace(/\\\//g, '/'));

  let best: { href: string; score: number } | null = null;
  for (const href of links) {
    const slug = href.replace(/\/$/, '').split('/').pop() ?? '';
    const words = slug.replace(/^\d+-/, '').replace(/-/g, ' ');
    const sim = titleSimilarity(album.title, words);
    if (sim < 0.6) continue;
    if (!best || sim > best.score) best = { href, score: sim };
  }
  if (!best) return null;
  return best.href.startsWith('http') ? best.href : `https://pitchfork.com${best.href}`;
}

function decodeEntities(s: string): string {
  return cheerio.load(`<div>${s}</div>`).text();
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function stateFromHtml(html: string): PitchforkState | null {
  const m = html.match(/window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
  if (!m?.[1]) return null;
  try {
    return JSON.parse(m[1]) as PitchforkState;
  } catch {
    return null;
  }
}

// The review body is an array-shaped HTML AST: ["div", ["p", "text", ["em", "x"]]...].
function collectNodeText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) {
    const start = typeof node[0] === 'string' ? 1 : 0;
    return node.slice(start).map(collectNodeText).join('');
  }
  return '';
}

function collectParagraphs(node: unknown, out: string[] = []): string[] {
  if (!Array.isArray(node)) return out;
  const tag = typeof node[0] === 'string' ? node[0] : '';
  if (tag === 'p') {
    const text = cleanText(collectNodeText(node));
    if (text) out.push(text);
    return out;
  }
  if (['div', 'section', 'article', 'main', 'blockquote'].includes(tag)) {
    for (const child of node.slice(1)) collectParagraphs(child, out);
  }
  return out;
}

function looksLikeLyricQuote(paragraph: string): boolean {
  if (paragraph.length > 700) return true;
  return /^["“][\s\S]*["”]$/.test(paragraph) && !/[.!?]\s+[A-Z]/.test(paragraph);
}

function quoteFromParagraphs(paragraphs: string[]): string | undefined {
  for (const p of paragraphs) {
    if (p.length >= 80 && !looksLikeLyricQuote(p)) return truncateQuote(p, 300);
  }
  const fallback = paragraphs.find((p) => p.length >= 120);
  return fallback ? truncateQuote(fallback, 300) : undefined;
}

interface LdReview {
  '@type'?: string;
  headline?: string;
  reviewBody?: string;
  author?: { name?: string } | { name?: string }[];
  reviewRating?: { ratingValue?: unknown } | unknown;
}

function scriptLdReviews(html: string): LdReview[] {
  const $ = cheerio.load(html);
  const out: LdReview[] = [];
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    try {
      const parsed = JSON.parse($(el).text()) as LdReview | LdReview[];
      for (const obj of Array.isArray(parsed) ? parsed : [parsed]) {
        if (obj && (obj['@type'] === 'Review' || obj.headline)) out.push(obj);
      }
    } catch {
      // Ignore malformed JSON-LD.
    }
  }
  return out;
}

function ldAuthorName(ld: LdReview | undefined): string | undefined {
  if (!ld?.author) return undefined;
  const author = ld.author;
  if (Array.isArray(author)) return author.map((a) => a.name).filter(Boolean).join(', ') || undefined;
  return author.name;
}

/** Parse a Pitchfork review page. Exported for fixture tests. */
export function parsePitchforkReview(html: string, url: string): PitchforkResult {
  const state = stateFromHtml(html);
  const review = state?.transformed?.review;
  const header = review?.headerProps;
  const ld = scriptLdReviews(html).find((r) => r['@type'] === 'Review') ?? scriptLdReviews(html)[0];

  let rating =
    toNumber(review?.rating) ??
    toNumber(header?.musicRating?.score) ??
    toNumber(review?.multiReviewHeaderProps?.itemsReviewed?.[0]?.musicRating?.score);
  if (rating === null) {
    const rr = ld?.reviewRating;
    if (rr && typeof rr === 'object') rating = toNumber((rr as { ratingValue?: unknown }).ratingValue);
  }

  const paragraphs = collectParagraphs(review?.body);
  const quoteText = quoteFromParagraphs(paragraphs) ?? quoteFromParagraphs(paragraphsFromLd(ld?.reviewBody));
  const author =
    review?.contributors?.author?.items?.[0]?.name ??
    header?.contributors?.author?.items?.[0]?.name ??
    ldAuthorName(ld);

  return {
    score:
      rating !== null && rating >= 0 && rating <= 10
        ? { outlet: 'Pitchfork', score: rating, scale: 10, url }
        : undefined,
    quote: quoteText ? { outlet: 'Pitchfork', quote: quoteText, url, ...(author ? { author } : {}) } : undefined,
  };
}

function paragraphsFromLd(body: string | undefined): string[] {
  if (!body) return [];
  return body
    .split(/\n{2,}|\r\n\r\n/)
    .map((p) => cleanText(decodeEntities(p)))
    .filter(Boolean);
}

/** True when a review page is plausibly about this album (guards bad wiki links). */
export function reviewMatchesAlbum(html: string, album: ReviewAlbumRef): boolean {
  const state = stateFromHtml(html);
  const title =
    decodeEntities(state?.transformed?.review?.headerProps?.dangerousHed ?? '').replace(/<[^>]+>/g, '') ||
    scriptLdReviews(html).find((r) => r['@type'] === 'Review')?.headline ||
    '';
  if (!title) return true; // Nothing to compare against; the URL came from search/wiki.
  const sim = titleSimilarity(album.title, title);
  if (sim < 0.6) return false;
  const artists = (state?.transformed?.review?.headerProps?.artists ?? []).map((a) => a.name ?? '').filter(Boolean);
  if (!artists.length) return true;
  return artists.some((a) => namesMatch(album.artist, a)) || sim >= 0.95;
}

export async function fetchPitchfork(
  http: CachedHttp,
  album: ReviewAlbumRef,
  knownUrl?: string,
): Promise<PitchforkResult> {
  let url = knownUrl && /pitchfork\.com\/reviews\/albums\//.test(knownUrl) ? knownUrl : undefined;
  if (!url) {
    const search = await http.get(pitchforkSearchUrl(album));
    if (search && search.status === 200) url = pickPitchforkLink(search.body, album) ?? undefined;
  }
  if (!url) return {};
  const page = await http.get(url);
  if (!page || page.status !== 200) return {};
  if (!reviewMatchesAlbum(page.body, album)) return {};
  return parsePitchforkReview(page.body, url);
}
