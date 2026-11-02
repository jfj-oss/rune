import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { collectHealth, registerOpsRoutes, type HealthResponse } from '../src/ops/health.js';

const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) {
    try {
      await fn();
    } catch {
      // best effort
    }
  }
});

function seededDb(): Db {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)').run('ar:1', 'Artist');
  db.prepare(
    `INSERT INTO albums (id, source, title, artist_id, added_at) VALUES ('la:1', 'local', 'Album', 'ar:1', 1)`,
  ).run();
  for (const id of ['l:1', 'l:2']) {
    db.prepare(
      `INSERT INTO tracks (id, album_id, source, title, number, duration_ms)
       VALUES (?, 'la:1', 'local', 'Track', 1, 1000)`,
    ).run(id);
  }
  return db;
}

async function makeApp(deps: Parameters<typeof registerOpsRoutes>[1]): Promise<FastifyInstance> {
  const app = Fastify();
  registerOpsRoutes(app, deps);
  await app.ready();
  cleanups.push(() => app.close());
  return app;
}

describe('GET /health', () => {
  it('returns the full injected shape', async () => {
    const db = seededDb();
    cleanups.push(() => db.close());
    const dir = mkdtempSync(join(tmpdir(), 'liner-health-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    const app = await makeApp({
      version: '1.2.3',
      startedAt: Date.now() - 65_000,
      db,
      libraryRoots: [dir],
      lastScanAt: 1_700_000_000_000,
      mpv: () => ({ pid: 4242, alive: true }),
      spotify: async () => ({ connected: true }),
      jobs: () => ({ matching: true, details: false, loudness: true }),
    });

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as HealthResponse;

    expect(body.ok).toBe(true);
    expect(body.version).toBe('1.2.3');
    expect(body.uptimeS).toBeGreaterThanOrEqual(64);
    expect(body.uptimeS).toBeLessThanOrEqual(66);
    expect(body.db.albums).toBe(1);
    expect(body.db.tracks).toBe(2);
    expect(body.db.sizeMB).toBeGreaterThan(0);
    expect(body.library.roots).toHaveLength(1);
    expect(body.library.roots[0]).toMatchObject({ path: dir, mounted: true, readOnly: false });
    expect(body.library.roots[0]!.free).toBeGreaterThan(0);
    expect(body.library.lastScanAt).toBe(1_700_000_000_000);
    expect(body.mpv).toEqual({ pid: 4242, alive: true });
    expect(body.spotify).toEqual({ connected: true });
    expect(body.jobs).toEqual({ matching: true, details: false, loudness: true });
  });

  it('works with no modules injected', async () => {
    const app = await makeApp({ version: '0.1.0' });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as HealthResponse;
    expect(body).toMatchObject({
      ok: true,
      version: '0.1.0',
      db: { albums: 0, tracks: 0, sizeMB: 0 },
      library: { roots: [], lastScanAt: null },
      mpv: { alive: false },
      spotify: { connected: false },
      jobs: { matching: false, details: false },
    });
    expect('pid' in body.mpv).toBe(false);
    expect('loudness' in body.jobs).toBe(false);
  });

  it('accepts a ready-made library block and static job state', async () => {
    const health = await collectHealth({
      version: 'x',
      library: {
        roots: [{ path: '/mnt/BIG data/Music', mounted: false, readOnly: false, free: 0 }],
        lastScanAt: null,
      },
      jobs: { matching: false, details: true },
      mpv: { alive: false },
    });
    expect(health.library.roots[0]).toEqual({
      path: '/mnt/BIG data/Music',
      mounted: false,
      readOnly: false,
      free: 0,
    });
    expect(health.jobs).toEqual({ matching: false, details: true });
    expect(health.mpv).toEqual({ alive: false });
  });

  it('reports ok:false when the database is unreadable', async () => {
    const app = await makeApp({
      version: 'x',
      dbStats: () => {
        throw new Error('disk gone');
      },
    });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as HealthResponse;
    expect(body.ok).toBe(false);
    expect(body.db).toEqual({ albums: 0, tracks: 0, sizeMB: 0 });
  });
});
