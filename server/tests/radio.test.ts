// Worker O — rune radio tests.
//
// Every test uses a small seeded in-memory library with two musical clusters:
//   grunge (seed / same artist / shared producer / many-album artist)
//   polka + unrelated rock (must never appear in a grunge radio)
// plus a short track and an "Interlude" to check the playability filter.
import { beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb, type Db } from '../src/db/index.js';
import { ensureHistorySchema } from '../src/history/index.js';
import {
  createRadio,
  describePick,
  registerRadioRoutes,
  type RadioPick,
  type Radio,
} from '../src/radio/index.js';
import {
  historyFor,
  loadLibrary,
  DEFAULT_WEIGHTS,
  type ScoreDetail,
} from '../src/radio/engine.js';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Fixture {
  db: Db;
  radio: () => Radio;
}

function insertArtist(db: Db, id: string, name: string): void {
  db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)').run(id, name);
}

function insertAlbum(
  db: Db,
  id: string,
  title: string,
  artistId: string,
  year: number | null,
  genres: string[],
): void {
  db.prepare(
    `INSERT INTO albums (id, source, title, artist_id, year, genres, added_at)
     VALUES (?, 'local', ?, ?, ?, ?, ?)`,
  ).run(id, title, artistId, year, JSON.stringify(genres), NOW);
}

function insertTrack(
  db: Db,
  id: string,
  albumId: string,
  title: string,
  durationMs: number,
  number: number,
  artists: string[],
): void {
  db.prepare(
    `INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms)
     VALUES (?, ?, 'local', ?, 1, ?, ?)`,
  ).run(id, albumId, title, number, durationMs);
  artists.forEach((artistId, i) => {
    db.prepare('INSERT INTO track_artists (track_id, artist_id, position) VALUES (?, ?, ?)').run(
      id,
      artistId,
      i,
    );
  });
}

function insertCredit(db: Db, albumId: string, artistId: string, role: string): void {
  db.prepare('INSERT INTO credits (album_id, artist_id, role, track_ids) VALUES (?, ?, ?, NULL)').run(
    albumId,
    artistId,
    role,
  );
}

