// Wikipedia: album page discovery, "Critical reception"/"Background" prose,
// critic quotes, and the ratings table (which is how we get Metacritic and
// outlet scores when the sites themselves are unavailable or blocked).
//
// Article selection order (round 2):
//   1. MusicBrainz release-group URL relationships -> Wikidata -> enwiki
//      sitelink (when the matcher filled mb_release_group_id). This is the
//      reliable path: the community already linked the album to its article.
//   2. Candidate-title lookup: "<Album> (<Artist> album)", "<Album> (album)",
//      "<Album>" (MediaWiki follows redirects and normalises "&" vs "and").
//   3. Search fallback: intitle search, then a plain search + batch validation.
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { CriticQuote, CriticScore, Sourced } from '@liner/shared';
import type { CachedHttp } from './http.js';
import type { MbClient } from '../match/mb.js';
import type { ReviewAlbumRef } from './types.js';
import { collectRefUrls, paragraphUrls } from './html.js';
import { extractQuotes, type ProseParagraph } from './quotes.js';
import { parseRatings } from './ratings.js';
import { releaseGroupWikipediaTitle } from './musicbrainz.js';
import {
  cleanText,
  namesMatch,
  stripQualifiers,
  titleSimilarity,
  truncateAtSentence,
  wikipediaUrl,
} from './text.js';

export type WikiAlbumRef = ReviewAlbumRef;

export interface WikipediaResult {
  pageTitle: string;
  reception?: Sourced<string>;
  background?: Sourced<string>;
  scores: CriticScore[];
  quotes: CriticQuote[];
  /** External URLs cited on the page; used to find direct review links. */
  referenceUrls: string[];
}

export interface WikiPage {
  pageid?: number;
  title?: string;
  index?: number;
  extract?: string;
  missing?: string;
  categories?: { title?: string }[];
}

interface GeneratorSearch {
  query?: { pages?: Record<string, WikiPage> };
}

interface ListSearch {
  query?: { search?: { title?: string }[] };
}

interface TitlesQuery {
  query?: { pages?: Record<string, WikiPage> };
}

interface ParseResponse {
  parse?: { title?: string; text?: { '*'?: string } };
}

export interface WikipediaOptions {
  /** Shared MusicBrainz client (1 req/s limiter shared with the matcher). */
  mb?: MbClient;
  /** Release-group id from the matcher; enables the Wikidata/sitelink path. */
  releaseGroupId?: string;
}

const WP_API = 'https://en.wikipedia.org/w/api.php';
const ACCEPT_JSON = { accept: 'application/json' } as const;

