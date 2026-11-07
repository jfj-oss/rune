import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import type { PlayerState, QueueItem, Track } from '@liner/shared';
import { openDb, type Db } from '../src/db/index.js';
import {
  createHistory,
  registerHistoryRoutes,
  playThreshold,
  type HistoryService,
} from '../src/history/index.js';

const BASE = 1_700_000_000_000;
const DAY = 86_400_000;

// ---------------------------------------------------------------- helpers

function track(id: string, durationMs: number, albumId = 'la:test'): Track {
  return {
    id,
    albumId,
    source: 'local',
    title: id,
    artists: [],
    disc: 1,
    number: 1,
    durationMs,
  };
}

interface Snap {
  zone: string;
  track: Track;
  positionMs: number;
  status: PlayerState['status'];
  at: number; // ms after BASE
  queueId?: string;
  repeat?: PlayerState['repeat'];
}

function state(s: Snap): PlayerState {
  const item: QueueItem = {
    queueId: s.queueId ?? `${s.zone}:${s.track.id}`,
    track: s.track,
    album: { id: s.track.albumId, title: s.track.albumId },
  };
  return {
    zone: s.zone,
    status: s.status,
    queue: [item],
    index: 0,
    positionMs: s.positionMs,
    volume: 100,
    shuffle: false,
    repeat: s.repeat ?? 'off',
    updatedAt: BASE + s.at * 1000,
  };
}

function stopped(zone: string, at: number): PlayerState {
  return {
    zone,
    status: 'stopped',
    queue: [],
    index: -1,
    positionMs: 0,
    volume: 100,
    shuffle: false,
    repeat: 'off',
    updatedAt: BASE + at * 1000,
  };
}

/** Feed snapshots in order, pairing each with the previous state of its zone. */
function feed(history: HistoryService, snaps: Snap[]): void {
  const prev = new Map<string, PlayerState>();
  for (const s of snaps) {
    const next = state(s);
    history.recordFromState(prev.get(s.zone) ?? stopped(s.zone, s.at - 1), next);
    prev.set(s.zone, next);
  }
}

interface PlayRow {
  trackId: string;
  albumId: string;
  zone: string;
  startedAt: number;
  playedMs: number;
  completed: number;
}

function plays(db: Db): PlayRow[] {
  return db
    .prepare(
      `SELECT track_id AS trackId, album_id AS albumId, zone,
              started_at AS startedAt, played_ms AS playedMs, completed
         FROM plays ORDER BY started_at, id`,
    )
    .all() as PlayRow[];
}

function insertAlbum(db: Db, id: string, title = id, addedAt = BASE): void {
  db.prepare('INSERT OR IGNORE INTO artists (id, name) VALUES (?, ?)').run('ar:test', 'Test');
  db.prepare(
    `INSERT INTO albums (id, source, title, artist_id, added_at)
     VALUES (?, 'local', ?, 'ar:test', ?)`,
  ).run(id, title, addedAt);
}

function insertTrack(db: Db, id: string, albumId: string, durationMs: number): void {
  db.prepare(
    `INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms)
     VALUES (?, ?, 'local', ?, 1, 1, ?)`,
  ).run(id, albumId, id, durationMs);
}

/** A play from position 0 to `seconds` (1 s snapshots), then a track change. */
function playSeconds(t: Track, seconds: number, zone = 'pc', from = 0): Snap[] {
  const snaps: Snap[] = [];
  for (let s = from; s <= seconds; s++) {
    snaps.push({ zone, track: t, positionMs: s * 1000, status: 'playing', at: s });
  }
  return snaps;
}

// ------------------------------------------------------------------ tests

