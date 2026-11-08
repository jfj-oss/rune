import type { Album, AlbumDetails, AlbumSummary, Artist, Page, PlayerCommand, PlayerState, Zone } from '@liner/shared';
import type { RunePlaylistDetail, RunePlaylistSummary } from './lib/playlists';
import { mockCover } from './mock/covers';
import type { AlbumQuery, MatchCandidate, PlayItem, SearchResults, ZoneInfo } from './lib/types';

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
  /** The server's own explanation (`{ error }` body), when it sent one. */
  serverMessage?: string;
  constructor(public status: number, message: string, serverMessage?: string) {
    super(message);
    if (serverMessage) this.serverMessage = serverMessage;
  }
}

export async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch('/api' + path, {
    ...init,
    // Only label a body that exists: Fastify rejects an empty body sent as JSON (400), which silently
    // broke the bodiless POSTs (/pc/spotify/start never launched Spotify; /scan never scanned).
    headers: { ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let msg: string | undefined;
    try { const b = (await res.json()) as { error?: unknown }; if (typeof b?.error === 'string') msg = b.error; } catch { /* not JSON */ }
    throw new ApiError(res.status, `${res.status} ${res.statusText} — ${path}`, msg);
  }
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
  /** Summaries for specific ids, returned in the order given; unknown ids are skipped. */
  async albumSummaries(ids: string[]): Promise<{ items: AlbumSummary[]; total: number }> {
    if (isMock) return (await mock()).mockApi.albumSummaries(ids);
    return http(`/library/albums${qs({ ids: ids.join(',') })}`);
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
  /** `localOnly`: just the library's hits (fast); the full search also waits for Spotify's catalogue. */
  async search(q: string, opts: { localOnly?: boolean } = {}): Promise<SearchResults> {
    if (isMock) return (await mock()).mockApi.search(q);
    return http(`/search${qs({ q, local: opts.localOnly ? '1' : undefined })}`);
  },
  /** `fresh`: the picker just opened — ask for the device list now instead of the server's short cache. */
  async zones(opts: { fresh?: boolean } = {}): Promise<ZoneInfo[]> {
    if (isMock) return (await mock()).mockApi.zones();
    return http(`/zones${opts.fresh ? '?refresh=1' : ''}`);
  },
  /** Is the Spotify desktop app (flatpak) currently running on the PC? */
  async pcSpotifyStatus(): Promise<{ running: boolean }> {
    if (isMock) return { running: false };
    return http('/pc/spotify/status');
  },
  /** Start the Spotify app on the PC (the server debounces repeated calls). */
  async pcSpotifyStart(): Promise<{ started: boolean; running: boolean }> {
    if (isMock) return { started: false, running: false };
    return http('/pc/spotify/start', { method: 'POST' });
  },
  /** Local copies of Spotify tracks the user owns: 'sp:<id>' → the local track + its album. */
  async localTwins(tracks: { id: string; title: string; artists: string[]; durationMs: number }[]): Promise<Record<string, PlayItem>> {
    if (isMock || !tracks.length) return {};
    const r = await http<{ twins: Record<string, PlayItem> }>('/local-twins', { method: 'POST', body: JSON.stringify({ tracks }) });
    return r.twins ?? {};
  },
  /** Spotify copies of local tracks: 'l:<id>' → the Spotify track (for Spotify-only zones). */
  async spotifyTwins(ids: string[]): Promise<Record<string, PlayItem>> {
    if (isMock || !ids.length) return {};
    const r = await http<{ twins: Record<string, PlayItem> }>('/spotify-twins', { method: 'POST', body: JSON.stringify({ ids }) });
    return r.twins ?? {};
  },
  /** Spotify devices hidden from the "Play on" list (by name, for every rune page). */
  async hiddenZones(): Promise<string[]> {
    if (isMock) return [];
    return http('/zones/hidden');
  },
  async setZoneHidden(name: string, hidden: boolean): Promise<string[]> {
    if (isMock) return [];
    return http('/zones/hidden', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, hidden }) });
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
  async spotifyStatus(): Promise<{ connected: boolean; configured?: boolean; user?: { name: string; product: string } }> {
    if (isMock) return (await mock()).mockApi.spotifyStatus();
    try {
      return await http('/spotify/status');
    } catch {
      return { connected: false, configured: false };
    }
  },
  async playlists(): Promise<RunePlaylistSummary[]> {
    if (isMock) return (await mock()).mockApi.playlists();
    return http('/playlists');
  },
  async playlist(id: string): Promise<RunePlaylistDetail> {
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
  /** Is this Spotify track in Liked Songs? Answered from the server's synced copy (no Spotify call). */
  async trackLiked(id: string): Promise<boolean> {
    if (isMock) return (await mock()).mockApi.trackLiked(id);
    const res = await http<{ liked: Record<string, boolean> }>(`/tracks/liked${qs({ ids: id })}`);
    return res.liked[id] === true;
  },
  /** Like/unlike this Spotify track, mirroring the change into Liked Songs on the server. */
  async setTrackLiked(id: string, liked: boolean): Promise<void> {
    if (isMock) return (await mock()).mockApi.setTrackLiked(id, liked);
    await http('/tracks/liked', { method: liked ? 'POST' : 'DELETE', body: JSON.stringify({ ids: [id] }) });
  },
  async scan(): Promise<void> {
    if (isMock) return;
    await http('/scan', { method: 'POST' });
  },
  /** Files the last scan could not read (paths relative to a library root). */
  async scanErrors(): Promise<{ path: string; reason: string }[]> {
    if (isMock) return [];
    return http<{ path: string; reason: string }[]>('/scan/errors');
  },
};

export function coverSrc(a: { id: string; title?: string; coverUrl?: string }, size: 200 | 600 | 'full' = 200): string {
  if (isMock) return mockCover(a.id, a.title ?? '');
  // Spotify catalogue albums not stored in rune (artist pages, search): the image lives on Spotify's CDN.
  if (a.coverUrl && /^https?:\/\//.test(a.coverUrl)) return a.coverUrl;
  return `/api/cover/${encodeURIComponent(a.id)}?size=${size}`;
}
