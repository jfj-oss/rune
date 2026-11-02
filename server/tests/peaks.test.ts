import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import type { Config } from '../src/config.js';
import {
  createPeaks,
  peaksFfmpegSpawnCount,
  registerPeaksRoutes,
  type PeaksService,
} from '../src/peaks/index.js';

let dir: string;
let db: Db;
let cfg: Config;
let peaks: PeaksService;
let app: FastifyInstance;

/** 5 s: 2 s silence, 1 s tone, 2 s silence. */
let burstPath: string;
/** 5 s: 2 s tone, 3 s silence (used to prove cue slices only decode their slice). */
let slicedPath: string;

function run(cmd: string, args: string[]): void {
  const res = spawnSync(cmd, args, { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
}

/** silence(2s) + sine(1s) + silence(2s) via lavfi, written as 8 kHz mono WAV. */
function burstFixture(path: string): void {
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=2',
    '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]',
    '-map', '[out]', '-ac', '1', '-ar', '8000', '-c:a', 'pcm_s16le', path,
  ]);
}

/** sine(2s) + silence(3s). */
function slicedFixture(path: string): void {
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=3',
    '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[out]',
    '-map', '[out]', '-ac', '1', '-ar', '8000', '-c:a', 'pcm_s16le', path,
  ]);
}

interface Seed {
  id: string;
  path: string | null;
  durationMs: number;
  cueStart?: number | null;
  cueEnd?: number | null;
  source?: 'local' | 'spotify';
}

function seedTrack(t: Seed): void {
  db.prepare('INSERT OR IGNORE INTO artists (id, name) VALUES (?, ?)').run('ar:1', 'Tester');
  db.prepare(
    `INSERT OR IGNORE INTO albums (id, source, title, artist_id, genres, added_at)
     VALUES ('la:1', 'local', 'Fixture Album', 'ar:1', '[]', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms, path,
                         cue_start_ms, cue_end_ms, format)
     VALUES (?, 'la:1', ?, ?, 1, 1, ?, ?, ?, ?, 'wav')`,
  ).run(t.id, t.source ?? 'local', t.id, t.durationMs, t.path, t.cueStart ?? null, t.cueEnd ?? null);
}

/** Wait until `predicate` is true (background prefetch), or fail after `ms`. */
async function waitFor(predicate: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out waiting for condition');
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'liner-peaks-'));
  burstPath = join(dir, 'burst.wav');
  slicedPath = join(dir, 'sliced.wav');
  burstFixture(burstPath);
  slicedFixture(slicedPath);

  cfg = { libraryRoots: [], dataDir: join(dir, 'data'), port: 0, audioDevice: 'null', userAgent: 'test' };
  db = openDb(':memory:');
  seedTrack({ id: 'l:burst', path: burstPath, durationMs: 5000 });
  seedTrack({ id: 'l:cue-silence', path: slicedPath, durationMs: 2500, cueStart: 2500, cueEnd: 5000 });
  seedTrack({ id: 'l:cue-tone', path: slicedPath, durationMs: 2000, cueStart: 0, cueEnd: 2000 });
  seedTrack({ id: 'l:missing', path: join(dir, 'nope.wav'), durationMs: 1000 });
  seedTrack({ id: 'sp:abc', path: null, durationMs: 1000, source: 'spotify' });

  peaks = createPeaks(db, cfg);
  app = Fastify();
  registerPeaksRoutes(app, peaks);
  await app.ready();
});

