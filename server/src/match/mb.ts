// MusicBrainz WS/2 JSON client.
//
// - Every network request is serialised through a global (per-client) 1 req/sec
//   rate limiter.
// - 429 / 503 responses are retried with exponential backoff (4 retries max).
// - Every GET response is stored in the `http_cache` table keyed by URL and reused
//   for 30 days. Cache hits do not touch the network or the rate limiter.
// - `fetch` (and `sleep` / `now`) are injectable so tests can replay recorded
//   fixtures completely offline.
import type { Db } from '../db/index.js';

export type FetchLike = typeof fetch;

// ---------- WS/2 response shapes (only the fields we consume) ----------

export interface MbArtist {
  id: string;
  name: string;
  'sort-name'?: string;
  disambiguation?: string;
}

export interface MbArtistCredit {
  name: string;
  joinphrase?: string;
  artist: MbArtist;
}

export interface MbTag {
  name: string;
  count?: number;
}

export interface MbGenre extends MbTag {
  id?: string;
  disambiguation?: string;
}

export interface MbRelation {
  type: string;
  'type-id'?: string;
  direction?: string;
  attributes?: string[];
  'attribute-values'?: Record<string, string>;
  'target-type'?: string;
  artist?: MbArtist;
  work?: MbWork;
  recording?: { id: string; title?: string };
}

export interface MbWork {
  id: string;
  title?: string;
  type?: string | null;
  relations?: MbRelation[];
}

export interface MbRecording {
  id: string;
  title?: string;
  length?: number | null;
  'artist-credit'?: MbArtistCredit[];
  relations?: MbRelation[];
  genres?: MbGenre[];
  tags?: MbTag[];
}

export interface MbTrack {
  id: string;
  title: string;
  number?: string;
  position?: number;
  length?: number | null;
  'artist-credit'?: MbArtistCredit[];
  recording?: MbRecording;
  relations?: MbRelation[];
}

export interface MbMedium {
  id?: string;
  position?: number;
  format?: string | null;
  'track-count'?: number;
  tracks?: MbTrack[];
}

export interface MbReleaseGroup {
  id: string;
  title?: string;
  'primary-type'?: string | null;
  'secondary-types'?: string[];
  'first-release-date'?: string;
  genres?: MbGenre[];
  tags?: MbTag[];
}

export interface MbLabelInfo {
  'catalog-number'?: string | null;
  label?: {
    id?: string;
    name?: string;
    'sort-name'?: string;
  } | null;
}

export interface MbRelease {
  id: string;
  title: string;
  date?: string;
  country?: string;
  status?: string;
  disambiguation?: string;
  'artist-credit'?: MbArtistCredit[];
  'release-group'?: MbReleaseGroup;
  'label-info'?: MbLabelInfo[];
  media?: MbMedium[];
  relations?: MbRelation[];
  genres?: MbGenre[];
  tags?: MbTag[];
  'cover-art-archive'?: { front?: boolean; artwork?: boolean; count?: number };
}

export interface MbSearchRelease {
  id: string;
  score?: number;
  title: string;
  status?: string;
  date?: string;
  country?: string;
  'track-count'?: number;
  media?: { format?: string | null; 'track-count'?: number }[];
  'artist-credit'?: MbArtistCredit[];
  'release-group'?: { id?: string; title?: string; 'primary-type'?: string; 'first-release-date'?: string };
  'label-info'?: MbLabelInfo[];
}

export interface MbSearchResponse {
  count?: number;
  offset?: number;
  releases?: MbSearchRelease[];
}

export interface MbSearchReleaseGroup {
  id: string;
  score?: number;
  title: string;
  'first-release-date'?: string;
  'primary-type'?: string | null;
  'secondary-types'?: string[];
  'artist-credit'?: MbArtistCredit[];
}

export interface MbReleaseGroupSearchResponse {
  count?: number;
  offset?: number;
  'release-groups'?: MbSearchReleaseGroup[];
}

/** A release as embedded in a recording-search result. */
export interface MbRecordingSearchRelease {
  id: string;
  title: string;
  date?: string;
  country?: string;
  status?: string;
  'track-count'?: number;
  'release-group'?: {
    id?: string;
    title?: string;
    'first-release-date'?: string;
    'primary-type'?: string;
    'secondary-types'?: string[];
  };
}

