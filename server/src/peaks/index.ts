// Waveform peaks service + HTTP route (worker Q).
//
//   GET /api/peaks/:trackId?buckets=200..2000          -> { buckets, data: number[] }
//   GET /api/peaks/:trackId?buckets=...&bin=1          -> application/octet-stream
//
// Local tracks are decoded on demand (single-flight per track, one ffmpeg at a
// time, nice -n 10) and cached under <dataDir>/peaks. Spotify tracks have no
// audio access here and answer 404. `prefetch(trackIds)` warms the cache for
// the current queue's upcoming tracks without blocking the caller.
import { existsSync, statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import {
  DEFAULT_BUCKETS,
  MAX_BUCKETS,
  MIN_BUCKETS,
  activePeakPids,
  cacheFilePath,
  computeBasePeaks,
  readBasePeaks,
  resamplePeaks,
  sourceExists,
  writeBasePeaks,
  type PeakTrack,
} from './compute.js';
import { PeakQueue } from './queue.js';

export interface PeaksResult {
  buckets: number;
  data: number[];
}

export interface PeaksService {
  /**
   * Peaks for a local track. Returns null for unknown ids, Spotify tracks and
   * missing audio files (all 404 to clients); rejects when decoding fails.
   */
  get(trackId: string, buckets?: number): Promise<PeaksResult | null>;
  /** Warm the cache in the background for these tracks (queue look-ahead). */
  prefetch(trackIds: string[]): void;
  /** Kill any ffmpeg this service started and refuse further work. */
  close(): void;
}

export type CreatePeaks = (db: Db, cfg: Config) => PeaksService;

interface TrackRow {
  id: string;
  source: string;
  path: string | null;
  cue_start_ms: number | null;
  cue_end_ms: number | null;
  duration_ms: number;
}

/** Clamp a requested bucket count into the supported range (default 800). */
export function clampBuckets(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return DEFAULT_BUCKETS;
  return Math.min(MAX_BUCKETS, Math.max(MIN_BUCKETS, Math.round(n)));
}

export function createPeaks(db: Db, cfg: Config): PeaksService {
  const getRow = db.prepare(
    'SELECT id, source, path, cue_start_ms, cue_end_ms, duration_ms FROM tracks WHERE id = ?',
  );
  const queue = new PeakQueue(1, 24);
  const inflight = new Map<string, Promise<Uint8Array>>();
  let closed = false;

  function loadTrack(trackId: string): { track: PeakTrack; path: string } | null {
    if (closed) return null;
    const row = getRow.get(trackId) as TrackRow | undefined;
    // Spotify has no local audio to decode; unknown ids are indistinguishable.
    if (!row || row.source === 'spotify' || !row.path) return null;
    if (!sourceExists(row.path)) return null;
    const isCue = row.cue_start_ms != null;
    const startMs = isCue ? row.cue_start_ms! : 0;
    let endMs = isCue ? row.cue_end_ms : null;
    // Fall back to the stored duration when a cue end is missing.
    if (isCue && endMs == null) endMs = startMs + row.duration_ms;
    const durationMs = isCue ? Math.max(0, endMs! - startMs) : row.duration_ms;
    return {
      path: row.path,
      track: {
        id: row.id,
        path: row.path,
        cueStartMs: isCue ? startMs : null,
        cueEndMs: isCue ? endMs : null,
        durationMs,
      },
    };
  }

  function ensureBase(track: PeakTrack, background: boolean): Promise<Uint8Array> {
    if (closed) return Promise.reject(new Error('peaks service closed'));
    const mtime = Math.round(statSync(track.path).mtimeMs);
    const file = cacheFilePath(cfg, track.id, mtime);
    const hit = readBasePeaks(file);
    if (hit) return Promise.resolve(hit);
    const running = inflight.get(file);
    if (running) return running;

    const job = queue
      .run(async () => {
        if (closed) throw new Error('peaks service closed');
        // Another process may have finished the same file while we waited.
        const again = readBasePeaks(file);
        if (again) return again;
        const data = await computeBasePeaks(track);
        writeBasePeaks(file, data);
        return data;
      }, background)
      .finally(() => {
        inflight.delete(file);
      });
    inflight.set(file, job);
    return job;
  }

  return {
    async get(trackId, buckets = DEFAULT_BUCKETS) {
      const count = clampBuckets(buckets);
      const loaded = loadTrack(trackId);
      if (!loaded) return null;
      const base = await ensureBase(loaded.track, false);
      return { buckets: count, data: resamplePeaks(base, count) };
    },

    prefetch(trackIds) {
      if (closed) return;
      const seen = new Set<string>();
      for (const trackId of trackIds) {
        if (seen.has(trackId)) continue;
        seen.add(trackId);
        const loaded = loadTrack(trackId);
        if (!loaded) continue;
        let file: string;
        try {
          file = cacheFilePath(cfg, loaded.track.id, statSync(loaded.path).mtimeMs);
        } catch {
          continue;
        }
        if (existsSync(file) || inflight.has(file)) continue;
        if (queue.backgroundFull) return;
        // Fire-and-forget: prefetch failures are never surfaced to the caller.
        void ensureBase(loaded.track, true).catch(() => undefined);
      }
    },

    close() {
      closed = true;
      for (const pid of activePeakPids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      activePeakPids.clear();
    },
  };
}

/**
 * Register the peaks route. Call inside the app's `/api` prefix scope, like the
 * other registerXxxRoutes helpers (paths are prefix-relative).
 */
export function registerPeaksRoutes(app: FastifyInstance, peaks: PeaksService): void {
  app.get<{
    Params: { trackId: string };
    Querystring: { buckets?: string; bin?: string };
  }>('/peaks/:trackId', async (request, reply) => {
    const buckets = clampBuckets(request.query.buckets);
    const wantsBinary = request.query.bin === '1' || request.query.bin === 'true';
    let result: PeaksResult | null;
    try {
      result = await peaks.get(request.params.trackId, buckets);
    } catch (err) {
      request.log.warn({ err, trackId: request.params.trackId }, 'peaks computation failed');
      return reply.code(500).send({ error: 'failed to compute peaks' });
    }
    if (!result) return reply.code(404).send({ error: 'track not found' });

    reply.header('cache-control', 'private, max-age=86400');
    if (wantsBinary) {
      reply.header('content-type', 'application/octet-stream');
      reply.header('x-peaks-buckets', String(result.buckets));
      return reply.send(Buffer.from(result.data));
    }
    return result;
  });
}

export {
  BASE_BUCKETS,
  DEFAULT_BUCKETS,
  MAX_BUCKETS,
  MIN_BUCKETS,
  activePeakPids,
  cacheFilePath,
  computeBasePeaks,
  peaksFfmpegSpawnCount,
  readBasePeaks,
  resamplePeaks,
  writeBasePeaks,
  type PeakTrack,
} from './compute.js';
export { PeakQueue } from './queue.js';
