// Waveform peaks: decode audio with ffmpeg to low-rate mono PCM and bucket it
// while streaming, so memory stays constant no matter how long the track is.
//
// Cache format: one byte per base bucket (0..255, peak absolute amplitude
// normalised to the track's own maximum). Files live in
// <dataDir>/peaks/<safe track id>-<mtime>.bin and are written atomically.
//
// The cache always holds BASE_BUCKETS buckets (fewer for very short tracks);
// requests for 200..2000 buckets are served by max-aggregating that base, so
// one decode can satisfy every zoom level.
import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from '../config.js';

/** Decode rate: 8 kHz mono is plenty for a visual envelope and ~1/44 the samples. */
export const PEAK_SAMPLE_RATE = 8000;
/** Resolution of the on-disk cache. Requests are aggregated down from this. */
export const BASE_BUCKETS = 2000;
export const MIN_BUCKETS = 200;
export const MAX_BUCKETS = BASE_BUCKETS;
export const DEFAULT_BUCKETS = 800;

export interface PeakTrack {
  id: string;
  path: string;
  /** Cue slice in the source file, if this is a cue-sheet track. */
  cueStartMs?: number | null;
  cueEndMs?: number | null;
  /** Duration of the audio to decode (for cue tracks: the slice length). */
  durationMs: number;
}

/** ffmpeg spawn counter — tests use it to prove cache hits spawn nothing. */
let spawnCount = 0;
export function peaksFfmpegSpawnCount(): number {
  return spawnCount;
}

/** PIDs of ffmpeg processes started by this module (for close/diagnostics). */
export const activePeakPids = new Set<number>();

export function safeTrackId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '_');
}

/** <dataDir>/peaks/<safe id>-<mtime>.bin */
export function cacheFilePath(cfg: Config, trackId: string, mtimeMs: number): string {
  return join(cfg.dataDir, 'peaks', `${safeTrackId(trackId)}-${Math.round(mtimeMs)}.bin`);
}

function seconds(ms: number): string {
  return String(Number((ms / 1000).toFixed(6)));
}

/** ffmpeg args: seek the cue slice before -i (fast, accurate_seek trims exactly). */
export function peakFfmpegArgs(track: PeakTrack): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (track.cueStartMs != null && track.cueStartMs > 0) args.push('-ss', seconds(track.cueStartMs));
  if (track.cueEndMs != null) args.push('-to', seconds(track.cueEndMs));
  args.push(
    '-i',
    track.path,
    '-map',
    '0:a:0',
    '-vn',
    '-sn',
    '-dn',
    '-ac',
    '1',
    '-ar',
    String(PEAK_SAMPLE_RATE),
    '-f',
    's16le',
    'pipe:1',
  );
  return args;
}

export interface ComputeOptions {
  /** Override spawn for tests. */
  spawnFn?: typeof spawn;
  /** Extra spawn options (unused in production). */
  spawnOptions?: SpawnOptions;
}

/**
 * Decode `track` and return BASE_BUCKETS (or fewer, for short tracks) bytes.
 * Uses the bucket count and sample count as ints; the only buffers held are the
 * fixed-size bin array and one stdout chunk.
 */
export function computeBasePeaks(track: PeakTrack, opts: ComputeOptions = {}): Promise<Uint8Array> {
  const spawnFn = opts.spawnFn ?? spawn;
  const expectedSamples = Math.max(1, Math.round((track.durationMs * PEAK_SAMPLE_RATE) / 1000));
  const bins = new Uint16Array(Math.min(BASE_BUCKETS, expectedSamples));
  const bucketWidth = expectedSamples / bins.length;

  return new Promise<Uint8Array>((resolve, reject) => {
    spawnCount += 1;
    // nice -n 10 keeps waveform work out of the way of playback.
    const child = spawnFn('nice', ['-n', '10', 'ffmpeg', ...peakFfmpegArgs(track)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts.spawnOptions,
    });
    const pid = child.pid;
    if (pid !== undefined) activePeakPids.add(pid);

    let settled = false;
    let stderr = '';
    let sampleIndex = 0;
    let globalMax = 0;
    let oddByte: number | null = null;

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (pid !== undefined) activePeakPids.delete(pid);
      if (err) {
        reject(err);
        return;
      }
      const out = new Uint8Array(bins.length);
      if (globalMax > 0) {
        const scale = 255 / globalMax;
        for (let i = 0; i < bins.length; i++) out[i] = Math.min(255, Math.round(bins[i]! * scale));
      }
      resolve(out);
    };

    const consume = (chunk: Buffer): void => {
      let offset = 0;
      if (oddByte != null) {
        // Complete the 16-bit little-endian sample split across chunk boundaries.
        const combined = oddByte | ((chunk.length > 0 ? chunk[0]! : 0) << 8);
        sample(combined & 0x8000 ? combined - 0x10000 : combined);
        oddByte = null;
        offset = 1;
      }
      const usable = offset + ((chunk.length - offset) & ~1);
      for (; offset < usable; offset += 2) sample(chunk.readInt16LE(offset));
      if (offset < chunk.length) oddByte = chunk[offset]!;
    };

    const sample = (v: number): void => {
      const a = v < 0 ? -v : v; // -32768 -> 32768
      let b = Math.floor(sampleIndex / bucketWidth);
      if (b >= bins.length) b = bins.length - 1;
      if (a > bins[b]!) bins[b] = a;
      if (a > globalMax) globalMax = a;
      sampleIndex += 1;
    };

    child.stdout?.on('data', (chunk: Buffer) => consume(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4_000);
    });
    child.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))));
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`ffmpeg exited with ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

/** Read a cached base waveform; null when absent/empty. */
export function readBasePeaks(file: string): Uint8Array | null {
  try {
    const buf = readFileSync(file);
    return buf.length > 0 ? new Uint8Array(buf) : null;
  } catch {
    return null;
  }
}

let tmpSeq = 0;
/** Atomically write the cache file (a crash never leaves a half file in place). */
export function writeBasePeaks(file: string, data: Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${tmpSeq++}.part`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Resolve the cache path for a track, statting the source for its mtime. */
export function cachePathFor(cfg: Config, trackId: string, path: string): string {
  return cacheFilePath(cfg, trackId, statSync(path).mtimeMs);
}

/** Max-aggregate the cached base waveform down/up to exactly `buckets` values. */
export function resamplePeaks(base: Uint8Array, buckets: number): number[] {
  const out = new Array<number>(buckets);
  if (base.length === 0) {
    out.fill(0);
    return out;
  }
  for (let i = 0; i < buckets; i++) {
    const start = Math.min(base.length - 1, Math.floor((i * base.length) / buckets));
    let end = Math.floor(((i + 1) * base.length) / buckets);
    if (end <= start) end = start + 1;
    let max = 0;
    for (let j = start; j < end && j < base.length; j++) {
      const v = base[j]!;
      if (v > max) max = v;
    }
    out[i] = max;
  }
  return out;
}

/** True when the file exists and can be decoded (used before queueing work). */
export function sourceExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}
