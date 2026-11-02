// Loudness analysis service + resumable background worker.
//
// One ffmpeg at a time, `nice -n 10`, paused while the scanner is running.
// Files are re-analysed only when track_loudness is missing or tracks.file_mtime
// changed, so stopping/restarting the process resumes where it left off.
//
// Embedded ReplayGain tags win over analysis: they are the same
// (ReplayGain 2.0, -18 LUFS) reference and avoid decoding the file.

import { readFileSync } from 'node:fs';
import type { Config, NormalizeMode } from '../config.js';
import type { Db } from '../db/index.js';
import { isScanRunning } from '../scan/state.js';
import {
  appliedGainDb,
  energyWeightedLufs,
  isNormalizeMode,
  lufsFromReplayGain,
  parseReplayGainTags,
} from './gain.js';
import {
  measureLoudness,
  probeTags,
  type AnalyzeSlice,
  type LoudnessResult,
} from './ebur128.js';

const migrationSql = readFileSync(
  new URL('../db/migrations-loudness.sql', import.meta.url),
  'utf8',
);

export function ensureLoudnessSchema(db: Db): void {
  db.exec(migrationSql);
}

// ---------------------------------------------------------------- settings

const SETTING_KEY = 'normalize';

export function getNormalizeMode(db: Db, fallback: NormalizeMode = 'album'): NormalizeMode {
  try {
    const row = db
      .prepare('SELECT value FROM loudness_settings WHERE key = ?')
      .get(SETTING_KEY) as { value: string } | undefined;
    if (row && isNormalizeMode(row.value)) return row.value;
  } catch {
    // Schema not applied yet (e.g. a route called before createLoudness).
  }
  return fallback;
}

