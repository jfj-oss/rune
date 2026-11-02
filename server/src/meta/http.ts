// Polite, cached HTTP client for external metadata sources.
//
// Every GET is cached in the existing `http_cache` table (key = URL) so a warm
// database never re-fetches the same page. Requests to the same host are spaced
// out, and 429/5xx responses are retried with backoff. Tests inject `fetch` and
// `sleep`, so they never touch the network.
import type { Db } from '../db/index.js';
import type { Config } from '../config.js';

export interface HttpResponse {
  url: string;
  status: number;
  body: string;
  contentType?: string;
  fromCache: boolean;
}

export interface HttpOptions {
  /** Accept header override. */
  accept?: string;
  headers?: Record<string, string>;
  /** Per-request extra retries (default from deps). */
  retries?: number;
}

export interface HttpDeps {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long a cached 2xx response stays fresh. Default 30 days. */
  ttlMs?: number;
  /** Minimum ms between requests to the same host (number or per-host map). */
  minIntervalMs?: number | Record<string, number>;
  timeoutMs?: number;
  maxRetries?: number;
}

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MIN_INTERVAL_MS: Record<string, number> = {
  'en.wikipedia.org': 1100, // MediaWiki asks clients to be conservative
  'backend.metacritic.com': 700,
  'www.metacritic.com': 700,
  'pitchfork.com': 700,
  'www.albumoftheyear.org': 700,
  'genius.com': 900,
};
const DEFAULT_MIN_INTERVAL_FALLBACK = 500;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export class CachedHttp {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly ttlMs: number;
  private readonly minInterval: number | Record<string, number>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly lastAt = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
    deps: HttpDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    this.minInterval = deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.timeoutMs = deps.timeoutMs ?? 20_000;
    this.maxRetries = deps.maxRetries ?? 3;
  }

  /** Cached GET. Returns null when the network failed after retries. */
  async get(url: string, opts: HttpOptions = {}): Promise<HttpResponse | null> {
    const cached = this.readCache(url);
    if (cached) return cached;

    await this.pace(url);

    let attempt = 0;
    const maxRetries = opts.retries ?? this.maxRetries;
    while (attempt <= maxRetries) {
      try {
        const res = await this.fetchImpl(url, {
          headers: {
            'user-agent': this.cfg.userAgent,
            accept: opts.accept ?? 'text/html,application/json;q=0.9,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.8',
            ...opts.headers,
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const body = await res.text();
        if (res.status >= 200 && res.status < 300) {
          this.writeCache(url, res.status, body);
          return { url, status: res.status, body, contentType: res.headers.get('content-type') ?? undefined, fromCache: false };
        }
        if (isRetryable(res.status) && attempt < maxRetries) {
          await this.sleep(this.backoff(attempt, res.headers.get('retry-after')));
          attempt++;
          continue;
        }
        return { url, status: res.status, body, contentType: res.headers.get('content-type') ?? undefined, fromCache: false };
      } catch {
        if (attempt >= maxRetries) return null;
        await this.sleep(this.backoff(attempt));
        attempt++;
      }
    }
    return null;
  }

  /** Cached GET parsed as JSON. Null for non-2xx or invalid JSON. */
  async getJson<T>(url: string, opts: HttpOptions = {}): Promise<T | null> {
    const res = await this.get(url, { accept: 'application/json', ...opts });
    if (!res || res.status < 200 || res.status >= 300) return null;
    try {
      return JSON.parse(res.body) as T;
    } catch {
      return null;
    }
  }

  private readCache(url: string): HttpResponse | null {
    const row = this.db
      .prepare('SELECT body, status, fetched_at FROM http_cache WHERE key = ?')
      .get(url) as { body: string; status: number; fetched_at: number } | undefined;
    if (!row) return null;
    if (row.status < 200 || row.status >= 300) return null;
    if (this.now() - row.fetched_at >= this.ttlMs) return null;
    return { url, status: row.status, body: row.body, fromCache: true };
  }

  private writeCache(url: string, status: number, body: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO http_cache (key, body, status, fetched_at) VALUES (?, ?, ?, ?)')
      .run(url, body, status, this.now());
  }

  private async pace(url: string): Promise<void> {
    const host = hostOf(url);
    if (!host) return;
    const min = this.intervalFor(host);
    if (min <= 0) return;
    const last = this.lastAt.get(host);
    const now = this.now();
    if (last !== undefined && now - last < min) {
      await this.sleep(min - (now - last));
    }
    this.lastAt.set(host, this.now());
  }

  private intervalFor(host: string): number {
    if (typeof this.minInterval === 'number') return this.minInterval;
    return this.minInterval[host] ?? DEFAULT_MIN_INTERVAL_FALLBACK;
  }

  private backoff(attempt: number, retryAfter?: string | null): number {
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000);
    }
    return Math.min(1000 * 2 ** attempt, 8000);
  }
}

function isRetryable(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}
