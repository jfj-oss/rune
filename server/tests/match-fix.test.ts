// Regressions for real-library albums the pre-matchfix matcher could not match.
//
// The fixtures were recorded from a copy of the real library DB with
// scripts/record-mb-fix.ts (the only place network is allowed). Replay is fully
// offline: every MusicBrainz URL is served from server/tests/fixtures/mb-fix.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/index.js';
import type { Config } from '../src/config.js';
import { createMatcher, type MatchOptions } from '../src/match/index.js';
import type { FetchLike } from '../src/match/mb.js';
import {
  FIX_FIXTURES_DIR,
  fixtureAlbum,
  fixtureFetch,
  insertLocalAlbum,
  loadFixtureAlbums,
  loadRelease,
  urlOf,
} from './support/fixtures.js';

function makeCfg(dataDir = mkdtempSync(join(tmpdir(), 'liner-match-fix-test-'))): Config {
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

function mappedTracks(db: Db, albumId: string): number {
  return count(db, 'SELECT count(*) AS c FROM tracks WHERE album_id = ? AND mb_recording_id IS NOT NULL', albumId);
}

const realAlbums = loadFixtureAlbums(FIX_FIXTURES_DIR);

describe('real-library fixture replay (offline)', () => {
  for (const album of realAlbums) {
    it(`matches ${album.artist} — ${album.title} to the MusicBrainz release`, async () => {
      const db = openDb(':memory:');
      const id = insertLocalAlbum(db, album);
      expect(id).toBe(album.albumId);

      await makeMatcher(db, makeCfg(), fixtureFetch(FIX_FIXTURES_DIR)).matchPending();

      const row = albumRow(db, id);
      expect(row.mb_release_id).toBe(album.targetReleaseId);
      expect(row.mb_release_group_id).toBe(album.targetReleaseGroupId);
      expect(row.match_confidence).toBeGreaterThanOrEqual(0.8);
      // Requirement: the canonical MusicBrainz title replaces the folder tag
      // ("City To City ( GZS-1075 )" → "City to City", "…CD1" → the album title).
      expect(row.title).toBe(album.targetTitle);
      expect(row.title).not.toBe(album.title);
      expect(loadRelease(row.mb_release_id, FIX_FIXTURES_DIR).title).toBe(album.targetTitle);

      // Every local track is mapped to a recording of the chosen release; a
      // one-disc subset of a multi-disc release still maps all its tracks.
      expect(mappedTracks(db, id)).toBe(album.tracks.length);

      const fts = db
        .prepare("SELECT text FROM search_fts WHERE kind = 'album' AND ref_id = ?")
        .get(id) as { text: string } | undefined;
      expect(fts?.text).toContain(album.targetTitle);

      expect(db.pragma('foreign_key_check')).toEqual([]);
      db.close();
    });
  }

  it('records at least six previously-failing real albums', () => {
    expect(realAlbums.length).toBeGreaterThanOrEqual(6);
    for (const album of realAlbums) {
      expect(album.targetReleaseId).toMatch(/^[0-9a-f-]{36}$/);
      expect(album.tracks.length).toBeGreaterThan(0);
    }
  });
});

describe('rematchWeak', () => {
  it('matches albums left unmatched by the old matcher', async () => {
    const album = fixtureAlbum('daft-punk-homework-25', FIX_FIXTURES_DIR);
    const db = openDb(':memory:');
    insertLocalAlbum(db, album);

    const stats = await makeMatcher(db, makeCfg(), fixtureFetch(FIX_FIXTURES_DIR)).rematchWeak(0.8);

    expect(stats).toEqual({ attempted: 1, matched: 1, improved: 0, remaining: 0 });
    const row = albumRow(db, album.albumId);
    expect(row.mb_release_id).toBe(album.targetReleaseId);
    expect(row.match_confidence).toBeGreaterThanOrEqual(0.8);
    expect(row.title).toBe('Homework');
    db.close();
  });

  it('improves a weak match but never lowers a confident one', async () => {
    const weak = fixtureAlbum('gerry-rafferty-city-to-city', FIX_FIXTURES_DIR);
    const strong = fixtureAlbum('sting-ten-summoners-tales', FIX_FIXTURES_DIR);
    const db = openDb(':memory:');
    insertLocalAlbum(db, weak);
    insertLocalAlbum(db, strong);
    // Pretend both were matched before, at 0.65 (weak) and 0.95 (confident).
    db.prepare('UPDATE albums SET mb_release_id = ?, match_confidence = 0.65 WHERE id = ?').run(
      weak.targetReleaseId,
      weak.albumId,
    );
    db.prepare('UPDATE albums SET mb_release_id = ?, match_confidence = 0.95 WHERE id = ?').run(
      strong.targetReleaseId,
      strong.albumId,
    );

    const matcher = makeMatcher(db, makeCfg(), fixtureFetch(FIX_FIXTURES_DIR));
    const stats = await matcher.rematchWeak(0.8);
    // The 0.95 album is above the threshold and is not touched at all.
    expect(stats).toEqual({ attempted: 1, matched: 0, improved: 1, remaining: 0 });
    expect(albumRow(db, weak.albumId).match_confidence).toBeGreaterThan(0.65);
    expect(albumRow(db, strong.albumId).match_confidence).toBe(0.95);

    // Force the confident album through a stricter threshold: the re-match
    // scores lower than the stored confidence, so nothing is written.
    const forced = await matcher.rematchWeak(0.99);
    expect(forced.attempted).toBe(2);
    expect(forced.improved).toBe(0);
    expect(albumRow(db, strong.albumId).match_confidence).toBe(0.95);
    expect(albumRow(db, strong.albumId).mb_release_id).toBe(strong.targetReleaseId);
    expect(albumRow(db, weak.albumId).mb_release_id).toBe(weak.targetReleaseId);
    db.close();
  });

  it('never touches locked albums', async () => {
    const album = fixtureAlbum('beatles-hard-days-night', FIX_FIXTURES_DIR);
    const db = openDb(':memory:');
    insertLocalAlbum(db, album, { locked: true });

    const stats = await makeMatcher(db, makeCfg(), fixtureFetch(FIX_FIXTURES_DIR)).rematchWeak(0.8);

    expect(stats).toEqual({ attempted: 0, matched: 0, improved: 0, remaining: 0 });
    const row = albumRow(db, album.albumId);
    expect(row.mb_release_id).toBeNull();
    expect(row.match_confidence).toBeNull();
    expect(row.match_locked).toBe(1);
    db.close();
  });

  it('reuses the HTTP cache, so a second pass makes no network requests', async () => {
    const album = fixtureAlbum('abba-voulez-vous', FIX_FIXTURES_DIR);
    const db = openDb(':memory:');
    insertLocalAlbum(db, album);

    let calls = 0;
    const base = fixtureFetch(FIX_FIXTURES_DIR);
    const countingFetch: FetchLike = async (input, init) => {
      calls++;
      return base(input, init);
    };
    const matcher = makeMatcher(db, makeCfg(), countingFetch);

    await matcher.matchPending();
    expect(calls).toBeGreaterThan(0);
    calls = 0;

    // Requeue the album at a weak confidence, keeping the *original* tag title
    // (applying the MB title changes the search variants, which would hide the
    // cache behind different URLs). The identical queries must be served
    // entirely from http_cache (30-day TTL).
    db.prepare('UPDATE albums SET title = ?, match_confidence = 0.5 WHERE id = ?').run(album.title, album.albumId);
    const stats = await matcher.rematchWeak(0.8);

    expect(stats).toEqual({ attempted: 1, matched: 0, improved: 1, remaining: 0 });
    expect(calls).toBe(0);
    expect(albumRow(db, album.albumId).mb_release_id).toBe(album.targetReleaseId);
    expect(albumRow(db, album.albumId).title).toBe(album.targetTitle);
    db.close();
  });

  it('honours limit and maxMs for resumable passes', async () => {
    const first = fixtureAlbum('beatles-white-album-cd1', FIX_FIXTURES_DIR);
    const second = fixtureAlbum('chemical-brothers-born-in-the-echoes', FIX_FIXTURES_DIR);
    const db = openDb(':memory:');
    insertLocalAlbum(db, first);
    insertLocalAlbum(db, second);

    const matcher = makeMatcher(db, makeCfg(), fixtureFetch(FIX_FIXTURES_DIR));

    const limited = await matcher.rematchWeak(0.8, { limit: 1 });
    expect(limited.attempted).toBe(1);
    expect(limited.remaining).toBe(1);
    const matchedAfterFirst = count(db, 'SELECT count(*) AS c FROM albums WHERE mb_release_id IS NOT NULL');
    expect(matchedAfterFirst).toBe(1);

    const timed = await matcher.rematchWeak(0.8, { maxMs: 0 });
    expect(timed.attempted).toBe(0);
    expect(timed.remaining).toBe(1);

    const rest = await matcher.rematchWeak(0.8);
    expect(rest.attempted).toBe(1);
    expect(rest.remaining).toBe(0);
    expect(count(db, 'SELECT count(*) AS c FROM albums WHERE mb_release_id IS NOT NULL')).toBe(2);
    db.close();
  });

  it('is reached entirely offline (unrecorded URLs never leak to the network)', async () => {
    const album = fixtureAlbum('sakamoto-love-is-the-devil', FIX_FIXTURES_DIR);
    const db = openDb(':memory:');
    insertLocalAlbum(db, album);

    const base = fixtureFetch(FIX_FIXTURES_DIR);
    const seen: string[] = [];
    const assertingFetch: FetchLike = async (input, init) => {
      const url = urlOf(input);
      seen.push(url);
      if (url.startsWith('https://coverartarchive.org/')) return new Response('no cover', { status: 404 });
      return base(input, init);
    };

    await makeMatcher(db, makeCfg(), assertingFetch).matchPending();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((url) => url.startsWith('https://musicbrainz.org/'))).toBe(true);
    expect(albumRow(db, album.albumId).mb_release_id).toBe(album.targetReleaseId);
    db.close();
  });
});
