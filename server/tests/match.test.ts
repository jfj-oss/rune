import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb, ids, type Db } from '../src/db/index.js';
import type { Config } from '../src/config.js';
import {
  MbClient,
  MbHttpError,
  RateLimiter,
  escapeLucene,
  normalizeTitle,
  scoreRelease,
  titleSimilarity,
  createMatcher,
  type MatchOptions,
} from '../src/match/index.js';
import type { FetchLike } from '../src/match/mb.js';
import {
  fixtureAlbum,
  fixtureFetch,
  insertBespokeAlbum,
  insertLocalAlbum,
  loadFixtureAlbums,
  loadRelease,
  urlOf,
} from './support/fixtures.js';

function makeCfg(dataDir = mkdtempSync(join(tmpdir(), 'liner-match-test-'))): Config {
  return {
    libraryRoots: [],
    dataDir,
    port: 0,
    audioDevice: 'pipewire',
    userAgent: 'Liner/0.1 ( test )',
  };
}

function makeMatcher(db: Db, cfg: Config, fetchImpl: FetchLike, extra: MatchOptions = {}) {
  return createMatcher(db, cfg, {
    fetch: fetchImpl,
    rateLimitMs: 0,
    sleep: async () => {},
    downloadCovers: false,
    ...extra,
  });
}

function albumRow(db: Db, id: string): Record<string, any> {
  return db.prepare('SELECT * FROM albums WHERE id = ?').get(id) as Record<string, any>;
}

function count(db: Db, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { c: number }).c;
}

