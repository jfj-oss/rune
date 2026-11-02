import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { openDb, type Db } from '../src/db/index.js';
import {
  createStats,
  ensureStatsSchema,
  registerStatsRoutes,
  isStatsPeriod,
  periodStart,
  type StatsService,
} from '../src/stats/index.js';

const DAY = 86_400_000;
/** Local noon, Mon 15 Jun 2026. Tests build plays relative to this. */
const NOW = new Date(2026, 5, 15, 12, 0, 0, 0).getTime();
const R7 = NOW - 7 * DAY;

/** Local calendar date (the bucket key stats returns). */
function localDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- seeding

function addArtist(db: Db, id: string, name: string): void {
  db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)').run(id, name);
}

function addAlbum(db: Db, id: string, title: string, artistId: string, genres: string[] = []): void {
  db.prepare(
    `INSERT INTO albums (id, source, title, artist_id, genres, added_at)
     VALUES (?, 'local', ?, ?, ?, ?)`,
  ).run(id, title, artistId, JSON.stringify(genres), NOW);
}

interface TrackOpts {
  format?: string;
  sampleRate?: number;
  bitDepth?: number;
}

function addTrack(db: Db, id: string, albumId: string, title: string, o: TrackOpts = {}): void {
  db.prepare(
    `INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms, format, sample_rate, bit_depth)
     VALUES (?, ?, 'local', ?, 1, 1, 240000, ?, ?, ?)`,
  ).run(id, albumId, title, o.format ?? null, o.sampleRate ?? null, o.bitDepth ?? null);
}

function addPlay(db: Db, trackId: string, albumId: string, startedAt: number, playedMs = 180_000): void {
  db.prepare(
    `INSERT INTO plays (track_id, album_id, zone, started_at, played_ms, completed)
     VALUES (?, ?, 'pc', ?, ?, 0)`,
  ).run(trackId, albumId, startedAt, playedMs);
}

/**
 * 5 albums / 4 artists / 11 plays spanning all four periods.
 *
 *   #   album    track                 when            ms      format
 *   1   rock1    r1a                   exactly -7d     200000  flac 24/96
 *   2   rock1    r1a                   -7d - 1ms       100000  flac 24/96
 *   3   rock1    r1b                   -1d             180000  flac 16/44.1
 *   4   rock1    r1b                   -2d             180000  flac 16/44.1
 *   5   jazz1    j1a                   -3d             240000  flac 16/44.1
 *   6   rock2    r2a                   -10d            150000  mp3
 *   7   jazz1    j1a                   -40d             60000  flac 16/44.1
 *   8   rock2    r2a                   -100d            90000  mp3
 *   9   new1     n1a                   -400d           120000  flac 24/96
 *  10   late1    l1a                   -2d             150000  mp3
 *  11   late1    l1a                   -1d             150000  mp3
 *
 * Period totals: 7d = 6 plays / 1_100_000 ms; 30d = 8 / 1_350_000;
 * 365d = 10 / 1_500_000; all = 11 / 1_620_000.
 */
