import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import type { Config } from '../src/config.js';
import {
  appliedGainDb,
  computeGainDb,
  createLoudness,
  energyWeightedLufs,
  ensureLoudnessSchema,
  formatSignedDb,
  gainInfoForTrack,
  lufsFromReplayGain,
  measureLoudness,
  mpvAfOption,
  parseEbur128Summary,
  parseReplayGainTags,
  probeTags,
  registerLoudnessRoutes,
  type LoudnessService,
} from '../src/loudness/index.js';
import { buildFileOptions } from '../src/play/file-options.js';
import { levelingLabel } from '../src/play/signal-path.js';
import { registerStreamRoutes } from '../src/play/stream.js';

function ffmpeg(args: string[]): void {
  const res = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`ffmpeg failed: ${res.stderr || res.stdout}`);
}

/** A 1 kHz sine; ffmpeg's sine source is -21.07 dBFS RMS, so `volumeDb` shifts LUFS predictably. */
function tone(path: string, seconds: number, volumeDb = 0): void {
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=1000:duration=${seconds}:sample_rate=48000,volume=${volumeDb}dB`,
    '-c:a',
    'flac',
    path,
  ]);
}

function config(dataDir: string): Config {
  return {
    libraryRoots: [],
    dataDir,
    port: 0,
    audioDevice: 'null',
    userAgent: 'test',
    normalize: 'album',
  };
}

function makeDb(): Db {
  const db = openDb(':memory:');
  ensureLoudnessSchema(db);
  db.prepare("INSERT INTO artists (id, name) VALUES ('ar:a', 'Artist')").run();
  db.prepare(
    "INSERT INTO albums (id, source, title, artist_id, added_at) VALUES ('la:a', 'local', 'Album', 'ar:a', 0)",
  ).run();
  return db;
}

interface TrackInput {
  id: string;
  path: string;
  number?: number;
  durationMs?: number;
  mtime?: number;
  cueStart?: number | null;
  cueEnd?: number | null;
}

function insertTrack(db: Db, track: TrackInput): void {
  db.prepare(
    `INSERT INTO tracks
       (id, album_id, source, title, disc, number, duration_ms, path,
        cue_start_ms, cue_end_ms, format, file_mtime)
     VALUES (?, 'la:a', 'local', ?, 1, ?, ?, ?, ?, ?, 'flac', ?)`,
  ).run(
    track.id,
    track.id,
    track.number ?? 1,
    track.durationMs ?? 1_000,
    track.path,
    track.cueStart ?? null,
    track.cueEnd ?? null,
    track.mtime ?? 1_000,
  );
}

interface LoudnessDbRow {
  lufs: number | null;
  true_peak_db: number | null;
  album_lufs: number | null;
  gain_source: string;
}

function loudnessRow(db: Db, trackId: string): LoudnessDbRow | undefined {
  return db
    .prepare(
      'SELECT lufs, true_peak_db, album_lufs, gain_source FROM track_loudness WHERE track_id = ?',
    )
    .get(trackId) as LoudnessDbRow | undefined;
}

describe('gain math', () => {
  it('targets -18 LUFS', () => {
    // A -20 LUFS track needs +2 dB.
    expect(computeGainDb(-20, -20)).toBeCloseTo(2, 6);
    // A loud modern master at -10 LUFS is turned down 8 dB.
    expect(computeGainDb(-10, -3)).toBeCloseTo(-8, 6);
    expect(computeGainDb(-18, null)).toBe(0);
  });

  it('limits gain so true peak never exceeds -1 dBTP', () => {
    // Desired +12 dB, but -3 dBTP + 12 would clip: only +2 dB allowed.
    expect(computeGainDb(-30, -3)).toBeCloseTo(2, 6);
    // Rounding never pushes past the ceiling: -30 LUFS / -3 dBTP -> 2.0.
    expect(appliedGainDb(-30, -3)).toBe(2);
    // Already at -1 dBTP: no boost at all.
    expect(computeGainDb(-25, -1)).toBe(0);
    // Unknown true peak: no limiting.
    expect(computeGainDb(-30, null)).toBe(12);
  });

  it('caps absurd boosts for near-silent files', () => {
    expect(computeGainDb(-70, -70)).toBe(24);
  });

  it('computes album loudness as an energy-weighted mean', () => {
    const equal = energyWeightedLufs([
      { lufs: -20, durationMs: 1_000 },
      { lufs: -10, durationMs: 1_000 },
    ]);
    expect(equal).toBeCloseTo(10 * Math.log10((0.01 + 0.1) / 2), 6);

    const weighted = energyWeightedLufs([
      { lufs: -20, durationMs: 3_000 },
      { lufs: -10, durationMs: 1_000 },
    ]);
    expect(weighted).toBeCloseTo(10 * Math.log10((3 * 0.01 + 0.1) / 4), 6);

    expect(energyWeightedLufs([])).toBeNull();
    expect(energyWeightedLufs([{ lufs: Number.NEGATIVE_INFINITY }])).toBeNull();
    // Without durations the tracks get equal weight.
    expect(energyWeightedLufs([{ lufs: -20 }, { lufs: -10 }])).toBeCloseTo(equal!, 6);
  });

  it('formats signed dB and mpv filters', () => {
    expect(formatSignedDb(3.2)).toBe('+3.2');
    expect(formatSignedDb(-7.45)).toBe('-7.5');
    expect(formatSignedDb(0)).toBe('0.0');
    expect(mpvAfOption(3.2)).toBe('af=volume=3.2dB');
    expect(mpvAfOption(-7.46)).toBe('af=volume=-7.5dB');
    expect(mpvAfOption(0)).toBeUndefined();
  });

  it('reads ReplayGain tags in any spelling', () => {
    const rg = parseReplayGainTags({
      REPLAYGAIN_TRACK_GAIN: '-7.50 dB',
      replaygain_album_gain: '+2.00 dB',
      'ReplayGain_Track_Peak': '0.5',
    });
    expect(rg.trackGainDb).toBe(-7.5);
    expect(rg.albumGainDb).toBe(2);
    expect(rg.trackPeakDb).toBeCloseTo(20 * Math.log10(0.5), 6);
    expect(lufsFromReplayGain(-7.5)).toBe(-10.5);
    expect(parseReplayGainTags({})).toEqual({});
  });
});

describe('EBU R128 analysis', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'liner-loudness-tones-'));
  }, 30_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses the ffmpeg summary', () => {
    const text = [
      '[Parsed_ebur128_0 @ 0x1] t: 0.1 TARGET:-23 LUFS M: -20.0 S:-120.0 I: -20.0 LUFS LRA: 0.0 LU FTPK: -3.0 dBFS TPK: -3.0 dBFS',
      '',
      ' Summary:',
      '',
      '  Integrated loudness:',
      '    I:         -21.1 LUFS',
      '    Threshold: -31.1 LUFS',
      '',
      '  True peak:',
      '    Peak:      -18.1 dBFS',
    ].join('\n');
    expect(parseEbur128Summary(text)).toEqual({ lufs: -21.1, truePeakDb: -18.1 });
    expect(parseEbur128Summary('Integrated loudness:\n    I: -inf LUFS\n').lufs).toBeNull();
  });

  it('measures generated tones at known levels within 0.5 LU', async () => {
    const defaultPath = join(dir, 'tone-default.flac');
    const quietPath = join(dir, 'tone-quiet.flac');
    const loudPath = join(dir, 'tone-loud.flac');
    tone(defaultPath, 3);
    tone(quietPath, 3, -6);
    tone(loudPath, 3, 6);

    // ffmpeg's sine source is -21.07 dBFS RMS at 1 kHz (K-weighting ~0 dB there).
    const base = await measureLoudness({ path: defaultPath }, { nice: false });
    expect(base.lufs).not.toBeNull();
    expect(base.lufs!).toBeCloseTo(-21.1, 0);
    expect(Math.abs(base.lufs! - -21.1)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(base.truePeakDb! - -18.1)).toBeLessThanOrEqual(0.5);

    const quiet = await measureLoudness({ path: quietPath }, { nice: false });
    expect(Math.abs(quiet.lufs! - -27.1)).toBeLessThanOrEqual(0.5);

    const loud = await measureLoudness({ path: loudPath }, { nice: false });
    expect(Math.abs(loud.lufs! - -15.1)).toBeLessThanOrEqual(0.5);
  }, 60_000);

  it('analyses only the cue slice of a big file', async () => {
    const concatPath = join(dir, 'two-halves.flac');
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=1000:duration=4:sample_rate=48000,volume=-6dB',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=1000:duration=4:sample_rate=48000,volume=6dB',
      '-filter_complex',
      '[0:a][1:a]concat=n=2:v=0:a=1[out]',
      '-map',
      '[out]',
      '-c:a',
      'flac',
      concatPath,
    ]);

    const first = await measureLoudness({ path: concatPath, startMs: 0, endMs: 4_000 }, { nice: false });
    const second = await measureLoudness(
      { path: concatPath, startMs: 4_000, endMs: 8_000 },
      { nice: false },
    );
    expect(Math.abs(first.lufs! - -27.1)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(second.lufs! - -15.1)).toBeLessThanOrEqual(0.5);
    expect(second.lufs! - first.lufs!).toBeCloseTo(12, 0);
  }, 60_000);
});

describe('worker: tags, analysis, resume', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'liner-loudness-worker-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prefers ReplayGain tags, measures only untagged files, and resumes incrementally', async () => {
    const taggedPath = join(dir, 'tagged.flac');
    const plainPath = join(dir, 'plain.flac');
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=1000:duration=1:sample_rate=48000',
      '-metadata',
      'REPLAYGAIN_TRACK_GAIN=-6.00 dB',
      '-metadata',
      'REPLAYGAIN_ALBUM_GAIN=-4.00 dB',
      '-metadata',
      'REPLAYGAIN_TRACK_PEAK=0.5',
      '-c:a',
      'flac',
      taggedPath,
    ]);
    tone(plainPath, 1);

    // The real ffprobe path is used for tags; only the measured fallback is stubbed.
    const measured: string[] = [];
    const db = makeDb();
    insertTrack(db, { id: 'l:tagged', path: taggedPath, number: 1, mtime: 111 });
    insertTrack(db, { id: 'l:plain', path: plainPath, number: 2, mtime: 222 });

    const service = createLoudness(db, config(dir), {
      measure: async (input) => {
        measured.push(input.path);
        return { lufs: -20, truePeakDb: -2 };
      },
      tags: probeTags,
    });

    expect(service.pendingCount()).toBe(2);
    const first = await service.runOnce();
    expect(first).toEqual({ analysed: 1, replaygain: 1, failed: 0, pausedForScan: false });
    expect(measured).toEqual([plainPath]);

    const tagged = loudnessRow(db, 'l:tagged')!;
    expect(tagged.gain_source).toBe('replaygain');
    expect(tagged.lufs).toBeCloseTo(-12, 6); // -18 - (-6)
    expect(tagged.true_peak_db).toBeCloseTo(20 * Math.log10(0.5), 6);
    expect(tagged.album_lufs).toBeCloseTo(-14, 6); // album gain tag wins

    const plain = loudnessRow(db, 'l:plain')!;
    expect(plain.gain_source).toBe('ffmpeg');
    expect(plain.lufs).toBe(-20);
    // Album gain tag already set by the tagged first track, so it is not
    // overwritten by the energy mean of the one analysed track.
    expect(plain.album_lufs).toBeCloseTo(-14, 6);

    // Album mode: -18 - (-14) = -4 dB. Track mode: -18 - (-12) = -6 dB.
    // (Both are attenuations: the tagged master is louder than the target.)
    expect(gainInfoForTrack(db, 'l:tagged', 'album')!.gainDb).toBe(-4);
    expect(gainInfoForTrack(db, 'l:tagged', 'track')!.gainDb).toBe(-6);
    expect(gainInfoForTrack(db, 'l:tagged', 'off')).toBeUndefined();
    expect(gainInfoForTrack(db, 'l:nope', 'album')).toBeUndefined();

    // Second pass: nothing changed, nothing re-analysed.
    const second = await service.runOnce();
    expect(second).toEqual({ analysed: 0, replaygain: 0, failed: 0, pausedForScan: false });
    expect(measured).toEqual([plainPath]);

    // A changed mtime makes the track pending again.
    db.prepare("UPDATE tracks SET file_mtime = 999 WHERE id = 'l:plain'").run();
    expect(service.pendingCount()).toBe(1);

    db.close();
  }, 60_000);

  it('computes album loudness from analysed tracks when no album tag exists', async () => {
    const a = join(dir, 'album-a.flac');
    const b = join(dir, 'album-b.flac');
    tone(a, 1);
    tone(b, 1);
    const db = makeDb();
    insertTrack(db, { id: 'l:a', path: a, number: 1, durationMs: 1_000, mtime: 1 });
    insertTrack(db, { id: 'l:b', path: b, number: 2, durationMs: 3_000, mtime: 1 });

    let call = 0;
    const service = createLoudness(db, config(dir), {
      tags: async () => ({}),
      measure: async () => {
        call += 1;
        return call === 1 ? { lufs: -20, truePeakDb: -10 } : { lufs: -10, truePeakDb: -5 };
      },
    });
    await service.runOnce();
    // 1:3 duration weighting: 10*log10((1*0.01 + 3*0.1)/4).
    const expected = 10 * Math.log10((0.01 + 3 * 0.1) / 4);
    expect(loudnessRow(db, 'l:a')!.album_lufs).toBeCloseTo(expected, 5);
    expect(loudnessRow(db, 'l:b')!.album_lufs).toBeCloseTo(expected, 5);
    db.close();
  }, 60_000);
});

describe('settings route', () => {
  let app: FastifyInstance;
  let service: LoudnessService;
  let db: Db;

  beforeAll(async () => {
    db = makeDb();
    service = createLoudness(db, config('/tmp'));
    app = Fastify({ logger: false });
    await app.register(async (r) => registerLoudnessRoutes(r, service), { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  it('GET/POST /api/settings/normalize', async () => {
    const initial = await app.inject({ method: 'GET', url: '/api/settings/normalize' });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ mode: 'album' });

    const set = await app.inject({
      method: 'POST',
      url: '/api/settings/normalize',
      payload: { mode: 'track' },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ mode: 'track' });
    expect(service.mode()).toBe('track');

    const off = await app.inject({
      method: 'POST',
      url: '/api/settings/normalize',
      payload: { mode: 'off' },
    });
    expect(off.json()).toEqual({ mode: 'off' });

    const bad = await app.inject({
      method: 'POST',
      url: '/api/settings/normalize',
      payload: { mode: 'loud' },
    });
    expect(bad.statusCode).toBe(400);
    expect(service.mode()).toBe('off');

    // Restore the module default for other tests/app instances using this db.
    service.setMode('album');
  });
});

describe('mpv per-file options', () => {
  it('combines cue bounds, start position and leveling', () => {
    expect(
      buildFileOptions({ cue: { startMs: 2_000, endMs: 6_000 }, gainDb: 3.2 }),
    ).toBe('start=2,end=6,af=volume=3.2dB');
    expect(buildFileOptions({ startMs: 1_500, gainDb: -7.5 })).toBe(
      'start=1.5,af=volume=-7.5dB',
    );
    expect(
      buildFileOptions({ cue: { startMs: 2_000, endMs: 6_000 }, startMs: 500 }),
    ).toBe('start=2.5,end=6');
    expect(buildFileOptions({ gainDb: 0 })).toBeUndefined();
    expect(buildFileOptions({})).toBeUndefined();
  });

  it('reports volume-leveled instead of bit-perfect when gain is applied', () => {
    expect(levelingLabel(3.2, 100)).toBe('volume-leveled +3.2 dB');
    expect(levelingLabel(-4, 100)).toBe('volume-leveled -4.0 dB');
    expect(levelingLabel(0, 80)).toBe('volume 80%');
    expect(levelingLabel(0, 100)).toBe('bit-perfect');
  });
});

describe('stream gain hint', () => {
  it('exposes X-Rune-Gain-Db and follows the normalize setting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'liner-loudness-stream-'));
    const path = join(dir, 'tone.flac');
    tone(path, 2);
    const db = makeDb();
    insertTrack(db, { id: 'l:stream', path, mtime: 5 });
    db.prepare(
      `INSERT INTO track_loudness
         (track_id, lufs, true_peak_db, album_lufs, analysed_at, file_mtime, gain_source)
       VALUES ('l:stream', -21.1, -18.1, -21.1, 0, 5, 'ffmpeg')`,
    ).run();
    const cfg = config(dir);
    const app = Fastify({ logger: false, forceCloseConnections: true });
    registerStreamRoutes(app, db, cfg);
    await app.ready();

    // target -18 - (-21.1) = +3.1 dB, below the +17.1 dB peak ceiling.
    const res = await app.inject({ method: 'GET', url: '/api/stream/l:stream' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-rune-gain-db']).toBe('3.1');

    db.prepare("INSERT OR REPLACE INTO loudness_settings (key, value) VALUES ('normalize', 'off')").run();
    const off = await app.inject({ method: 'GET', url: '/api/stream/l:stream' });
    expect(off.statusCode).toBe(200);
    expect(off.headers['x-rune-gain-db']).toBeUndefined();

    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});
