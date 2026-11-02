// Optional Last.fm fallback for Discover. ListenBrainz remains the primary
// similarity source; this client is only constructed when cfg.lastfmApiKey is
// set, and is used when ListenBrainz has no similar recordings/artists for a
// seed. Like every other discovery source, responses are cached for a week.
import type { FetchLike } from './listenbrainz.js';
import { DiscoverCache, TTL } from './schema.js';

const DEFAULT_API = 'https://ws.audioscrobbler.com/2.0/';
const TIMEOUT_MS = 10_000;

export interface LastFmSimilarTrack {
  title: string;
  artist: string;
  recordingMbid?: string;
  match?: number;
}

export interface LastFmSimilarArtist {
  name: string;
  artistMbid?: string;
  match?: number;
  /** Last.fm's 0–1 match, exposed as a score so callers can share LB code. */
  score?: number;
}

interface LfmTrackSimilarBody {
  similartracks?: {
    track?: {
      name?: string;
      mbid?: string;
      match?: number;
      artist?: { name?: string } | string;
    }[];
  };
  error?: number;
  message?: string;
}

interface LfmArtistSimilarBody {
  similarartists?: {
    artist?: { name?: string; mbid?: string; match?: number }[];
  };
  error?: number;
  message?: string;
}

export interface LastFmOptions {
  cache: DiscoverCache;
  userAgent?: string;
  fetch?: FetchLike;
  baseUrl?: string;
  onWarn?: (msg: string, err?: unknown) => void;
}

export class LastFm {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly opts: LastFmOptions,
  ) {
    this.fetchImpl = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.baseUrl = (opts.baseUrl ?? DEFAULT_API).replace(/\/$/, '');
  }

  get enabled(): boolean {
    return !!this.apiKey;
  }

  async similarTracks(artist: string, title: string, limit = 20): Promise<LastFmSimilarTrack[]> {
    if (!this.enabled || !artist.trim() || !title.trim()) return [];
    const key = `lfm:track:v1:${normalize(artist)}|${normalize(title)}:${limit}`;
    const rows = await this.cached<LfmTrackSimilarBody, LastFmSimilarTrack>(
      key,
      { method: 'track.getsimilar', artist, track: title, limit: String(limit), autocorrect: '1' },
      (body) =>
        (body.similartracks?.track ?? [])
          .map((row) => ({
            title: row.name?.trim() ?? '',
            artist: typeof row.artist === 'string' ? row.artist.trim() : row.artist?.name?.trim() ?? '',
            ...(row.mbid ? { recordingMbid: row.mbid } : {}),
            ...(typeof row.match === 'number' ? { match: row.match } : {}),
          }))
          .filter((row) => !!row.title && !!row.artist),
    );
    return rows.slice(0, limit);
  }

  async similarArtists(name: string, limit = 20): Promise<LastFmSimilarArtist[]> {
    if (!this.enabled || !name.trim()) return [];
    const key = `lfm:artist:v1:${normalize(name)}:${limit}`;
    const rows = await this.cached<LfmArtistSimilarBody, LastFmSimilarArtist>(
      key,
      { method: 'artist.getsimilar', artist: name, limit: String(limit), autocorrect: '1' },
      (body) =>
        (body.similarartists?.artist ?? [])
          .map((row) => ({
            name: row.name?.trim() ?? '',
            ...(row.mbid ? { artistMbid: row.mbid } : {}),
            ...(typeof row.match === 'number' ? { match: row.match, score: row.match * 100 } : {}),
          }))
          .filter((row) => !!row.name),
    );
    return rows.slice(0, limit);
  }

  private async cached<B, T>(
    cacheKey: string,
    params: Record<string, string>,
    parse: (body: B) => T[],
  ): Promise<T[]> {
    const hit = this.opts.cache.get<T[]>(cacheKey, TTL.similar);
    if (hit) return hit.value;
    if (!this.apiKey) return [];

    const url = new URL(this.baseUrl);
    for (const [k, v] of Object.entries({ ...params, api_key: this.apiKey, format: 'json' })) {
      url.searchParams.set(k, v);
    }
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          ...(this.opts.userAgent ? { 'User-Agent': this.opts.userAgent } : {}),
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        this.opts.onWarn?.(`Last.fm ${params.method} answered ${res.status}`);
        return [];
      }
      const body = (await res.json()) as B & { error?: number; message?: string };
      if (body.error) {
        this.opts.onWarn?.(`Last.fm ${params.method} error ${body.error}: ${body.message ?? ''}`);
        return [];
      }
      const rows = parse(body);
      // Cache only successful responses; an outage must not stick for a week.
      this.opts.cache.set(cacheKey, rows);
      return rows;
    } catch (err) {
      this.opts.onWarn?.(`Last.fm ${params.method} failed`, err);
      return [];
    }
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}
