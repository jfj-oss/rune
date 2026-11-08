// HTTP streaming for phones/browsers.
//
//   GET /api/stream/:trackId?fmt=orig|flac|aac&kbps=256
//
// - orig + non-cue  -> the file itself, with full HTTP Range support (206 and
//                      multipart/byteranges for multiple ranges).
// - orig with cue, fmt=flac, fmt=aac -> ffmpeg transcode. Cue tracks are sliced
//   with -ss/-to *before* -i (fast seek); ffmpeg's accurate_seek (on by default)
//   decodes and discards up to the exact start time, so output starts sample-accurately.
// - fmt=aac is emitted as raw ADTS AAC (audio/aac). iOS Safari's <audio> plays ADTS
//   AAC streams directly, it needs no moov atom/index, and it lets playback start
//   immediately without buffering the whole file. (fragmented MP4 would also work
//   but adds a moov init segment and offers no benefit for a live-only stream.)
//
// First play of a track whose cache file does not exist yet is answered at once by
// a live ffmpeg stream (X-Rune-Live: 1) while a background job builds the cache for
// later plays and range seeks. Live streams have no length and cannot be range
// seeked, so clients reload with ?t=<ms>; the server slices from that offset.
//
// ffmpeg for a live stream is killed as soon as the HTTP client disconnects.
// Background cache jobs are deliberately *not* tied to a client.
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, statSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { ensureLoudnessSchema, gainInfoForTrack } from '../loudness/index.js';

export interface StoredTrack {
  id: string;
  album_id: string;
  path: string | null;
  cue_start_ms: number | null;
  cue_end_ms: number | null;
  format: string | null;
  source: string;
  disc: number;
  number: number;
}

export type StreamFormat = 'orig' | 'flac' | 'aac';

export interface ByteRange {
  start: number;
  end: number; // inclusive
}

export type ParsedRange =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'unsatisfiable' }
  | { kind: 'ranges'; ranges: ByteRange[] };

/** PIDs of ffmpeg processes currently serving transcoded streams (for tests/diagnostics). */
export const activeFfmpegPids = new Set<number>();

export function activeFfmpegCount(): number {
  return activeFfmpegPids.size;
}

/** Parse an RFC 7233 Range header against a known resource size. */
export function parseRangeHeader(header: string | undefined, size: number): ParsedRange {
  if (!header) return { kind: 'none' };
  const trimmed = header.trim();
  const match = /^bytes\s*=\s*(.+)$/i.exec(trimmed);
  if (!match) return { kind: 'invalid' };
  const specs = match[1]!.split(',').map((s) => s.trim());
  const ranges: ByteRange[] = [];
  let sawValidSyntax = false;

  for (const spec of specs) {
    if (spec.length === 0) continue;
    const m = /^(\d*)-(\d*)$/.exec(spec);
    if (!m) return { kind: 'invalid' };
    sawValidSyntax = true;
    const startRaw = m[1]!;
    const endRaw = m[2]!;
    if (startRaw === '' && endRaw === '') return { kind: 'invalid' };

    if (startRaw === '') {
      // suffix range: last N bytes
      const suffix = Number(endRaw);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) continue;
      ranges.push({ start: Math.max(0, size - suffix), end: Math.max(0, size - 1) });
      continue;
    }
    const start = Number(startRaw);
    if (!Number.isSafeInteger(start) || start < 0) return { kind: 'invalid' };
    if (start >= size) continue; // unsatisfiable for this one
    const end = endRaw === '' ? size - 1 : Math.min(Number(endRaw), size - 1);
    if (!Number.isSafeInteger(end) || end < start) continue;
    ranges.push({ start, end });
  }

  if (!sawValidSyntax) return { kind: 'invalid' };
  if (ranges.length === 0) return { kind: 'unsatisfiable' };
  return { kind: 'ranges', ranges };
}

function contentTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.flac':
      return 'audio/flac';
    case '.mp3':
      return 'audio/mpeg';
    case '.m4a':
    case '.mp4':
      return 'audio/mp4';
    case '.aac':
      return 'audio/aac';
    case '.wav':
      return 'audio/wav';
    case '.aif':
    case '.aiff':
      return 'audio/aiff';
    case '.ogg':
    case '.oga':
      return 'audio/ogg';
    case '.opus':
      return 'audio/opus';
    case '.wma':
      return 'audio/x-ms-wma';
    default:
      return 'application/octet-stream';
  }
}

function ffmpegArgs(track: StoredTrack, fmt: 'flac' | 'aac', kbps: number, offsetMs = 0): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  // offsetMs lets clients seek inside transcoded streams (they reload with ?t=).
  const startMs = track.cue_start_ms != null || offsetMs > 0 ? (track.cue_start_ms ?? 0) + offsetMs : null;
  const endMs = track.cue_end_ms;
  if (startMs != null) {
    // Input seeking before -i is fast; ffmpeg accurately trims to the timestamp.
    args.push('-ss', seconds(startMs));
    if (endMs != null && endMs > startMs) args.push('-to', seconds(endMs));
  }
  args.push('-i', track.path!);
  args.push('-map', '0:a:0', '-vn', '-sn', '-dn');
  if (fmt === 'flac') {
    args.push('-c:a', 'flac', '-f', 'flac');
  } else {
    args.push('-c:a', 'aac', '-b:a', `${kbps}k`, '-f', 'adts');
  }
  args.push('pipe:1');
  return args;
}

function seconds(ms: number): string {
  return String(Number((ms / 1000).toFixed(6)));
}

/** Where a track's finished cache file would live (null if the source is gone). */
export function transcodeOutputPath(
  cfg: Config,
  track: StoredTrack,
  fmt: 'flac' | 'aac',
  kbps: number,
): string | null {
  if (!track.path) return null;
  let mtime: number;
  try {
    mtime = Math.round(statSync(track.path).mtimeMs);
  } catch {
    return null;
  }
  const ext = fmt === 'flac' ? 'flac' : 'm4a';
  const name = `${track.id.replace(/[^a-z0-9]/gi, '_')}-${fmt}${fmt === 'aac' ? kbps : ''}-${mtime}.${ext}`;
  return join(cfg.dataDir, 'transcode', name);
}

const cacheJobs = new Map<string, Promise<string | null>>();
/** Cache jobs waiting for a slot. Only one background ffmpeg runs at a time. */
const cacheQueue: Array<() => void> = [];
let cacheRunning = 0;
const CACHE_CONCURRENCY = 1;

function drainCacheQueue(): void {
  while (cacheRunning < CACHE_CONCURRENCY && cacheQueue.length > 0) {
    const start = cacheQueue.shift()!;
    cacheRunning++;
    start();
  }
}

/**
 * Transcode a whole track (or cue slice) once into <dataDir>/transcode and reuse it.
 * A finished file can be served with byte ranges, which Safari requires for <audio>
 * and which makes seeking work everywhere.
 *
 * The returned promise settles when the file is ready, but callers streaming a
 * first play do not await it: one background job per output file is enough and
 * jobs run one at a time (the live stream is a separate ffmpeg).
 */