describe('play counting rule', () => {
  it('thresholds: 30 s or 50%, whichever is smaller', () => {
    expect(playThreshold(200_000)).toBe(30_000);
    expect(playThreshold(40_000)).toBe(20_000);
    expect(playThreshold(10_000)).toBe(5_000);
    expect(playThreshold(0)).toBe(30_000);
  });

  it('does not count a 10 s skip', () => {
    const db = openDb(':memory:');
    const h = createHistory(db);
    const t = track('l:skip', 200_000);
    const next = track('l:next', 200_000);
    feed(h, [
      ...playSeconds(t, 10),
      { zone: 'pc', track: next, positionMs: 0, status: 'playing', at: 11 },
      { zone: 'pc', track: next, positionMs: 0, status: 'stopped', at: 12 },
    ]);
    expect(plays(db)).toEqual([]);
  });

  it('counts a 31 s play with played_ms 31000', () => {
    const db = openDb(':memory:');
    const h = createHistory(db);
    const t = track('l:counted', 200_000);
    const next = track('l:next', 200_000);
    feed(h, [
      ...playSeconds(t, 31),
      { zone: 'pc', track: next, positionMs: 0, status: 'playing', at: 32 },
    ]);
    expect(plays(db)).toEqual([
      {
        trackId: 'l:counted',
        albumId: 'la:test',
        zone: 'pc',
        startedAt: BASE,
        playedMs: 31_000,
        completed: 0,
      },
    ]);
  });

  it('counts 50% of a 40 s track (20 s)', () => {
    const db = openDb(':memory:');
    const h = createHistory(db);
    const t = track('l:short', 40_000);
    feed(h, [
      ...playSeconds(t, 20),
      { zone: 'pc', track: track('l:next', 200_000), positionMs: 0, status: 'playing', at: 21 },
    ]);
    expect(plays(db)).toHaveLength(1);
    expect(plays(db)[0]?.playedMs).toBe(20_000);
  });

  it('does not count 19 s of a 40 s track', () => {
    const db = openDb(':memory:');
    const h = createHistory(db);
    const t = track('l:short', 40_000);
    feed(h, [
      ...playSeconds(t, 19),
      { zone: 'pc', track: track('l:next', 200_000), positionMs: 0, status: 'playing', at: 20 },
    ]);
    expect(plays(db)).toEqual([]);
  });

  it('a forward seek does not fake listening time', () => {
    const db = openDb(':memory:');
    const h = createHistory(db);
    const t = track('l:seek', 200_000);
    const snaps: Snap[] = [];
    for (let s = 0; s <= 5; s++) {
      snaps.push({ zone: 'pc', track: t, positionMs: s * 1000, status: 'playing', at: s });
    }
    // Jump 5 s -> 35 s between two 1 s snapshots: only the 1 s of wall time counts.
    snaps.push({ zone: 'pc', track: t, positionMs: 35_000, status: 'playing', at: 6 });
    snaps.push({ zone: 'pc', track: t, positionMs: 40_000, status: 'playing', at: 7 });
    snaps.push({
      zone: 'pc',
      track: track('l:next', 200_000),
      positionMs: 0,
      status: 'playing',
      at: 8,
    });
    feed(h, snaps);
    expect(plays(db)).toEqual([]);
  });

  it('pause/resume continues the same play', () => {
    const db = openDb(':memory:');
    const h = createHistory(db);
    const t = track('l:pause', 40_000);
    const snaps: Snap[] = playSeconds(t, 15);
    snaps.push({ zone: 'pc', track: t, positionMs: 15_000, status: 'paused', at: 16 });
    snaps.push({ zone: 'pc', track: t, positionMs: 15_000, status: 'playing', at: 20 });
    for (let s = 16; s <= 30; s++) {
      snaps.push({ zone: 'pc', track: t, positionMs: s * 1000, status: 'playing', at: 20 + s - 15 });
    }
    snaps.push({
      zone: 'pc',
      track: track('l:next', 200_000),
      positionMs: 0,
      status: 'playing',
      at: 37,
    });
    feed(h, snaps);
    const rows = plays(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.playedMs).toBe(30_000);
    expect(rows[0]?.startedAt).toBe(BASE);
  });

  it('a very long pause splits the listen into two plays', () => {
    const db = openDb(':memory:');
    const h = createHistory(db);
    const t = track('l:longpause', 40_000);
    const snaps: Snap[] = playSeconds(t, 20);
    snaps.push({ zone: 'pc', track: t, positionMs: 20_000, status: 'paused', at: 21 });
    // Resume ten minutes later (Snap.at is in seconds).
    const resume = 21 + 10 * 60;
    snaps.push({ zone: 'pc', track: t, positionMs: 20_000, status: 'playing', at: resume });
    for (let i = 1; i <= 20; i++) {
      snaps.push({
        zone: 'pc',
        track: t,
        positionMs: 20_000 + i * 1000,
        status: 'playing',
        at: resume + i,
      });
    }
    snaps.push({ zone: 'pc', track: t, positionMs: 40_000, status: 'stopped', at: resume + 21 });
    feed(h, snaps);
    const rows = plays(db);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.playedMs)).toEqual([20_000, 20_000]);
  });

  it('a long pause is recorded even if the zone never resumes', () => {
    const db = openDb(':memory:');
    const h = createHistory(db);
    const t = track('l:paused', 200_000);
    const snaps: Snap[] = playSeconds(t, 31);
    snaps.push({ zone: 'pc', track: t, positionMs: 31_000, status: 'paused', at: 32 });
    // The next state arrives ten minutes later, still paused.
    snaps.push({
      zone: 'pc',
      track: t,
      positionMs: 31_000,
      status: 'paused',
      at: 32 + 10 * 60,
    });
    feed(h, snaps);
    expect(plays(db)).toHaveLength(1);
    expect(plays(db)[0]?.playedMs).toBe(31_000);
    expect(plays(db)[0]?.completed).toBe(0);
  });

  it('repeat-one counts each loop', () => {
    const db = openDb(':memory:');
    const h = createHistory(db);
    const t = track('l:loop', 40_000);
    const snaps: Snap[] = [];
    for (let s = 0; s <= 40; s++) {
      snaps.push({ zone: 'pc', track: t, positionMs: s * 1000, status: 'playing', at: s });
    }
    // Wrap to the start of the same queue entry.
    snaps.push({ zone: 'pc', track: t, positionMs: 0, status: 'playing', at: 41 });
    for (let s = 1; s <= 40; s++) {
      snaps.push({ zone: 'pc', track: t, positionMs: s * 1000, status: 'playing', at: 41 + s });
    }
    snaps.push({ zone: 'pc', track: t, positionMs: 40_000, status: 'stopped', at: 82 });
    feed(h, snaps);
    const rows = plays(db);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.playedMs)).toEqual([40_000, 40_000]);
    expect(rows.map((r) => r.completed)).toEqual([1, 1]);
    expect(rows[0]?.startedAt).toBe(BASE);
    expect(rows[1]?.startedAt).toBe(BASE + 41_000);
  });

  it('does not double count when the same state is fed twice', () => {
    const db = openDb(':memory:');
    const h = createHistory(db);
    const t = track('l:once', 200_000);
    const next = track('l:next', 200_000);
    const change: Snap = { zone: 'pc', track: next, positionMs: 0, status: 'playing', at: 32 };
    feed(h, [...playSeconds(t, 31), change, change]);
    expect(plays(db)).toHaveLength(1);
    expect(plays(db)[0]?.playedMs).toBe(31_000);
  });

  it('keeps zones independent', () => {
    const db = openDb(':memory:');
    const h = createHistory(db);
    const a = track('l:a', 200_000, 'la:a');
    const b = track('l:b', 200_000, 'la:b');
    const snaps: Snap[] = [];
    for (let s = 0; s <= 31; s++) {
      snaps.push({ zone: 'pc', track: a, positionMs: s * 1000, status: 'playing', at: s * 2 });
    }
    for (let s = 0; s <= 10; s++) {
      snaps.push({ zone: 'browser', track: b, positionMs: s * 1000, status: 'playing', at: s * 2 + 1 });
    }
    // Close both: pc by moving on (counts 31 s), browser by stopping (10 s, too short).
    snaps.push({ zone: 'pc', track: track('l:na', 200_000), positionMs: 0, status: 'playing', at: 80 });
    snaps.push({ zone: 'browser', track: b, positionMs: 10_000, status: 'stopped', at: 81 });
    snaps.sort((x, y) => x.at - y.at);
    feed(h, snaps);
    const rows = plays(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.trackId).toBe('l:a');
    expect(rows[0]?.zone).toBe('pc');
  });
});