function foreignKeyCheck(db: Db): unknown[] {
  return db.pragma('foreign_key_check') as unknown[];
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MusicBrainz client', () => {
  it('spaces calls at least 1000 ms apart (fake timers)', async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(1000);
    const times: number[] = [];
    const calls = Array.from({ length: 3 }, async () => {
      await limiter.wait();
      times.push(Date.now());
    });
    const all = Promise.all(calls);
    await vi.advanceTimersByTimeAsync(5000);
    await all;

    expect(times).toHaveLength(3);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(1000);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(1000);
  });

  it('retries 429/503 with backoff and gives up after 4 retries', async () => {
    let calls = 0;
    const flaky: FetchLike = async () => {
      calls++;
      return calls < 3
        ? new Response('rate limited', { status: 429 })
        : new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const client = new MbClient({
      userAgent: 'test',
      db: openDb(':memory:'),
      fetch: flaky,
      sleep: async () => {},
      rateLimitMs: 0,
    });
    await expect(client.getJson('https://musicbrainz.org/ws/2/test-flaky')).resolves.toEqual({ ok: true });
    expect(calls).toBe(3);

    let downCalls = 0;
    const down: FetchLike = async () => {
      downCalls++;
      return new Response('unavailable', { status: 503 });
    };
    const failing = new MbClient({
      userAgent: 'test',
      db: openDb(':memory:'),
      fetch: down,
      sleep: async () => {},
      rateLimitMs: 0,
    });
    await expect(failing.getJson('https://musicbrainz.org/ws/2/test-down')).rejects.toBeInstanceOf(MbHttpError);
    expect(downCalls).toBe(5); // initial + 4 retries
  });

  it('caches every GET in http_cache and reuses it for 30 days', async () => {
    const db = openDb(':memory:');
    let calls = 0;
    let now = 1_000_000;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return new Response('{"n":1}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const client = new MbClient({
      userAgent: 'test',
      db,
      fetch: fetchImpl,
      now: () => now,
      rateLimitMs: 0,
      sleep: async () => {},
    });

    expect(await client.getJson('https://musicbrainz.org/ws/2/cache-me')).toEqual({ n: 1 });
    expect(await client.getJson('https://musicbrainz.org/ws/2/cache-me')).toEqual({ n: 1 });
    expect(calls).toBe(1);
    expect(count(db, 'SELECT count(*) AS c FROM http_cache')).toBe(1);

    now += 30 * 24 * 60 * 60 * 1000 + 1;
    expect(await client.getJson('https://musicbrainz.org/ws/2/cache-me')).toEqual({ n: 1 });
    expect(calls).toBe(2);
  });

  it('escapes Lucene special characters in search queries', async () => {
    expect(escapeLucene('AC/DC & "Friends"')).toBe('AC\\/DC \\& \\"Friends\\"');

    let seen = '';
    const client = new MbClient({
      userAgent: 'test',
      db: openDb(':memory:'),
      rateLimitMs: 0,
      sleep: async () => {},
      fetch: async (input) => {
        seen = urlOf(input);
        return new Response('{"releases":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    await client.searchRelease('AC/DC & "Friends"', 'Art/ist');
    const query = new URL(seen).searchParams.get('query');
    expect(query).toBe('release:"AC\\/DC \\& \\"Friends\\"" AND artist:"Art\\/ist"');
  });
});

describe('title scoring', () => {
  it('strips edition and remaster suffixes before comparing titles', () => {
    expect(normalizeTitle('Discovery (Deluxe Edition)')).toBe('discovery');
    expect(normalizeTitle('Discovery [Remastered 2011]')).toBe('discovery');
    expect(normalizeTitle('Discovery - Remastered')).toBe('discovery');
    expect(titleSimilarity('Discovery (Deluxe Edition)', 'Discovery')).toBe(1);
    expect(titleSimilarity('Jar of Flies', 'Jar of Flies EP')).toBeGreaterThan(0.8);
  });
});

describe('fixture matching (offline replay)', () => {
  for (const album of loadFixtureAlbums()) {
    it(`picks the right release for ${album.artist} — ${album.title}`, async () => {
      const db = openDb(':memory:');
      const cfg = makeCfg();
      insertLocalAlbum(db, album);

      await makeMatcher(db, cfg, fixtureFetch()).matchPending();

      const row = albumRow(db, album.albumId);
      expect(row.mb_release_id).toBe(album.targetReleaseId);
      expect(row.mb_release_group_id).toBe(album.targetReleaseGroupId);
      expect(row.match_confidence).toBeGreaterThanOrEqual(0.8);
      expect(row.release_date).toBeTruthy();
      expect(row.label).toBeTruthy();

      const mapped = count(
        db,
        'SELECT count(*) AS c FROM tracks WHERE album_id = ? AND mb_recording_id IS NOT NULL',
        album.albumId,
      );
      expect(mapped).toBe(album.tracks.length);

      const credits = count(db, 'SELECT count(*) AS c FROM credits WHERE album_id = ?', album.albumId);
      expect(credits).toBeGreaterThan(0);

      const genres = JSON.parse(row.genres) as string[];
      expect(genres.length).toBeGreaterThan(0);
      expect(genres.length).toBeLessThanOrEqual(5);
      expect(genres.every((g) => g.length > 0)).toBe(true);

      expect(foreignKeyCheck(db)).toEqual([]);
    });
  }

  it('gibberish album gets no match and scores < 0.5 against a real release', async () => {
    const discovery = fixtureAlbum('daft-punk-discovery');
    const release = loadRelease(discovery.targetReleaseId);
    const local = {
      title: 'Xqzzt Plorf',
      artist: 'Nobody Real',
      year: 2024,
      format: 'FLAC 16/44.1',
      tracks: [1, 2, 3].map((n) => ({
        id: `x${n}`,
        title: `Nonsense ${n}`,
        disc: 1,
        number: n,
        durationMs: 1000 * n,
      })),
    };
    expect(scoreRelease(local, release).score).toBeLessThan(0.5);

    const db = openDb(':memory:');
    const cfg = makeCfg();
    const id = insertBespokeAlbum(db, {
      slug: 'gibberish',
      title: 'Xqzzt Plorf',
      artist: 'Nobody Real',
      year: 2024,
      tracks: local.tracks.map((t) => ({ title: t.title, durationMs: t.durationMs })),
    });

    await makeMatcher(db, cfg, fixtureFetch()).matchPending();

    const row = albumRow(db, id);
    expect(row.mb_release_id).toBeNull();
    expect(row.match_confidence).toBeNull();
    expect(count(db, 'SELECT count(*) AS c FROM credits WHERE album_id = ?', id)).toBe(0);
  });

  it('merges the provisional artist into the canonical MB artist without orphans', async () => {
    const album = fixtureAlbum('daft-punk-discovery');
    const db = openDb(':memory:');
    const cfg = makeCfg();
    const id = insertLocalAlbum(db, album);
    const oldArtistId = ids.artistByName(album.artist);
    expect(db.prepare('SELECT 1 FROM artists WHERE id = ?').get(oldArtistId)).toBeTruthy();

    await makeMatcher(db, cfg, fixtureFetch()).matchPending();

    const row = albumRow(db, id);
    const mbid = '056e4f3e-d505-4dad-8ec1-d04f521cbb56';
    const canonicalId = ids.artistByMbid(mbid);

    expect(row.artist_id).toBe(canonicalId);
    const canonical = db.prepare('SELECT * FROM artists WHERE id = ?').get(canonicalId) as Record<string, any>;
    expect(canonical).toBeTruthy();
    expect(canonical.name).toBe('Daft Punk');
    expect(canonical.mbid).toBe(mbid);
    expect(count(db, 'SELECT count(*) AS c FROM artists WHERE mbid = ?', mbid)).toBe(1);

    // Provisional row is gone and nothing still references it.
    expect(db.prepare('SELECT 1 FROM artists WHERE id = ?').get(oldArtistId)).toBeUndefined();
    expect(count(db, 'SELECT count(*) AS c FROM albums WHERE artist_id = ?', oldArtistId)).toBe(0);
    expect(count(db, 'SELECT count(*) AS c FROM track_artists WHERE artist_id = ?', oldArtistId)).toBe(0);
    expect(count(db, 'SELECT count(*) AS c FROM credits WHERE artist_id = ?', oldArtistId)).toBe(0);

    // Daft Punk's credits include both members.
    const creditNames = (
      db
        .prepare(
          `SELECT DISTINCT ar.name AS name
             FROM credits c JOIN artists ar ON ar.id = c.artist_id
            WHERE c.album_id = ?`,
        )
        .all(id) as { name: string }[]
    ).map((r) => r.name);
    expect(creditNames.some((n) => n.includes('Bangalter'))).toBe(true);
    expect(creditNames.some((n) => n.includes('Homem'))).toBe(true);

    // Recording-level credits carry a JSON array of local track ids.
    const withTracks = db
      .prepare('SELECT track_ids FROM credits WHERE album_id = ? AND track_ids IS NOT NULL')
      .all(id) as { track_ids: string }[];
    expect(withTracks.length).toBeGreaterThan(0);
    const trackIds = JSON.parse(withTracks[0]!.track_ids) as string[];
    expect(Array.isArray(trackIds)).toBe(true);
    expect(trackIds.length).toBeGreaterThan(0);
    expect(trackIds.every((trackId) => trackId.startsWith(id))).toBe(true);

    // Some credits are whole-album (track_ids NULL).
    expect(count(db, 'SELECT count(*) AS c FROM credits WHERE album_id = ? AND track_ids IS NULL', id)).toBeGreaterThan(0);

    expect(foreignKeyCheck(db)).toEqual([]);
  });

  it('promotes same-role-on-every-track credits to whole-album credits', async () => {
    const album = fixtureAlbum('alice-in-chains-jar-of-flies');
    const db = openDb(':memory:');
    const cfg = makeCfg();
    const id = insertLocalAlbum(db, album);
    await makeMatcher(db, cfg, fixtureFetch()).matchPending();

    // The same mixer is credited on all seven tracks in the fixture.
    const wholeAlbum = db
      .prepare(
        `SELECT c.role AS role, ar.name AS name
           FROM credits c JOIN artists ar ON ar.id = c.artist_id
          WHERE c.album_id = ? AND c.track_ids IS NULL`,
      )
      .all(id) as { role: string; name: string }[];
    expect(wholeAlbum.some((c) => c.role === 'Mix')).toBe(true);

    // No track-level credit lists all seven tracks (that would not be deduped).
    const trackLevel = db
      .prepare('SELECT track_ids FROM credits WHERE album_id = ? AND track_ids IS NOT NULL')
      .all(id) as { track_ids: string }[];
    for (const credit of trackLevel) {
      expect((JSON.parse(credit.track_ids) as string[]).length).toBeLessThan(album.tracks.length);
    }
  });

  it('does not overwrite locked albums during matchPending; setRelease applies and locks', async () => {
    const album = fixtureAlbum('daft-punk-discovery');
    const db = openDb(':memory:');
    const cfg = makeCfg();
    const id = insertLocalAlbum(db, album, { locked: true });

    const progress: [number, number][] = [];
    await makeMatcher(db, cfg, fixtureFetch()).matchPending((done, total) => progress.push([done, total]));

    expect(progress).toEqual([[0, 0]]);
    let row = albumRow(db, id);
    expect(row.mb_release_id).toBeNull();
    expect(row.match_confidence).toBeNull();
    expect(row.match_locked).toBe(1);
    expect(count(db, 'SELECT count(*) AS c FROM credits WHERE album_id = ?', id)).toBe(0);

    await makeMatcher(db, cfg, fixtureFetch()).setRelease(id, album.targetReleaseId);
    row = albumRow(db, id);
    expect(row.mb_release_id).toBe(album.targetReleaseId);
    expect(row.match_locked).toBe(1);
    expect(row.match_confidence).toBeGreaterThan(0.8);
  });

  it('reports progress and keeps going when one album cannot be matched', async () => {
    const album = fixtureAlbum('daft-punk-discovery');
    const db = openDb(':memory:');
    const cfg = makeCfg();
    insertLocalAlbum(db, album);
    const gibberishId = insertBespokeAlbum(db, {
      slug: 'gibberish-progress',
      title: 'Xqzzt Plorf',
      artist: 'Nobody Real',
      tracks: [{ title: 'Nope', durationMs: 1234 }],
    });

    const progress: [number, number][] = [];
    await makeMatcher(db, cfg, fixtureFetch()).matchPending((done, total) => progress.push([done, total]));

    expect(progress[0]).toEqual([0, 2]);
    expect(progress[progress.length - 1]).toEqual([2, 2]);
    expect(progress.map(([done]) => done)).toEqual([0, 1, 2]);
    expect(albumRow(db, album.albumId).mb_release_id).toBe(album.targetReleaseId);
    expect(albumRow(db, gibberishId).mb_release_id).toBeNull();
  });

  it('falls back to a track-title search when tags are weak', async () => {
    const album = fixtureAlbum('daft-punk-discovery');
    const db = openDb(':memory:');
    const cfg = makeCfg();
    const id = insertLocalAlbum(db, album, { title: 'Unknown Album' });

    const base = fixtureFetch();
    let recordingSearches = 0;
    const fetchImpl: FetchLike = async (input, init) => {
      if (urlOf(input).includes('/ws/2/recording/')) recordingSearches++;
      return base(input, init);
    };

    await makeMatcher(db, cfg, fetchImpl).matchPending();

    const row = albumRow(db, id);
    expect(recordingSearches).toBeGreaterThan(0);
    expect(row.mb_release_id).toBeTruthy();
    // The exact edition may differ from the fully-tagged match, but it must be
    // the same album (same release group).
    expect(row.mb_release_group_id).toBe(album.targetReleaseGroupId);
    expect(row.match_confidence).toBeGreaterThanOrEqual(0.7);
    expect(loadRelease(row.mb_release_id).title).toBe('Discovery');
  });

  it('returns scored candidates for the manual fix dialog', async () => {
    const album = fixtureAlbum('bill-withers-still-bill');
    const db = openDb(':memory:');
    const cfg = makeCfg();
    insertLocalAlbum(db, album);

    const candidates = await makeMatcher(db, cfg, fixtureFetch()).candidates(album.albumId);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(15);

    const target = candidates.find((c) => c.mbReleaseId === album.targetReleaseId);
    expect(target).toBeDefined();
    expect(target!.title).toBe('Still Bill');
    expect(target!.artist).toContain('Bill Withers');
    expect(target!.tracks).toBe(album.tracks.length);
    expect(target!.score).toBeGreaterThanOrEqual(0.8);
    for (const candidate of candidates) {
      expect(candidate.mbReleaseId).toMatch(/^[0-9a-f-]{36}$/);
      expect(typeof candidate.title).toBe('string');
      expect(typeof candidate.score).toBe('number');
      expect(candidate.score).toBeGreaterThanOrEqual(0);
      expect(candidate.score).toBeLessThanOrEqual(1);
    }
  });

  it('downloads cover art to <dataDir>/covers/<albumId>.jpg with release-group fallback', async () => {
    const album = fixtureAlbum('alice-in-chains-jar-of-flies');
    const db = openDb(':memory:');
    const dataDir = mkdtempSync(join(tmpdir(), 'liner-match-cover-'));
    const cfg = makeCfg(dataDir);
    const id = insertLocalAlbum(db, album);

    const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const base = fixtureFetch();
    const fetchImpl: FetchLike = async (input, init) => {
      const url = urlOf(input);
      if (url.startsWith('https://coverartarchive.org/release-group/')) {
        return new Response(image, { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      if (url.startsWith('https://coverartarchive.org/release/')) {
        return new Response('not found', { status: 404 });
      }
      return base(input, init);
    };

    await makeMatcher(db, cfg, fetchImpl, { downloadCovers: true }).matchPending();

    const row = albumRow(db, id);
    const expectedPath = join(dataDir, 'covers', `${id}.jpg`);
    expect(row.cover_path).toBe(expectedPath);
    expect(readFileSync(expectedPath).equals(image)).toBe(true);
  });
});