function seed(db: Db): void {
  addArtist(db, 'ar:rock', 'The Rockers');
  addArtist(db, 'ar:jazz', 'Jazz Cat');
  addArtist(db, 'ar:late', 'Latecomer');
  addArtist(db, 'ar:new', 'Old Timer');

  addAlbum(db, 'la:rock1', 'Rock One', 'ar:rock', ['Rock', 'Alternative']);
  addAlbum(db, 'la:rock2', 'Rock Two', 'ar:rock', ['Rock']);
  addAlbum(db, 'la:jazz1', 'Jazz One', 'ar:jazz', ['Jazz']);
  addAlbum(db, 'la:late1', 'New Electronic', 'ar:late', ['Electronic']);
  addAlbum(db, 'la:new1', 'Ancient Pop', 'ar:new', ['Pop']);

  addTrack(db, 'l:r1a', 'la:rock1', 'Rock Track A', { format: 'flac', sampleRate: 96000, bitDepth: 24 });
  addTrack(db, 'l:r1b', 'la:rock1', 'Rock Track B', { format: 'flac', sampleRate: 44100, bitDepth: 16 });
  addTrack(db, 'l:r2a', 'la:rock2', 'Rock Two A', { format: 'mp3' });
  addTrack(db, 'l:j1a', 'la:jazz1', 'Jazz A', { format: 'flac', sampleRate: 44100, bitDepth: 16 });
  addTrack(db, 'l:l1a', 'la:late1', 'Electronic A', { format: 'mp3' });
  addTrack(db, 'l:n1a', 'la:new1', 'Pop A', { format: 'flac', sampleRate: 96000, bitDepth: 24 });

  addPlay(db, 'l:r1a', 'la:rock1', R7, 200_000);
  addPlay(db, 'l:r1a', 'la:rock1', R7 - 1, 100_000);
  addPlay(db, 'l:r1b', 'la:rock1', NOW - 1 * DAY, 180_000);
  addPlay(db, 'l:r1b', 'la:rock1', NOW - 2 * DAY, 180_000);
  addPlay(db, 'l:j1a', 'la:jazz1', NOW - 3 * DAY, 240_000);
  addPlay(db, 'l:r2a', 'la:rock2', NOW - 10 * DAY, 150_000);
  addPlay(db, 'l:j1a', 'la:jazz1', NOW - 40 * DAY, 60_000);
  addPlay(db, 'l:r2a', 'la:rock2', NOW - 100 * DAY, 90_000);
  addPlay(db, 'l:n1a', 'la:new1', NOW - 400 * DAY, 120_000);
  addPlay(db, 'l:l1a', 'la:late1', NOW - 2 * DAY, 150_000);
  addPlay(db, 'l:l1a', 'la:late1', NOW - 1 * DAY, 150_000);
}

function seeded(): { db: Db; stats: StatsService } {
  const db = openDb(':memory:');
  ensureStatsSchema(db); // creates `plays`, normally done by createHistory/createStats
  seed(db);
  return { db, stats: createStats(db, { now: () => NOW }) };
}

// ---------------------------------------------------------------- periods