describe('Spotify Connect zones: the time between reads is estimated', () => {
  const SP = 'spotify:dev';
  const fresh = () => {
    const db = openDb(':memory:');
    return { db, history: createHistory(db) };
  };

  it('a song read every 30 s and then seen rewound (Spotify\'s end) is one completed play of its length', () => {
    const { db, history } = fresh();
    const a = track('sp:a', 200_000);
    const b = track('sp:b', 100_000);
    feed(history, [
      ...[0, 30, 60, 90, 120, 150, 180].map((t) => ({ zone: SP, track: a, positionMs: t * 1000, status: 'playing' as const, at: t })),
      { zone: SP, track: a, positionMs: 0, status: 'paused', at: 201.5 },
      { zone: SP, track: b, positionMs: 0, status: 'playing', at: 201.5 },
      { zone: SP, track: b, positionMs: 30_000, status: 'playing', at: 231.5 },
    ]);
    expect(plays(db).map((p) => [p.trackId, p.playedMs, p.completed])).toEqual([['sp:a', 200_000, 1]]);
  });

  it('a next song seen late counts the unseen time up to the end only', () => {
    const { db, history } = fresh();
    const a = track('sp:a', 200_000);
    const b = track('sp:b', 100_000);
    feed(history, [
      ...[0, 60, 120, 180].map((t) => ({ zone: SP, track: a, positionMs: t * 1000, status: 'playing' as const, at: t })),
      { zone: SP, track: b, positionMs: 40_000, status: 'playing', at: 240 },
    ]);
    expect(plays(db).map((p) => [p.trackId, p.playedMs, p.completed])).toEqual([['sp:a', 200_000, 1]]);
  });

  it('a skip mid-song counts the time since the last read, not the rest of the song', () => {
    const { db, history } = fresh();
    const a = track('sp:a', 200_000);
    const b = track('sp:b', 100_000);
    feed(history, [
      { zone: SP, track: a, positionMs: 0, status: 'playing', at: 0 },
      { zone: SP, track: a, positionMs: 30_000, status: 'playing', at: 30 },
      { zone: SP, track: b, positionMs: 0, status: 'playing', at: 50 },
    ]);
    expect(plays(db).map((p) => [p.trackId, p.playedMs, p.completed])).toEqual([['sp:a', 50_000, 0]]);
  });

  it('a song moved to another device is not counted past the last read here', () => {
    const { db, history } = fresh();
    const a = track('sp:a', 200_000);
    const prev = state({ zone: SP, track: a, positionMs: 40_000, status: 'playing', at: 40 });
    history.recordFromState(stopped(SP, -1), state({ zone: SP, track: a, positionMs: 0, status: 'playing', at: 0 }));
    history.recordFromState(stopped(SP, -1), prev);
    history.recordFromState(prev, { ...stopped(SP, 120), elsewhere: true });
    expect(plays(db).map((p) => [p.trackId, p.playedMs, p.completed])).toEqual([['sp:a', 40_000, 0]]);
  });

  it('the PC zone is not estimated: it reports its own position', () => {
    const { db, history } = fresh();
    const a = track('l:a', 200_000);
    const b = track('l:b', 100_000);
    feed(history, [
      { zone: 'pc', track: a, positionMs: 0, status: 'playing', at: 0 },
      { zone: 'pc', track: a, positionMs: 40_000, status: 'playing', at: 40 },
      { zone: 'pc', track: b, positionMs: 0, status: 'playing', at: 120 },
    ]);
    expect(plays(db).map((p) => [p.trackId, p.playedMs, p.completed])).toEqual([['l:a', 40_000, 0]]);
  });
});