export interface MbSearchRecording {
  id: string;
  score?: number;
  title: string;
  length?: number | null;
  'artist-credit'?: MbArtistCredit[];
  'first-release-date'?: string;
  releases?: MbRecordingSearchRelease[];
}

export interface MbRecordingSearchResponse {
  count?: number;
  offset?: number;
  recordings?: MbSearchRecording[];
}

export interface MbReleaseLookupResponse extends MbRelease {}

// ---------- errors ----------

export class MbHttpError extends Error {
  readonly url: string;
  readonly status: number;
  readonly body: string;

  constructor(url: string, status: number, body: string) {
    super(`MusicBrainz request failed (${status}) for ${url}`);
    this.name = 'MbHttpError';
    this.url = url;
    this.status = status;
    this.body = body;
  }
}

// ---------- rate limiting ----------

export type SleepFn = (ms: number) => Promise<void>;
export type NowFn = () => number;

export const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serialises calls so that two consecutive network requests are at least
 * `intervalMs` apart. Concurrent callers queue in invocation order.
 */
export class RateLimiter {
  private readonly intervalMs: number;
  private readonly sleep: SleepFn;
  private readonly now: NowFn;
  private last = Number.NEGATIVE_INFINITY;
  private queue: Promise<void> = Promise.resolve();

  constructor(intervalMs = 1000, sleep: SleepFn = defaultSleep, now: NowFn = () => Date.now()) {
    this.intervalMs = Math.max(0, intervalMs);
    this.sleep = sleep;
    this.now = now;
  }

  wait(): Promise<void> {
    const run = this.queue.then(async () => {
      const elapsed = this.now() - this.last;
      const delay = this.intervalMs - elapsed;
      if (delay > 0) await this.sleep(delay);
      this.last = this.now();
    });
    // Keep the chain alive even if a waiter rejects (it never should).
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

// ---------- client ----------

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_RETRIES = 4;
const BASE_URL = 'https://musicbrainz.org/ws/2';

export const RELEASE_INC = [
  'recordings',
  'artist-credits',
  'labels',
  'release-groups',
  'genres',
  'tags',
  'artist-rels',
  'recording-rels',
  'work-rels',
  'recording-level-rels',
  'work-level-rels',
].join('+');

export interface MbClientOptions {
  userAgent: string;
  db?: Db;
  fetch?: FetchLike;
  sleep?: SleepFn;
  now?: NowFn;
  rateLimitMs?: number;
  cacheTtlMs?: number;
  maxRetries?: number;
  limiter?: RateLimiter;
}

interface CacheRow {
  body: string;
  status: number;
}

export class MbClient {
  private readonly userAgent: string;
  private readonly db?: Db;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: SleepFn;
  private readonly now: NowFn;
  private readonly cacheTtlMs: number;
  private readonly maxRetries: number;
  private readonly limiter: RateLimiter;

  constructor(opts: MbClientOptions) {
    this.userAgent = opts.userAgent;
    this.db = opts.db;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? (() => Date.now());
    this.cacheTtlMs = opts.cacheTtlMs ?? CACHE_TTL_MS;
    this.maxRetries = opts.maxRetries ?? MAX_RETRIES;
    this.limiter = opts.limiter ?? new RateLimiter(opts.rateLimitMs ?? 1000, this.sleep, this.now);
  }

  /** GET a URL through the rate limiter + cache. Throws on non-2xx. */
  private async request(url: string): Promise<CacheRow> {
    const cached = this.cacheGet(url);
    if (cached) {
      if (cached.status < 200 || cached.status >= 300) throw new MbHttpError(url, cached.status, cached.body);
      return cached;
    }

    for (let attempt = 0; ; attempt++) {
      await this.limiter.wait();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            'User-Agent': this.userAgent,
            Accept: 'application/json',
          },
        });
      } catch (err) {
        if (attempt < this.maxRetries) {
          await this.sleep(this.backoff(attempt + 1));
          continue;
        }
        throw err;
      }

      const body = await res.text();
      const retryable = res.status === 429 || res.status === 503;
      if (retryable && attempt < this.maxRetries) {
        await this.sleep(this.backoff(attempt + 1, res));
        continue;
      }
      if (retryable) {
        throw new MbHttpError(url, res.status, body);
      }

