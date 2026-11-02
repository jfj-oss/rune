// MusicBrainz helpers used only by Discover (everything goes through the shared
// 1 req/s client + 30-day http_cache from src/match/mb.ts).
import { escapeLucene, type MbClient } from '../match/mb.js';
import { normalizeName } from '../db/index.js';
import { artistMatches, titleMatches } from './match.js';
import type { MbArtistSearchResponse, MbIsrcResponse, MbRecordingSearchResponse } from './types.js';

const BASE = 'https://musicbrainz.org/ws/2';

export function normalizeIsrc(isrc: string | undefined | null): string | undefined {
  if (!isrc) return undefined;
  const compact = isrc.replace(/-/g, '').trim().toUpperCase();
  return /^[A-Z0-9]{12}$/.test(compact) ? compact : undefined;
}

/** First recording from an ISRC lookup (the resource is keyed by ISRC). */
export function recordingFromIsrc(body: MbIsrcResponse): { id: string; title?: string } | undefined {
  const first = body.recordings?.find((r) => !!r.id);
  return first ? { id: first.id, title: first.title } : undefined;
}

/** Best recording search hit whose title and artist agree with what we asked for. */
export function pickRecording(
  body: MbRecordingSearchResponse,
  title: string,
  artist: string,
): string | undefined {
  const rows = [...(body.recordings ?? [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  for (const row of rows) {
    if (!row.id || !titleMatches(title, row.title ?? '')) continue;
    if (!artist.trim()) return row.id;
    const credit = (row['artist-credit'] ?? []).map((c) => `${c.name}${c.joinphrase ?? ''}`).join('');
    if (artistMatches(artist, [credit])) return row.id;
  }
  return undefined;
}

/** Best artist search hit; exact normalized names win over fuzzy first hits. */
export function pickArtist(body: MbArtistSearchResponse, name: string): string | undefined {
  const wanted = normalizeName(name);
  const rows = [...(body.artists ?? [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const exact = rows.find((r) => normalizeName(r.name ?? '') === wanted);
  if (exact?.id) return exact.id;
  const contains = rows.find((r) => {
    const got = normalizeName(r.name ?? '');
    return got.length > 0 && (got.includes(wanted) || wanted.includes(got));
  });
  return contains?.id ?? rows[0]?.id;
}

export class DiscoverMb {
  constructor(private readonly mb: MbClient) {}

  /** Spotify track ISRC → MusicBrainz recording id. */
  async recordingByIsrc(isrc: string | undefined | null): Promise<string | undefined> {
    const clean = normalizeIsrc(isrc);
    if (!clean) return undefined;
    try {
      const body = await this.mb.getJson<MbIsrcResponse>(`${BASE}/isrc/${encodeURIComponent(clean)}?fmt=json`);
      return recordingFromIsrc(body)?.id;
    } catch {
      return undefined;
    }
  }

  /** Last-resort recording resolution for tracks without an ISRC. */
  async searchRecording(title: string, artist: string): Promise<string | undefined> {
    if (!title.trim()) return undefined;
    const query = [`recording:"${escapeLucene(title)}"`];
    if (artist.trim()) query.push(`artist:"${escapeLucene(artist)}"`);
    const params = new URLSearchParams({ query: query.join(' AND '), fmt: 'json', limit: '5' });
    try {
      const body = await this.mb.getJson<MbRecordingSearchResponse>(
        `${BASE}/recording/?${params.toString()}`,
      );
      return pickRecording(body, title, artist);
    } catch {
      return undefined;
    }
  }

  /** Artist name → MBID (only needed for Spotify-only artists). */
  async searchArtist(name: string): Promise<string | undefined> {
    if (!name.trim()) return undefined;
    const params = new URLSearchParams({
      query: `artist:"${escapeLucene(name)}"`,
      fmt: 'json',
      limit: '5',
    });
    try {
      const body = await this.mb.getJson<MbArtistSearchResponse>(`${BASE}/artist/?${params.toString()}`);
      return pickArtist(body, name);
    } catch {
      return undefined;
    }
  }
}
