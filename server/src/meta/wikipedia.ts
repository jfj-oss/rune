// Wikipedia: album page discovery, "Critical reception"/"Background" prose, and
// the ratings table (which is how we get Metacritic/Pitchfork/AOTY scores when
// the sites themselves are unavailable or blocked).
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { CriticScore, Sourced } from '@liner/shared';
import type { CachedHttp } from './http.js';
import { cleanText, namesMatch, titleSimilarity, truncateAtSentence, wikipediaUrl } from './text.js';

export interface WikiAlbumRef {
  id: string;
  title: string;
  artist: string;
  year?: number;
}

export interface WikipediaResult {
  pageTitle: string;
  reception?: Sourced<string>;
  background?: Sourced<string>;
  scores: CriticScore[];
  /** External URLs cited on the page; used to find direct review links. */
  referenceUrls: string[];
}

export interface WikiPage {
  pageid?: number;
  title?: string;
  index?: number;
  extract?: string;
  categories?: { title?: string }[];
}

interface GeneratorSearch {
  query?: { pages?: Record<string, WikiPage> };
}

interface ListSearch {
  query?: { search?: { title?: string }[] };
}

interface ParseResponse {
  parse?: { title?: string; text?: { '*'?: string } };
}

const WP_API = 'https://en.wikipedia.org/w/api.php';
const ACCEPT_JSON = { accept: 'application/json' } as const;

function luceneValue(s: string): string {
  return s.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function wikipediaSearchUrl(album: WikiAlbumRef): string {
  const q = `intitle:"${luceneValue(album.title)}" ${luceneValue(album.artist)}`;
  return `${WP_API}?action=query&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=10&prop=categories|extracts&exintro=1&explaintext=1&cllimit=50&format=json&redirects=1`;
}

export function wikipediaPlainSearchUrl(album: WikiAlbumRef): string {
  const q = `"${luceneValue(album.title)}" "${luceneValue(album.artist)}" album`;
  return `${WP_API}?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=10&format=json`;
}

export function wikipediaParseUrl(pageTitle: string): string {
  return `${WP_API}?action=parse&page=${encodeURIComponent(pageTitle)}&prop=text&format=json&redirects=1&disableeditsection=1`;
}

const ALBUM_CATEGORY = /\b(albums|EPs|extended plays|live albums|compilation albums|soundtrack albums|remix albums)\b/i;

/** Pick the best album-page candidate from a generator=search response. */
export function pickAlbumPage(pages: WikiPage[], album: WikiAlbumRef): WikiPage | null {
  let best: { page: WikiPage; score: number } | null = null;

  for (const page of pages) {
    const title = page.title ?? '';
    if (!title) continue;
    const cats = (page.categories ?? []).map((c) => c.title ?? '').join(' ');
    if (!ALBUM_CATEGORY.test(cats)) continue;
    const sim = titleSimilarity(album.title, title);
    if (sim < 0.75) continue;

    const intro = page.extract ?? '';
    // Without an intro we cannot verify the artist, and a same-titled album by
    // someone else is worse than no data at all.
    if (!intro) continue;
    const artistHit = namesMatch(album.artist, intro) || intro.toLowerCase().includes(album.artist.toLowerCase());
    const yearHit = album.year ? intro.includes(String(album.year)) : false;
    if (!artistHit && !(yearHit && sim >= 0.95)) continue;

    const rank = page.index === undefined ? 0 : 1 / (1 + page.index);
    const score = sim * 4 + (artistHit ? 2 : 0) + (yearHit ? 1 : 0) + rank;
    if (!best || score > best.score) best = { page, score };
  }
  return best?.page ?? null;
}

export async function findAlbumPage(http: CachedHttp, album: WikiAlbumRef): Promise<string | null> {
  const search = await http.getJson<GeneratorSearch>(wikipediaSearchUrl(album), ACCEPT_JSON);
  const pages = Object.values(search?.query?.pages ?? {});
  const picked = pickAlbumPage(pages, album);
  if (picked?.title) return picked.title;

  // Fallback: plain list search, then use the first few titles. This path does
  // not have categories, so we only accept a title that is an exact match and
  // contains the artist or year in the search result title itself.
  const fallback = await http.getJson<ListSearch>(wikipediaPlainSearchUrl(album), ACCEPT_JSON);
  const titles = (fallback?.query?.search ?? []).map((r) => r.title ?? '').filter(Boolean);
  for (const title of titles.slice(0, 5)) {
    if (titleSimilarity(album.title, title) >= 0.95) return title;
  }
  return null;
}

interface Section {
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
      // Stop at the references/external-links machinery, which can be huge.
      nodes.push(el);
      next = next.next();
    }
    sections.push({ heading: cleanText($h.text()), id: $h.attr('id'), level: tag === 'h2' ? 2 : 3, nodes });
  }
  return sections;
}

