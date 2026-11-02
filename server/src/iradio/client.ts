// Thin client for the free radio-browser.info API (worker Y).
//
// Usage guidelines (https://api.radio-browser.info):
//  - identify the app with a descriptive User-Agent (we reuse cfg.userAgent),
//  - spread load by picking a server from /json/servers instead of hammering one,
//  - at most ~1 request/second (enforced by a serialized gate),
//  - short-lived caching of read-only calls,
//  - the click endpoint (/json/url/<uuid>) is only called when a station is
//    actually played, never for search/browse.
import type { RadioBrowserStation, RadioSearchParams, RadioSort } from './types.js';

export const DEFAULT_SERVERS_URL = 'https://all.api.radio-browser.info/json/servers';
export const FALLBACK_BASE_URL = 'https://all.api.radio-browser.info';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_MIN_INTERVAL_MS = 1_000;

export interface RadioBrowserOptions {
  /** Base API URL, e.g. https://de1.api.radio-browser.info. Resolved from the
   *  server list when omitted. */
  baseUrl?: string;
  serversUrl?: string;
  /** Injected for tests / self-checks. */
  fetchImpl?: typeof fetch;
  userAgent: string;
  /** Minimum spacing between API requests (radio-browser asks for ~1/s). */
  minRequestIntervalMs?: number;
  timeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
  random?: () => number;
}

export class RadioBrowserError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'RadioBrowserError';
    this.status = status;
  }
}

interface CacheEntry {
  at: number;
  value: unknown;
}

export class RadioBrowserApi {
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly serversUrl: string;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly random: () => number;

  private explicitBase: string | undefined;
  private discoveredBase: string | undefined;
  private discovery: Promise<string> | undefined;

  private lastRequestAt = -Infinity;
  /** Serializes API calls so the 1 req/s guide holds even under concurrency. */
  private gate: Promise<unknown> = Promise.resolve();

  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: RadioBrowserOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.userAgent = opts.userAgent;
    this.serversUrl = opts.serversUrl ?? DEFAULT_SERVERS_URL;
    this.minIntervalMs = opts.minRequestIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.explicitBase = normalizeBase(opts.baseUrl);
  }

  /** The concrete server in use (undefined until discovery has run). */
  get baseUrl(): string | undefined {
    return this.explicitBase ?? this.discoveredBase;
  }

  /** Search stations by name/tag/country/language. */
  async searchStations(params: RadioSearchParams): Promise<RadioBrowserStation[]> {
    const key = `search:${JSON.stringify(params)}`;
    const cached = this.readCache<RadioBrowserStation[]>(key);
    if (cached) return cached;

    const base = await this.resolveBase();
    const qs = searchQuery(params);
    const body = await this.getJson<RadioBrowserStation[]>(`${base}/json/stations/search?${qs}`);
    const list = Array.isArray(body) ? body.filter(isStation) : [];
    this.writeCache(key, list);
    return list;
  }

  /** Full station record by uuid (the API returns an array). */
  async stationByUuid(uuid: string): Promise<RadioBrowserStation | undefined> {
    const key = `uuid:${uuid}`;
    const cached = this.readCache<RadioBrowserStation | undefined>(key);
    if (cached !== undefined) return cached;

    const base = await this.resolveBase();
    const body = await this.getJson<RadioBrowserStation[]>(
      `${base}/json/stations/byuuid/${encodeURIComponent(uuid)}`,
    );
    const station = Array.isArray(body) ? body.find(isStation) : undefined;
    this.writeCache(key, station ?? null);
    return station;
  }

  /**
   * Register one play with the radio-browser click counter. Callers must only
   * use this when a station actually started playing.
   */
  async click(uuid: string): Promise<void> {
    const base = await this.resolveBase();
    // The endpoint answers with a small JSON object; ignore the body.
    await this.request(`${base}/json/url/${encodeURIComponent(uuid)}`);
  }

  /** Raw server list used to pick a concrete API host. */
  async listServers(): Promise<{ name: string }[]> {
    const body = await this.getJson<{ name?: string }[]>(this.serversUrl);
    return Array.isArray(body)
      ? body.filter((s): s is { name: string } => typeof s?.name === 'string' && s.name.length > 0)
      : [];
  }

  /** Pick (and remember) a server from the round-robin list. */
  async resolveBase(): Promise<string> {
    if (this.explicitBase) return this.explicitBase;
    if (this.discoveredBase) return this.discoveredBase;
    this.discovery ??= (async () => {
      try {
        const servers = await this.listServers();
        const names = [...new Set(servers.map((s) => s.name))];
        if (names.length > 0) {
          const pick = names[Math.floor(this.random() * names.length)] ?? names[0]!;
          this.discoveredBase = normalizeBase(`https://${pick}`);
        }
      } catch {
        // Discovery is best-effort; the round-robin hostname still works.
      }
      this.discoveredBase ??= FALLBACK_BASE_URL;
      return this.discoveredBase;
    })();
    try {
      return await this.discovery;
    } finally {
      // Keep the resolved value but allow a retry if discovery failed hard.
      this.discovery = undefined;
    }
  }

  // ------------------------------------------------------------------ HTTP

  private getJson<T>(url: string): Promise<T> {
    return this.request(url).then((res) => res.json() as Promise<T>);
  }

  private request(url: string): Promise<Response> {
    const run = this.gate.then(async () => {
      await this.waitForGate();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      timer.unref?.();
      try {
        const res = await this.fetchImpl(url, {
          headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
          signal: controller.signal,
          redirect: 'follow',
        });
        if (!res.ok) {
          throw new RadioBrowserError(`radio-browser request failed: HTTP ${res.status}`, res.status);
        }
        return res;
      } catch (err) {
        if (err instanceof RadioBrowserError) throw err;
        throw new RadioBrowserError(
          `radio-browser request failed: ${(err as Error).message}`,
        );
      } finally {
        clearTimeout(timer);
      }
    });
    // Keep the gate alive after failures without swallowing the caller's error.
    this.gate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async waitForGate(): Promise<void> {
    const elapsed = this.now() - this.lastRequestAt;
    if (this.minIntervalMs > 0 && elapsed < this.minIntervalMs) {
      await sleep(this.minIntervalMs - elapsed);
    }
    this.lastRequestAt = this.now();
  }

  private readCache<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at > this.cacheTtlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  private writeCache(key: string, value: unknown): void {
    this.cache.set(key, { at: this.now(), value });
    // Bound the cache; searches are user-driven and cheap to repeat.
    if (this.cache.size > 200) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }
}