describe('period handling', () => {
  it('computes rolling bounds and all = none', () => {
    expect(periodStart('7d', NOW)).toBe(NOW - 7 * DAY);
    expect(periodStart('30d', NOW)).toBe(NOW - 30 * DAY);
    expect(periodStart('365d', NOW)).toBe(NOW - 365 * DAY);
    expect(periodStart('all', NOW)).toBeNull();
  });

  it('validates period names', () => {
    expect(isStatsPeriod('7d')).toBe(true);
    expect(isStatsPeriod('30d')).toBe(true);
    expect(isStatsPeriod('365d')).toBe(true);
    expect(isStatsPeriod('all')).toBe(true);
    expect(isStatsPeriod('1y')).toBe(false);
    expect(isStatsPeriod(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------- summary

describe('GET /stats/summary semantics', () => {
  let stats: StatsService;
  beforeEach(() => {
    stats = seeded().stats;
  });

  it('7d includes a play exactly on the boundary and excludes one 1 ms older', () => {
    const s = stats.summary('7d');
    expect(s.plays).toBe(6);
    expect(s.totalMs).toBe(1_100_000);
    expect(s.distinctAlbums).toBe(3);
    expect(s.distinctArtists).toBe(3);
    expect(s.period).toBe('7d');
    expect(s.from).toBe(R7);
    expect(s.to).toBe(NOW);
  });

  it('30d, 365d and all widen to older plays', () => {
    expect(stats.summary('30d').plays).toBe(8);
    expect(stats.summary('30d').totalMs).toBe(1_350_000);
    expect(stats.summary('365d').plays).toBe(10);
    expect(stats.summary('365d').totalMs).toBe(1_500_000);
    expect(stats.summary('365d').distinctAlbums).toBe(4);
    const all = stats.summary('all');
    expect(all.plays).toBe(11);
    expect(all.totalMs).toBe(1_620_000);
    expect(all.distinctAlbums).toBe(5);
    expect(all.distinctArtists).toBe(4);
    expect(all.from).toBeNull();
  });

  it('ranks top albums/artists/tracks by plays, then time, then id', () => {
    const s = stats.summary('30d');
    expect(s.topAlbums.map((a) => a.albumId)).toEqual([
      'la:rock1', // 4 plays
      'la:late1', // 2 plays
      'la:jazz1', // 1 play, 240 s -> beats rock2's 150 s
      'la:rock2',
    ]);
    expect(s.topAlbums[0]).toMatchObject({
      albumId: 'la:rock1',
      title: 'Rock One',
      artist: 'The Rockers',
      plays: 4,
      totalMs: 660_000,
    });
    expect(s.topArtists.map((a) => a.artistId)).toEqual(['ar:rock', 'ar:late', 'ar:jazz']);
    expect(s.topArtists[0]).toMatchObject({ name: 'The Rockers', plays: 5, totalMs: 810_000, albumCount: 2 });

    // r1b and l1a tie on 2 plays (r1b has more time); j1a and r1a tie on 1
    // play (j1a has more time).
    const week = stats.summary('7d');
    expect(week.topTracks.map((t) => t.trackId)).toEqual(['l:r1b', 'l:l1a', 'l:j1a', 'l:r1a']);
    expect(week.topTracks[0]).toMatchObject({
      title: 'Rock Track B',
      albumId: 'la:rock1',
      albumTitle: 'Rock One',
      artist: 'The Rockers',
      plays: 2,
      totalMs: 360_000,
      lastPlayedAt: NOW - DAY,
    });
  });

  it('counts each album genre per play, ties ordered by name', () => {
    const s = stats.summary('7d');
    expect(s.topGenres.map((g) => g.genre)).toEqual([
      'Alternative', // 3 plays / 560 s, same as Rock -> alphabetical
      'Rock',
      'Electronic', // 2 / 300 s
      'Jazz', // 1 / 240 s
    ]);
    expect(s.topGenres[0]).toMatchObject({ genre: 'Alternative', plays: 3, totalMs: 560_000 });
  });

  it('reports format share by listened time', () => {
    const s = stats.summary('7d');
    // lossless: 200k + 180k + 180k + 240k = 800k of 1.1M; hi-res: 200k.
    expect(s.formats.lossless).toBeCloseTo(72.7, 5);
    expect(s.formats.hiRes).toBeCloseTo(18.2, 5);
    expect(stats.summary('30d').formats.lossless).toBeCloseTo(66.7, 5); // 900k / 1.35M
  });

  it('lists artists whose first play ever falls inside the period', () => {
    expect(stats.summary('7d').newDiscoveries.map((d) => d.artistId)).toEqual(['ar:late']);
    expect(stats.summary('30d').newDiscoveries.map((d) => d.artistId)).toEqual(['ar:late']);
    expect(stats.summary('365d').newDiscoveries.map((d) => d.artistId)).toEqual([
      'ar:late', // first -2d
      'ar:jazz', // first -40d
      'ar:rock', // first -100d (the Rock Two play)
    ]);
    expect(stats.summary('all').newDiscoveries.map((d) => d.artistId)).toEqual([
      'ar:late',
      'ar:jazz',
      'ar:rock',
      'ar:new', // first -400d
    ]);
    expect(stats.summary('30d').newDiscoveries[0]).toMatchObject({
      name: 'Latecomer',
      firstPlayedAt: NOW - 2 * DAY,
      plays: 2,
    });
  });

  it('day buckets sum to the period total and are sparse', () => {
    const week = stats.summary('7d');
    expect(week.byDay.map((d) => d.date)).toEqual(
      [NOW - 7 * DAY, NOW - 3 * DAY, NOW - 2 * DAY, NOW - 1 * DAY].map(localDate),
    );
    expect(week.byDay.map((d) => d.ms)).toEqual([200_000, 240_000, 330_000, 330_000]);
    expect(week.byDay.reduce((n, d) => n + d.ms, 0)).toBe(week.totalMs);
    expect(week.byHour).toHaveLength(24);
    expect(week.byWeekday).toHaveLength(7);
    expect(week.byHour[12]).toBe(week.totalMs); // every seeded play was at local noon
    expect(week.byWeekday.reduce((n, v) => n + v, 0)).toBe(week.totalMs);
  });

  it('returns zeroed buckets and empty lists for an empty history', () => {
    const db = openDb(':memory:');
    const empty = createStats(db, { now: () => NOW }).summary('all');
    expect(empty).toMatchObject({
      plays: 0,
      totalMs: 0,
      distinctAlbums: 0,
      distinctArtists: 0,
      topAlbums: [],
      topArtists: [],
      topTracks: [],
      topGenres: [],
      byDay: [],
      newDiscoveries: [],
      formats: { lossless: 0, hiRes: 0 },
    });
    expect(empty.byHour).toEqual(new Array(24).fill(0));
    expect(empty.byWeekday).toEqual(new Array(7).fill(0));
  });
});

// ---------------------------------------------------------------- timezone

describe('local timezone bucketing', () => {
  it('buckets hour/day/weekday by server-local time, not UTC', () => {
    const db = openDb(':memory:');
    ensureStatsSchema(db);
    addArtist(db, 'ar:tz', 'Timezone');
    addAlbum(db, 'la:tz', 'TZ Album', 'ar:tz', ['Ambient']);
    addTrack(db, 'l:tz', 'la:tz', 'TZ Track', { format: 'flac', sampleRate: 44100, bitDepth: 16 });

    // Constructed with local Date components, so these are 23:30 and 00:30
    // local time on consecutive local days (whatever the process TZ is).
    const lateNight = new Date(2026, 5, 10, 23, 30, 0, 0).getTime();
    const afterMidnight = new Date(2026, 5, 11, 0, 30, 0, 0).getTime();
    const midday = new Date(2026, 5, 10, 12, 15, 0, 0).getTime();
    addPlay(db, 'l:tz', 'la:tz', lateNight, 10_000);
    addPlay(db, 'l:tz', 'la:tz', afterMidnight, 20_000);
    addPlay(db, 'l:tz', 'la:tz', midday, 30_000);

    const now = new Date(2026, 5, 20, 12, 0, 0, 0).getTime();
    const s = createStats(db, { now: () => now }).summary('all');

    expect(s.byDay).toEqual([
      { date: '2026-06-10', ms: 40_000 },
      { date: '2026-06-11', ms: 20_000 },
    ]);
    expect(s.byHour[23]).toBe(10_000);
    expect(s.byHour[0]).toBe(20_000);
    expect(s.byHour[12]).toBe(30_000);
    expect(s.byHour.reduce((n, v) => n + v, 0)).toBe(60_000);
    expect(s.byWeekday[new Date(lateNight).getDay()]).toBe(40_000);
    expect(s.byWeekday[new Date(afterMidnight).getDay()]).toBe(20_000);
  });
});

// ---------------------------------------------------------------- ties

describe('deterministic tie ordering', () => {
  it('falls back to track/album id when plays and time are equal', () => {
    const db = openDb(':memory:');
    ensureStatsSchema(db);
    addArtist(db, 'ar:tie', 'Tie');
    addAlbum(db, 'la:b', 'Album B', 'ar:tie', ['Rock']);
    addAlbum(db, 'la:a', 'Album A', 'ar:tie', ['Rock']);
    addTrack(db, 'l:b', 'la:b', 'Track B');
    addTrack(db, 'l:a', 'la:a', 'Track A');
    for (let i = 0; i < 2; i++) {
      addPlay(db, 'l:b', 'la:b', NOW - (i + 1) * DAY, 100_000);
      addPlay(db, 'l:a', 'la:a', NOW - (i + 1) * DAY, 100_000);
    }
    const s = createStats(db, { now: () => NOW }).summary('all');
    expect(s.topAlbums.map((a) => a.albumId)).toEqual(['la:a', 'la:b']);
    expect(s.topTracks.map((t) => t.trackId)).toEqual(['l:a', 'l:b']);
    expect(s.topArtists.map((a) => a.artistId)).toEqual(['ar:tie']);
  });
});

// ---------------------------------------------------------------- detail

describe('artist and album detail', () => {
  let stats: StatsService;
  beforeEach(() => {
    stats = seeded().stats;
  });

  it('album: totals, first/last play and most played tracks', () => {
    const a = stats.album('la:rock1');
    expect(a).not.toBeNull();
    expect(a).toMatchObject({
      albumId: 'la:rock1',
      title: 'Rock One',
      artist: { id: 'ar:rock', name: 'The Rockers' },
      from: null,
      plays: 4,
      totalMs: 660_000,
      firstPlayedAt: R7 - 1,
      lastPlayedAt: NOW - DAY,
    });
    expect(a!.topTracks.map((t) => t.trackId)).toEqual(['l:r1b', 'l:r1a']);
    expect(a!.topTracks[0]).toMatchObject({ plays: 2, totalMs: 360_000, lastPlayedAt: NOW - DAY });
    expect(a!.topTracks[1]).toMatchObject({ plays: 2, totalMs: 300_000, lastPlayedAt: R7 });
    // Two plays share the -7d local date, so the series has three days.
    expect(a!.byDay.map((d) => d.date)).toEqual([
      localDate(R7),
      localDate(NOW - 2 * DAY),
      localDate(NOW - DAY),
    ]);
    expect(a!.byDay.map((d) => d.ms)).toEqual([300_000, 180_000, 180_000]);
  });

  it('album: an optional period clips the detail stats (boundary inclusive)', () => {
    const a = stats.album('la:rock1', '7d');
    expect(a).toMatchObject({ from: R7, plays: 3, totalMs: 560_000, firstPlayedAt: R7, lastPlayedAt: NOW - DAY });
    expect(a!.byDay.map((d) => d.ms)).toEqual([200_000, 180_000, 180_000]);
  });

  it('artist: aggregates across albums', () => {
    const a = stats.artist('ar:rock');
    expect(a).not.toBeNull();
    expect(a).toMatchObject({
      artistId: 'ar:rock',
      name: 'The Rockers',
      from: null,
      plays: 6,
      totalMs: 900_000,
      firstPlayedAt: NOW - 100 * DAY,
      lastPlayedAt: NOW - DAY,
    });
    expect(a!.topAlbums.map((x) => x.albumId)).toEqual(['la:rock1', 'la:rock2']);
    expect(a!.topAlbums[0]).toMatchObject({ plays: 4, totalMs: 660_000 });
    expect(a!.topTracks.map((t) => t.trackId)).toEqual(['l:r1b', 'l:r1a', 'l:r2a']);
    expect(a!.byDay.reduce((n, d) => n + d.ms, 0)).toBe(a!.totalMs);
  });

  it('artist: an optional period clips the detail stats', () => {
    const a = stats.artist('ar:rock', '7d');
    expect(a).toMatchObject({ plays: 3, totalMs: 560_000, firstPlayedAt: R7 });
  });

  it('returns null for unknown ids', () => {
    expect(stats.album('la:nope')).toBeNull();
    expect(stats.artist('ar:nope')).toBeNull();
  });
});

// ---------------------------------------------------------------- routes

describe('registerStatsRoutes', () => {
  it('serves summary and detail endpoints with 400/404s', async () => {
    const db = openDb(':memory:');
    ensureStatsSchema(db);
    seed(db);
    const app = Fastify();
    registerStatsRoutes(app, db, { now: () => NOW });
    await app.ready();
    try {
      const week = await app.inject({ method: 'GET', url: '/stats/summary?period=7d' });
      expect(week.statusCode).toBe(200);
      const weekBody = week.json();
      expect(weekBody.period).toBe('7d');
      expect(weekBody.plays).toBe(6);
      expect(weekBody.byDay).toHaveLength(4);

      // Default period is 30d.
      const def = await app.inject({ method: 'GET', url: '/stats/summary' });
      expect(def.json().plays).toBe(8);

      const all = await app.inject({ method: 'GET', url: '/stats/summary?period=all' });
      expect(all.json().plays).toBe(11);

      const bad = await app.inject({ method: 'GET', url: '/stats/summary?period=1y' });
      expect(bad.statusCode).toBe(400);

      const album = await app.inject({ method: 'GET', url: '/stats/album/la:rock1' });
      expect(album.statusCode).toBe(200);
      expect(album.json().plays).toBe(4);

      const artist = await app.inject({ method: 'GET', url: '/stats/artist/ar:rock?period=7d' });
      expect(artist.statusCode).toBe(200);
      expect(artist.json().plays).toBe(3);

      expect((await app.inject({ method: 'GET', url: '/stats/album/la:nope' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/stats/artist/ar:nope' })).statusCode).toBe(404);
      expect(
        (await app.inject({ method: 'GET', url: '/stats/album/la:rock1?period=nope' })).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
});
