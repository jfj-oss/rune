// All Discover → Spotify traffic. Every network call takes a slot from the
// persisted budget; successful responses are cached aggressively. Artists are
// resolved with search (top-tracks only needs the artist id) and top-tracks
// falls back to `artist:"<name>"` when Spotify refuses the endpoint (403).
import { normalizeName } from '../db/index.js';
import type { SpotifyApi, SpotifySearchResult, SpotifyTrack } from '../spotify/api.js';
import { DiscoverBlockedError, type SpotifyDiscoverBudget } from './budget.js';
import { artistMatches, titleMatches } from './match.js';
import { DiscoverCache, TTL } from './schema.js';

export interface SpotifyArtistLite {
  id: string;
  name: string;
}

type SpotifyTrackWithExtras = SpotifyTrack & {
  popularity?: number;
  external_ids?: { isrc?: string };
};

export interface SpotifyGatewayOptions {
  now?: () => number;
  onWarn?: (msg: string, err?: unknown) => void;
}

export class SpotifyGateway {
  constructor(
    private readonly api: SpotifyApi,
    private readonly budget: SpotifyDiscoverBudget,
    private readonly cache: DiscoverCache,
    private readonly opts: SpotifyGatewayOptions = {},
  ) {}

  /** Cached Spotify search. Cache hits are free (no budget). */
  async search(query: string, types: string[], limit: number): Promise<SpotifySearchResult> {
    const key = `sp:search:v1:${types.join(',')}:${limit}:${query.toLowerCase()}`;
    const hit = this.cache.get<SpotifySearchResult>(key, TTL.spotifyMapping);
    if (hit) return hit.value;
    const result = await this.call(() => this.api.search(query, { types, limit }));
    this.cache.set(key, result);
    return result;
  }

  /** Resolve a similar-artist name to a Spotify artist (exact name only). */
  async findArtist(name: string): Promise<SpotifyArtistLite | null> {
    const key = `sp:artist:v1:${normalizeName(name)}`;
    const hit = this.cache.get<SpotifyArtistLite | null>(key, TTL.topTracks);
    if (hit) return hit.value;
    let result: SpotifyArtistLite | null = null;
    try {
      const res = await this.search(artistQuery(name), ['artist'], 3);
      const wanted = normalizeName(name);
      const exact = (res.artists?.items ?? []).find((a) => normalizeName(a.name) === wanted);
      result = exact ? { id: exact.id, name: exact.name } : null;
    } catch (err) {
      if (err instanceof DiscoverBlockedError) throw err;
      if (!isRefusal(err)) throw err;
      result = null;
    }
    this.cache.set(key, result);
    return result;
  }

  /**
   * Popular tracks for an artist: GET /artists/:id/top-tracks, falling back to
   * search when Spotify refuses it. Returns [] for artists Spotify does not know.
   */
  async topTracks(artist: SpotifyArtistLite, limit = 10): Promise<SpotifyTrack[]> {
    const key = `sp:top:v1:${artist.id}:${limit}`;
    const hit = this.cache.get<SpotifyTrack[]>(key, TTL.topTracks);
    if (hit) return hit.value;
    let tracks: SpotifyTrack[] = [];
    try {
      const res = await this.call(() =>
        this.api.request<{ tracks?: SpotifyTrack[] }>(
          `/artists/${encodeURIComponent(artist.id)}/top-tracks?market=from_token`,
        ),
      );
      tracks = (res?.tracks ?? []).filter((t) => !!t.id).slice(0, limit);
    } catch (err) {
      if (err instanceof DiscoverBlockedError) throw err;
      if (!isRefusal(err)) throw err;
      tracks = await this.searchTracksByArtist(artist.name, limit);
    }
    this.cache.set(key, tracks);
    return tracks;
  }