function seed(db: Db): void {
  ensureHistorySchema(db);

  insertArtist(db, 'ar:seed', 'Seed Artist');
  insertArtist(db, 'ar:sim', 'Similar Band');
  insertArtist(db, 'ar:prod', 'Toby Wright');
  insertArtist(db, 'ar:far', 'Polka Band');
  insertArtist(db, 'ar:other', 'Cold Artist');
  insertArtist(db, 'ar:hog', 'Album Hog');
  insertArtist(db, 'ar:era', 'Era Band');

  // --- grunge cluster
  insertAlbum(db, 'la:seed', 'Seed Album', 'ar:seed', 1994, ['Grunge', 'Alternative Rock']);
  insertTrack(db, 'l:s1', 'la:seed', 'Seed Song', 240_000, 1, ['ar:seed']);
  insertTrack(db, 'l:s2', 'la:seed', 'Second Song', 210_000, 2, ['ar:seed']);
  insertTrack(db, 'l:s3', 'la:seed', 'Interlude', 100_000, 3, ['ar:seed']);
  insertTrack(db, 'l:s4', 'la:seed', 'Short Blip', 30_000, 4, ['ar:seed']);
  insertCredit(db, 'la:seed', 'ar:prod', 'Producer');

  // Same album, another edition (same album identity after normalisation).
  insertAlbum(db, 'la:seedDup', 'Seed Album (Deluxe Edition)', 'ar:seed', 1994, ['Grunge']);
  insertTrack(db, 'l:dup1', 'la:seedDup', 'Seed Song (Deluxe)', 250_000, 1, ['ar:seed']);
  insertCredit(db, 'la:seedDup', 'ar:prod', 'Producer');

  // Same artist, later album.
  insertAlbum(db, 'la:seed2', 'Seed Later', 'ar:seed', 1996, ['Grunge']);
  insertTrack(db, 'l:same1', 'la:seed2', 'Later Song', 230_000, 1, ['ar:seed']);

  // Similar band sharing the producer.
  insertAlbum(db, 'la:sim', 'Similar Album', 'ar:sim', 1995, ['Grunge', 'Alternative Rock']);
  for (let i = 1; i <= 4; i++) {
    insertTrack(db, `l:sim${i}`, 'la:sim', `Similar Song ${i}`, 200_000 + i * 1000, i, ['ar:sim']);
  }
  insertCredit(db, 'la:sim', 'ar:prod', 'Producer');

  // More same-genre bands so variety constraints never exhaust the pool.
  for (let b = 2; b <= 6; b++) {
    insertArtist(db, `ar:sim${b}`, `Similar Band ${b}`);
    insertAlbum(db, `la:sim${b}`, `Similar Album ${b}`, `ar:sim${b}`, 1992 + b, [
      'Grunge',
      'Alternative Rock',
    ]);
    for (let i = 1; i <= 4; i++) {
      insertTrack(db, `l:sim${b}_${i}`, `la:sim${b}`, `Similar ${b} Song ${i}`, 200_000, i, [
        `ar:sim${b}`,
      ]);
    }
  }

  // A large same-genre album for the "2 per 10" rule.
  insertAlbum(db, 'la:hog', 'Hog Album', 'ar:hog', 1994, ['Grunge']);
  for (let i = 1; i <= 8; i++) {
    insertTrack(db, `l:hog${i}`, 'la:hog', `Hog Song ${i}`, 190_000 + i * 1000, i, ['ar:hog']);
  }

  // Same era + genre.
  insertAlbum(db, 'la:era', 'Era Album', 'ar:era', 1996, ['Grunge']);
  for (let i = 1; i <= 3; i++) {
    insertTrack(db, `l:era${i}`, 'la:era', `Era Song ${i}`, 220_000 + i * 1000, i, ['ar:era']);
  }

  // --- never related to the seed
  insertAlbum(db, 'la:far', 'Polka Time', 'ar:far', 2019, ['Polka']);
  for (let i = 1; i <= 3; i++) {
    insertTrack(db, `l:far${i}`, 'la:far', `Polka Song ${i}`, 180_000, i, ['ar:far']);
  }
  insertAlbum(db, 'la:other', 'Other Album', 'ar:other', 2018, ['Shoegaze']);
  for (let i = 1; i <= 3; i++) {
    insertTrack(db, `l:other${i}`, 'la:other', `Other Song ${i}`, 180_000, i, ['ar:other']);
  }
}

const GRUNGE_IDS = new Set<string>([
  'l:s2',
  'l:dup1',
  'l:same1',
  'l:sim1',
  'l:sim2',
  'l:sim3',
  'l:sim4',
  'l:hog1',
  'l:hog2',
  'l:hog3',
  'l:hog4',
  'l:hog5',
  'l:hog6',
  'l:hog7',
  'l:hog8',
  'l:era1',
  'l:era2',
  'l:era3',
]);
for (let b = 2; b <= 6; b++) {
  for (let i = 1; i <= 4; i++) GRUNGE_IDS.add(`l:sim${b}_${i}`);
}

/** Album identity mirroring the engine's folding of editions. */
function albumKeyOf(db: Db, trackId: string): string {
  const row = db
    .prepare(
      `SELECT a.title AS title, ar.name AS artist FROM tracks t
         JOIN albums a ON a.id = t.album_id JOIN artists ar ON ar.id = a.artist_id
        WHERE t.id = ?`,
    )
    .get(trackId) as { title: string; artist: string };
  return `${row.artist}|${row.title.replace(/\[[^\]]*\]|\([^)]*\)/g, '').replace(/\s+/g, ' ').trim()}`;
}