describe('recent albums', () => {
  it('orders by last played and aggregates plays', () => {
    const db = openDb(':memory:');
    insertAlbum(db, 'la:a');
    insertAlbum(db, 'la:b');
    insertAlbum(db, 'la:c');
    const h = createHistory(db);
    h.record({ trackId: 'l:a1', albumId: 'la:a', zone: 'pc', startedAt: BASE + 1_000, playedMs: 31_000, completed: false });
    h.record({ trackId: 'l:a2', albumId: 'la:a', zone: 'browser', startedAt: BASE + 2_000, playedMs: 31_000, completed: true });
    h.record({ trackId: 'l:b1', albumId: 'la:b', zone: 'pc', startedAt: BASE + 3_000, playedMs: 31_000, completed: false });
    h.record({ trackId: 'l:c1', albumId: 'la:c', zone: 'pc', startedAt: BASE + 500, playedMs: 31_000, completed: false });
    // History for an album that is no longer in the library is not surfaced.
    h.record({ trackId: 'l:gone', albumId: 'la:gone', zone: 'pc', startedAt: BASE + 9_000, playedMs: 31_000, completed: false });

    expect(h.recentAlbums()).toEqual([
      { albumId: 'la:b', lastPlayedAt: BASE + 3_000, plays: 1 },
      { albumId: 'la:a', lastPlayedAt: BASE + 2_000, plays: 2 },
      { albumId: 'la:c', lastPlayedAt: BASE + 500, plays: 1 },
    ]);
    expect(h.recentAlbums(2)).toHaveLength(2);
  });
});

