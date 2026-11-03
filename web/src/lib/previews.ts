import type { AlbumDetails, CriticQuote, CriticScore, Sourced } from '@liner/shared';
import type { PreviewItem } from '../store/preview';
import { sentencesMentioning, termsFor } from './reviewContext';

/** Where the stored Wikipedia reception mentions this critic, if it does. */
function contextFor(details: AlbumDetails | undefined, outlet: string, author?: string): PreviewItem['context'] {
  const rec = details?.reception;
  if (!rec) return undefined;
  const terms = termsFor(outlet, author);
  const sentences = sentencesMentioning(rec.value, terms);
  return sentences.length ? { source: rec.source, url: rec.url, sentences, terms } : undefined;
}

export function quotePreview(q: CriticQuote, details?: AlbumDetails): PreviewItem {
  return { kind: 'quote', label: 'Review excerpt', title: q.outlet, author: q.author, quote: q.quote, url: q.url, context: contextFor(details, q.outlet, q.author) };
}

const outletKey = (o: string) => o.toLowerCase().replace(/^the\s+/, '').trim();

export function scorePreview(s: CriticScore, details?: AlbumDetails): PreviewItem {
  // the same outlet's stored excerpt, if rune has one, so the score comes with words
  const q = details?.quotes?.find((x) => outletKey(x.outlet) === outletKey(s.outlet));
  return {
    kind: 'score', label: 'Critic score', title: s.outlet, score: s, url: s.url,
    ...(q ? { quote: q.quote, author: q.author } : {}),
    context: contextFor(details, s.outlet, q?.author),
  };
}

/** Full stored text (reception, background, artist note, bio) with its attribution. */
export function textPreview(label: string, title: string, src: Sourced<string>): PreviewItem {
  return { kind: 'text', label, title, text: src.value, url: src.url, attribution: { source: src.source, url: src.url } };
}