function audit(db: Db, picks: RadioPick[]): void {
  const ids = picks.map((p) => p.trackId);
  // never repeat
  expect(new Set(ids).size).toBe(ids.length);
  for (let i = 0; i < picks.length; i++) {
    const window = picks.slice(Math.max(0, i - 9), i + 1);
    const key = albumKeyOf(db, picks[i]!.trackId);
    expect(window.filter((p) => albumKeyOf(db, p.trackId) === key).length).toBeLessThanOrEqual(2);
  }
  for (let i = 1; i < picks.length; i++) {
    const a = db
      .prepare(
        `SELECT a.artist_id AS artistId FROM tracks t JOIN albums a ON a.id=t.album_id WHERE t.id=?`,
      )
      .get(picks[i - 1]!.trackId) as { artistId: string };
    const b = db
      .prepare(
        `SELECT a.artist_id AS artistId FROM tracks t JOIN albums a ON a.id=t.album_id WHERE t.id=?`,
      )
      .get(picks[i]!.trackId) as { artistId: string };
    expect(a.artistId).not.toBe(b.artistId);
  }
  // short / interlude tracks are never picked
  for (const id of ids) {
    const row = db
      .prepare('SELECT duration_ms AS d, title FROM tracks WHERE id = ?')
      .get(id) as { d: number; title: string };
    expect(row.d).toBeGreaterThanOrEqual(60_000);
    expect(row.title).not.toMatch(/\binterlude\b/i);
  }
}

let fixture: Fixture;

beforeEach(() => {
  const db = openDb(':memory:');
  seed(db);
  fixture = { db, radio: () => createRadio(db) };
});

describe('radio selection', () => {
  it('keeps a fromTrack radio inside the seed musical cluster', () => {
    const picks = fixture.radio().planFromTrack('l:s1', 12, { randomSeed: 7 });
    expect(picks).toHaveLength(12);
    expect(picks.map((p) => p.trackId).every((id) => GRUNGE_IDS.has(id))).toBe(true);
    const ids = new Set(picks.map((p) => p.trackId));
    expect(ids.has('l:far1') || ids.has('l:other1')).toBe(false);
    // The seed track is not replayed.
    expect(ids.has('l:s1')).toBe(false);
  });

  it('explains picks with a producer credit or the same artist', () => {
    const picks = fixture.radio().planFromTrack('l:s1', 12, { randomSeed: 7 });
    const reasons = picks.map((p) => p.reason);
    expect(reasons.some((r) => r.includes('same producer: Toby Wright'))).toBe(true);
    expect(reasons.some((r) => r.includes('more from Seed Artist'))).toBe(true);
    for (const r of reasons) expect(r.length).toBeGreaterThan(0);
  });

  it('formats genre and era reasons like "Grunge, 1994"', () => {
    const lib = loadLibrary(fixture.db);
    const track = lib.byId.get('l:hog1')!;
    const genreDetail: ScoreDetail = {
      artist: 0,
      credit: 0,
      genre: 0.8,
      era: 0.4,
      genreKey: 'grunge',
      year: 1994,
    };
    expect(describePick(track, genreDetail, { delta: 0 }, lib, DEFAULT_WEIGHTS)).toBe('Grunge, 1994');

    const eraDetail: ScoreDetail = { artist: 0, credit: 0, genre: 0, era: 0.9, year: 1994 };
    expect(describePick(track, eraDetail, { delta: 0 }, lib, DEFAULT_WEIGHTS)).toBe(
      '1994, same era',
    );
  });

  it('respects the variety rules for a long session', () => {
    const picks = fixture.radio().planFromTrack('l:s1', 16, { randomSeed: 3 });
    expect(picks.length).toBeGreaterThanOrEqual(10);
    audit(fixture.db, picks);
  });

  it('returns the same session for the same random seed', () => {
    const a = fixture.radio().planFromTrack('l:s1', 10, { randomSeed: 42 });
    const b = fixture.radio().planFromTrack('l:s1', 10, { randomSeed: 42 });
    expect(a.map((p) => p.trackId)).toEqual(b.map((p) => p.trackId));
  });

  it('never plays an artist back-to-back even when its catalogue is large', () => {
    const picks = fixture.radio().planFromTrack('l:s1', 16, { randomSeed: 9 });
    audit(fixture.db, picks);
  });
});