export function cachedTranscode(cfg: Config, track: StoredTrack, fmt: 'flac' | 'aac', kbps: number): Promise<string | null> {
  const out = transcodeOutputPath(cfg, track, fmt, kbps);
  if (!out) return Promise.resolve(null);
  if (existsSync(out)) return Promise.resolve(out);
  const existing = cacheJobs.get(out);
  if (existing) return existing;

  const dir = join(cfg.dataDir, 'transcode');
  mkdirSync(dir, { recursive: true });
  const tmp = out + '.part';
  const base = ffmpegArgs(track, fmt, kbps).slice(0, -1); // drop pipe:1
  const fmtIdx = base.lastIndexOf('-f');
  if (fmt === 'aac') base.splice(fmtIdx, 2, '-movflags', '+faststart', '-f', 'mp4');

  const job = new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      cacheRunning--;
      cacheJobs.delete(out);
      resolve(value);
      drainCacheQueue();
    };
    cacheQueue.push(() => {
      const child = spawn('ffmpeg', ['-y', ...base, tmp], { stdio: 'ignore' });
      child.on('error', () => {
        rmSync(tmp, { force: true });
        finish(null);
      });
      child.on('close', (code) => {
        if (code === 0) {
          try {
            renameSync(tmp, out);
            finish(out);
          } catch {
            rmSync(tmp, { force: true });
            finish(null);
          }
        } else {
          rmSync(tmp, { force: true });
          finish(null);
        }
      });
    });
  });
  cacheJobs.set(out, job);
  drainCacheQueue();
  return job;
}

/**
 * Remove `.part` files left behind by a crashed cache job. Files younger than an
 * hour might belong to a live server instance, so they are left alone.
 */
export function cleanupStaleCacheParts(cfg: Config, olderThanMs = 3_600_000, nowMs = Date.now()): number {
  const dir = join(cfg.dataDir, 'transcode');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.part')) continue;
    const path = join(dir, name);
    try {
      if (nowMs - statSync(path).mtimeMs > olderThanMs) {
        rmSync(path, { force: true });
        removed++;
      }
    } catch {
      // another process may have just removed it
    }
  }
  return removed;
}

export function registerStreamRoutes(app: FastifyInstance, db: Db, cfg: Config): void {
  ensureLoudnessSchema(db);
  cleanupStaleCacheParts(cfg);
  const getTrack = db.prepare(
    'SELECT id, album_id, path, cue_start_ms, cue_end_ms, format, source, disc, number FROM tracks WHERE id = ?',
  );
  const getNextTrack = db.prepare(
    `SELECT id, album_id, path, cue_start_ms, cue_end_ms, format, source, disc, number
       FROM tracks
      WHERE album_id = ? AND (disc > ? OR (disc = ? AND number > ?))
      ORDER BY disc, number
      LIMIT 1`,
  );

  app.get('/api/stream/:trackId', async (request, reply) => {
    const { trackId } = request.params as { trackId: string };
    const query = request.query as { fmt?: string; kbps?: string; t?: string; live?: string; wait?: string };
    const offsetMs = Math.max(0, Number.parseInt(query.t ?? '0', 10) || 0);

    const fmtRaw = (query.fmt ?? 'orig').toLowerCase();
    if (fmtRaw !== 'orig' && fmtRaw !== 'flac' && fmtRaw !== 'aac') {
      return reply.code(400).send({ error: `unsupported fmt '${query.fmt}'` });
    }
    const fmt = fmtRaw as StreamFormat;
    const kbps = (() => {
      const n = Number.parseInt(query.kbps ?? '', 10);
      return Number.isFinite(n) && n >= 8 && n <= 512 ? n : 256;
    })();

    const track = getTrack.get(trackId) as StoredTrack | undefined;
    if (!track) return reply.code(404).send({ error: 'track not found' });
    if (!track.path || !existsSync(track.path)) {
      return reply.code(410).send({ error: 'audio file is missing' });
    }

    // Loudness gain is only a *hint*: the server never alters the audio here.
    // Browsers apply it with Web Audio (GainNode) so a quiet 70s FLAC and a
    // loud modern master play at the same level. Absent when normalization is
    // off or the track has not been analysed.
    const loudnessHeaders = gainHeaders(db, trackId, cfg);

    const isCue = track.cue_start_ms != null;
    if (fmt === 'orig' && !isCue && offsetMs === 0) {
      return serveFile(request.method, request.headers.range, reply, track.path, loudnessHeaders);
    }
    // Cue tracks are always resliced; orig means "lossless FLAC" in that case.
    const outFmt: 'flac' | 'aac' = fmt === 'aac' ? 'aac' : 'flac';

    // Warm the next track of the album so gapless preloading gets a ranged file.
    // Only one background job runs at a time, and it never blocks this response.
    const warmNext = (): void => {
      if (!isCue && fmt !== 'aac') return;
      const next = getNextTrack.get(track.album_id, track.disc, track.disc, track.number) as
        | StoredTrack
        | undefined;
      if (!next?.path || !existsSync(next.path)) return;
      // A plain file needs no cache unless the client asked for a transcoded format.
      if (next.cue_start_ms == null && fmt === 'orig') return;
      void cachedTranscode(cfg, next, outFmt, kbps).catch(() => null);
    };

    if (offsetMs === 0 && query.live !== '1') {
      const cachePath = transcodeOutputPath(cfg, track, outFmt, kbps);
      if (cachePath && existsSync(cachePath)) {
        // Fully cached: byte ranges, instant start, normal seeking.
        if (request.method !== 'HEAD') warmNext();
        return serveFile(request.method, request.headers.range, reply, cachePath, loudnessHeaders);
      }
      if (query.wait === '1') {
        // iOS Safari will not play an <audio> source without byte ranges: wait for the
        // finished file (warm-ahead usually has it ready before the track is reached).
        const file = await cachedTranscode(cfg, track, outFmt, kbps);
        if (request.method !== 'HEAD') warmNext();
        if (file) return serveFile(request.method, request.headers.range, reply, file, loudnessHeaders);
      }
      if (request.method !== 'HEAD') {
        // Not ready: answer now with a live stream and build the cache in parallel.
        void cachedTranscode(cfg, track, outFmt, kbps).catch(() => null);
        warmNext();
      }
      // HEAD (the client's gain/seek probe) must not spawn ffmpeg; serveTranscode
      // only writes the live headers. X-Rune-Live tells the client to seek via ?t=.
      return serveTranscode(request.method, reply, track, outFmt, kbps, offsetMs, loudnessHeaders);
    }
    return serveTranscode(request.method, reply, track, outFmt, kbps, offsetMs, loudnessHeaders);
  });
}