describe('rediscover', () => {
  it('returns old and never-played albums, excluding the recent window, stable per day', () => {
    const db = openDb(':memory:');
    for (const id of ['la:recent', 'la:old', 'la:never', 'la:older', 'la:edge']) insertAlbum(db, id);
    const now = BASE + 400 * DAY;
    const h = createHistory(db, { now: () => now });
    const add = (albumId: string, at: number) =>
      h.record({ trackId: `l:${albumId}`, albumId, zone: 'pc', startedAt: at, playedMs: 31_000, completed: false });
    add('la:recent', now - DAY); // inside the 90-day window -> excluded
    add('la:old', now - 200 * DAY); // included
    add('la:older', now - 100 * DAY); // included
    add('la:edge', now - 89 * DAY); // excluded

    const first = h.rediscover(10, 90);
    expect(first.map((r) => r.albumId).sort()).toEqual(['la:never', 'la:old', 'la:older']);
    expect(first.find((r) => r.albumId === 'la:never')).toEqual({
      albumId: 'la:never',
      lastPlayedAt: null,
      plays: 0,
    });
    expect(first.find((r) => r.albumId === 'la:old')?.lastPlayedAt).toBe(now - 200 * DAY);

    // Same day -> identical order.
    expect(h.rediscover(10, 90)).toEqual(first);
    // Respects the limit.
    expect(h.rediscover(2, 90)).toHaveLength(2);
    // A different window changes the set: 50 days includes the 89-day-old album.
    expect(h.rediscover(10, 50).map((r) => r.albumId).sort()).toEqual([
      'la:edge',
      'la:never',
      'la:old',
      'la:older',
    ]);
  });

  it('memoizes per day/window until albums or plays change', () => {
    const db = openDb(':memory:');
    let clock = BASE + 400 * DAY;
    let scans = 0;
    const original = db.prepare.bind(db);
    const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      const stmt = original(sql);
      if (sql.includes('LEFT JOIN plays p ON p.album_id = a.id')) {
        const all = stmt.all.bind(stmt);
        (stmt as unknown as { all: (...args: unknown[]) => unknown }).all = (...args) => {
          scans++;
          return all(...args);
        };
      }
      return stmt;
    }) as typeof db.prepare);
    let h: HistoryService;
    try {
      h = createHistory(db, { now: () => clock });
    } finally {
      spy.mockRestore();
    }
    insertAlbum(db, 'la:a');
    insertAlbum(db, 'la:b');
    h.record({
      trackId: 'l:a1',
      albumId: 'la:a',
      zone: 'pc',
      startedAt: clock - 200 * DAY,
      playedMs: 31_000,
      completed: false,
    });

    const first = h.rediscover(10, 90);
    expect(scans).toBe(1);
    expect(h.rediscover(10, 90)).toEqual(first); // same key: cached
    expect(h.rediscover(1, 90)).toHaveLength(1); // limit slices the cached list
    expect(scans).toBe(1);

    insertAlbum(db, 'la:c'); // library changed: album count/version changes
    h.rediscover(10, 90);
    expect(scans).toBe(2);

    h.record({
      trackId: 'l:b1',
      albumId: 'la:b',
      zone: 'pc',
      startedAt: clock - 150 * DAY,
      playedMs: 31_000,
      completed: false,
    }); // plays table changed
    h.rediscover(10, 90);
    expect(scans).toBe(3);

    h.rediscover(10, 50); // different window
    expect(scans).toBe(4);

    clock += DAY; // next UTC day: new deterministic shuffle
    h.rediscover(10, 90);
    expect(scans).toBe(5);
  });
});

describe('stats', () => {
  it('counts album and track plays with the last timestamp', () => {
    const db = openDb(':memory:');
    const h = createHistory(db);
    h.record({ trackId: 'l:t1', albumId: 'la:a', zone: 'pc', startedAt: BASE + 1_000, playedMs: 31_000, completed: false });
    h.record({ trackId: 'l:t1', albumId: 'la:a', zone: 'pc', startedAt: BASE + 2_000, playedMs: 31_000, completed: false });
    h.record({ trackId: 'l:t2', albumId: 'la:a', zone: 'browser', startedAt: BASE + 3_000, playedMs: 31_000, completed: false });
    expect(h.stats('la:a')).toEqual({ plays: 3, lastPlayedAt: BASE + 3_000 });
    expect(h.stats('l:t1')).toEqual({ plays: 2, lastPlayedAt: BASE + 2_000 });
    expect(h.stats('l:unknown')).toEqual({ plays: 0, lastPlayedAt: null });
  });
});

