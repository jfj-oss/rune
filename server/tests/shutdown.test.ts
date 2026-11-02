import { describe, expect, it } from 'vitest';
import { createShutdownHandler, gracefulShutdown } from '../src/ops/shutdown.js';

describe('graceful shutdown', () => {
  it('tears down in order: watcher, db flush/checkpoint, playback, extra, db', async () => {
    const order: string[] = [];
    const result = await gracefulShutdown({
      watcher: { stop: () => void order.push('watcher') },
      flushDb: () => void order.push('flush'),
      db: {
        pragma: () => void order.push('checkpoint'),
        close: () => void order.push('db-close'),
      },
      mpv: [{ close: () => void order.push('mpv') }],
      extra: [{ name: 'http-close', run: () => void order.push('extra') }],
      timeoutMs: 2_000,
    });

    expect(order).toEqual(['watcher', 'flush', 'checkpoint', 'mpv', 'extra', 'db-close']);
    expect(result.timedOut).toBe(false);
    expect(result.steps.map((s) => s.name)).toEqual([
      'watcher-stop',
      'db-flush',
      'db-checkpoint',
      'playback-close',
      'http-close',
      'db-close',
    ]);
    expect(result.steps.every((s) => s.ok)).toBe(true);
    expect(result.elapsedMs).toBeLessThan(2_000);
  });

  it('caps the whole sequence at the timeout instead of hanging on SIGTERM', async () => {
    const ran: string[] = [];
    const result = await gracefulShutdown({
      watcher: { stop: () => new Promise<void>(() => undefined) }, // never resolves
      flushDb: () => void ran.push('flush'),
      db: { close: () => void ran.push('db-close') },
      timeoutMs: 60,
    });

    expect(result.timedOut).toBe(true);
    expect(result.elapsedMs).toBeLessThan(1_000);
    expect(result.steps[0]).toMatchObject({ name: 'watcher-stop', ok: false, error: 'timeout' });
    expect(result.steps.slice(1).every((s) => s.skipped === true)).toBe(true);
    expect(ran).toEqual([]);
  });

  it('continues after a failing step and reports the error', async () => {
    const order: string[] = [];
    const result = await gracefulShutdown({
      watcher: {
        stop: () => {
          throw new Error('watch close failed');
        },
      },
      flushDb: () => void order.push('flush'),
      mpv: { close: () => Promise.reject(new Error('mpv gone')) },
      db: { close: () => void order.push('db-close') },
      timeoutMs: 2_000,
    });

    expect(order).toEqual(['flush', 'db-close']);
    expect(result.timedOut).toBe(false);
    expect(result.steps[0]).toMatchObject({ name: 'watcher-stop', ok: false, error: 'watch close failed' });
    expect(result.steps.find((s) => s.name === 'playback-close')).toMatchObject({ ok: false, error: 'mpv gone' });
    expect(result.steps.find((s) => s.name === 'db-close')).toMatchObject({ ok: true });
  });

  it('createShutdownHandler runs the sequence only once', async () => {
    let calls = 0;
    const shutdown = createShutdownHandler({
      watcher: {
        stop: () => {
          calls++;
        },
      },
      timeoutMs: 1_000,
    });
    const [first, second] = await Promise.all([shutdown(), shutdown('SIGTERM')]);
    expect(calls).toBe(1);
    expect(first).toBe(second);
    const third = await shutdown('SIGINT');
    expect(third).toBe(first);
    expect(calls).toBe(1);
  });
});
