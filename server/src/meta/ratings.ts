// Parser for Wikipedia's rendered "Professional ratings" / "Music ratings"
// tables. The wikitext templates ({{Album ratings}}, {{Music ratings}}, the
// infobox `revN`/`MC` fields) are expanded by MediaWiki into a regular wikitable,
// so we read the rendered HTML rather than trying to parse template syntax.
//
// Every helper here is exported for offline fixture tests.
import type { CheerioAPI } from 'cheerio';
import type { CriticScore } from '@liner/shared';
import type { ReviewAlbumRef } from './types.js';
import { citationUrlForCell, cellText, collectRefUrls } from './html.js';
import { cleanText, wikipediaUrl } from './text.js';

interface OutletMeta {
  defaultScale?: number;
  searchUrl?: (album: ReviewAlbumRef) => string;
}

/**
 * Letter grades have no numeric scale on Wikipedia. We map them to the same
 * 5-star scale used by {{Rating}} so the UI can render them consistently:
 * A+ 5.0, A 4.75, A− 4.5, B+ 4.25, B 4.0, B− 3.75, C+ 3.5, C 3.0, C− 2.5,
 * D+ 2.0, D 1.5, D− 1.0, F 0.
 */
const LETTER_GRADES: Record<string, number> = {
  'A+': 5,
  A: 4.75,
  'A-': 4.5,
  'B+': 4.25,
  B: 4,
  'B-': 3.75,
  'C+': 3.5,
  C: 3,
  'C-': 2.5,
  'D+': 2,
  D: 1.5,
  'D-': 1,
  F: 0,
};

