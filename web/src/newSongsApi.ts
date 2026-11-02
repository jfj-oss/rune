// Find new songs + song radio: API client for /api/discover/* (song radio, feed, dismiss). Uses mock data in ?mock=1.
import { isMock } from './api';
import type { FeedResponse, SimilarResponse } from './lib/newSongs';

async function get<T>(path: string): Promise<T> {
  const res = await fetch('/api' + path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch('/api' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}`);
  return (await res.json()) as T;
}

export const newSongsApi = {
  async similar(trackId: string, limit = 30): Promise<SimilarResponse> {
    if (isMock) return (await import('./mock/newSongs')).mockDiscover.similar(trackId, limit);
    return get(`/discover/track/${encodeURIComponent(trackId)}/similar?limit=${limit}`);
  },

  async feed(limit = 50, refresh = false): Promise<FeedResponse> {
    if (isMock) return (await import('./mock/newSongs')).mockDiscover.feed(limit, refresh);
    return get(`/discover/new?limit=${limit}${refresh ? '&refresh=1' : ''}`);
  },

  /** Hide a song from radio/Discover (persisted server-side). */
  async dismiss(trackId: string): Promise<void> {
    if (isMock) {
      await (await import('./mock/newSongs')).mockDiscover.dismiss(trackId);
      return;
    }
    await post<{ ok: boolean }>('/discover/dismiss', { trackId });
  },
};