function luceneValue(s: string): string {
  return s.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Direct page lookup for a handful of candidate titles, in one request. */
export function wikipediaTitlesUrl(titles: string[]): string {
  const params = new URLSearchParams({
    action: 'query',
    titles: titles.join('|'),
    redirects: '1',
    prop: 'categories|extracts',
    exintro: '1',
    explaintext: '1',
    cllimit: '50',
    format: 'json',
  });
  return `${WP_API}?${params.toString()}`;
}

/** Candidate article titles, most specific first. */
export function candidateTitles(album: WikiAlbumRef): string[] {
  const title = stripQualifiers(album.title) || album.title.trim();
  const artists = new Set<string>();
  const artist = album.artist.trim();
  if (artist) {
    artists.add(artist);
    artists.add(artist.replace(/&/g, 'and'));
    artists.add(artist.replace(/\band\b/gi, '&'));
    artists.add(artist.replace(/^The\s+/i, ''));
  }
  const out: string[] = [];
  const add = (value: string): void => {
    const clean = cleanText(value);
    if (clean && !out.includes(clean)) out.push(clean);
  };
  for (const name of artists) add(`${title} (${name} album)`);
  add(`${title} (album)`);
  add(title);
  return out.slice(0, 8);
}

export function wikipediaSearchUrl(album: WikiAlbumRef): string {
  const q = `intitle:"${luceneValue(stripQualifiers(album.title))}" ${luceneValue(album.artist)}`;
  return `${WP_API}?action=query&generator=search&gsrsearch=${encodeURIComponent(
    q,
  )}&gsrlimit=10&prop=categories|extracts&exintro=1&explaintext=1&cllimit=50&format=json&redirects=1`;
}

export function wikipediaListSearchUrl(album: WikiAlbumRef): string {
  const q = `"${luceneValue(stripQualifiers(album.title))}" "${luceneValue(album.artist)}" album`;
  return `${WP_API}?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=10&format=json`;
}

export function wikipediaParseUrl(pageTitle: string): string {
  return `${WP_API}?action=parse&page=${encodeURIComponent(pageTitle)}&prop=text&format=json&redirects=1&disableeditsection=1`;
}

const ALBUM_CATEGORY = /\b(albums|EPs|extended plays|live albums|compilation albums|soundtrack albums|remix albums)\b/i;
const NOT_ALBUM_TITLE = /\b(song|single|discography|film|novel)\b/i;

/** Pick the best album-page candidate from a generator=search / titles response. */
export function pickAlbumPage(pages: WikiPage[], album: WikiAlbumRef): WikiPage | null {
  let best: { page: WikiPage; score: number } | null = null;

  for (const page of pages) {
    const title = page.title ?? '';
    if (!title || page.missing !== undefined) continue;
    if (!titleSimilarity(album.title, title)) continue;
    if (NOT_ALBUM_TITLE.test(title) && !ALBUM_CATEGORY.test((page.categories ?? []).map((c) => c.title ?? '').join(' '))) {
      continue;
    }

    const cats = (page.categories ?? []).map((c) => c.title ?? '').join(' ');
    const albumCategory = ALBUM_CATEGORY.test(cats);
    const sim = titleSimilarity(album.title, title);
    if (sim < 0.75) continue;

    const intro = page.extract ?? '';
    // Without an intro we cannot verify the artist, and a same-titled album by
    // someone else is worse than no data at all.
    if (!intro) continue;
    const artistHit = namesMatch(album.artist, intro) || normalizeContains(intro, album.artist);
    const yearHit = album.year ? intro.includes(String(album.year)) : false;
    const albumWord = /\b(album|EP|extended play|record|LP)\b/i.test(intro);
    if (!albumCategory && !artistHit && !(yearHit && sim >= 0.95)) continue;
    if (!albumCategory && !albumWord && !artistHit) continue;

    const rank = page.index === undefined ? 0.25 : 1 / (1 + page.index);
    const score =
      sim * 4 + (artistHit ? 3 : 0) + (yearHit ? 1 : 0) + (albumCategory ? 1 : 0) + rank;
    if (!best || score > best.score) best = { page, score };
  }
  return best?.page ?? null;
}

function normalizeContains(haystack: string, needle: string): boolean {
  const n = needle
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  if (!n) return false;
  const h = haystack
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return (` ${h} `).includes(` ${n} `);
}

async function pagesForTitles(http: CachedHttp, titles: string[]): Promise<WikiPage[]> {
  if (!titles.length) return [];
  const data = await http.getJson<TitlesQuery>(wikipediaTitlesUrl(titles), ACCEPT_JSON);
  return Object.values(data?.query?.pages ?? {});
}

export async function findAlbumPage(http: CachedHttp, album: WikiAlbumRef): Promise<string | null> {
  // 1. Direct candidate titles ("Discovery (Daft Punk album)", "Discovery (album)",
  //    "Discovery") in a single query; redirects are followed by MediaWiki.
  const direct = await pagesForTitles(http, candidateTitles(album));
  const pickedDirect = pickAlbumPage(direct, album);
  if (pickedDirect?.title) return pickedDirect.title;

  // 2. Generator search keeps categories + intros in one request.
  const search = await http.getJson<GeneratorSearch>(wikipediaSearchUrl(album), ACCEPT_JSON);
  const picked = pickAlbumPage(Object.values(search?.query?.pages ?? {}), album);
  if (picked?.title) return picked.title;

  // 3. Plain search, then validate the top titles in a second batch request.
  const fallback = await http.getJson<ListSearch>(wikipediaListSearchUrl(album), ACCEPT_JSON);
  const titles = (fallback?.query?.search ?? [])
    .map((r) => r.title ?? '')
    .filter((t) => t && titleSimilarity(album.title, t) >= 0.75)
    .slice(0, 10);
  const pickedFallback = pickAlbumPage(await pagesForTitles(http, titles), album);
  return pickedFallback?.title ?? null;
}

export interface Section {
  heading: string;
  id?: string;
  level: 2 | 3;
  nodes: unknown[];
}

function collectSections($: CheerioAPI): Section[] {
  const root = $('.mw-parser-output').first();
  const scope = root.length ? root : $('body');
  const sections: Section[] = [];
  for (const h of scope.find('h2,h3').toArray()) {
    const tag = (h as { tagName?: string }).tagName?.toLowerCase();
    if (tag !== 'h2' && tag !== 'h3') continue;
    const $h = $(h);
    const wrapper = $h.closest('.mw-heading');
    const anchor = wrapper.length ? wrapper : $h;
    const nodes: unknown[] = [];
    let next = anchor.next();
    while (next.length) {
      const el = next.get(0);
      const tagName = (el as { tagName?: string } | undefined)?.tagName?.toLowerCase();
      if (tagName === 'h2' || tagName === 'h3') break;
      if (tagName === 'div' && next.hasClass('mw-heading')) break;
      nodes.push(el);
      next = next.next();
    }
    sections.push({ heading: cleanText($h.text()), id: $h.attr('id'), level: tag === 'h2' ? 2 : 3, nodes });
  }
  return sections;
}

const RECEPTION_PATTERNS: { re: RegExp; score: number }[] = [
  { re: /^critical reception( and legacy)?$/i, score: 9 },
  { re: /^critical response$/i, score: 9 },
  { re: /^critical reception and response$/i, score: 9 },
  { re: /^reception$/i, score: 8 },
  { re: /^release and reception$/i, score: 8 },
  { re: /^reception and legacy$/i, score: 8 },
  { re: /^reception and awards$/i, score: 7 },
  { re: /^legacy$/i, score: 5 },
  { re: /^(critical )?(reception|response)\b/i, score: 4 },
  { re: /\breception\b/i, score: 2 },
];
const RECEPTION_EXCLUDE = /commercial|chart|award|accolade|certification|personnel|track listing|references|discography/i;

const BACKGROUND_PATTERNS: { re: RegExp; score: number }[] = [
  { re: /^background( and recording)?$/i, score: 9 },
  { re: /^recording( and production)?$/i, score: 8 },
  { re: /^background and recording$/i, score: 9 },
  { re: /^writing and recording$/i, score: 8 },
  { re: /^production$/i, score: 5 },
  { re: /^composition$/i, score: 5 },
  { re: /^music and lyrics$/i, score: 6 },
  { re: /^music and composition$/i, score: 6 },
  { re: /^background\b/i, score: 4 },
];
const BACKGROUND_EXCLUDE = /reception|track listing|personnel|charts?|certification|references|external|further|discography|legacy|release|single/i;

function pickSection(
  sections: Section[],
  patterns: { re: RegExp; score: number }[],
  exclude: RegExp,
): Section | undefined {
  let best: { section: Section; score: number } | undefined;
  for (const section of sections) {
    if (exclude.test(section.heading)) continue;
    let score = 0;
    for (const p of patterns) {
      if (p.re.test(section.heading)) score = Math.max(score, p.score);
    }
    if (score > 0 && (!best || score > best.score)) best = { section, score };
  }
  return best?.section;
}

/** Exported for the heading-acceptance tests. */
export function pickReceptionSection(sections: Section[]): Section | undefined {
  return pickSection(sections, RECEPTION_PATTERNS, RECEPTION_EXCLUDE);
}

/** Exported for the heading-acceptance tests. */
export function pickBackgroundSection(sections: Section[]): Section | undefined {
  return pickSection(sections, BACKGROUND_PATTERNS, BACKGROUND_EXCLUDE);
}

function paragraphFromNode($: CheerioAPI, node: unknown, refs: Map<string, string>): ProseParagraph | null {
  const $p = $(node as never).clone();
  $p.find(
    'sup.reference, sup, .mw-editsection, style, script, table, figure, .thumb, .infobox, .navbox, .hatnote, .mw-empty-elt, .cite-bracket',
  ).remove();
  const text = cleanText($p.text());
  if (text.length < 60) return null;
  return { text, urls: paragraphUrls($, node, refs) };
}

function sectionParagraphs($: CheerioAPI, section: Section | undefined, refs: Map<string, string>): ProseParagraph[] {
  if (!section) return [];
  const out: ProseParagraph[] = [];
  const seen = new Set<string>();
  for (const node of section.nodes) {
    const tag = (node as { tagName?: string }).tagName?.toLowerCase();
    if (tag === 'table' || tag === 'ul' || tag === 'ol' || tag === 'figure') continue;
    const $n = $(node as never);
    const candidates: unknown[] = tag === 'p' ? [node] : tag === 'div' || tag === 'section' ? $n.find('p').toArray() : [];
    for (const p of candidates) {
      const parsed = paragraphFromNode($, p, refs);
      if (parsed && !seen.has(parsed.text)) {
        seen.add(parsed.text);
        out.push(parsed);
      }
    }
  }
  return out;
}

/** Lead paragraphs, used only as a reception fallback when no section exists. */
function leadParagraphs($: CheerioAPI, refs: Map<string, string>): ProseParagraph[] {
  const root = $('.mw-parser-output').first();
  const scope = root.length ? root : $('body');
  const out: ProseParagraph[] = [];
  for (const p of scope.children('p').toArray()) {
    const parsed = paragraphFromNode($, p, refs);
    if (parsed) out.push(parsed);
  }
  return out;
}

const LEAD_RECEPTION_HINT = /\b(reviews?|reviewers?|critics?|critically|acclaim|praised|praise)\b/i;

function receptionParagraphsWithFallback(
  $: CheerioAPI,
  section: Section | undefined,
  refs: Map<string, string>,
): { paragraphs: ProseParagraph[]; section?: Section } {
  let fromSection = sectionParagraphs($, section, refs);
  // Combined "Release and reception" sections often open with release/single
  // information. Start at the first paragraph that actually discusses reviews.
  if (section && /\brelease\b/i.test(section.heading) && fromSection.length > 1) {
    // A review paragraph can be recognisable by an attributed critic even when
    // it never uses the word "review" ("Paul Evans of Rolling Stone called...").
    const startsReception = (p: ProseParagraph): boolean =>
      LEAD_RECEPTION_HINT.test(p.text) || extractQuotes([p], '', 1).length > 0;
    const firstReview = fromSection.findIndex(startsReception);
    if (firstReview > 0) fromSection = fromSection.slice(firstReview);
  }
  if (fromSection.length) return { paragraphs: fromSection, ...(section ? { section } : {}) };
  const lead = leadParagraphs($, refs).filter((p) => LEAD_RECEPTION_HINT.test(p.text));
  if (lead.length) return { paragraphs: lead.slice(0, 1) };
  return { paragraphs: [] };
}

function paragraphsValue(
  paragraphs: ProseParagraph[],
  pageTitle: string,
  section: Section | undefined,
  max: number,
): Sourced<string> | undefined {
  if (!paragraphs.length) return undefined;
  const value = truncateAtSentence(paragraphs.map((p) => p.text).join('\n\n'), max);
  if (value.length < 60) return undefined;
  return {
    value,
    source: 'Wikipedia',
    url: wikipediaUrl(pageTitle, section?.id ?? section?.heading),
  };
}

export async function fetchWikipedia(
  http: CachedHttp,
  album: WikiAlbumRef,
  opts: WikipediaOptions = {},
): Promise<WikipediaResult | null> {
  let fromMusicBrainz = false;
  let pageTitle: string | null = null;

  if (opts.mb && opts.releaseGroupId) {
    pageTitle = await releaseGroupWikipediaTitle(http, opts.mb, opts.releaseGroupId).catch(() => null);
    fromMusicBrainz = Boolean(pageTitle);
  }
  if (!pageTitle) pageTitle = await findAlbumPage(http, album);
  if (!pageTitle) return null;

  let parsed = await http.getJson<ParseResponse>(wikipediaParseUrl(pageTitle), ACCEPT_JSON);
  let html = parsed?.parse?.text?.['*'];
  if (!html && fromMusicBrainz) {
    // A stale Wikidata sitelink: fall back to title/search selection.
    pageTitle = await findAlbumPage(http, album);
    if (!pageTitle) return null;
    parsed = await http.getJson<ParseResponse>(wikipediaParseUrl(pageTitle), ACCEPT_JSON);
    html = parsed?.parse?.text?.['*'];
  }
  if (!html) return null;

  const canonical = parsed?.parse?.title ?? pageTitle;
  const $ = cheerio.load(html);
  const refs = collectRefUrls($);
  const sections = collectSections($);

  const receptionSection = pickReceptionSection(sections);
  const receptionPick = receptionParagraphsWithFallback($, receptionSection, refs);
  const backgroundSection = pickBackgroundSection(sections);
  const backgroundParagraphs = sectionParagraphs($, backgroundSection, refs);

  const reception = paragraphsValue(receptionPick.paragraphs, canonical, receptionPick.section, 2400);
  const background = paragraphsValue(backgroundParagraphs, canonical, backgroundSection, 2200);
  const quotes = extractQuotes(receptionPick.paragraphs, wikipediaUrl(canonical), 4);

  return {
    pageTitle: canonical,
    ...(reception ? { reception } : {}),
    ...(background ? { background } : {}),
    scores: parseRatings($, album, canonical),
    quotes,
    referenceUrls: [...refs.values()],
  };
}