const RECEPTION_PATTERNS: { re: RegExp; score: number }[] = [
  { re: /^critical (reception|response|reviews?)$/i, score: 6 },
  { re: /^critical (reception|response|reviews?)\b/i, score: 5 },
  { re: /^(release and )?reception$/i, score: 5 },
  { re: /^reception$/i, score: 4 },
  { re: /\b(critical reception|critical response)\b/i, score: 4 },
  { re: /\breception\b/i, score: 2 },
];
const RECEPTION_EXCLUDE = /commercial|chart|award|accolade|legacy|certification|personnel|track listing|references/i;

const BACKGROUND_PATTERNS: { re: RegExp; score: number }[] = [
  { re: /^background( and recording)?$/i, score: 6 },
  { re: /^background and recording$/i, score: 6 },
  { re: /^recording( and production)?$/i, score: 5 },
  { re: /^writing and recording$/i, score: 5 },
  { re: /^production$/i, score: 4 },
  { re: /^background\b/i, score: 4 },
  { re: /^composition$/i, score: 2 },
];
const BACKGROUND_EXCLUDE = /reception|track listing|personnel|charts?|certification|references|external|further|discography|legacy|release/i;

function pickSection(sections: Section[], patterns: { re: RegExp; score: number }[], exclude: RegExp): Section | undefined {
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

function sectionParagraphs($: CheerioAPI, section: Section | undefined): string[] {
  if (!section) return [];
  const out: string[] = [];
  for (const node of section.nodes) {
    const $n = $(node as never);
    const tag = (node as { tagName?: string }).tagName?.toLowerCase();
    const candidates: unknown[] =
      tag === 'p' ? [node] : tag === 'div' || tag === 'section' ? $n.find('p').toArray() : [];
    for (const p of candidates) {
      const $p = $(p as never).clone();
      $p.find(
        'sup.reference, sup, .mw-editsection, style, script, table, figure, .thumb, .infobox, .navbox, .hatnote, .mw-empty-elt, .cite-bracket',
      ).remove();
      const text = cleanText($p.text());
      if (text.length >= 60 && !out.includes(text)) out.push(text);
    }
  }
  return out;
}

function sectionValue($: CheerioAPI, section: Section | undefined, pageTitle: string, max: number): Sourced<string> | undefined {
  const paragraphs = sectionParagraphs($, section);
  if (!paragraphs.length) return undefined;
  const value = truncateAtSentence(paragraphs.join('\n\n'), max);
  if (value.length < 60) return undefined;
  return {
    value,
    source: 'Wikipedia',
    url: wikipediaUrl(pageTitle, section?.id ?? section?.heading),
  };
}

export async function fetchWikipedia(http: CachedHttp, album: WikiAlbumRef): Promise<WikipediaResult | null> {
  const pageTitle = await findAlbumPage(http, album);
  if (!pageTitle) return null;
  const parsed = await http.getJson<ParseResponse>(wikipediaParseUrl(pageTitle), ACCEPT_JSON);
  const html = parsed?.parse?.text?.['*'];
  if (!html) return null;
  const canonical = parsed?.parse?.title ?? pageTitle;
  const $ = cheerio.load(html);
  const sections = collectSections($);

  const receptionSection = pickSection(sections, RECEPTION_PATTERNS, RECEPTION_EXCLUDE);
  const backgroundSection = pickSection(sections, BACKGROUND_PATTERNS, BACKGROUND_EXCLUDE);
  return {
    pageTitle: canonical,
    reception: sectionValue($, receptionSection, canonical, 2400),
    background: sectionValue($, backgroundSection, canonical, 2200),
    scores: parseRatings($, album),
    referenceUrls: [...collectRefUrls($).values()],
  };
}

// ---------- ratings table ----------

interface OutletInfo {
  outlet: string;
  defaultScale?: number;
  host: string;
  searchUrl: (album: WikiAlbumRef) => string;
}

const OUTLETS: { re: RegExp; info: OutletInfo }[] = [
  {
    re: /^metacritic$/i,
    info: {
      outlet: 'Metacritic',
      defaultScale: 100,
      host: 'metacritic.com',
      searchUrl: (a) => `https://www.metacritic.com/search/music/${encodeURIComponent(`${a.artist} ${a.title}`)}/`,
    },
  },
  {
    re: /^(album of the year|album ?of ?the ?year|aoty)$/i,
    info: {
      outlet: 'Album of the Year',
      defaultScale: 100,
      host: 'albumoftheyear.org',
      searchUrl: (a) => `https://www.albumoftheyear.org/search/?q=${encodeURIComponent(`${a.title} ${a.artist}`)}`,
    },
  },
  {
    re: /^pitchfork( media)?$/i,
    info: {
      outlet: 'Pitchfork',
      defaultScale: 10,
      host: 'pitchfork.com',
      searchUrl: (a) => `https://pitchfork.com/search/?query=${encodeURIComponent(`${a.title} ${a.artist}`)}`,
    },
  },
];

function outletInfo(raw: string): OutletInfo | null {
  for (const o of OUTLETS) if (o.re.test(raw.trim())) return o.info;
  return null;
}

function cellText($: CheerioAPI, cell: unknown): string {
  const $cell = $(cell as never).clone();
  $cell.find('sup, .reference, .cite-bracket').remove();
  return cleanText($cell.text());
}

function collectRefUrls($: CheerioAPI): Map<string, string> {
  const refs = new Map<string, string>();
  $('li[id^="cite_note-"]').each((_, li) => {
    const id = $(li).attr('id');
    if (!id) return;
    const links = $(li).find('a[href^="http"]').toArray();
    const preferred = links.find((a) => !/web\.archive\.org|archive\.(today|is|ph)/i.test($(a).attr('href') ?? ''));
    const href = $(preferred ?? links[0] ?? li).attr('href');
    if (href && /^https?:/.test(href)) refs.set(id, href);
  });
  return refs;
}

function citationUrlForCell($: CheerioAPI, cell: unknown, refs: Map<string, string>): string | undefined {
  const href = $(cell as never).find('a[href^="#cite_note-"]').first().attr('href');
  if (!href) return undefined;
  return refs.get(href.slice(1));
}

function parseRating(text: string, defaultScale?: number): { score: number; scale: number } | null {
  const t = text.replace(/\s+/g, ' ').trim();
  const slash = t.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  if (slash) {
    const score = Number(slash[1]);
    const scale = Number(slash[2]);
    if (Number.isFinite(score) && Number.isFinite(scale) && scale > 0 && score >= 0 && score <= scale) return { score, scale };
    return null;
  }
  const single = t.match(/^(\d+(?:\.\d+)?)$/);
  if (single && defaultScale) {
    const score = Number(single[1]);
    if (Number.isFinite(score) && score >= 0 && score <= defaultScale) return { score, scale: defaultScale };
  }
  return null;
}

function hostMatches(url: string, host: string): boolean {
  try {
    const h = new URL(url).host;
    return h === host || h.endsWith(`.${host}`);
  } catch {
    return false;
  }
}

/** Parse the "Professional ratings" wikitable. Exported for fixture tests. */
export function parseRatings($: CheerioAPI, album: WikiAlbumRef): CriticScore[] {
  const refs = collectRefUrls($);
  const scores: CriticScore[] = [];
  const tables = $('table').toArray();
  for (const table of tables) {
    const $t = $(table);
    const header = `${cleanText($t.find('caption').first().text())} ${cleanText($t.text()).slice(0, 260)}`;
    if (!/professional ratings|aggregate scores|review scores/i.test(header)) continue;

    $t.find('tr').each((_, tr) => {
      const cells = $(tr).children('td,th').toArray();
      if (cells.length < 2) return;
      const outletRaw = cellText($, cells[0]);
      if (!outletRaw || /^source$/i.test(outletRaw)) return;
      const info = outletInfo(outletRaw);
      if (!info) return;
      const parsed = parseRating(cellText($, cells[1]), info.defaultScale);
      if (!parsed) return;
      if (scores.some((s) => s.outlet === info.outlet)) return;
      const cited = citationUrlForCell($, cells[1], refs);
      const normalizedCited = cited?.replace(/^http:\/\//i, 'https://');
      const url = normalizedCited && hostMatches(normalizedCited, info.host) ? normalizedCited : info.searchUrl(album);
      scores.push({ outlet: info.outlet, score: parsed.score, scale: parsed.scale, url });
    });
    if (scores.length) break;
  }
  return scores;
}
