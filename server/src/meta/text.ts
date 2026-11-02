// Small text helpers shared by the meta sources. Deliberately dependency-free so
// parsers can be unit tested without cheerio.
import { normalizeName } from '../db/index.js';

/** Collapse whitespace and trim. */
export function cleanText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Remove release qualifiers that review sites add to album titles:
 * "[Deluxe Edition]", "(Remastered)", " - 2011 Remaster", etc.
 * Parentheticals are stripped only when they look like qualifiers (they contain a
 * known edition word) so "(What's the Story) Morning Glory?" survives.
 */
export function stripQualifiers(title: string): string {
  let out = title;
  // Bracketed suffixes are almost always release junk; keep bracketed words that
  // are part of the title (rare) by only stripping when the bracket contains a
  // digit or a known edition marker.
  out = out.replace(/\s*[[(]([^\])]*)[\])]/g, (whole, inner: string) => {
    if (
      /\b(deluxe|remaster\w*|edition|expanded|anniversary|bonus|reissue|special|collector|explicit|digitally|mono|stereo|single|ep|lp|cd|vinyl|album|song)\b/i.test(
        inner,
      ) ||
      /\d{4}/.test(inner)
    ) {
      return ' ';
    }
    return whole;
  });
  out = out.replace(/\s+-\s+.*\b(remaster\w*|edition|version|mix)\b.*$/i, ' ');
  out = out.replace(/\b(deluxe|remastered|remaster|anniversary|expanded|reissue|special edition)\s+(edition|version)?\b/gi, ' ');
  return cleanText(out);
}

/** Normalize a title for comparison (lowercase, diacritics/punctuation stripped). */
export function normalizeTitle(title: string): string {
  return normalizeName(title);
}

function tokenSet(s: string): Set<string> {
  return new Set(s.split(' ').filter(Boolean));
}

/** 0..1 token Dice similarity for normalized strings. */
export function similarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const A = tokenSet(na);
  const B = tokenSet(nb);
  let common = 0;
  for (const t of A) if (B.has(t)) common++;
  const dice = (2 * common) / (A.size + B.size);
  // One title contained in the other ("discovery" in "discovery live") is a
  // decent signal, but never let it beat an exact match.
  const contained = na.includes(nb) || nb.includes(na) ? 0.75 : 0;
  return Math.max(dice, contained);
}

/** Compare two album titles, ignoring release qualifiers. */
export function titleSimilarity(a: string, b: string): number {
  return Math.max(similarity(a, b), similarity(stripQualifiers(a), stripQualifiers(b)));
}

export function titlesMatch(a: string, b: string, min = 0.8): boolean {
  return titleSimilarity(a, b) >= min;
}

/**
 * Compare artist names. Exact normalized equality first, then containment for
 * "Bob Marley" vs "Bob Marley & The Wailers"-style credit variations.
 */
export function namesMatch(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Word-boundary containment, e.g. "bob marley" in "bob marley and the wailers".
  return (` ${na} `).includes(` ${nb} `) || (` ${nb} `).includes(` ${na} `);
}

/** Truncate at a sentence boundary at or before `max` chars. */
export function truncateAtSentence(text: string, max: number): string {
  const t = cleanText(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sentenceEnd = Math.max(
    cut.lastIndexOf('. '),
    cut.lastIndexOf('! '),
    cut.lastIndexOf('? '),
    cut.lastIndexOf('." '),
    cut.lastIndexOf('.” '),
  );
  if (sentenceEnd >= Math.floor(max * 0.45)) return cut.slice(0, sentenceEnd + 1).trim();
  const wordEnd = cut.lastIndexOf(' ');
  return `${cut.slice(0, wordEnd > 0 ? wordEnd : cut.length).trim()}…`;
}

/** Truncate a pull quote to `max` chars, always marking a cut with an ellipsis. */
export function truncateQuote(text: string, max = 300): string {
  const t = cleanText(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentenceEnd >= Math.floor(max * 0.5)) return cut.slice(0, sentenceEnd + 1).trim();
  const wordEnd = cut.lastIndexOf(' ');
  return `${cut.slice(0, wordEnd > 0 ? wordEnd : cut.length).trim()}…`;
}

/** URL-safe Wikipedia page URL, with optional section anchor. */
export function wikipediaUrl(pageTitle: string, section?: string): string {
  const base = `https://en.wikipedia.org/wiki/${encodeURIComponent(pageTitle.replace(/ /g, '_'))}`;
  return section ? `${base}#${encodeURIComponent(section.replace(/ /g, '_'))}` : base;
}

/** Genius-style path slugs: "Bob Marley & The Wailers" -> "Bob-Marley-The-Wailers". */
export function geniusSlug(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('-');
}
