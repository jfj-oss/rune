import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import type { Config } from '../src/config.js';
import {
  activeFfmpegPids,
  parseRangeHeader,
  registerStreamRoutes,
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
let plainBytes: Buffer;

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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'liner-stream-'));
  plainPath = join(dir, 'tone4.flac');
  cuePath = join(dir, 'tone10.flac');
  longPath = join(dir, 'long2410.flac');
  tone(plainPath, 4, 440);
  tone(cuePath, 10, 330);
  tone(longPath, 240, 220);
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
  insertTrack({
    id: 'l:missing',
    title: 'Missing',
    number: 3,
    durationMs: 4000,
    path: join(dir, 'does-not-exist.flac'),
  });
  insertTrack({ id: 'l:long', title: 'Long', number: 4, durationMs: 240_000, path: longPath });

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

describe('GET /api/stream fmt=orig (plain file)', () => {
  it('serves the whole file with metadata', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stream/l:plain' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/flac');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(Number(res.headers['content-length'])).toBe(plainBytes.length);
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
    const full = await app.inject({ method: 'GET', url: '/api/stream/l:cue?fmt=flac' });
    expect(full.headers['accept-ranges']).toBe('bytes');
    const size = Number(full.headers['content-length']);
    expect(size).toBeGreaterThan(1000);
    const part = await app.inject({ method: 'GET', url: '/api/stream/l:cue?fmt=flac', headers: { range: 'bytes=0-1' } });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload.length).toBe(2);
    expect(part.headers['content-range']).toBe(`bytes 0-1/${size}`);
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

describe('client disconnect', () => {
  it('kills ffmpeg when the HTTP client goes away', async () => {
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const controller = new AbortController();
    const response = await fetch(`${address}/api/stream/l:long?fmt=aac&kbps=128&live=1`, {
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