/** X-Rune-Gain-Db hint for clients that can apply gain (Web Audio). */
function gainHeaders(db: Db, trackId: string, cfg: Config): Record<string, string> {
  try {
    const info = gainInfoForTrack(db, trackId, cfg.normalize ?? 'album');
    if (!info || info.gainDb === 0) return {};
    return {
      'X-Rune-Gain-Db': info.gainDb.toFixed(1),
      // Keep the CORS-exposed list complete: this header can override the one
      // the CORS hook put on the response, and cross-origin readers need to
      // see Range/seek headers too (api/cors.ts).
      'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, X-Rune-Gain-Db',
    };
  } catch {
    return {};
  }
}

function serveFile(
  method: string,
  rangeHeader: string | undefined,
  reply: import('fastify').FastifyReply,
  path: string,
  extraHeaders: Record<string, string> = {},
): void {
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error('not a file');
    size = stat.size;
  } catch {
    reply.code(410).send({ error: 'audio file is missing' });
    return;
  }

  const parsed = parseRangeHeader(rangeHeader, size);
  if (parsed.kind === 'invalid' || parsed.kind === 'none') {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': contentTypeFor(path),
      'Content-Length': size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
      ...extraHeaders,
    });
    if (method === 'HEAD') {
      res.end();
      return;
    }
    pipeFile(path, 0, size - 1, res);
    return;
  }

  if (parsed.kind === 'unsatisfiable') {
    reply.hijack();
    reply.raw.writeHead(416, {
      'Content-Type': 'text/plain',
      'Content-Range': `bytes */${size}`,
      'Accept-Ranges': 'bytes',
    });
    reply.raw.end('range not satisfiable');
    return;
  }

  if (parsed.ranges.length === 1) {
    const range = parsed.ranges[0]!;
    const length = range.end - range.start + 1;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(206, {
      'Content-Type': contentTypeFor(path),
      'Content-Length': length,
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
      ...extraHeaders,
    });
    if (method === 'HEAD') {
      res.end();
      return;
    }
    pipeFile(path, range.start, range.end, res);
    return;
  }

  // Multiple ranges -> multipart/byteranges.
  const boundary = `liner_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const parts = parsed.ranges.map((range) => ({
    range,
    header: Buffer.from(
      `--${boundary}\r\nContent-Type: ${contentTypeFor(path)}\r\n` +
        `Content-Range: bytes ${range.start}-${range.end}/${size}\r\n\r\n`,
    ),
  }));
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`);
  let total = closing.length + Math.max(0, parts.length - 1) * 2; // CRLF between parts
  for (const part of parts) {
    total += part.header.length + (part.range.end - part.range.start + 1);
  }

  reply.hijack();
  const res = reply.raw;
  res.writeHead(206, {
    'Content-Type': `multipart/byteranges; boundary=${boundary}`,
    'Content-Length': total,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    ...extraHeaders,
  });
  if (method === 'HEAD') {
    res.end();
    return;
  }
  void (async () => {
    try {
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        res.write(part.header);
        if (res.destroyed) return;
        await pipeFileAsync(path, part.range.start, part.range.end, res);
        if (res.destroyed) return;
        if (i < parts.length - 1) res.write('\r\n');
      }
      res.end(closing);
    } catch {
      res.destroy();
    }
  })();
}

