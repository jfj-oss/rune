// Graceful shutdown with a hard deadline.
//
// Order matters:
//   1. stop the library watcher            (no new scans pile up)
//   2. finish the current DB write          (flushDb, e.g. await in-flight scan/backup)
//   3. checkpoint the WAL                   (optional, when a db handle is supplied)
//   4. close playback (mpv)                 (blocks up to 3 s inside PcZone.close)
//   5. extra teardown callbacks             (HTTP server, Spotify zones, ...)
//   6. close the database                   (last)
//
// Every step runs once, errors are collected instead of thrown, and the whole
// sequence is capped (5 s by default) so SIGTERM cannot hang the process.

export interface Closeable {
  close(): void | Promise<void>;
}

export interface CloseableDb {
  close(): void | Promise<void>;
  pragma?: (source: string) => unknown;
}

export interface ShutdownStep {
  name: string;
  run: () => void | Promise<void>;
}

export interface GracefulShutdownOptions {
  /** Library watcher (src/watch). */
  watcher?: { stop(): void | Promise<void> };
  /** Await the DB write that is currently running (scan transaction, backup...). */
  flushDb?: () => void | Promise<void>;
  /** WAL checkpoint after flushDb (default true when `db` is supplied). */
  checkpoint?: boolean;
  /** Playback zone(s) to close (mpv). */
  mpv?: Closeable | readonly Closeable[];
  /** Further teardown (HTTP listener, Spotify zones, ...) in call order. */
  extra?: readonly ShutdownStep[];
  /** Database handle; closed last. */
  db?: CloseableDb;
  /** Whole-sequence budget. Default 5 000 ms. */
  timeoutMs?: number;
  logger?: { warn: (obj: unknown, msg?: string) => void };
}

export interface ShutdownStepResult {
  name: string;
  ok: boolean;
  /** Present when the step failed. */
  error?: string;
  /** True when the deadline expired before this step could run. */
  skipped?: boolean;
}

export interface ShutdownResult {
  timedOut: boolean;
  elapsedMs: number;
  steps: ShutdownStepResult[];
}

const DEFAULT_TIMEOUT_MS = 5_000;

/** Run the teardown sequence. Never throws. */
export async function gracefulShutdown(opts: GracefulShutdownOptions): Promise<ShutdownResult> {
  const startedAt = Date.now();
  const budget = Math.max(0, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const deadline = startedAt + budget;
  const steps: ShutdownStepResult[] = [];
  let timedOut = false;

  const runStep = async (name: string, run: () => void | Promise<void>): Promise<void> => {
    if (timedOut) {
      steps.push({ name, ok: false, skipped: true });
      return;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      timedOut = true;
      steps.push({ name, ok: false, skipped: true });
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), remaining);
      timer.unref?.();
    });

    const work = Promise.resolve().then(run);
    // If the deadline wins, the underlying promise may reject later; keep that
    // from becoming an unhandled rejection.
    work.catch(() => undefined);

    try {
      const outcome = await Promise.race([
        work.then(
          () => ({ status: 'ok' as const }),
          (err: unknown) => ({ status: 'error' as const, err }),
        ),
        timeout,
      ]);
      if (outcome === 'timeout') {
        timedOut = true;
        steps.push({ name, ok: false, error: 'timeout' });
      } else if (outcome.status === 'error') {
        steps.push({ name, ok: false, error: errorMessage(outcome.err) });
      } else {
        steps.push({ name, ok: true });
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  if (opts.watcher) await runStep('watcher-stop', () => opts.watcher!.stop());
  if (opts.flushDb) await runStep('db-flush', opts.flushDb);
  if (opts.db && opts.checkpoint !== false) {
    await runStep('db-checkpoint', () => {
      opts.db!.pragma?.('wal_checkpoint(TRUNCATE)');
    });
  }

  if (opts.mpv) {
    const zones = Array.isArray(opts.mpv) ? opts.mpv : [opts.mpv];
    await runStep('playback-close', async () => {
      const results = await Promise.allSettled(zones.map((z) => Promise.resolve().then(() => z.close())));
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) throw failed.reason;
    });
  }

  for (const step of opts.extra ?? []) await runStep(step.name, step.run);
  if (opts.db) await runStep('db-close', () => opts.db!.close());

  return { timedOut, elapsedMs: Date.now() - startedAt, steps };
}

/**
 * Wrap gracefulShutdown so signals and an explicit "quit" cannot run it twice.
 * The returned function resolves to the same result for every caller.
 */
export function createShutdownHandler(
  opts: GracefulShutdownOptions,
): (reason?: string) => Promise<ShutdownResult> {
  let running: Promise<ShutdownResult> | null = null;
  return (reason?: string) => {
    if (!running) {
      if (reason) {
        try {
          opts.logger?.warn({ reason }, 'shutting down');
        } catch {
          // ignore
        }
      }
      running = gracefulShutdown(opts);
    }
    return running;
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