describe('fromAlbum / fromArtist', () => {
  it('fromAlbum excludes the album and its other editions', () => {
    const picks = fixture.radio().planFromAlbum('la:seed', 10, { randomSeed: 5 });
    const ids = picks.map((p) => p.trackId);
    expect(picks.length).toBeGreaterThan(0);
    for (const excluded of ['l:s1', 'l:s2', 'l:s3', 'l:s4', 'l:dup1']) {
      expect(ids).not.toContain(excluded);
    }
    expect(ids.every((id) => GRUNGE_IDS.has(id))).toBe(true);
  });

  it('fromArtist stays in the artist’s style and may play the artist', () => {
    const picks = fixture.radio().planFromArtist('ar:seed', 10, { randomSeed: 5 });
    expect(picks.length).toBeGreaterThan(0);
    const ids = picks.map((p) => p.trackId);
    expect(ids.some((id) => id === 'l:s1' || id === 'l:same1' || id === 'l:s2')).toBe(true);
    expect(ids.every((id) => id === 'l:s1' || id === 'l:s2' || GRUNGE_IDS.has(id))).toBe(true);
  });

  it('returns an empty session for unknown artists/albums', () => {
    expect(fixture.radio().planFromAlbum('la:nope', 5)).toEqual([]);
    expect(fixture.radio().planFromArtist('ar:nope', 5)).toEqual([]);
    expect(fixture.radio().planFromTrack('l:nope', 5)).toEqual([]);
  });
});

describe('next()', () => {
  it('never repeats the seed queue or anything already heard', () => {
    const seedIds = ['l:s1', 'l:sim1'];
    const recent = ['l:s1', 'l:sim1', 'l:era1'];
    const picks = fixture.radio().planNext(
      { trackIds: seedIds, recentTrackIds: recent },
      8,
      { randomSeed: 12 },
    );
    expect(picks.length).toBeGreaterThan(0);
    const ids = picks.map((p) => p.trackId);
    for (const id of [...seedIds, ...recent]) expect(ids).not.toContain(id);
  });

  it('continues in the seed style', () => {
    const picks = fixture.radio().planNext(
      { trackIds: ['l:s1'], recentTrackIds: [] },
      8,
      { randomSeed: 12 },
    );
    expect(picks.map((p) => p.trackId).every((id) => GRUNGE_IDS.has(id))).toBe(true);
  });
});

