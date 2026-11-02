// API client for the browse + history + frame-check routes. Kept apart from api.ts so the
// parallel Spotify/playlists/search work does not collide with it.
import type { AlbumSummary, HistoryPlayRequest, Page, RecentAlbum, RediscoverAlbum } from '@liner/shared';
import { isMock } from './api';
import type { BrowseTrack, GenreAlbumQuery, GenreFacet, LabelFacet, TrackQuery, YearFacet } from './lib/types';

async function get<T>(path: string): Promise<T> {
  const res = await fetch('/api' + path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}`);
  return (await res.json()) as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? '?' + s : '';
}

const mock = () => import('./mock/browse');

export const browseApi = {
  async tracks(q: TrackQuery = {}): Promise<Page<BrowseTrack>> {
    if (isMock) return (await mock()).mockBrowse.tracks(q);
    return get(`/tracks${qs({ ...q })}`);
  },
  async genres(): Promise<GenreFacet[]> {
    if (isMock) return (await mock()).mockBrowse.genres();
    return get('/genres');
  },
  async genreAlbums(genre: string, q: GenreAlbumQuery = {}): Promise<Page<AlbumSummary>> {
    if (isMock) return (await mock()).mockBrowse.genreAlbums(genre, q);
    return get(`/genres/${encodeURIComponent(genre)}/albums${qs({ ...q })}`);
  },
  async labels(): Promise<LabelFacet[]> {
    if (isMock) return (await mock()).mockBrowse.labels();
    return get('/labels');
  },
  async years(): Promise<YearFacet[]> {
    if (isMock) return (await mock()).mockBrowse.years();
    return get('/years');
  },

  // ---- listening history ----
  async historyRecent(limit = 12): Promise<RecentAlbum[]> {
    if (isMock) return (await mock()).mockBrowse.historyRecent(limit);
    return get(`/history/recent${qs({ limit })}`);
  },
  async historyRediscover(limit = 8, olderThanDays = 90): Promise<RediscoverAlbum[]> {
    if (isMock) return (await mock()).mockBrowse.historyRediscover(limit);
    return get(`/history/rediscover${qs({ limit, olderThanDays })}`);
  },
  /** Fire-and-forget report of a browser-zone listen; the server decides whether it counts. */
  historyPlayed(body: HistoryPlayRequest, opts?: { keepalive?: boolean }): Promise<void> {
    if (isMock) return Promise.resolve();
    return fetch('/api/history/played', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: opts?.keepalive,
    }).then(() => undefined, () => undefined);
  },

  // ---- review preview ----
  /** Can this https page be shown in an iframe? Errors count as "no". */
  async frameOk(url: string): Promise<boolean> {
    if (isMock) return (await mock()).mockBrowse.frameOk(url);
    try {
      const r = await get<{ embeddable: boolean }>(`/frame-ok${qs({ url })}`);
      return r.embeddable;
    } catch {
      return false;
    }
  },
};
