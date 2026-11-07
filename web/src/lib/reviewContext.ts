/** Helpers for the review preview: find where a critic is mentioned in text we already store. */

const SENTENCE = /(?<=[.!?]["”')\]]?)\s+(?=["“'(\[]?[A-Z0-9])/u;

export function splitSentences(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .flatMap((p) => p.split(SENTENCE))
    .map((s) => s.trim())
    .filter(Boolean);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ALIASES: Record<string, string[]> = {
  'album of the year': ['aoty', 'albumoftheyear'],
  metacritic: ['metascore'],
};

/** Search terms for an outlet / author: the outlet name, a few aliases and the author's surname. */
export function termsFor(outlet: string, author?: string): string[] {
  const out = new Set<string>();
  const o = outlet.replace(/^the\s+/i, '').trim();
  if (o.length >= 3) out.add(o);
  for (const a of ALIASES[outlet.toLowerCase()] ?? []) out.add(a);
  if (author) {
    const last = author.trim().split(/\s+/).pop()?.replace(/[.,]/g, '') ?? '';
    if (last.length >= 4) out.add(last);
  }
  return [...out];
}

function termRegex(terms: string[]): RegExp | null {
  if (!terms.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(${terms.map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
}

/** Sentences of `text` that mention any of `terms` (case-insensitive, whole words), at most `max`. */
export function sentencesMentioning(text: string, terms: string[], max = 3): string[] {
  const re = termRegex(terms);
  if (!re) return [];
  const hits: string[] = [];
  for (const s of splitSentences(text)) {
    re.lastIndex = 0;
    if (re.test(s)) hits.push(s);
    if (hits.length >= max) break;
  }
  return hits;
}

export interface Segment {
  text: string;
  hit: boolean;
}

/** Split `text` so the matches of `terms` can be highlighted. */
export function highlightSegments(text: string, terms: string[]): Segment[] {
  const re = termRegex(terms);
  if (!re) return [{ text, hit: false }];
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: text.slice(last, i), hit: false });
    out.push({ text: m[0], hit: true });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out.length ? out : [{ text, hit: false }];
}

const flat = (t: string) => t.toLowerCase().replace(/[…]|\.{3}/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Quotes whose words are not already printed in the reception text: an excerpt that is a sentence of that text would only repeat it. */
export function quotesNotInReception<Q extends { quote: string }>(quotes: readonly Q[], reception: string | undefined): Q[] {
  if (!reception) return [...quotes];
  const text = ` ${flat(reception)} `;
  return quotes.filter((q) => {
    const k = flat(q.quote);
    return k.length < 12 || !text.includes(` ${k} `);
  });
}
