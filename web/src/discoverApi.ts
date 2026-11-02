// Typed client for the discover surfaces (people, editions/discography, stats,
// duplicates, health, artist info). Kept apart from api.ts / browseApi.ts so the
// parallel playlist/search work does not collide. Shapes mirror the server
// modules (see lib/discover.ts).
import { isMock } from './api';
import type {
  AlbumConnections,
  AlbumEditions,
  AlbumStats,
  ArtistDiscography,
  ArtistInfo,
  ArtistStats,
  DuplicateReport,
  HealthResponse,
  PersonPage,
  PersonSummary,
  StatsPeriod,
  StatsSummary,
} from './lib/discover';

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

const mock = () => import('./mock/discover');

export const discoverApi = {
  // ---------- people ----------
  async person(id: string): Promise<PersonPage> {
    if (isMock) return (await mock()).mockDiscover.person(id);
    return get(`/people/${encodeURIComponent(id)}`);
  },
  async people(q: { role?: string; q?: string } = {}): Promise<PersonSummary[]> {
    if (isMock) return (await mock()).mockDiscover.people(q);
    return get(`/people${qs({ role: q.role, q: q.q })}`);
  },
  async connections(albumId: string): Promise<AlbumConnections> {
    if (isMock) return (await mock()).mockDiscover.connections(albumId);
    return get(`/albums/${encodeURIComponent(albumId)}/connections`);
  },

  // ---------- editions + discography ----------
  async editions(albumId: string): Promise<AlbumEditions> {
    if (isMock) return (await mock()).mockDiscover.editions(albumId);
    return get(`/albums/${encodeURIComponent(albumId)}/editions`);
  },
  async discography(artistId: string): Promise<ArtistDiscography> {
    if (isMock) return (await mock()).mockDiscover.discography(artistId);
    return get(`/artists/${encodeURIComponent(artistId)}/discography`);
  },

  // ---------- statistics ----------
  async statsSummary(period: StatsPeriod = '30d'): Promise<StatsSummary> {
    if (isMock) return (await mock()).mockDiscover.statsSummary(period);
    return get(`/stats/summary${qs({ period })}`);
  },
  async statsAlbum(id: string, period: StatsPeriod = 'all'): Promise<AlbumStats | null> {
    if (isMock) return (await mock()).mockDiscover.statsAlbum(id, period);
    try {
      return await get<AlbumStats>(`/stats/album/${encodeURIComponent(id)}${qs({ period })}`);
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  },
  async statsArtist(id: string, period: StatsPeriod = 'all'): Promise<ArtistStats | null> {
    if (isMock) return (await mock()).mockDiscover.statsArtist(id, period);
    try {
      return await get<ArtistStats>(`/stats/artist/${encodeURIComponent(id)}${qs({ period })}`);
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  },

  // ---------- duplicates ----------
  async duplicates(): Promise<DuplicateReport> {
    if (isMock) return (await mock()).mockDiscover.duplicates();
    return get('/library/duplicates');
  },
  async hideAlbum(albumId: string): Promise<void> {
    if (isMock) return (await mock()).mockDiscover.hideAlbum(albumId);
    await fetch(`/api/albums/${encodeURIComponent(albumId)}/hide`, { method: 'POST' });
  },
  async unhideAlbum(albumId: string): Promise<void> {
    if (isMock) return (await mock()).mockDiscover.unhideAlbum(albumId);
    await fetch(`/api/albums/${encodeURIComponent(albumId)}/hide`, { method: 'DELETE' });
  },

  // ---------- health + artist info ----------
  async health(): Promise<HealthResponse> {
    if (isMock) return (await mock()).mockDiscover.health();
    return get('/health');
  },
  /** null when the server knows no such artist (404). */
  async artistInfo(id: string): Promise<ArtistInfo | null> {
    if (isMock) return (await mock()).mockDiscover.artistInfo(id);
    try {
      return await get<ArtistInfo>(`/artists/${encodeURIComponent(id)}/info`);
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  },
};

function isNotFound(e: unknown): boolean {
  return e instanceof Error && /^404 /.test(e.message);
}