afterAll(async () => {
  peaks.close();
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('peak data', () => {
  it('places a loud burst at the right bucket (within one)', async () => {
    const result = await peaks.get('l:burst', 200);
    expect(result).not.toBeNull();
    expect(result!.buckets).toBe(200);
    expect(result!.data).toHaveLength(200);
    expect(result!.data.every((v) => v >= 0 && v <= 255)).toBe(true);

    // Burst occupies 2.0–3.0 s => bucket 80 of 200.
    const firstLoud = result!.data.findIndex((v) => v > 0);
    expect(Math.abs(firstLoud - 80)).toBeLessThanOrEqual(1);
    expect(Math.max(...result!.data)).toBe(255);
    // Silence before the burst is really silent.
    expect(result!.data.slice(0, 79).every((v) => v === 0)).toBe(true);
  });

  it('decodes only the cue slice of a shared file', async () => {
    const full = await peaks.get('l:cue-tone', 200); // 0–2 s = tone
    expect(full!.data.some((v) => v > 0)).toBe(true);

    const silent = await peaks.get('l:cue-silence', 200); // 2.5–5 s = silence
    expect(silent!.data.every((v) => v === 0)).toBe(true);

    // Different cue tracks of one file have their own cache entries.
    const files = readdirSync(join(cfg.dataDir, 'peaks')).filter((f) => f.endsWith('.bin'));
    expect(files.some((f) => f.startsWith('l_cue_silence-'))).toBe(true);
    expect(files.some((f) => f.startsWith('l_cue_tone-'))).toBe(true);
  });

  it('serves every requested resolution from the same cached decode', async () => {
    const before = peaksFfmpegSpawnCount();
    const one = await peaks.get('l:burst', 200);
    const two = await peaks.get('l:burst', 2000);
    expect(peaksFfmpegSpawnCount() - before).toBe(0); // already cached by the first test
    expect(one!.data).toHaveLength(200);
    expect(two!.data).toHaveLength(2000);
    // The burst is still in the right place at the cache's native resolution.
    const firstLoud = two!.data.findIndex((v) => v > 0);
    expect(Math.abs(firstLoud - 800)).toBeLessThanOrEqual(10);
  });

  it('cache hit does not spawn ffmpeg', async () => {
    const before = peaksFfmpegSpawnCount();
    await peaks.get('l:cue-tone', 400);
    await peaks.get('l:cue-tone', 400);
    expect(peaksFfmpegSpawnCount() - before).toBe(0);
  });

  it('single-flights concurrent requests for an uncached track', async () => {
    seedTrack({ id: 'l:single', path: burstPath, durationMs: 5000 });
    // Cache path is per track id, so this id is cold even though burstPath is warm.
    const before = peaksFfmpegSpawnCount();
    const [a, b] = await Promise.all([peaks.get('l:single', 200), peaks.get('l:single', 800)]);
    expect(peaksFfmpegSpawnCount() - before).toBe(1);
    expect(a!.data).toHaveLength(200);
    expect(b!.data).toHaveLength(800);
  });

  it('prefetches in the background, then the request reuses the cache', async () => {
    seedTrack({ id: 'l:prefetch', path: burstPath, durationMs: 5000 });
    const before = peaksFfmpegSpawnCount();
    peaks.prefetch(['l:prefetch', 'sp:abc', 'l:does-not-exist']);
    const cacheDir = join(cfg.dataDir, 'peaks');
    await waitFor(() => existsSync(cacheDir) && readdirSync(cacheDir).some((f) => f.startsWith('l_prefetch-')));
    const spawnsAfterPrefetch = peaksFfmpegSpawnCount();
    expect(spawnsAfterPrefetch - before).toBe(1);
    const got = await peaks.get('l:prefetch', 200);
    expect(got).not.toBeNull();
    expect(peaksFfmpegSpawnCount()).toBe(spawnsAfterPrefetch);
  });

  it('writes one compact binary file per track+mtime', async () => {
    const cacheDir = join(cfg.dataDir, 'peaks');
    const files = readdirSync(cacheDir).filter((f) => f.startsWith('l_burst-'));
    expect(files).toHaveLength(1);
    const size = statSync(join(cacheDir, files[0]!)).size;
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(2000);
  });
});

describe('GET /peaks/:trackId', () => {
  it('returns JSON with the requested bucket count', async () => {
    const res = await app.inject({ url: '/peaks/l:burst?buckets=200' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { buckets: number; data: number[] };
    expect(body.buckets).toBe(200);
    expect(body.data).toHaveLength(200);
  });

  it('defaults to 800 buckets and clamps out-of-range values', async () => {
    const def = await app.inject({ url: '/peaks/l:burst' });
    expect((def.json() as { buckets: number }).buckets).toBe(800);

    const low = await app.inject({ url: '/peaks/l:burst?buckets=10' });
    expect((low.json() as { buckets: number }).buckets).toBe(200);

    const high = await app.inject({ url: '/peaks/l:burst?buckets=99999' });
    const highBody = high.json() as { buckets: number; data: number[] };
    expect(highBody.buckets).toBe(2000);
    expect(highBody.data).toHaveLength(2000);
  });

  it('returns application/octet-stream with ?bin=1', async () => {
    const res = await app.inject({ url: '/peaks/l:burst?buckets=200&bin=1' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['x-peaks-buckets']).toBe('200');
    expect(res.rawPayload).toHaveLength(200);
    expect(res.rawPayload.every((v) => v >= 0 && v <= 255)).toBe(true);
  });

  it('uses the local twin of a Spotify song (same title, shared artist, close length)', async () => {
    db.prepare("INSERT OR IGNORE INTO artists (id, name) VALUES ('ar:sp', 'tester')").run();
    db.prepare(
      `INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms, path)
       VALUES ('sp:twin', 'la:1', 'spotify', 'L:BURST', 1, 1, 6500, NULL),
              ('sp:far', 'la:1', 'spotify', 'l:burst', 1, 1, 12000, NULL),
              ('sp:other', 'la:1', 'spotify', 'l:burst', 1, 1, 5000, NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO track_artists (track_id, artist_id, position) VALUES
       ('l:burst', 'ar:1', 0), ('sp:twin', 'ar:sp', 0), ('sp:far', 'ar:sp', 0)`,
    ).run();
    // sp:other has no artist in common, sp:far is 7 s longer: no twin for either
    const local = await peaks.get('l:burst', 200);
    expect(await peaks.get('sp:twin', 200)).toEqual(local);
    expect(await peaks.get('sp:far', 200)).toBeNull();
    expect(await peaks.get('sp:other', 200)).toBeNull();
  });

  it('404s for Spotify, unknown tracks and missing files', async () => {
    for (const id of ['sp:abc', 'l:unknown', 'l:missing']) {
      const res = await app.inject({ url: `/peaks/${id}` });
      expect(res.statusCode, id).toBe(404);
    }
  });
});
