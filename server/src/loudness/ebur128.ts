// EBU R128 loudness measurement through ffmpeg's ebur128 filter.
//
//   ffmpeg -i file -af ebur128=peak=true -f null -
//
// ffmpeg writes the filter's final summary to stderr:
//
//   Integrated loudness:
//     I:         -21.1 LUFS
//   True peak:
//     Peak:      -18.1 dBFS
//
// Cue-sheet tracks are measured on their slice only (-ss/-to before -i, the same
// framing the stream route uses), so one FLAC holding a whole album yields one
// measurement per logical track.

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface AnalyzeSlice {
  path: string;
  startMs?: number | null;
  endMs?: number | null;
}

export interface LoudnessResult {
  /** Integrated loudness, or null for silence/unreadable audio. */
  lufs: number | null;
  /** True peak in dBTP, or null when unknown. */
  truePeakDb: number | null;
  /** Set when ffmpeg failed or the output could not be parsed. */
  error?: string;
}

export interface MeasureOptions {
  /** Wrap ffmpeg in `nice -n 10` (the background worker does). */
  nice?: boolean;
  /** Abort a stuck decode. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20 * 60_000;

function seconds(ms: number): string {
  return String(Number((ms / 1000).toFixed(6)));
}

/** ffmpeg arguments for measuring one file or cue slice. */
export function analysisArgs(input: AnalyzeSlice): string[] {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'info'];
  const startMs = Math.max(0, input.startMs ?? 0);
  const endMs = input.endMs ?? null;
  if (startMs > 0) args.push('-ss', seconds(startMs));
  if (endMs != null && endMs > startMs) args.push('-to', seconds(endMs));
  args.push(
    '-i',
    input.path,
    '-map',
    '0:a:0',
    '-vn',
    '-sn',
    '-dn',
    '-af',
    'ebur128=peak=true',
    '-f',
    'null',
    '-',
  );
  return args;
}

function parseLevel(raw: string): number | null {
  const value = raw.trim().toLowerCase();
  if (value === '-inf' || value === 'inf') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse the last integrated-loudness and true-peak figures from ebur128 output.
 * Progress lines and the final summary share the same `I:` / `TPK:` / `Peak:`
 * shapes; taking the last match reads the final summary.
 */
export function parseEbur128Summary(text: string): LoudnessResult {
  const lufsMatches = [
    ...text.matchAll(/^\s*I:\s*([-+]?(?:\d+(?:\.\d+)?|inf))\s*LUFS\b/gim),
  ];
  const peakMatches = [
    ...text.matchAll(/^\s*(?:Peak|TPK):\s*([-+]?(?:\d+(?:\.\d+)?|inf))\s*dBFS\b/gim),
  ];
  const lufs = lufsMatches.length > 0 ? parseLevel(lufsMatches[lufsMatches.length - 1]![1]!) : null;
  const truePeakDb =
    peakMatches.length > 0 ? parseLevel(peakMatches[peakMatches.length - 1]![1]!) : null;
  if (lufs === null) {
    return { lufs: null, truePeakDb, error: 'no integrated loudness in ffmpeg output' };
  }
  return { lufs, truePeakDb };
}

/** Run ffmpeg and measure integrated loudness + true peak. */
export function measureLoudness(
  input: AnalyzeSlice,
  opts: MeasureOptions = {},
): Promise<LoudnessResult> {
  if (!existsSync(input.path)) {
    return Promise.resolve({ lufs: null, truePeakDb: null, error: 'file not found' });
  }
  const ffmpegArgs = analysisArgs(input);
  const command = opts.nice === false ? 'ffmpeg' : 'nice';
  const args = opts.nice === false ? ffmpegArgs : ['-n', '10', 'ffmpeg', ...ffmpegArgs];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      resolve({ lufs: null, truePeakDb: null, error: (err as Error).message });
      return;
    }

    let stderr = '';
    let settled = false;
    const finish = (result: LoudnessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      finish({ lufs: null, truePeakDb: null, error: `ffmpeg timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    timer.unref?.();

    child.stderr?.on('data', (chunk: Buffer) => {
      // The summary is at the very end; keep a bounded tail.
      stderr = (stderr + chunk.toString()).slice(-131_072);
    });
    child.on('error', (err) => {
      finish({ lufs: null, truePeakDb: null, error: `ffmpeg failed to start: ${err.message}` });
    });
    child.on('close', (code) => {
      if (code !== 0) {
        finish({
          lufs: null,
          truePeakDb: null,
          error: `ffmpeg exited with code ${code ?? 'null'}`,
        });
        return;
      }
      finish(parseEbur128Summary(stderr));
    });
  });
}

/**
 * Read all tags ffprobe can see for a file (format tags merged with the first
 * audio stream's tags). Used to prefer embedded ReplayGain values.
 */
export function probeTags(path: string, timeoutMs = 30_000): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'format_tags:stream_tags',
        '-of',
        'json',
        path,
      ],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve({});
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as {
            format?: { tags?: Record<string, string> };
            streams?: { tags?: Record<string, string> }[];
          };
          resolve({ ...(parsed.streams?.[0]?.tags ?? {}), ...(parsed.format?.tags ?? {}) });
        } catch {
          resolve({});
        }
      },
    );
  });
}
