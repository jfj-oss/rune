import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import type { Config } from '../src/config.js';
import {
  activeFfmpegPids,
  cleanupStaleCacheParts,
  negotiateStreamFormat,
  parseAcceptedKinds,
  parseRangeHeader,
  registerStreamRoutes,
  sourceKindForFile,
  transcodeOutputPath,
  type SourceKind,
  type StoredTrack,
  type StreamFormat,
} from '../src/play/stream.js';

const cfg: Config = {
  libraryRoots: [],
  dataDir: '/tmp',
  port: 0,
  audioDevice: 'null',
  userAgent: 'test',
};

let dir: string;
let db: Db;
let app: FastifyInstance;
let plainPath: string;
let cuePath: string;
let longPath: string;
let slowCuePath: string;
let plainBytes: Buffer;
let address: string | null = null;

function run(cmd: string, args: string[]): void {
  const res = spawnSync(cmd, args, { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  }
}

function tone(path: string, seconds: number, freq: number): void {
  run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${freq}:duration=${seconds}`,
    '-c:a',
    'flac',
    path,
  ]);
}

/** Total audio duration from ffprobe packet timestamps (works for headerless/pipe output). */
function packetDuration(path: string): number {
  const res = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'packet=duration_time', '-of', 'csv=p=0', path],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(`ffprobe failed: ${res.stderr}`);
  let total = 0;
  for (const line of res.stdout.split('\n')) {
    const value = Number.parseFloat(line.trim());
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

function ffprobeStream(path: string): { codec_name?: string; sample_rate?: string; channels?: number } {
  const res = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'json', path],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(`ffprobe failed: ${res.stderr}`);
  const parsed = JSON.parse(res.stdout) as { streams?: { codec_name?: string; sample_rate?: string; channels?: number }[] };
  return parsed.streams?.[0] ?? {};
}

function insertTrack(row: {
  id: string;
  title: string;
  number: number;
  durationMs: number;
  path: string;
  cueStart?: number | null;
  cueEnd?: number | null;
}): void {
  db.prepare(
    `INSERT INTO tracks
       (id, album_id, source, title, disc, number, duration_ms, path, cue_start_ms, cue_end_ms,
        format, sample_rate, bit_depth, bitrate_kbps)
     VALUES (?, 'la:x', 'local', ?, 1, ?, ?, ?, ?, ?, 'flac', 44100, 16, NULL)`,
  ).run(
    row.id,
    row.title,
    row.number,
    row.durationMs,
    row.path,
    row.cueStart ?? null,
    row.cueEnd ?? null,
  );
}

const trackRow = (id: string): StoredTrack =>
  db
    .prepare(
      'SELECT id, album_id, path, cue_start_ms, cue_end_ms, format, source, disc, number FROM tracks WHERE id = ?',
    )
    .get(id) as StoredTrack;

async function ensureAddress(): Promise<string> {
  if (!address) address = await app.listen({ port: 0, host: '127.0.0.1' });
  return address;
}

/** Resolve once the server serves `id` as a cached (range-capable) file. */
async function waitForCached(id: string, url = `/api/stream/${encodeURIComponent(id)}?fmt=flac`): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const res = await app.inject({ method: 'HEAD', url });
    if (res.headers['accept-ranges'] === 'bytes') return;
    await sleep(25);
  }
  throw new Error(`cache for ${id} was not ready in time`);
}

async function waitForPath(path: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await sleep(25);
  }
  throw new Error(`${path} did not appear in time`);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'liner-stream-'));
  cfg.dataDir = dir; // keep cache files in the test's temp dir
  plainPath = join(dir, 'tone4.flac');
  cuePath = join(dir, 'tone10.flac');
  longPath = join(dir, 'long240.flac');
  slowCuePath = join(dir, 'tone600.flac');
  tone(plainPath, 4, 440);
  tone(cuePath, 10, 330);
  tone(longPath, 240, 220);
  tone(slowCuePath, 600, 275);
  plainBytes = readFileSync(plainPath);

  db = openDb(':memory:');
  db.prepare("INSERT INTO artists (id, name) VALUES ('ar:x', 'Test Artist')").run();
  db.prepare(
    "INSERT INTO albums (id, source, title, artist_id, added_at) VALUES ('la:x', 'local', 'Test Album', 'ar:x', 0)",
  ).run();
  insertTrack({ id: 'l:plain', title: 'Plain', number: 1, durationMs: 4000, path: plainPath });
  insertTrack({
    id: 'l:cue',
    title: 'Cue',
    number: 2,
    durationMs: 4000,
    path: cuePath,
    cueStart: 2000,
    cueEnd: 6000,
  });
  // cue3 -> cue4 are consecutive in this album: cue3 warms cue4.
  insertTrack({
    id: 'l:cue3',
    title: 'Cue 3',
    number: 5,
    durationMs: 2000,
    path: cuePath,
    cueStart: 1000,
    cueEnd: 3000,
  });
  insertTrack({
    id: 'l:cue4',
    title: 'Cue 4',
    number: 6,
    durationMs: 2000,
    path: cuePath,
    cueStart: 3000,
    cueEnd: 5000,
  });
  insertTrack({
    id: 'l:missing',
    title: 'Missing',
    number: 9,
    durationMs: 4000,
    path: join(dir, 'does-not-exist.flac'),
  });
  insertTrack({ id: 'l:long', title: 'Long', number: 4, durationMs: 240_000, path: longPath });
  // A long cue slice: the live transcode has plenty of audio to emit before the
  // background cache file can possibly be complete.
  insertTrack({
    id: 'l:slowcue',
    title: 'Slow cue',
    number: 20,
    durationMs: 600_000,
    path: slowCuePath,
    cueStart: 0,
    cueEnd: 600_000,
  });

  app = Fastify({ logger: false, forceCloseConnections: true });
  registerStreamRoutes(app, db, cfg);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}, 30_000);

describe('parseRangeHeader', () => {
  it('parses a simple range', () => {
    expect(parseRangeHeader('bytes=0-9', 100)).toEqual({ kind: 'ranges', ranges: [{ start: 0, end: 9 }] });
  });
  it('parses open-ended and suffix ranges', () => {
    expect(parseRangeHeader('bytes=90-', 100)).toEqual({ kind: 'ranges', ranges: [{ start: 90, end: 99 }] });
    expect(parseRangeHeader('bytes=-10', 100)).toEqual({ kind: 'ranges', ranges: [{ start: 90, end: 99 }] });
  });
  it('clamps ranges past the end', () => {
    expect(parseRangeHeader('bytes=90-200', 100)).toEqual({ kind: 'ranges', ranges: [{ start: 90, end: 99 }] });
  });
  it('parses multiple ranges', () => {
    expect(parseRangeHeader('bytes=0-9,20-29', 100)).toEqual({
      kind: 'ranges',
      ranges: [
        { start: 0, end: 9 },
        { start: 20, end: 29 },
      ],
    });
  });
  it('reports unsatisfiable ranges', () => {
    expect(parseRangeHeader('bytes=100-', 100).kind).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=-0', 100).kind).toBe('unsatisfiable');
  });
  it('reports malformed headers', () => {
    expect(parseRangeHeader('bytes=abc', 100).kind).toBe('invalid');
    expect(parseRangeHeader('items=0-1', 100).kind).toBe('invalid');
    expect(parseRangeHeader(undefined, 100).kind).toBe('none');
  });
});

describe('format negotiation from the client’s accept= list', () => {
  const kinds = (...list: SourceKind[]) => new Set<SourceKind>(list);
  const file = (path: string, cueStart: number | null = null) => ({ path, cue_start_ms: cueStart });

  it('parses the accept list, ignoring unknown entries and malformed values', () => {
    expect(parseAcceptedKinds(' FLAC, mp3 ,nope')).toEqual(kinds('flac', 'mp3'));
    expect(parseAcceptedKinds('opus')).toEqual(kinds('opus'));
    expect(parseAcceptedKinds('')).toBeNull();
    expect(parseAcceptedKinds('nope')).toBeNull();
    expect(parseAcceptedKinds(undefined)).toBeNull();
    expect(parseAcceptedKinds('x'.repeat(201))).toBeNull();
  });

  it('names a stored file’s source kind by its extension', () => {
    expect(sourceKindForFile('/music/a.FLAC')).toBe('flac');
    expect(sourceKindForFile('/music/a.mp3')).toBe('mp3');
    expect(sourceKindForFile('/music/a.m4a')).toBe('m4a');
    expect(sourceKindForFile('/music/a.opus')).toBe('opus');
    expect(sourceKindForFile('/music/a.ogg')).toBe('vorbis');
    expect(sourceKindForFile('/music/a.unknown')).toBeNull();
  });

  it('keeps the requested format when there is no accept list (older clients)', () => {
    expect(negotiateStreamFormat(file('/m/a.flac'), 'orig', null)).toBe('orig');
    expect(negotiateStreamFormat(file('/m/a.flac'), 'flac', null)).toBe('flac');
    expect(negotiateStreamFormat(file('/m/a.flac'), 'aac', null)).toBe('aac');
  });

  it('serves orig only when the file’s kind is accepted, and AAC otherwise', () => {
    const flac = file('/m/a.flac');
    const opus = file('/m/a.opus');
    expect(negotiateStreamFormat(flac, 'orig', kinds('flac', 'mp3'))).toBe('orig');
    expect(negotiateStreamFormat(flac, 'orig', kinds('mp3', 'aac'))).toBe('aac');
    expect(negotiateStreamFormat(opus, 'orig', kinds('flac', 'mp3'))).toBe('aac');
    // No recognisable extension: cannot promise the browser plays it, so transcode.
    expect(negotiateStreamFormat(file('/m/a.data'), 'orig', kinds('flac'))).toBe('aac');
  });

  it('slices cue tracks to FLAC when accepted, and to AAC when not', () => {
    const cue = file('/m/a.flac', 1000);
    expect(negotiateStreamFormat(cue, 'orig', kinds('flac'))).toBe('flac');
    expect(negotiateStreamFormat(cue, 'orig', kinds('mp3', 'aac'))).toBe('aac');
  });

  it('downgrades an explicit flac request the browser cannot play', () => {
    const flac = file('/m/a.flac');
    expect(negotiateStreamFormat(flac, 'flac' satisfies StreamFormat, kinds('flac'))).toBe('flac');
    expect(negotiateStreamFormat(flac, 'flac', kinds('mp3', 'aac'))).toBe('aac');
    expect(negotiateStreamFormat(flac, 'aac', kinds('flac'))).toBe('aac');
  });
});

describe('GET /api/stream fmt=orig (plain file)', () => {
  it('serves the whole file with metadata', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stream/l:plain' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/flac');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(Number(res.headers['content-length'])).toBe(plainBytes.length);
    expect(res.rawPayload.equals(plainBytes)).toBe(true);
  });

  it('transcodes to AAC when the client says it cannot play FLAC', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stream/l:plain?fmt=orig&accept=mp3,aac,m4a' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/aac');
    const out = join(dir, 'plain-negotiated.aac');
    writeFileSync(out, res.rawPayload);
    expect(ffprobeStream(out).codec_name).toBe('aac');
    expect(Math.abs(packetDuration(out) - 4.0)).toBeLessThanOrEqual(0.15);
  }, 30_000);

  it('serves the stored FLAC unchanged when the client accepts FLAC', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stream/l:plain?fmt=orig&accept=flac,mp3' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/flac');
    expect(res.rawPayload.equals(plainBytes)).toBe(true);
  });

  it('serves byte ranges exactly (206)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/stream/l:plain',
      headers: { range: 'bytes=100-199' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 100-199/${plainBytes.length}`);
    expect(Number(res.headers['content-length'])).toBe(100);
    expect(res.rawPayload.equals(plainBytes.subarray(100, 200))).toBe(true);
  });

  it('supports open-ended and suffix ranges', async () => {
    const open = await app.inject({
      method: 'GET',
      url: '/api/stream/l:plain',
      headers: { range: 'bytes=1234-' },
    });
    expect(open.statusCode).toBe(206);
    expect(open.rawPayload.equals(plainBytes.subarray(1234))).toBe(true);

    const suffix = await app.inject({
      method: 'GET',
      url: '/api/stream/l:plain',
      headers: { range: 'bytes=-64' },
    });
    expect(suffix.statusCode).toBe(206);
    expect(suffix.rawPayload.equals(plainBytes.subarray(plainBytes.length - 64))).toBe(true);
  });

  it('supports multiple ranges as multipart/byteranges', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/stream/l:plain',
      headers: { range: 'bytes=0-9,200-209' },
    });
    expect(res.statusCode).toBe(206);
    const contentType = String(res.headers['content-type']);
    expect(contentType).toMatch(/^multipart\/byteranges; boundary=/);
    expect(Number(res.headers['content-length'])).toBe(res.rawPayload.length);
    expect(res.rawPayload.includes(plainBytes.subarray(0, 10))).toBe(true);
    expect(res.rawPayload.includes(plainBytes.subarray(200, 210))).toBe(true);
    const text = res.rawPayload.toString('latin1');
    expect(text).toContain(`Content-Range: bytes 0-9/${plainBytes.length}`);
    expect(text).toContain(`Content-Range: bytes 200-209/${plainBytes.length}`);
    expect(text.trimEnd().endsWith('--')).toBe(true);
  });

  it('returns 416 for unsatisfiable ranges', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/stream/l:plain',
      headers: { range: 'bytes=99999999-' },
    });
    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${plainBytes.length}`);
  });

  it('ignores malformed Range headers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/stream/l:plain',
      headers: { range: 'bytes=wat' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(plainBytes)).toBe(true);
  });

  it('answers HEAD with headers and no body', async () => {
    const res = await app.inject({ method: 'HEAD', url: '/api/stream/l:plain' });
    expect(res.statusCode).toBe(200);
    expect(Number(res.headers['content-length'])).toBe(plainBytes.length);
    expect(res.rawPayload.length).toBe(0);
  });
});

describe('GET /api/stream transcoding', () => {
  it('404s unknown track ids', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stream/l:nope' });
    expect(res.statusCode).toBe(404);
  });

  it('410s when the file is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stream/l:missing' });
    expect(res.statusCode).toBe(410);
  });

  it('400s for an unsupported fmt', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stream/l:plain?fmt=opus' });
    expect(res.statusCode).toBe(400);
  });

  it('slices a cue track to FLAC within 0.1 s', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stream/l:cue?fmt=flac' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/flac');
    const out = join(dir, 'cue-slice.flac');
    writeFileSync(out, res.rawPayload);
    expect(ffprobeStream(out).codec_name).toBe('flac');
    expect(packetDuration(out)).toBeCloseTo(4.0, 1);
    expect(Math.abs(packetDuration(out) - 4.0)).toBeLessThanOrEqual(0.1);
  });

  it('serves cached cue slices with byte ranges (Safari needs them)', async () => {
    // The first request above started the background cache job; wait for it.
    await waitForCached('l:cue');
    const full = await app.inject({ method: 'GET', url: '/api/stream/l:cue?fmt=flac' });
    expect(full.headers['accept-ranges']).toBe('bytes');
    const size = Number(full.headers['content-length']);
    expect(size).toBeGreaterThan(1000);
    const part = await app.inject({ method: 'GET', url: '/api/stream/l:cue?fmt=flac', headers: { range: 'bytes=0-1' } });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload.length).toBe(2);
    expect(part.headers['content-range']).toBe(`bytes 0-1/${size}`);
  });

  it('wait=1 (iOS) waits for the cache and serves a ranged file, never a live stream', async () => {
    const cachePath = transcodeOutputPath(cfg, trackRow('l:cue'), 'aac', 96)!;
    expect(existsSync(cachePath)).toBe(false);
    const res = await app.inject({ method: 'GET', url: '/api/stream/l:cue?fmt=aac&kbps=96&wait=1', headers: { range: 'bytes=0-1' } });
    expect(res.statusCode).toBe(206);
    expect(res.headers['x-rune-live']).toBeUndefined();
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(existsSync(cachePath)).toBe(true);
  });

  it('seeks inside transcoded streams with ?t=', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stream/l:cue?fmt=flac&t=1500' });
    expect(res.statusCode).toBe(200);
    const out = join(dir, 'cue-offset.flac');
    writeFileSync(out, res.rawPayload);
    expect(Math.abs(packetDuration(out) - 2.5)).toBeLessThanOrEqual(0.1);
  });

  it('also slices a cue track for fmt=orig (orig means lossless)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stream/l:cue' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/flac');
    const out = join(dir, 'cue-orig.flac');
    writeFileSync(out, res.rawPayload);
    expect(Math.abs(packetDuration(out) - 4.0)).toBeLessThanOrEqual(0.1);
  });

  it('transcodes a plain file to FLAC', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stream/l:plain?fmt=flac' });
    expect(res.statusCode).toBe(200);
    const out = join(dir, 'plain-transcoded.flac');
    writeFileSync(out, res.rawPayload);
    expect(ffprobeStream(out).codec_name).toBe('flac');
    expect(Math.abs(packetDuration(out) - 4.0)).toBeLessThanOrEqual(0.1);
  });

  it('streams a decodable AAC (ADTS) cue slice', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stream/l:cue?fmt=aac&kbps=128&live=1' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/aac');
    const out = join(dir, 'cue.aac');
    writeFileSync(out, res.rawPayload);
    const stream = ffprobeStream(out);
    expect(stream.codec_name).toBe('aac');
    expect(stream.sample_rate).toBe('44100');
    const decode = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', out, '-f', 'null', '-'], {
      encoding: 'utf8',
    });
    expect(decode.status).toBe(0);
    expect(Math.abs(packetDuration(out) - 4.0)).toBeLessThanOrEqual(0.15);
  }, 30_000);

  it('supports HEAD for transcoded streams without spawning ffmpeg', async () => {
    const before = new Set(activeFfmpegPids);
    const res = await app.inject({ method: 'HEAD', url: '/api/stream/l:cue?fmt=flac' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/flac');
    expect(res.rawPayload.length).toBe(0);
    expect(activeFfmpegPids.size).toBe(before.size);
  });
});

describe('uncached cue tracks', () => {
  it('starts live at once, finishes caching after the client leaves, then serves ranges', async () => {
    const base = await ensureAddress();
    const id = 'l:slowcue';
    const cachePath = transcodeOutputPath(cfg, trackRow(id), 'flac', 256)!;
    expect(existsSync(cachePath)).toBe(false);

    const controller = new AbortController();
    const started = Date.now();
    const res = await fetch(`${base}/api/stream/${id}?fmt=flac`, { signal: controller.signal });
    const headersMs = Date.now() - started;
    expect(res.status).toBe(200);
    expect(res.headers.get('x-rune-live')).toBe('1');
    expect(res.headers.get('accept-ranges')).toBeNull();
    // The HTTP request is answered without waiting for the cache file.
    expect(headersMs).toBeLessThan(1000);
    expect(existsSync(cachePath)).toBe(false);

    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.value?.length ?? 0).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(existsSync(cachePath)).toBe(false);

    // The background cache job is not tied to the client.
    controller.abort();
    await waitForPath(cachePath);

    // A later range request is served from the finished file.
    const part = await app.inject({
      method: 'GET',
      url: `/api/stream/${id}?fmt=flac`,
      headers: { range: 'bytes=0-1' },
    });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload.length).toBe(2);
    expect(part.headers['content-range']).toMatch(/^bytes 0-1\/\d+$/);
  }, 40_000);

  it('warms the cache of the next track of the album', async () => {
    const nextCache = transcodeOutputPath(cfg, trackRow('l:cue4'), 'flac', 256)!;
    expect(existsSync(nextCache)).toBe(false);

    const res = await app.inject({ method: 'GET', url: '/api/stream/l:cue3?fmt=orig' });
    expect(res.statusCode).toBe(200);
    await waitForPath(nextCache);
    expect(existsSync(nextCache)).toBe(true);
  }, 40_000);
});

describe('stale cache parts', () => {
  it('removes .part files older than an hour and keeps fresh ones', () => {
    const cacheDir = join(dir, 'transcode');
    mkdirSync(cacheDir, { recursive: true });
    const old = join(cacheDir, 'crashed-job.part');
    const fresh = join(cacheDir, 'running-job.part');
    writeFileSync(old, 'stale');
    writeFileSync(fresh, 'fresh');
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(old, twoHoursAgo, twoHoursAgo);

    expect(cleanupStaleCacheParts(cfg)).toBeGreaterThanOrEqual(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    rmSync(fresh, { force: true });
  });
});

describe('client disconnect', () => {
  it('kills ffmpeg when the HTTP client goes away', async () => {
    const base = await ensureAddress();
    const controller = new AbortController();
    const response = await fetch(`${base}/api/stream/l:long?fmt=aac&kbps=128&live=1`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);

    // ffmpeg is producing a 240 s stream; it is alive and holds the request open.
    const deadline = Date.now() + 5_000;
    let pid: number | undefined;
    while (Date.now() < deadline) {
      pid = [...activeFfmpegPids][0];
      if (pid !== undefined) break;
      await sleep(20);
    }
    expect(pid).toBeDefined();
    expect(isAlive(pid!)).toBe(true);

    controller.abort();
    await waitFor(() => !activeFfmpegPids.has(pid!) && !isAlive(pid!), 5_000);
  }, 20_000);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(20);
  }
}