export function setNormalizeMode(db: Db, mode: NormalizeMode): NormalizeMode {
  db.prepare(
    `INSERT INTO loudness_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(SETTING_KEY, mode);
  return mode;
}

// ---------------------------------------------------------------- gain lookup

export type EffectiveNormalizeMode = 'track' | 'album';

export interface GainInfo {
  gainDb: number;
  mode: EffectiveNormalizeMode;
  /** Loudness used for the gain (track or album). */
  lufs: number;
  truePeakDb: number | null;
}

interface LoudnessRow {
  lufs: number | null;
  true_peak_db: number | null;
  album_lufs: number | null;
}

/**
 * Gain for one track in track/album mode. Returns undefined for mode 'off',
 * Apple/Spotify tracks, unknown tracks and tracks without measurements.
 */
export function gainInfoForTrack(
  db: Db,
  trackId: string,
  defaultMode: NormalizeMode = 'album',
  modeOverride?: NormalizeMode,
): GainInfo | undefined {
  const mode = modeOverride ?? getNormalizeMode(db, defaultMode);
  if (mode === 'off') return undefined;
  let row: LoudnessRow | undefined;
  try {
    row = db
      .prepare('SELECT lufs, true_peak_db, album_lufs FROM track_loudness WHERE track_id = ?')
      .get(trackId) as LoudnessRow | undefined;
  } catch {
    return undefined;
  }
  if (!row) return undefined;

  const lufs = mode === 'album' ? row.album_lufs ?? row.lufs : row.lufs;
  if (lufs == null || !Number.isFinite(lufs)) return undefined;
  const truePeakDb =
    row.true_peak_db != null && Number.isFinite(row.true_peak_db) ? row.true_peak_db : null;
  return {
    gainDb: appliedGainDb(lufs, truePeakDb),
    mode,
    lufs,
    truePeakDb,
  };
}

// ---------------------------------------------------------------- album loudness

interface AlbumTrackLoudness {
  lufs: number;
  duration_ms: number | null;
}

/** True when the album has a REPLAYGAIN_ALBUM_GAIN tag value driving its loudness. */
function tagAlbumLoudness(db: Db, albumId: string): number | null {
  const row = db
    .prepare('SELECT lufs, source FROM album_loudness WHERE album_id = ?')
    .get(albumId) as { lufs: number | null; source: string } | undefined;
  if (row && row.source === 'replaygain' && row.lufs != null && Number.isFinite(row.lufs)) {
    return row.lufs;
  }
  return null;
}

function writeAlbumLoudness(db: Db, albumId: string, lufs: number, source: string): void {
  db.prepare(
    `INSERT INTO album_loudness (album_id, lufs, source, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(album_id) DO UPDATE SET lufs = excluded.lufs, source = excluded.source,
       updated_at = excluded.updated_at`,
  ).run(albumId, lufs, source, Date.now());
  db.prepare(
    'UPDATE track_loudness SET album_lufs = ? WHERE track_id IN (SELECT id FROM tracks WHERE album_id = ?)',
  ).run(lufs, albumId);
}

/**
 * Recompute an album's loudness from its analysed tracks (energy-weighted mean).
 * A REPLAYGAIN_ALBUM_GAIN value, when present, always wins.
 * Returns the album loudness, or null when no track has a measurement.
 */
export function recomputeAlbumLoudness(db: Db, albumId: string): number | null {
  const tagged = tagAlbumLoudness(db, albumId);
  if (tagged != null) {
    writeAlbumLoudness(db, albumId, tagged, 'replaygain');
    return tagged;
  }

  const rows = db
    .prepare(
      `SELECT l.lufs AS lufs, t.duration_ms AS duration_ms
         FROM track_loudness l JOIN tracks t ON t.id = l.track_id
        WHERE t.album_id = ? AND l.lufs IS NOT NULL`,
    )
    .all(albumId) as AlbumTrackLoudness[];
  const lufs = energyWeightedLufs(
    rows.map((r) => ({ lufs: r.lufs, durationMs: r.duration_ms })),
  );
  if (lufs == null) return null;
  writeAlbumLoudness(db, albumId, lufs, 'computed');
  return lufs;
}

function setTagAlbumLoudness(db: Db, albumId: string, albumGainDb: number): void {
  writeAlbumLoudness(db, albumId, lufsFromReplayGain(albumGainDb), 'replaygain');
}

// ---------------------------------------------------------------- worker

export interface TrackLoudnessInput {
  path: string;
  startMs: number | null;
  endMs: number | null;
}

export interface TrackRowForLoudness {
  id: string;
  album_id: string;
  path: string | null;
  cue_start_ms: number | null;
  cue_end_ms: number | null;
  file_mtime: number | null;
}

const SELECT_TRACK = `
  SELECT id, album_id, path, cue_start_ms, cue_end_ms, file_mtime
    FROM tracks WHERE id = ?`;

export type LoudnessSource = 'ffmpeg' | 'replaygain' | 'silent' | 'error' | 'missing';

export interface AnalysisOutcome {
  trackId: string;
  source: LoudnessSource;
  lufs: number | null;
  truePeakDb: number | null;
  albumLufs: number | null;
  error?: string;
}

export interface WorkerStats {
  /** Tracks measured with ffmpeg. */
  analysed: number;
  /** Tracks whose embedded ReplayGain tags were used instead. */
  replaygain: number;
  /** Tracks that could not be measured (missing file/decoder error/silence). */
  failed: number;
  /** True when the pass stopped because a library scan is running. */
  pausedForScan: boolean;
}

export interface WorkerStatus {
  running: boolean;
  analysing: string | null;
  pending: number;
  lastError?: string;
}

export interface LoudnessService {
  readonly db: Db;
  mode(): NormalizeMode;
  setMode(mode: NormalizeMode): NormalizeMode;
  gainFor(trackId: string, modeOverride?: NormalizeMode): number;
  gainInfo(trackId: string, modeOverride?: NormalizeMode): GainInfo | undefined;
  pendingCount(): number;
  analyseTrack(trackId: string): Promise<AnalysisOutcome>;
  /** Analyse all pending tracks once, sequentially. */
  runOnce(options?: { limit?: number }): Promise<WorkerStats>;
  start(): void;
  stop(): Promise<void>;
  status(): WorkerStatus;
}

export interface CreateLoudnessOptions {
  /** Injected for tests; defaults to the real ffmpeg measurement. */
  measure?: (input: AnalyzeSlice) => Promise<LoudnessResult>;
  /** Injected for tests; defaults to ffprobe. */
  tags?: (path: string) => Promise<Record<string, string>>;
  /** Idle poll interval for start(). */
  pollMs?: number;
  log?: (message: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createLoudness(
  db: Db,
  cfg: Config,
  opts: CreateLoudnessOptions = {},
): LoudnessService {
  ensureLoudnessSchema(db);

  const defaultMode: NormalizeMode = cfg.normalize ?? 'album';
  const measure = opts.measure ?? ((input: AnalyzeSlice) => measureLoudness(input, { nice: true }));
  const readTags = opts.tags ?? ((path: string) => probeTags(path));
  const pollMs = opts.pollMs ?? 2_000;
  const log = opts.log ?? (() => undefined);

  let running = false;
  let stopping = false;
  let loop: Promise<void> | null = null;
  let analysing: string | null = null;
  let lastError: string | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  const stmtPending = db.prepare(`
    SELECT t.id
      FROM tracks t
      LEFT JOIN track_loudness l ON l.track_id = t.id
     WHERE t.source = 'local' AND t.path IS NOT NULL
       AND (l.track_id IS NULL OR l.file_mtime <> COALESCE(t.file_mtime, 0))
     ORDER BY t.album_id, t.disc, t.number
     LIMIT 1`);

  const stmtPendingCount = db.prepare(`
    SELECT COUNT(*) AS n
      FROM tracks t
      LEFT JOIN track_loudness l ON l.track_id = t.id
     WHERE t.source = 'local' AND t.path IS NOT NULL
       AND (l.track_id IS NULL OR l.file_mtime <> COALESCE(t.file_mtime, 0))`);

  const stmtTrack = db.prepare(SELECT_TRACK);
  const stmtWrite = db.prepare(`
    INSERT INTO track_loudness
      (track_id, lufs, true_peak_db, album_lufs, analysed_at, file_mtime, gain_source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(track_id) DO UPDATE SET
      lufs = excluded.lufs,
      true_peak_db = excluded.true_peak_db,
      album_lufs = excluded.album_lufs,
      analysed_at = excluded.analysed_at,
      file_mtime = excluded.file_mtime,
      gain_source = excluded.gain_source`);

  function nextPending(): string | undefined {
    return (stmtPending.get() as { id: string } | undefined)?.id;
  }

  function pendingCount(): number {
    return Number((stmtPendingCount.get() as { n: number }).n);
  }

  function existingAlbumLufs(albumId: string): number | null {
    const row = db
      .prepare('SELECT lufs FROM album_loudness WHERE album_id = ?')
      .get(albumId) as { lufs: number | null } | undefined;
    return row?.lufs ?? null;
  }

  function writeRow(
    track: TrackRowForLoudness,
    lufs: number | null,
    truePeakDb: number | null,
    source: LoudnessSource,
  ): void {
    stmtWrite.run(
      track.id,
      lufs,
      truePeakDb,
      existingAlbumLufs(track.album_id),
      Date.now(),
      Number(track.file_mtime ?? 0),
      source,
    );
  }

  async function doAnalyse(trackId: string): Promise<AnalysisOutcome> {
    const track = stmtTrack.get(trackId) as TrackRowForLoudness | undefined;
    if (!track) {
      return { trackId, source: 'error', lufs: null, truePeakDb: null, albumLufs: null, error: 'track not found' };
    }
    const finish = (source: LoudnessSource, lufs: number | null, truePeakDb: number | null, error?: string): AnalysisOutcome => {
      writeRow(track, lufs, truePeakDb, source);
      const albumLufs = recomputeAlbumLoudness(db, track.album_id);
      return {
        trackId,
        source,
        lufs,
        truePeakDb,
        albumLufs,
        ...(error ? { error } : {}),
      };
    };

    if (!track.path) {
      return finish('missing', null, null, 'track has no file');
    }

    // Prefer embedded ReplayGain values; scanning them is far cheaper than a decode.
    let tags: Record<string, string> = {};
    try {
      tags = await readTags(track.path);
    } catch {
      tags = {};
    }
    const rg = parseReplayGainTags(tags);
    if (rg.trackGainDb !== undefined) {
      const lufs = lufsFromReplayGain(rg.trackGainDb);
      const truePeakDb = rg.trackPeakDb ?? null;
      writeRow(track, lufs, truePeakDb, 'replaygain');
      let albumLufs: number | null;
      if (rg.albumGainDb !== undefined) {
        setTagAlbumLoudness(db, track.album_id, rg.albumGainDb);
        albumLufs = existingAlbumLufs(track.album_id);
      } else {
        albumLufs = recomputeAlbumLoudness(db, track.album_id);
      }
      return { trackId, source: 'replaygain', lufs, truePeakDb, albumLufs };
    }

    let result: LoudnessResult;
    try {
      result = await measure({
        path: track.path,
        startMs: track.cue_start_ms,
        endMs: track.cue_end_ms,
      });
    } catch (err) {
      // A spawn-level failure (ffmpeg/nice missing) is not the track's fault:
      // rethrow so the worker backs off instead of writing an "error" row.
      throw err;
    }

    if (result.lufs == null) {
      const source: LoudnessSource = result.error ? 'error' : 'silent';
      return finish(source, null, result.truePeakDb, result.error);
    }
    // ALBUM_GAIN tags are still useful when the track gain tag is missing.
    if (rg.albumGainDb !== undefined) setTagAlbumLoudness(db, track.album_id, rg.albumGainDb);
    return finish('ffmpeg', result.lufs, result.truePeakDb);
  }

  const service: LoudnessService = {
    db,

    mode(): NormalizeMode {
      return getNormalizeMode(db, defaultMode);
    },

    setMode(mode: NormalizeMode): NormalizeMode {
      if (!isNormalizeMode(mode)) throw new Error(`invalid normalize mode: ${String(mode)}`);
      return setNormalizeMode(db, mode);
    },

    gainFor(trackId: string, modeOverride?: NormalizeMode): number {
      return gainInfoForTrack(db, trackId, defaultMode, modeOverride)?.gainDb ?? 0;
    },

    gainInfo(trackId: string, modeOverride?: NormalizeMode): GainInfo | undefined {
      return gainInfoForTrack(db, trackId, defaultMode, modeOverride);
    },

    pendingCount,

    analyseTrack(trackId: string): Promise<AnalysisOutcome> {
      analysing = trackId;
      const run = chain.then(
        () => doAnalyse(trackId),
        () => doAnalyse(trackId),
      );
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run.finally(() => {
        if (analysing === trackId) analysing = null;
      });
    },

    async runOnce(options: { limit?: number } = {}): Promise<WorkerStats> {
      const stats: WorkerStats = { analysed: 0, replaygain: 0, failed: 0, pausedForScan: false };
      let done = 0;
      while (!stopping) {
        if (isScanRunning()) {
          stats.pausedForScan = true;
          break;
        }
        const id = nextPending();
        if (!id) break;
        try {
          const outcome = await service.analyseTrack(id);
          if (outcome.source === 'ffmpeg') stats.analysed += 1;
          else if (outcome.source === 'replaygain') stats.replaygain += 1;
          else stats.failed += 1;
          if (outcome.error) lastError = `${outcome.trackId}: ${outcome.error}`;
        } catch (err) {
          lastError = (err as Error).message;
          log(`loudness analysis failed for ${id}: ${lastError}`);
          break; // back off; retry on the next pass
        }
        done += 1;
        if (options.limit !== undefined && done >= options.limit) break;
      }
      return stats;
    },

    start(): void {
      if (loop) return;
      running = true;
      stopping = false;
      loop = (async () => {
        while (!stopping) {
          if (isScanRunning()) {
            await sleep(pollMs);
            continue;
          }
          if (nextPending() === undefined) {
            await sleep(pollMs);
            continue;
          }
          try {
            await service.runOnce();
          } catch (err) {
            lastError = (err as Error).message;
            await sleep(Math.max(pollMs, 5_000));
          }
        }
      })().finally(() => {
        running = false;
        loop = null;
      });
    },

    async stop(): Promise<void> {
      stopping = true;
      if (loop) await loop;
    },

    status(): WorkerStatus {
      return {
        running,
        analysing,
        pending: pendingCount(),
        ...(lastError ? { lastError } : {}),
      };
    },
  };

  return service;
}