  /** `artist:"<name>"` track search, filtered to artists that actually match. */
  async searchTracksByArtist(name: string, limit = 10): Promise<SpotifyTrack[]> {
    const key = `sp:artist-tracks:v1:${normalizeName(name)}:${limit}`;
    const hit = this.cache.get<SpotifyTrack[]>(key, TTL.topTracks);
    if (hit) return hit.value;
    let tracks: SpotifyTrack[] = [];
    try {
      const res = await this.search(artistQuery(name), ['track'], Math.min(limit, 10));
      tracks = (res.tracks?.items ?? []).filter(
        (t) => !!t.id && artistMatches(name, (t.artists ?? []).map((a) => a.name)),
      );
    } catch (err) {
      if (err instanceof DiscoverBlockedError) throw err;
      if (!isRefusal(err)) throw err;
      tracks = [];
    }
    this.cache.set(key, tracks);
    return tracks;
  }

  /**
   * Find the Spotify track for an LB similar recording. Returns undefined when
   * Spotify has no confident match; successful searches are cached for a week.
   */
  async findTrack(title: string, artist: string): Promise<SpotifyTrack | undefined> {
    if (!title.trim() || !artist.trim()) return undefined;
    const key = `sp:find:v1:${normalizeName(artist)}|${normalizeName(title)}`;
    const hit = this.cache.get<SpotifyTrack | null>(key, TTL.spotifyMapping);
    if (hit) return hit.value ?? undefined;

    let found: SpotifyTrack | undefined;
    try {
      const query = `track:"${quote(title)}" artist:"${quote(artist)}"`;
      const res = await this.search(query, ['track'], 5);
      const rows = (res.tracks?.items ?? []).filter(
        (t): t is SpotifyTrack & { id: string } => !!t.id,
      );
      const matching = rows.filter(
        (t) =>
          titleMatches(title, t.name) &&
          artistMatches(artist, (t.artists ?? []).map((a) => a.name)),
      );
      found = bestByPopularity(matching);
    } catch (err) {
      if (err instanceof DiscoverBlockedError) throw err;
      if (!isRefusal(err)) throw err;
      // Do not cache a refusal: a later retry may succeed.
      return undefined;
    }
    if (found) this.cache.set(key, found);
    else this.cache.set(key, null);
    return found;
  }

  /** Full Spotify track (with ISRC) for a seed that may not be stored locally. */
  async trackInfo(spotifyId: string): Promise<SpotifyTrackWithExtras | undefined> {
    const key = `sp:track:v1:${spotifyId}`;
    const hit = this.cache.get<{ track: SpotifyTrackWithExtras | null }>(key, TTL.isrc);
    if (hit) return hit.value.track ?? undefined;
    let track: SpotifyTrackWithExtras | null = null;
    try {
      // GET /tracks/{id}: development-mode apps are refused the batch `/tracks?ids=` endpoint.
      track = await this.call(() =>
        this.api.request<SpotifyTrackWithExtras>(`/tracks/${encodeURIComponent(spotifyId)}`),
      );
    } catch (err) {
      if (err instanceof DiscoverBlockedError) throw err;
      if (!isRefusal(err)) throw err;
      // Refusals (403/404) are cached too: a retry within the TTL will not ask again.
    }
    this.cache.set(key, { track: track ?? null });
    return track ?? undefined;
  }

  /** ISRC for a Spotify track (needed to resolve its MB recording id). */
  async trackIsrc(spotifyId: string): Promise<string | undefined> {
    const track = await this.trackInfo(spotifyId);
    return track?.external_ids?.isrc;
  }

  /** Budget + 429 translation for one Spotify request. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    await this.budget.take();
    try {
      return await fn();
    } catch (err) {
      if (httpStatus(err) === 429) {
        const retry = (err as { retryAfterMs?: number }).retryAfterMs;
        const until = this.budget.block(retry);
        this.opts.onWarn?.('Spotify rate-limited discovery', err);
        throw new DiscoverBlockedError(until, 'blocked');
      }
      throw err;
    }
  }
}

function artistQuery(name: string): string {
  return `artist:"${quote(name)}"`;
}

function quote(value: string): string {
  return value.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

function bestByPopularity(tracks: (SpotifyTrack & { popularity?: number })[]): SpotifyTrack | undefined {
  let best: SpotifyTrack | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const t of tracks) {
    const score = t.popularity ?? 0;
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  return best ?? tracks[0];
}

function httpStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** Spotify 403 (endpoint unavailable in dev mode) / 404 must not fail a radio. */
function isRefusal(err: unknown): boolean {
  const status = httpStatus(err);
  return status === 403 || status === 404;
}