describe('listening history', () => {
  function recordPlay(
    db: Db,
    trackId: string,
    albumId: string,
    startedAt: number,
    completed: number,
  ): void {
    db.prepare(
      `INSERT INTO plays (track_id, album_id, zone, started_at, played_ms, completed)
       VALUES (?, ?, 'pc', ?, 200000, ?)`,
    ).run(trackId, albumId, startedAt, completed);
  }

  it('historyFor rewards completions and avoids recent plays', () => {
    const fresh = historyFor(undefined, NOW, DEFAULT_WEIGHTS);
    expect(fresh.delta).toBe(0);

    const recent = historyFor(
      { plays: 1, completed: 1, lastPlayedAt: NOW - HOUR },
      NOW,
      DEFAULT_WEIGHTS,
    );
    expect(recent.delta).toBeLessThan(-10);
    expect(recent.label).toBe('recently played');

    const favourite = historyFor(
      { plays: 5, completed: 5, lastPlayedAt: NOW - 30 * DAY },
      NOW,
      DEFAULT_WEIGHTS,
    );
    expect(favourite.delta).toBeGreaterThan(3);
    expect(favourite.label).toBe('a favourite of yours');

    const skipped = historyFor(
      { plays: 4, completed: 0, lastPlayedAt: NOW - 30 * DAY },
      NOW,
      DEFAULT_WEIGHTS,
    );
    expect(skipped.delta).toBeLessThan(0);
  });

  it('avoids a track played an hour ago and favours one finished every time', () => {
    const db = fixture.db;
    recordPlay(db, 'l:sim1', 'la:sim', NOW - HOUR, 1); // recent, avoid
    recordPlay(db, 'l:sim2', 'la:sim', NOW - 30 * DAY, 1); // favourite
    recordPlay(db, 'l:sim2', 'la:sim', NOW - 40 * DAY, 1);
    recordPlay(db, 'l:sim2', 'la:sim', NOW - 50 * DAY, 1);
    recordPlay(db, 'l:sim2', 'la:sim', NOW - 60 * DAY, 1);

    const radio = createRadio(db, { randomSeed: 11, now: () => NOW });
    const picks = radio.planFromTrack('l:s1', 10);
    const ids = picks.map((p) => p.trackId);
    expect(ids).not.toContain('l:sim1');
    expect(ids).toContain('l:sim2');
  });

  it('does not require the plays table to exist', () => {
    const bare = openDb(':memory:');
    seed(bare);
    bare.exec('DROP TABLE plays');
    expect(() => createRadio(bare).planFromTrack('l:s1', 5, { randomSeed: 1 })).not.toThrow();
  });
});

describe('routes', () => {
  async function appWithRadio(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    registerRadioRoutes(app, createRadio(fixture.db));
    await app.ready();
    return app;
  }

  it('POST /radio/start returns track ids plus reasons', async () => {
    const app = await appWithRadio();
    for (const [from, id] of [
      ['track', 'l:s1'],
      ['album', 'la:seed'],
      ['artist', 'ar:seed'],
    ] as const) {
      const res = await app.inject({ method: 'POST', url: '/radio/start', payload: { from, id, count: 5 } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { trackIds: string[]; picks: RadioPick[] };
      expect(body.trackIds.length).toBe(5);
      expect(body.picks.map((p) => p.trackId)).toEqual(body.trackIds);
      for (const p of body.picks) expect(p.reason.length).toBeGreaterThan(0);
    }
    await app.close();
  });

  it('POST /radio/next returns a next batch and validates its body', async () => {
    const app = await appWithRadio();
    const ok = await app.inject({
      method: 'POST',
      url: '/radio/next',
      payload: { trackIds: ['l:s1'], recentTrackIds: ['l:s1'], count: 4 },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { trackIds: string[]; picks: RadioPick[] };
    expect(body.trackIds).toHaveLength(4);
    expect(body.trackIds).not.toContain('l:s1');

    const bad = await app.inject({ method: 'POST', url: '/radio/next', payload: { trackIds: 'nope' } });
    expect(bad.statusCode).toBe(400);

    const badCount = await app.inject({
      method: 'POST',
      url: '/radio/next',
      payload: { trackIds: ['l:s1'], count: 'many' },
    });
    expect(badCount.statusCode).toBe(400);
    await app.close();
  });

  it('POST /radio/start validates from/id and 404s unknown seeds', async () => {
    const app = await appWithRadio();
    const badFrom = await app.inject({ method: 'POST', url: '/radio/start', payload: { from: 'playlist', id: 'x' } });
    expect(badFrom.statusCode).toBe(400);

    const noId = await app.inject({ method: 'POST', url: '/radio/start', payload: { from: 'track' } });
    expect(noId.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'POST',
      url: '/radio/start',
      payload: { from: 'track', id: 'l:nope' },
    });
    expect(missing.statusCode).toBe(404);

    const missingAlbum = await app.inject({
      method: 'POST',
      url: '/radio/start',
      payload: { from: 'album', id: 'la:nope' },
    });
    expect(missingAlbum.statusCode).toBe(404);
    await app.close();
  });
});
