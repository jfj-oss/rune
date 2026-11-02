// ListenBrainz Labs similarity API. Free, no key; asks for a descriptive UA.
// The old Spotify /recommendations + related-artists + audio-features endpoints
// were removed in Nov 2024, so this is the similarity source.
//
// Both algorithms are intentionally the "session_based" variants — they are the
// ones the Labs endpoint documents. Responses are cached for a week.
import type { LbSimilarArtist, LbSimilarRecording } from './types.js';
import { DiscoverCache, TTL } from './schema.js';

/** Valid `algorithm` enum for /similar-artists/json. */
export const LB_ARTIST_ALGORITHM =
  'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30';
/** Valid `algorithm` enum for /similar-recordings/json (the enums differ). */
export const LB_RECORDING_ALGORITHM =
  'session_based_days_7500_session_300_contribution_5_threshold_15_limit_50_skip_30';

const DEFAULT_LABS = 'https://labs.api.listenbrainz.org';
const TIMEOUT_MS = 10_000;

export type FetchLike = typeof fetch;

export interface ListenBrainzOptions {
  userAgent: string;
  cache: DiscoverCache;
  fetch?: FetchLike;
  now?: () => number;
  baseUrl?: string;
  limit?: number;
  sleep?: (ms: number) => Promise<void>;
  onWarn?: (msg: string, err?: unknown) => void;
}

function validMbid(mbid: string | undefined): mbid is string {
  return !!mbid && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mbid);
}

export class ListenBrainz {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly limit: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: ListenBrainzOptions) {
    this.fetchImpl = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.baseUrl = (opts.baseUrl ?? DEFAULT_LABS).replace(/\/$/, '');
    this.limit = opts.limit ?? 50;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Artists similar to `artistMbid`, best first. [] when the MBID is unknown. */
  similarArtists(artistMbid: string | undefined, limit = 20): Promise<LbSimilarArtist[]> {
    if (!validMbid(artistMbid)) return Promise.resolve([]);
    return this.similar<LbSimilarArtist>(
      `lb:similar-artists:${artistMbid}`,
      'similar-artists',
      'artist_mbids',
      artistMbid,
      LB_ARTIST_ALGORITHM,
      limit,
    );
  }

  /** Recordings similar to `recordingMbid`, best first. [] when unavailable. */
  similarRecordings(recordingMbid: string | undefined, limit = 50): Promise<LbSimilarRecording[]> {
    if (!validMbid(recordingMbid)) return Promise.resolve([]);
    return this.similar<LbSimilarRecording>(
      `lb:similar-recordings:${recordingMbid}`,
      'similar-recordings',
      'recording_mbids',
      recordingMbid,
      LB_RECORDING_ALGORITHM,
      limit,
    );
  }

  private async similar<T extends { score?: number }>(
    cacheKey: string,
    path: string,
    param: string,
    mbid: string,
    algorithm: string,
    limit: number,
  ): Promise<T[]> {
    const cached = this.opts.cache.get<T[]>(cacheKey, TTL.similar);
    if (cached) return cached.value.slice(0, limit);

    const params = new URLSearchParams({ [param]: mbid, algorithm });
    const url = `${this.baseUrl}/${path}/json?${params.toString()}`;
    try {
      let res: Awaited<ReturnType<FetchLike>> | undefined;
      let lastError: unknown;
      // Labs occasionally drops a connection; two short retries avoid turning a
      // transient failure into an empty radio (the result is cached for a week).
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          res = await this.fetchImpl(url, {
            method: 'GET',
            headers: { 'User-Agent': this.opts.userAgent, Accept: 'application/json' },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (res.ok || res.status < 500) break;
        } catch (err) {
          lastError = err;
        }
        if (attempt < 2) await this.sleep(400 * (attempt + 1));
      }
      if (!res) throw lastError ?? new Error('no response');
      if (!res.ok) {
        this.opts.onWarn?.(`ListenBrainz ${path} answered ${res.status}`);
        return [];
      }
      const body = (await res.json()) as T[] | { error?: string };
      if (!Array.isArray(body)) {
        this.opts.onWarn?.(`ListenBrainz ${path} returned a non-array body`);
        return [];
      }
      const rows = body
        .filter((row) => row && typeof row === 'object')
        .slice()
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      // Cache only successful responses; an outage must not stick for a week.
      this.opts.cache.set(cacheKey, rows);
      return rows.slice(0, limit);
    } catch (err) {
      this.opts.onWarn?.(`ListenBrainz ${path} failed`, err);
      return [];
    }
  }
}