      // Cache every final GET response (including 4xx) so repeated lookups for
      // missing/ambiguous data do not hammer the API.
      this.cachePut(url, body, res.status);
      if (res.status < 200 || res.status >= 300) {
        throw new MbHttpError(url, res.status, body);
      }
      return { body, status: res.status };
    }
  }

  async getJson<T>(url: string): Promise<T> {
    const { body } = await this.request(url);
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error(`MusicBrainz returned invalid JSON for ${url}`);
    }
  }

  /** Free-form Lucene release search. */
  async searchReleasesQuery(query: string, limit = 15): Promise<MbSearchRelease[]> {
    const params = new URLSearchParams({ query, fmt: 'json', limit: String(limit) });
    const url = `${BASE_URL}/release/?${params.toString()}`;
    const body = await this.getJson<MbSearchResponse>(url);
    return body.releases ?? [];
  }

  /** Release search by album title + artist name (+ optional exact track count). */
  async searchRelease(title: string, artist: string, limit = 15, trackCount?: number): Promise<MbSearchRelease[]> {
    const clauses: string[] = [];
    if (title.trim()) clauses.push(`release:"${escapeLucene(title)}"`);
    if (artist.trim()) clauses.push(`artist:"${escapeLucene(artist)}"`);
    if (trackCount != null && trackCount > 0) clauses.push(`tracks:${Math.trunc(trackCount)}`);
    if (clauses.length === 0) return [];
    return this.searchReleasesQuery(clauses.join(' AND '), limit);
  }

  /** Release-group search (the group survives edition differences). */
  async searchReleaseGroups(query: string, limit = 10, artist?: string): Promise<MbSearchReleaseGroup[]> {
    const clauses: string[] = [];
    if (query.trim()) clauses.push(`releasegroup:"${escapeLucene(query)}"`);
    if (artist?.trim()) clauses.push(`artist:"${escapeLucene(artist)}"`);
    if (clauses.length === 0) return [];
    const params = new URLSearchParams({ query: clauses.join(' AND '), fmt: 'json', limit: String(limit) });
    const url = `${BASE_URL}/release-group/?${params.toString()}`;
    const body = await this.getJson<MbReleaseGroupSearchResponse>(url);
    return body['release-groups'] ?? [];
  }

  /**
   * Releases belonging to a release group, including their media/track counts.
   * Used to pick the edition (deluxe, one disc of a box, bonus tracks) that
   * matches the local album, then only that release is fetched in full.
   */
  async browseReleaseGroup(groupId: string, limit = 100): Promise<MbSearchRelease[]> {
    const params = new URLSearchParams({
      'release-group': groupId,
      inc: 'media+artist-credits+labels',
      fmt: 'json',
      limit: String(limit),
    });
    const url = `${BASE_URL}/release/?${params.toString()}`;
    const body = await this.getJson<MbSearchResponse>(url);
    return (body.releases ?? []).map((release) => ({
      ...release,
      'track-count':
        release['track-count'] ??
        (release.media ?? []).reduce((sum, medium) => sum + (medium['track-count'] ?? 0), 0),
    }));
  }

  /**
   * Release candidates found from the first few local track titles.
   *
   * The release search index does not contain track titles, so this searches
   * recordings (which do) and expands each hit to the releases it appears on.
   * `releaseTitle` narrows the search when the local album title is usable, and
   * `artist` narrows it when the local artist is usable.
   */
  async searchReleaseByTracks(
    trackTitles: string[],
    opts: { artist?: string; releaseTitle?: string; limit?: number } = {},
  ): Promise<MbSearchRelease[]> {
    const titles = trackTitles.map((t) => t.trim()).filter(Boolean).slice(0, 3);
    if (titles.length === 0) return [];
    // Query each title separately: an OR query favours medleys/remix recordings
    // that match several titles, pushing the actual album recordings down.
    const perTitleLimit = opts.limit ?? (opts.artist?.trim() ? 10 : 25);

    const out: MbSearchRelease[] = [];
    const seen = new Set<string>();
    for (const title of titles) {
      let query = `recording:"${escapeLucene(title)}"`;
      if (opts.artist?.trim()) query += ` AND artist:"${escapeLucene(opts.artist)}"`;
      if (opts.releaseTitle?.trim()) query += ` AND release:"${escapeLucene(opts.releaseTitle)}"`;

      const params = new URLSearchParams({
        query,
        fmt: 'json',
        limit: String(perTitleLimit),
      });
      const url = `${BASE_URL}/recording/?${params.toString()}`;
      const body = await this.getJson<MbRecordingSearchResponse>(url);

      for (const recording of body.recordings ?? []) {
        for (const release of recording.releases ?? []) {
          if (!release.id || seen.has(release.id)) continue;
          seen.add(release.id);
          out.push({
            id: release.id,
            score: recording.score,
            title: release.title,
            date: release.date || release['release-group']?.['first-release-date'],
            country: release.country,
            status: release.status,
            'track-count': release['track-count'],
            'release-group': release['release-group'],
            'artist-credit': recording['artist-credit'],
          });
          if (out.length >= 60) return out;
        }
      }
    }
    return out;
  }

  /** Full release lookup including recordings, relations, genres and tags. */
  async getRelease(id: string): Promise<MbRelease> {
    const url = `${BASE_URL}/release/${encodeURIComponent(id)}?inc=${RELEASE_INC}&fmt=json`;
    return this.getJson<MbReleaseLookupResponse>(url);
  }

  private backoff(retryNumber: number, res?: Response): number {
    let delay = Math.min(1000 * 2 ** (retryNumber - 1), 15000);
    const retryAfter = res?.headers.get('retry-after');
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs) && secs > 0) delay = Math.max(delay, Math.min(secs * 1000, 30000));
    }
    return delay;
  }

  private cacheGet(url: string): CacheRow | null {
    if (!this.db) return null;
    try {
      const row = this.db
        .prepare('SELECT body, status, fetched_at FROM http_cache WHERE key = ?')
        .get(url) as { body: string; status: number; fetched_at: number } | undefined;
      if (!row) return null;
      if (this.now() - row.fetched_at > this.cacheTtlMs) {
        this.db.prepare('DELETE FROM http_cache WHERE key = ?').run(url);
        return null;
      }
      return { body: row.body, status: row.status };
    } catch {
      return null;
    }
  }

  private cachePut(url: string, body: string, status: number): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `INSERT INTO http_cache (key, body, status, fetched_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET body = excluded.body, status = excluded.status, fetched_at = excluded.fetched_at`,
        )
        .run(url, body, status, this.now());
    } catch {
      // Cache writes must never break matching.
    }
  }
}

