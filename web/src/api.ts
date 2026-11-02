import type { Album, AlbumDetails, AlbumSummary, Artist, Page, PlayerCommand, PlayerState, PlaylistDetail, PlaylistSummary, Zone } from '@liner/shared';
import { mockCover } from './mock/covers';
import type { AlbumQuery, MatchCandidate, SearchResults, ZoneInfo } from './lib/types';

/** Mock mode: VITE_MOCK=1 at build time, or ?mock=1 (sticks for the session; ?mock=0 clears it). */
function detectMock(): boolean {
  try {
    const q = new URLSearchParams(window.location.search).get('mock');
    if (q === '1') sessionStorage.setItem('rune.mock', '1');
    if (q === '0') sessionStorage.removeItem('rune.mock');
    if (sessionStorage.getItem('rune.mock') === '1') return true;
  } catch {
    /* storage blocked */
  }
  return import.meta.env.VITE_MOCK === '1';
}
export const isMock = typeof window !== 'undefined' && detectMock();

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch('/api' + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText} — ${path}`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? '?' + s : '';
}

const mock = () => import('./mock');

/** Typed API client — one function per route in CONTRACTS.md. */
export const api = {
  async albums(q: AlbumQuery = {}): Promise<Page<AlbumSummary>> {
    if (isMock) return (await mock()).mockApi.albums(q);
    return http(`/library/albums${qs({ ...q, source: q.source === 'all' ? undefined : q.source })}`);
  },
  async album(id: string): Promise<Album> {
    if (isMock) return (await mock()).mockApi.album(id);
    return http(`/albums/${encodeURIComponent(id)}`);
  },
  /** null = the server has no details (404) — the UI hides Review/About tabs. */
  async details(id: string): Promise<AlbumDetails | null> {
    if (isMock) return (await mock()).mockApi.details(id);
    try {
      return await http<AlbumDetails>(`/albums/${encodeURIComponent(id)}/details`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },
  async artist(id: string): Promise<Artist> {
    if (isMock) return (await mock()).mockApi.artist(id);
    return http(`/artists/${encodeURIComponent(id)}`);
  },
  async search(q: string): Promise<SearchResults> {
    if (isMock) return (await mock()).mockApi.search(q);
    return http(`/search${qs({ q })}`);
  },
  async zones(): Promise<ZoneInfo[]> {
    if (isMock) return (await mock()).mockApi.zones();
    return http('/zones');
  },
  /** Contract gap: not in CONTRACTS.md yet. */
  async candidates(albumId: string): Promise<MatchCandidate[]> {
    if (isMock) return (await mock()).mockApi.candidates(albumId);
    try {
      return await http<MatchCandidate[]>(`/albums/${encodeURIComponent(albumId)}/candidates`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return [];
      throw e;
    }
  },
  async match(albumId: string, musicbrainzReleaseId: string): Promise<void> {
    if (isMock) return (await mock()).mockApi.match(albumId, musicbrainzReleaseId);
    await http(`/albums/${encodeURIComponent(albumId)}/match`, { method: 'POST', body: JSON.stringify({ musicbrainzReleaseId }) });
  },
  async playerState(zone: Zone): Promise<PlayerState> {
    return http(`/player/${encodeURIComponent(zone)}`);
  },
  async playerSend(zone: Zone, cmd: PlayerCommand | { type: string }): Promise<PlayerState> {
    return http(`/player/${encodeURIComponent(zone)}`, { method: 'POST', body: JSON.stringify(cmd) });
  },
  // ---------- Spotify ----------
  async spotifyStatus(): Promise<{ connected: boolean; user?: { name: string; product: string } }> {
    if (isMock) return (await mock()).mockApi.spotifyStatus();
    try {
      return await http('/spotify/status');
    } catch {
      return { connected: false };
    }
  },
  async playlists(): Promise<PlaylistSummary[]> {
    if (isMock) return (await mock()).mockApi.playlists();
    return http('/playlists');
  },
  async playlist(id: string): Promise<PlaylistDetail> {
    if (isMock) return (await mock()).mockApi.playlist(id);
    return http(`/playlists/${encodeURIComponent(id)}`);
  },
  /** Is this Spotify album saved to the user's Spotify library? */
  async albumSaved(id: string): Promise<boolean> {
    if (isMock) return (await mock()).mockApi.albumSaved(id);
    try {
      return (await http<{ saved: boolean }>(`/albums/${encodeURIComponent(id)}/saved`)).saved;
    } catch {
      return false;
    }
  },
  async setAlbumSaved(id: string, saved: boolean): Promise<void> {
    if (isMock) return (await mock()).mockApi.setAlbumSaved(id, saved);
    await http(`/albums/${encodeURIComponent(id)}/save`, { method: saved ? 'POST' : 'DELETE' });
  },
  async scan(): Promise<void> {
    if (isMock) return;
    await http('/scan', { method: 'POST' });
  },
};

export function coverSrc(a: { id: string; title?: string }, size: 200 | 600 | 'full' = 200): string {
  if (isMock) return mockCover(a.id, a.title ?? '');
  return `/api/cover/${encodeURIComponent(a.id)}?size=${size}`;
}