/** Normalise the outlet label shown in the table's Source column. */
export function canonicalOutlet(raw: string): string | null {
  const text = cleanText(raw).replace(/^[“"'‘]+|[”"'’]+$/g, '').trim();
  if (!text) return null;
  if (/^(source|rating|review scores?|average score|aggregate score|overall score)$/i.test(text)) return null;
  if (/^metacritic$/i.test(text)) return 'Metacritic';
  if (/^(album of the year|aoty)$/i.test(text)) return 'Album of the Year';
  if (/^pitchfork( media)?$/i.test(text)) return 'Pitchfork';
  return text;
}

function outletMeta(outlet: string, album: ReviewAlbumRef): OutletMeta {
  if (outlet === 'Metacritic') {
    return {
      defaultScale: 100,
      searchUrl: (a) => `https://www.metacritic.com/search/music/${encodeURIComponent(`${a.artist} ${a.title}`)}/`,
    };
  }
  if (outlet === 'Album of the Year') {
    return {
      defaultScale: 100,
      searchUrl: (a) => `https://www.albumoftheyear.org/search/?q=${encodeURIComponent(`${a.title} ${a.artist}`)}`,
    };
  }
  if (outlet === 'Pitchfork') {
    return {
      defaultScale: 10,
      searchUrl: (a) => `https://pitchfork.com/search/?query=${encodeURIComponent(`${a.title} ${a.artist}`)}`,
    };
  }
  if (/^allmusic$/i.test(outlet)) return { defaultScale: 5 };
  void album;
  return {};
}

/** Parse one rating cell's text/title into a native score + scale. */
export function parseRatingValue(text: string, defaultScale?: number): { score: number; scale: number } | null {
  const t = cleanText(text);
  if (!t) return null;

  // "8.1/10", "4.5/5", "3/4", "74/100" (also U+2044 fraction slash).
  const slash = t.match(/(\d+(?:\.\d+)?)\s*[/⁄]\s*(\d+(?:\.\d+)?)/);
  if (slash) {
    const score = Number(slash[1]);
    const scale = Number(slash[2]);
    if (valid(score, scale)) return { score, scale };
    return null;
  }

  // "4.5 out of 5 stars".
  const outOf = t.match(/(\d+(?:\.\d+)?)\s*out of\s*(\d+(?:\.\d+)?)/i);
  if (outOf) {
    const score = Number(outOf[1]);
    const scale = Number(outOf[2]);
    if (valid(score, scale)) return { score, scale };
  }

  // "89%" (AbsolutePunk and friends).
  const pct = t.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) {
    const score = Number(pct[1]);
    if (valid(score, 100)) return { score, scale: 100 };
  }

  // Letter grade, allowing ASCII hyphen, U+2212 minus and en dash.
  const grade = t.match(/^([A-F])\s*([+\-−–]?)$/i);
  if (grade) {
    const letter = (grade[1] ?? '').toUpperCase();
    const key = `${letter}${grade[2] === '+' ? '+' : grade[2] ? '-' : ''}`;
    const score = LETTER_GRADES[key];
    if (score !== undefined) return { score, scale: 5 };
  }

  // "★★★★½" / "4 stars" (Star rating template fallback).
  const stars = t.match(/(\d+(?:\.\d+)?)\s*stars?/i);
  if (stars) {
    const score = Number(stars[1]);
    const scale = 5;
    if (valid(score, scale)) return { score, scale };
  }
  if (/^[★☆½]+$/.test(t)) {
    let score = 0;
    for (const ch of t) {
      if (ch === '★') score += 1;
      else if (ch === '½') score += 0.5;
    }
    if (score > 0 && score <= 5) return { score, scale: 5 };
  }

  // Bare number for outlets with a known native scale (Metacritic 74,
  // Pitchfork 8.1, AllMusic 4.5).
  const bare = t.match(/^(\d+(?:\.\d+)?)$/);
  if (bare && defaultScale) {
    const score = Number(bare[1]);
    if (valid(score, defaultScale)) return { score, scale: defaultScale };
  }
  return null;
}

function valid(score: number, scale: number): boolean {
  return Number.isFinite(score) && Number.isFinite(scale) && scale > 0 && score >= 0 && score <= scale;
}

/** Star ratings render as <span title="4.5/5 stars"> with no useful text. */
function ratingFromTitle($: CheerioAPI, cell: unknown): { score: number; scale: number } | null {
  const titles: string[] = [];
  $(cell as never)
    .find('[title]')
    .each((_, el) => {
      const title = $(el).attr('title');
      if (title) titles.push(title);
    });
  const ownTitle = $(cell as never).attr('title');
  if (ownTitle) titles.push(ownTitle);
  for (const title of titles) {
    const parsed = parseRatingValue(title);
    if (parsed) return parsed;
  }
  return null;
}

function isRatingsTable($: CheerioAPI, table: unknown): boolean {
  const $t = $(table as never);
  const caption = cleanText($t.find('caption').first().text());
  const head = cleanText($t.find('tr').first().text());
  // {{Album ratings}} renders "Professional ratings"; {{Music ratings}} with a
  // `title=` parameter renders e.g. "Retrospective professional reviews".
  if (/ratings|review scores|aggregate scores|critical reviews|professional reviews/i.test(caption)) return true;
  // Some skins drop the caption but keep the Review scores / Source+Rating rows.
  if (/review scores|source\s+rating/i.test(head)) return true;
  return false;
}

/**
 * Parse every ratings table on the page. Handles the rendered {{Album ratings}}
 * / {{Music ratings}} tables (rev1/rev1score…, MC, ADM and friends) and the
 * aggregate-scores table. Duplicate outlets are collapsed to the first row.
 */
export function parseRatings($: CheerioAPI, album: ReviewAlbumRef, pageTitle: string): CriticScore[] {
  const refs = collectRefUrls($);
  const scores: CriticScore[] = [];
  const seen = new Set<string>();

  for (const table of $('table').toArray()) {
    if (!isRatingsTable($, table)) continue;
    const $t = $(table);
    for (const tr of $t.find('tr').toArray()) {
      const cells = $(tr).children('td,th').toArray();
      if (cells.length < 2) continue;
      const outlet = canonicalOutlet(cellText($, cells[0]));
      if (!outlet) continue;
      const key = outlet.toLowerCase();
      if (seen.has(key)) continue;

      const scoreCell = cells[1];
      const meta = outletMeta(outlet, album);
      const parsed = ratingFromTitle($, scoreCell) ?? parseRatingValue(cellText($, scoreCell), meta.defaultScale);
      if (!parsed) continue;
      seen.add(key);

      const cited = citationUrlForCell($, scoreCell, refs);
      const url = cited ?? meta.searchUrl?.(album) ?? wikipediaUrl(pageTitle);
      const reviewCount = parseReviewCount(cellText($, scoreCell));
      scores.push({
        outlet,
        score: parsed.score,
        scale: parsed.scale,
        url,
        ...(reviewCount === undefined ? {} : { reviewCount }),
      });
    }
  }
  return scores;
}

function parseReviewCount(text: string): number | undefined {
  const m = text.match(/\(?\s*(\d[\d,]*)\s+reviews?\b/i);
  if (!m?.[1]) return undefined;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