describe('routes', () => {
  it('serves recent/rediscover/stats and accepts browser plays', async () => {
    const db = openDb(':memory:');
    insertAlbum(db, 'la:route');
    insertTrack(db, 'l:route', 'la:route', 200_000);
    const h = createHistory(db);
    const app = Fastify();
    await app.register(async (r) => registerHistoryRoutes(r, h), { prefix: '/api' });

    const short = await app.inject({
      method: 'POST',
      url: '/api/history/played',
      payload: { trackId: 'l:route', zone: 'browser', playedMs: 10_000, completed: false },
    });
    expect(short.statusCode).toBe(200);
    expect(short.json()).toEqual({ recorded: false });

    const long = await app.inject({
      method: 'POST',
      url: '/api/history/played',
      payload: {
        trackId: 'l:route',
        zone: 'browser',
        startedAt: BASE + 1,
        playedMs: 31_000,
        completed: false,
      },
    });
    expect(long.statusCode).toBe(200);
    expect(long.json()).toEqual({ recorded: true });

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/history/played',
      payload: { trackId: 'l:nope', zone: 'browser', playedMs: 31_000 },
    });
    expect(unknown.statusCode).toBe(404);

    const recent = await app.inject({ method: 'GET', url: '/api/history/recent?limit=5' });
    expect(recent.json()).toEqual([
      { albumId: 'la:route', lastPlayedAt: BASE + 1, plays: 1 },
    ]);

    const stats = await app.inject({ method: 'GET', url: '/api/history/stats/l:route' });
    expect(stats.json()).toEqual({ plays: 1, lastPlayedAt: BASE + 1 });

    const rediscover = await app.inject({ method: 'GET', url: '/api/history/rediscover?limit=5' });
    expect(rediscover.statusCode).toBe(200);
    expect(rediscover.json()).toHaveLength(1);

    await app.close();
  });
});

describe('self-check: scripted snapshots from two zones', () => {
  it('produces exactly the expected plays table', () => {
    const db = openDb(':memory:');
    const h = createHistory(db);

    const pc1 = track('l:pc1', 200_000, 'la:pc');
    const pc2 = track('l:pc2', 200_000, 'la:pc');
    const br1 = track('l:br1', 40_000, 'la:br');
    const br2 = track('l:br2', 40_000, 'la:br');

    const snaps: Snap[] = [];
    // PC: 31 s of pc1, then pc2 played 5 s and stopped (too short to count).
    for (let s = 0; s <= 31; s++) {
      snaps.push({ zone: 'pc', track: pc1, positionMs: s * 1000, status: 'playing', at: s });
    }
    snaps.push({ zone: 'pc', track: pc2, positionMs: 0, status: 'playing', at: 32 });
    snaps.push({ zone: 'pc', track: pc2, positionMs: 5_000, status: 'playing', at: 37 });
    snaps.push({ zone: 'pc', track: pc2, positionMs: 5_000, status: 'stopped', at: 38 });

    // Browser: 20 s of br1 (50% of 40 s -> counts), then br2 5 s (does not).
    for (let s = 0; s <= 10; s++) {
      snaps.push({ zone: 'browser', track: br1, positionMs: s * 2000, status: 'playing', at: 1 + s * 2 });
    }
    snaps.push({ zone: 'browser', track: br2, positionMs: 0, status: 'playing', at: 22 });
    snaps.push({ zone: 'browser', track: br2, positionMs: 5_000, status: 'playing', at: 27 });
    snaps.push({ zone: 'browser', track: br2, positionMs: 5_000, status: 'stopped', at: 28 });

    snaps.sort((a, b) => a.at - b.at);
    feed(h, snaps);

    const rows = plays(db);
    // eslint-disable-next-line no-console
    console.log('self-check plays table:', rows);

    expect(rows).toEqual([
      {
        trackId: 'l:pc1',
        albumId: 'la:pc',
        zone: 'pc',
        startedAt: BASE,
        playedMs: 31_000,
        completed: 0,
      },
      {
        trackId: 'l:br1',
        albumId: 'la:br',
        zone: 'browser',
        startedAt: BASE + 1_000,
        playedMs: 20_000,
        completed: 0,
      },
    ]);
    expect(snaps.length).toBeGreaterThanOrEqual(40);
  });
});
