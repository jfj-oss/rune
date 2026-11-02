// Short-lived memo for the LOCAL half of /api/search. The web asks for
// /search?local=1 and then /search for the same query (so library hits can paint
// before Spotify answers); both hit this cache and share one computation.
// Cleared by the server whenever a library-changed event is broadcast.

export interface LocalSearchCache<T> {
  /** Return the cached value for `key`, or compute and store it when stale. */
  get(key: string, compute: () => T): T;
  /** Drop every entry (library scan / Spotify sync / linking changed the data). */
  clear(): void;
  size(): number;
}

export interface LocalSearchCacheOptions {
  /** Entry lifetime. Default 15 s. */
  ttlMs?: number;
  /** Injectable clock (tests). Default Date.now. */
  now?: () => number;
  /** Bound on remembered queries; the oldest entry is evicted first. */
  maxEntries?: number;
}

export function createLocalSearchCache<T>(
  opts: LocalSearchCacheOptions = {},
): LocalSearchCache<T> {
  const ttlMs = opts.ttlMs ?? 15_000;
  const now = opts.now ?? Date.now;
  const maxEntries = Math.max(1, opts.maxEntries ?? 200);
  const entries = new Map<string, { at: number; value: T }>();

  return {
    get(key, compute) {
      const at = now();
      const hit = entries.get(key);
      if (hit && at - hit.at < ttlMs) return hit.value;
      const value = compute();
      if (entries.size >= maxEntries && !entries.has(key)) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(key, { at, value });
      return value;
    },
    clear() {
      entries.clear();
    },
    size() {
      return entries.size;
    },
  };
}