const RADIO_SORTS: readonly RadioSort[] = ['votes', 'clickcount', 'name', 'bitrate'];

export function searchQuery(params: RadioSearchParams): string {
  const sort: RadioSort = RADIO_SORTS.includes(params.sort as RadioSort)
    ? (params.sort as RadioSort)
    : 'votes';
  const limit =
    params.limit !== undefined && Number.isFinite(params.limit)
      ? clampInt(params.limit, 1, 100)
      : 30;
  const offset =
    params.offset !== undefined && Number.isFinite(params.offset)
      ? clampInt(params.offset, 0, 100_000)
      : 0;
  const qs = new URLSearchParams({
    hidebroken: 'true',
    limit: String(limit),
    offset: String(offset),
    order: sort,
    // The API's "reverse" means descending. Names read A→Z.
    reverse: sort === 'name' ? 'false' : 'true',
  });
  const q = params.q?.trim();
  if (q) qs.set('name', q);
  const tag = params.tag?.trim();
  if (tag) qs.set('tag', tag);
  const country = params.country?.trim();
  if (country) {
    // A two-letter value is a country code, anything longer is a name.
    if (/^[a-z]{2}$/i.test(country)) qs.set('countrycode', country.toUpperCase());
    else qs.set('country', country);
  }
  const language = params.language?.trim();
  if (language) qs.set('language', language);
  return qs.toString();
}

function isStation(value: unknown): value is RadioBrowserStation {
  const s = value as RadioBrowserStation | null;
  return !!s && typeof s.stationuuid === 'string' && s.stationuuid.length > 0 && typeof s.name === 'string';
}

function normalizeBase(base: string | undefined): string | undefined {
  if (!base) return undefined;
  return base.replace(/\/+$/, '');
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function sleep(ms: number): Promise<void> {
  // Deliberately referenced: this sleeps inside an awaited API request (the 1/s
  // gate), so an unref'd timer would let Node exit with an unsettled promise.
  return new Promise((resolve) => setTimeout(resolve, ms));
}
