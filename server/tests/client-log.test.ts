// POST /api/client-log keeps a bounded ring in memory: oversized bodies are refused, large data is truncated.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/server.js';
import { openDb, type Db } from '../src/db/index.js';
import type { Config } from '../src/config.js';

process.env.LOG_LEVEL = 'silent';

let root: string;
let db: Db;
let app: FastifyInstance;
let closeApp: () => Promise<void>;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'rune-client-log-'));
  db = openDb(':memory:');
  const cfg: Config = { libraryRoots: [], dataDir: join(root, 'data'), port: 0, audioDevice: 'null', userAgent: 'test' };
  const built = await buildApp(db, cfg, { scanOnStart: false, spotifySyncOnStart: false, webDist: join(root, 'none') });
  app = built.app;
  closeApp = built.close;
});

afterAll(async () => {
  await closeApp?.();
  db?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('POST /api/client-log', () => {
  it('stores a normal entry', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/client-log', payload: { level: 'warn', msg: 'hello', data: { a: 1 } } });
    expect(res.statusCode).toBe(200);
    const log = (await app.inject({ method: 'GET', url: '/api/client-log' })).json() as { msg: string; data: unknown }[];
    expect(log.at(-1)).toMatchObject({ msg: 'hello', data: { a: 1 } });
  });

  it('refuses a ~900 KB body', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/client-log', payload: { msg: 'big', data: 'x'.repeat(900_000) } });
    expect(res.statusCode).toBe(413);
  });

  it('truncates data that fits the body limit but is large', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/client-log', payload: { msg: 'mid', data: 'y'.repeat(10_000) } });
    expect(res.statusCode).toBe(200);
    const log = (await app.inject({ method: 'GET', url: '/api/client-log' })).json() as { msg: string; data: string }[];
    const entry = log.find((e) => e.msg === 'mid')!;
    expect(entry.data.length).toBeLessThan(2200);
    expect(entry.data).toMatch(/truncated/);
  });
});
