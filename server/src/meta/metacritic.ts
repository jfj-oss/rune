// Metacritic's public frontend JSON API (the same one metacritic.com itself
// calls). It returns the critic score and canonical review URL without scraping
// the Cloudflare-protected HTML pages.
import type { CriticScore } from '@liner/shared';
import type { CachedHttp } from './http.js';
import { namesMatch, titleSimilarity } from './text.js';

export interface ReviewAlbumRef {
  id: string;
  title: string;
  artist: string;
  year?: number;
}

export interface MetacriticResult {
  score?: CriticScore;
}

export interface McItem {
  type?: string;
  title?: string;
  slug?: string;
  artistSlug?: string;
  artists?: { name?: string }[];
  criticScoreSummary?: { url?: string; score?: number; reviewCount?: number };
  releaseDate?: string;
  premiereYear?: number;
}

interface McSearch {
  data?: { items?: McItem[] };
}

// Public API key used by metacritic.com's own frontend.
const API_KEY = '1MOZgmNFxvmljaQR1X9KAij9Mo4xAY3u';

export function metacriticSearchUrl(query: string): string {
  return `https://backend.metacritic.com/finder/metacritic/search/${encodeURIComponent(query)}/web?mcoType=music&offset=0&limit=50&apiKey=${API_KEY}`;
}

function yearOf(item: McItem): number | undefined {
  if (typeof item.premiereYear === 'number') return item.premiereYear;
  if (item.releaseDate) {
    const y = Number(item.releaseDate.slice(0, 4));
    if (Number.isFinite(y) && y > 1900) return y;
  }
  return undefined;
}

/** Rank search hits; exported for offline fixture tests. */
export function pickMetacriticItem(items: McItem[], album: ReviewAlbumRef): McItem | null {
  const candidates = items.filter((i) => i.type === 'music-album' && typeof i.criticScoreSummary?.score === 'number');
  let best: { item: McItem; score: number } | null = null;

  for (const item of candidates) {
    const sim = titleSimilarity(album.title, item.title ?? '');
    if (sim < 0.8) continue;
    const artists = (item.artists ?? []).map((a) => a.name ?? '').filter(Boolean);
    // An artist match is mandatory: a same-titled album by someone else must
    // never contribute a score. Credit variations (& vs and) still match.
    const artistHit = artists.some((name) => namesMatch(album.artist, name));
    if (!artistHit) continue;
    const year = yearOf(item);
    const yearOk = !album.year || !year || Math.abs(album.year - year) <= 2;
    if (!yearOk) continue;
    const score = sim * 3 + 3 + (yearOk ? 1 : 0);
    if (!best || score > best.score) best = { item, score };
  }
  return best?.item ?? null;
}

export async function fetchMetacritic(http: CachedHttp, album: ReviewAlbumRef): Promise<MetacriticResult> {
  const queries = [`${album.title} ${album.artist}`, album.title];
  for (const query of queries) {
    const data = await http.getJson<McSearch>(metacriticSearchUrl(query), { accept: 'application/json' });
    const items = data?.data?.items ?? [];
    const picked = pickMetacriticItem(items, album);
    const summary = picked?.criticScoreSummary;
    if (picked && summary && typeof summary.score === 'number' && summary.url) {
      return {
        score: {
          outlet: 'Metacritic',
          score: summary.score,
          scale: 100,
          url: `https://www.metacritic.com${summary.url}`,
          ...(typeof summary.reviewCount === 'number' ? { reviewCount: summary.reviewCount } : {}),
        },
      };
    }
  }
  return {};
}