function pipeFile(
  path: string,
  start: number,
  end: number,
  res: import('node:http').ServerResponse,
): void {
  const stream = createReadStream(path, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res, { end: true });
}

function pipeFileAsync(
  path: string,
  start: number,
  end: number,
  res: import('node:http').ServerResponse,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path, { start, end });
    let settled = false;
    const done = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    stream.on('error', (err) => {
      stream.destroy();
      done(err);
    });
    stream.on('end', () => done());
    res.on('close', () => {
      stream.destroy();
      done();
    });
    stream.pipe(res, { end: false });
  });
}

function serveTranscode(
  method: string,
  reply: import('fastify').FastifyReply,
  track: StoredTrack,
  fmt: 'flac' | 'aac',
  kbps: number,
  offsetMs = 0,
  extraHeaders: Record<string, string> = {},
): void {
  const contentType = fmt === 'flac' ? 'audio/flac' : 'audio/aac';
  const exposed = new Set(
    (extraHeaders['Access-Control-Expose-Headers'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  exposed.add('X-Rune-Live');
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
    'Access-Control-Expose-Headers': [...exposed].join(', '),
    // The body is an unbounded live ffmpeg stream: no length, no byte ranges.
    // A client that wants to seek must reload with ?t=<ms>.
    'X-Rune-Live': '1',
  };

  if (method === 'HEAD') {
    reply.hijack();
    reply.raw.writeHead(200, headers);
    reply.raw.end();
    return;
  }

  const child = spawn('ffmpeg', ffmpegArgs(track, fmt, kbps, offsetMs), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pid = child.pid;
  if (pid !== undefined) activeFfmpegPids.add(pid);

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4_000);
  });

  reply.hijack();
  const res = reply.raw;

  const forget = (): void => {
    if (pid !== undefined) activeFfmpegPids.delete(pid);
  };

  const killChild = (): void => {
    forget();
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  };

  // Client went away (closed tab/phone) -> kill the encoder immediately.
  res.on('close', killChild);
  res.on('error', killChild);

  child.on('error', (err) => {
    forget();
    stderr = `${stderr}\nspawn error: ${err.message}`;
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('ffmpeg failed to start');
    } else if (!res.writableEnded) {
      res.destroy();
    }
  });

  child.on('exit', (code, signal) => {
    forget();
    if (!res.writableEnded && !res.destroyed) {
      if (code !== 0 && code !== null && stderr.trim()) {
        res.destroy();
      } else {
        res.end();
      }
    }
    void signal;
  });

  if (!res.headersSent) res.writeHead(200, headers);
  child.stdout?.pipe(res);
}
