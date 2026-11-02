// Cover thumbnails run through a 3-slot FIFO semaphore: a grid of 200 px tiles
// used to spawn one ffmpeg per tile. ffmpeg is replaced with a slow fake here so
// the test can observe how many run at once without touching the real binary.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/server.js';
import { openDb, type Db } from '../src/db/index.js';
import { ensureSpotifyLibrarySchema } from '../src/spotify/library-schema.js';
import type { Config } from '../src/config.js';

process.env.LOG_LEVEL = 'silent';

const ffmpeg = vi.hoisted(() => ({ active: 0, max: 0, calls: 0, delayMs: 30 }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { writeFileSync: write } = await import('node:fs');
  return {
    ...actual,
    execFile: (
      _file: string,
      args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null) => void,
    ) => {
      ffmpeg.active++;
      ffmpeg.calls++;
      ffmpeg.max = Math.max(ffmpeg.max, ffmpeg.active);
      const out = args[args.length - 1]!;
      setTimeout(() => {
        try {
          write(out, 'jpeg');
        } catch {
          // the route 500s if the fake cannot write; the assertion below reports it
        }
        ffmpeg.active--;
        cb(null);
      }, ffmpeg.delayMs);
    },
  };
});

const ALBUMS = Array.from({ length: 12 }, (_, i) => `sp:thumb${i}`);

let root: string;
let db: Db;
let app: FastifyInstance;
let closeApp: (() => Promise<void>) | undefined;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'liner-thumb-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const src = join(root, 'cover.jpg');
  writeFileSync(src, 'jpeg');

  db = openDb(':memory:');
  ensureSpotifyLibrarySchema(db);
  db.prepare("INSERT INTO artists (id, name, sort_name) VALUES ('ar:thumb', 'Thumbs', NULL)").run();
  const insert = db.prepare(
    `INSERT INTO albums (id, source, title, artist_id, cover_path, added_at, in_library)
     VALUES (?, 'spotify', ?, 'ar:thumb', ?, 1, 0)`,
  );
  for (const id of ALBUMS) insert.run(id, id, src);

  const cfg: Config = {
    libraryRoots: [join(root, 'library')],
    dataDir,
    port: 0,
    audioDevice: 'pipewire',
    userAgent: 'Liner test',
  };
  const built = await buildApp(db, cfg, {
    pcZone: false,
    scanOnStart: false,
    webDist: join(root, 'no-web-dist'),
  });
  app = built.app;
  closeApp = built.close;
});

afterAll(async () => {
  await closeApp?.();
  db?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('cover thumbnail concurrency', () => {
  it('runs at most three ffmpeg processes at once', async () => {
    const responses = await Promise.all(
      ALBUMS.map((id) =>
        app.inject({ method: 'GET', url: `/api/cover/${encodeURIComponent(id)}?size=200` }),
      ),
    );
    for (const res of responses) {
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).toBe('jpeg');
    }
    expect(ffmpeg.calls).toBe(ALBUMS.length);
    expect(ffmpeg.max).toBe(3); // reaches the cap but never exceeds it
  });
});
