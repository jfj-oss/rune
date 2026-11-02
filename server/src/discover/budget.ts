// Shared, persisted request budget for all Spotify calls made by Discover.
//
// The app was once rate-limited for ~23 hours. Discovery can easily fan out into
// dozens of search calls, so every Spotify request goes through this budget:
//   - at most one request per second (serialised across concurrent callers),
//   - at most `hourlyLimit` requests per rolling fixed hour (persisted),
//   - the app-wide `spotify.blockedUntil` is obeyed,
//   - a discovery 429 writes its own `spotify.discoverBlockedUntil`.
// Cache hits never reach the budget (see spotify-gateway.ts).
import type { Db } from '../db/index.js';
import { ensureDiscoverSchema } from './schema.js';

export const HOUR_MS = 60 * 60 * 1000;
export const DISCOVER_BLOCKED_KEY = 'spotify.discoverBlockedUntil';
const GLOBAL_BLOCKED_KEY = 'spotify.blockedUntil';
const BUDGET_KEY = 'spotify.discoverBudget';
const LAST_KEY = 'spotify.discoverLastRequestAt';

export type BlockReason = 'blocked' | 'budget';

export class DiscoverBlockedError extends Error {
  readonly until: number;
  readonly reason: BlockReason;

  constructor(until: number, reason: BlockReason) {
    super(reason === 'budget' ? 'Spotify discovery hourly budget exhausted' : 'Spotify is rate-limited');
    this.name = 'DiscoverBlockedError';
    this.until = until;
    this.reason = reason;
  }
}

export type SleepFn = (ms: number) => Promise<void>;

export interface DiscoverBudgetOptions {
  /** Minimum gap between two network calls (default 1100ms ≈ 1 req/s). */
  minIntervalMs?: number;
  /** Discovery requests per hour (default 300). */
  hourlyLimit?: number;
  now?: () => number;
  sleep?: SleepFn;
}

interface BudgetWindow {
  start: number;
  count: number;
}

export class SpotifyDiscoverBudget {
  private readonly minIntervalMs: number;
  private readonly hourlyLimit: number;
  private readonly now: () => number;
  private readonly sleep: SleepFn;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Db,
    opts: DiscoverBudgetOptions = {},
  ) {
    ensureDiscoverSchema(db);
    this.minIntervalMs = Math.max(0, opts.minIntervalMs ?? 1100);
    this.hourlyLimit = Math.max(1, opts.hourlyLimit ?? 300);
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Earliest time the next request may go out (0 = now). */
  blockedUntil(): number {
    return Math.max(this.getNumber(DISCOVER_BLOCKED_KEY), this.getNumber(GLOBAL_BLOCKED_KEY));
  }

  /** Requests left in the current hour window. */
  remaining(): number {
    const w = this.window(this.now());
    return Math.max(0, this.hourlyLimit - w.count);
  }

  /** Record a 429 (or any hard rate limit) and return the epoch ms it clears. */
  block(retryAfterMs: number | undefined): number {
    const until = this.now() + Math.max(60_000, retryAfterMs ?? 0);
    this.setState(DISCOVER_BLOCKED_KEY, String(until));
    return until;
  }

  /**
   * Wait for a budget slot. Rejects with DiscoverBlockedError when the global
   * block, the discovery block or the hourly cap forbids a request right now.
   */
  take(): Promise<void> {
    const run = this.queue.then(() => this.takeInner());
    // A rejected waiter must not poison the chain for later callers.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async takeInner(): Promise<void> {
    this.assertNotBlocked();
    const last = this.getNumber(LAST_KEY);
    const elapsed = this.now() - last;
    if (last > 0 && elapsed < this.minIntervalMs) {
      await this.sleep(this.minIntervalMs - elapsed);
    }
    this.assertNotBlocked();

    const now = this.now();
    const w = this.window(now);
    if (w.count >= this.hourlyLimit) {
      throw new DiscoverBlockedError(w.start + HOUR_MS, 'budget');
    }
    this.setState(BUDGET_KEY, JSON.stringify({ start: w.start, count: w.count + 1 }));
    this.setState(LAST_KEY, String(now));
  }

  private assertNotBlocked(): void {
    const until = this.blockedUntil();
    if (until > this.now()) throw new DiscoverBlockedError(until, 'blocked');
  }

  private window(now: number): BudgetWindow {
    const raw = this.getState(BUDGET_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<BudgetWindow>;
        if (
          typeof parsed.start === 'number' &&
          typeof parsed.count === 'number' &&
          Number.isFinite(parsed.start) &&
          Number.isFinite(parsed.count) &&
          now - parsed.start >= 0 &&
          now - parsed.start < HOUR_MS
        ) {
          return { start: parsed.start, count: Math.max(0, parsed.count) };
        }
      } catch {
        /* fall through to a fresh window */
      }
    }
    return { start: now, count: 0 };
  }

  private getState(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as { value: string } | undefined)
      ?.value;
  }

  private setState(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  private getNumber(key: string): number {
    const value = Number(this.getState(key) ?? 0);
    return Number.isFinite(value) ? value : 0;
  }
}