// ---------- sharing ----------

const sharedClients = new WeakMap<object, MbClient>();

/**
 * One MusicBrainz client per database (and therefore one 1 req/s limiter and
 * one HTTP cache). The matcher, album meta and artist meta all use this in
 * production, so their combined request rate stays within MusicBrainz's limit.
 * Tests that inject a fake `fetch` build their own client instead.
 */
export function sharedMbClient(db: Db, opts: MbClientOptions): MbClient {
  const existing = sharedClients.get(db);
  if (existing) return existing;
  const client = new MbClient(opts);
  sharedClients.set(db, client);
  return client;
}

// ---------- helpers ----------

/** Escape Lucene special characters inside a quoted phrase. */
export function escapeLucene(value: string): string {
  return value.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1');
}

/** "Daft Punk" from [{name:'Daft Punk'}] / "A & B" from credits + joinphrases. */
export function artistCreditName(credit: MbArtistCredit[] | undefined): string {
  if (!credit || credit.length === 0) return '';
  return credit.map((c) => `${c.name}${c.joinphrase ?? ''}`).join('').trim();
}

export function yearFromDate(date: string | undefined | null): number | undefined {
  if (!date) return undefined;
  const m = /^(\d{4})/.exec(date);
  return m ? Number(m[1]) : undefined;
}

export function flattenReleaseTracks(release: MbRelease): {
  medium: number;
  position: number;
  track: MbTrack;
  recording?: MbRecording;
}[] {
  const out: { medium: number; position: number; track: MbTrack; recording?: MbRecording }[] = [];
  for (const medium of release.media ?? []) {
    const mediumPos = medium.position ?? 1;
    const tracks = medium.tracks ?? [];
    tracks.forEach((track, index) => {
      out.push({
        medium: mediumPos,
        position: track.position ?? index + 1,
        track,
        recording: track.recording,
      });
    });
  }
  return out;
}

export function releaseTrackCount(release: MbRelease): number {
  const media = release.media ?? [];
  if (media.length === 0) return 0;
  return media.reduce((sum, m) => sum + (m.tracks?.length ?? m['track-count'] ?? 0), 0);
}

export function searchItemTrackCount(item: MbSearchRelease): number {
  if (typeof item['track-count'] === 'number') return item['track-count'];
  return (item.media ?? []).reduce((sum, m) => sum + (m['track-count'] ?? 0), 0);
}
