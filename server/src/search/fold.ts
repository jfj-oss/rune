// Text folding / matching primitives for search. Kept dependency-free and pure so
// ranking can be unit-tested without a database.

/** Lowercase, strip diacritics, fold punctuation to spaces, drop apostrophes.
 *  "Björk" → "bjork", "AC/DC" → "ac dc", "Don't" → "dont", "Simon & Garfunkel"
 *  → "simon and garfunkel". */
export function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’‘`´]/g, '')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function tokens(s: string): string[] {
  const f = fold(s);
  return f ? f.split(' ').filter(Boolean) : [];
}

/** Folded text without spaces — lets "acdc" match the tokens "ac dc". */
export function compact(s: string): string {
  return fold(s).replace(/ /g, '');
}

/** Drop a leading article for exact-title comparisons ("The Beatles" == "Beatles"). */
export function withoutThe(s: string): string {
  return fold(s).replace(/^(the|a|an) /, '');
}

/** Maximum edit distance accepted for a query token of this length. */
export function maxEditDistance(len: number): number {
  // One edit handles the common typos (pumpkns, smashng, discoery, pnk) and
  // keeps two-edit coincidences ("baker" ~ "fake") out of the result set.
  return len <= 8 ? 1 : 2;
}

/** Levenshtein distance, giving up (returning max+1) once a row exceeds max. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let next = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    next[0] = i;
    let rowMin = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j]! + 1, next[j - 1]! + 1, prev[j - 1]! + cost);
      next[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const tmp = prev;
    prev = next;
    next = tmp;
  }
  const d = prev[b.length]!;
  return d > max ? max + 1 : d;
}

/** Unique 3-character substrings (trigrams) of a folded token. */
export function trigrams(token: string): string[] {
  if (token.length < 3) return [];
  const out = new Set<string>();
  for (let i = 0; i + 3 <= token.length; i++) out.add(token.slice(i, i + 3));
  return [...out];
}

/** Escape a folded word for an FTS5 quoted prefix query. */
export function ftsPrefix(word: string): string {
  return `"${word.replace(/"/g, '')}"*`;
}

export function ftsPhrase(word: string): string {
  return `"${word.replace(/"/g, '')}"`;
}
