import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Page, Track } from '@liner/shared';
import { openDb } from '../src/db/index.js';
import type { Db } from '../src/db/index.js';
import { registerBrowseRoutes, titleCase, type BrowseTrack, type GenreFacet } from '../src/api/browse.js';

interface AlbumSeed {
  id: string;
  title: string;
  artistId: string;
  year: number | null;
  label: string | null;
  genres: string[];
  format?: string | null;
  cover?: string | null;
  addedAt: number;
}

interface TrackSeed {
  id: string;
  albumId: string;
  title: string;
  disc?: number;
  number: number;
  durationMs: number;
  path: string;
  format?: string | null;
  cueStart?: number | null;
  cueEnd?: number | null;
  artists?: string[];
}

function seed(db: Db, albums: AlbumSeed[], tracks: TrackSeed[]): void {
  const artist = db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)');
  for (const [id, name] of [
    ['ar:1', 'Alpha'],
    ['ar:2', 'Beta'],
    ['ar:3', 'Gamma'],
    ['ar:4', 'Guest'],
  ]) {
    artist.run(id, name);
  }
  const album = db.prepare(
    `INSERT INTO albums (id, source, title, artist_id, year, label, genres, format, cover_path, added_at)
     VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const a of albums) {
    album.run(a.id, a.title, a.artistId, a.year, a.label, JSON.stringify(a.genres), a.format ?? null, a.cover ?? null, a.addedAt);
  }
  const track = db.prepare(
    `INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms, path, cue_start_ms, cue_end_ms, format, sample_rate, bit_depth, bitrate_kbps)
     VALUES (?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, 44100, 16, null)`,
  );
  const credit = db.prepare('INSERT INTO track_artists (track_id, artist_id, position) VALUES (?, ?, ?)');
  for (const t of tracks) {
    track.run(
      t.id,
      t.albumId,
      t.title,
      t.disc ?? 1,
      t.number,
      t.durationMs,
      t.path,
      t.cueStart ?? null,
      t.cueEnd ?? null,
      t.format ?? 'FLAC',
    );
    (t.artists ?? []).forEach((artistId, i) => credit.run(t.id, artistId, i));
  }
}

const ALBUMS: AlbumSeed[] = [
  {
    id: 'la:a1',
    title: 'First Album',
    artistId: 'ar:1',
    year: 1999,
    label: 'Label One',
    genres: ['Rock', 'Alternative'],
    format: 'FLAC 16/44.1',
    cover: '/covers/a1.jpg',
    addedAt: 1000,
  },
  {
    id: 'la:a2',
    title: 'Second Album',
    artistId: 'ar:2',
    year: 2003,
    label: 'label one',
    genres: ['rock', 'pop punk'],
    cover: null,
    addedAt: 2000,
  },
  {
    id: 'la:a3',
    title: 'Third Album',
    artistId: 'ar:1',
    year: 1975,
    label: 'Label Two',
    genres: ['R&B', '', '  '],
    cover: '/covers/a3.jpg',
    addedAt: 3000,
  },
  {
    id: 'la:a4',
    title: 'Fourth Album',
    artistId: 'ar:3',
    year: 2003,
    label: null,
    genres: ['ROCK', 'Pop Punk', 'r&b'],
    cover: '/covers/a4.jpg',
    addedAt: 4000,
  },
  {
    id: 'la:a5',
    title: 'Fifth Album',
    artistId: 'ar:3',
    year: 1979,
    label: 'Label Two',
    genres: ['rock'],
    cover: '/covers/a5.jpg',
    addedAt: 5000,
  },
  {
    id: 'la:a6',
    title: 'Sixth Album',
    artistId: 'ar:2',
    year: 1980,
    label: 'Label One',
    genres: ['rock'],
    cover: '/covers/a6.jpg',
    addedAt: 6000,
  },
];

const TRACKS: TrackSeed[] = [
  { id: 'l:t1', albumId: 'la:a1', title: 'Alpha Song', number: 1, durationMs: 100_000, path: '/music/secret/alpha.flac', artists: ['ar:1'] },
  { id: 'l:t2', albumId: 'la:a1', title: 'Zeta Song', number: 2, durationMs: 300_000, path: '/music/secret/zeta.flac', artists: ['ar:4'] },
  { id: 'l:t3', albumId: 'la:a2', title: 'Beta Song', number: 1, durationMs: 200_000, path: '/music/secret/beta.flac' },
  { id: 'l:t4', albumId: 'la:a3', title: 'Cue Song', number: 1, durationMs: 0, path: '/music/secret/cue.flac', cueStart: 10_000, cueEnd: 70_000, artists: ['ar:1'] },
  { id: 'l:t5', albumId: 'la:a4', title: 'Fourth Song', number: 1, durationMs: 250_000, path: '/music/secret/fourth.flac', artists: ['ar:3'] },
  { id: 'l:t6', albumId: 'la:a5', title: 'Fifth Song', number: 1, durationMs: 400_000, path: '/music/secret/fifth.flac', artists: ['ar:3'] },
  { id: 'l:t7', albumId: 'la:a6', title: 'Sixth Song', number: 1, durationMs: 150_000, path: '/music/secret/sixth.flac', artists: ['ar:2'] },
];

function seededDb(): Db {
  const db = openDb(':memory:');
  seed(db, ALBUMS, TRACKS);
  return db;
}

const apps: FastifyInstance[] = [];
async function makeApp(db: Db): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerBrowseRoutes(app, db);
  await app.ready();
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function getJson<T>(app: FastifyInstance, url: string): Promise<T> {
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode, `${url} → ${res.body}`).toBe(200);
  return res.json() as T;
}

async function tracks(app: FastifyInstance, qs: string): Promise<Page<BrowseTrack>> {
  return getJson(app, `/tracks${qs ? `?${qs}` : ''}`);
}

describe('GET /tracks', () => {
  it('returns a Page of tracks with album info and no file paths', async () => {
    const app = await makeApp(seededDb());
    const res = await app.inject({ method: 'GET', url: '/tracks?sort=title&limit=2' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Page<BrowseTrack>;
    expect(body.total).toBe(7);
    expect(body.items).toHaveLength(2);
    const first = body.items[0]!;
    expect(first.title).toBe('Alpha Song');
    expect(first.album).toEqual({ id: 'la:a1', title: 'First Album', coverUrl: '/api/cover/la%3Aa1?size=600' });
    expect(first.artists).toEqual([{ id: 'ar:1', name: 'Alpha' }]);
    expect(first.disc).toBe(1);
    expect(first.number).toBe(1);
    expect(first.durationMs).toBe(100_000);
    expect(first.format).toBe('flac');
    expect(first.sampleRate).toBe(44100);
    expect(first.albumId).toBe('la:a1');
    // never send the local path
    expect(first).not.toHaveProperty('path');
    expect(JSON.stringify(body)).not.toContain('/music/secret');
  });

  it('omits coverUrl for albums without artwork and falls back to the album artist', async () => {
    const app = await makeApp(seededDb());
    const body = await tracks(app, 'q=Second');
    expect(body.total).toBe(1);
    const t = body.items[0]!;
    expect(t.id).toBe('l:t3');
    expect(t.album).toEqual({ id: 'la:a2', title: 'Second Album' });
    expect(t.artists).toEqual([{ id: 'ar:2', name: 'Beta' }]);
  });

  it('sorts by title', async () => {
    const app = await makeApp(seededDb());
    const asc = await tracks(app, 'sort=title&dir=asc');
    expect(asc.items.map((t) => t.id)).toEqual(['l:t1', 'l:t3', 'l:t4', 'l:t6', 'l:t5', 'l:t7', 'l:t2']);
    const desc = await tracks(app, 'sort=title&dir=desc');
    expect(desc.items.map((t) => t.id)).toEqual(['l:t2', 'l:t7', 'l:t5', 'l:t6', 'l:t4', 'l:t3', 'l:t1']);
  });

  it('sorts by primary track artist, then album title', async () => {
    const app = await makeApp(seededDb());
    const body = await tracks(app, 'sort=artist');
    // Alpha (t1, t4) → Beta (t3, t7) → Gamma (t6, t5) → Guest (t2)
    expect(body.items.map((t) => t.id)).toEqual(['l:t1', 'l:t4', 'l:t3', 'l:t7', 'l:t6', 'l:t5', 'l:t2']);
  });

  it('sorts by album, added date and duration', async () => {
    const app = await makeApp(seededDb());
    const byAlbum = await tracks(app, 'sort=album');
    expect(byAlbum.items.map((t) => t.id)).toEqual(['l:t6', 'l:t1', 'l:t2', 'l:t5', 'l:t3', 'l:t7', 'l:t4']);

    const byAdded = await tracks(app, 'sort=added');
    expect(byAdded.items.map((t) => t.id)).toEqual(['l:t7', 'l:t6', 'l:t5', 'l:t4', 'l:t3', 'l:t1', 'l:t2']);

    const byDuration = await tracks(app, 'sort=duration');
    expect(byDuration.items.map((t) => t.id)).toEqual(['l:t4', 'l:t1', 'l:t7', 'l:t3', 'l:t5', 'l:t2', 'l:t6']);
  });

  it('computes cue-track duration from its cue window', async () => {
    const app = await makeApp(seededDb());
    const body = await tracks(app, 'q=cue');
    const t = body.items[0]!;
    expect(t.durationMs).toBe(60_000);
    expect(t.cue).toEqual({ startMs: 10_000, endMs: 70_000 });
  });

  it('matches q against title, album title and credited artists', async () => {
    const app = await makeApp(seededDb());
    expect((await tracks(app, 'q=zeta')).items.map((t) => t.id)).toEqual(['l:t2']);
    expect((await tracks(app, 'q=Second')).items.map((t) => t.id)).toEqual(['l:t3']);
    // "Guest" is only credited on the track, not the album
    expect((await tracks(app, 'q=Guest')).items.map((t) => t.id)).toEqual(['l:t2']);
    expect((await tracks(app, 'q=%25')).total).toBe(0); // % is literal, not a wildcard
    // repeated keys must not crash (Fastify hands them over as an array)
    expect((await tracks(app, 'q=zeta&q=other')).items.map((t) => t.id)).toEqual(['l:t2']);
  });

  it('paginates with offset/limit and keeps the unpaged total', async () => {
    const app = await makeApp(seededDb());
    const body = await tracks(app, 'sort=title&limit=3&offset=1');
    expect(body.total).toBe(7);
    expect(body.items.map((t) => t.id)).toEqual(['l:t3', 'l:t4', 'l:t6']);
  });

  it('ignores unknown sort values and clamps limits', async () => {
    const app = await makeApp(seededDb());
    const body = await tracks(app, 'sort=nope&dir=sideways&limit=0');
    expect(body.items[0]!.title).toBe('Alpha Song');
    expect(body.items).toHaveLength(1);
  });

  it('hides albums with in_library = 0 when that column exists', async () => {
    const db = openDb(':memory:');
    db.exec('ALTER TABLE albums ADD COLUMN in_library INTEGER NOT NULL DEFAULT 1');
    seed(db, ALBUMS, TRACKS);
    db.exec("UPDATE albums SET in_library = 0 WHERE id IN ('la:a2', 'la:a5')");
    const app = await makeApp(db);

    const body = await tracks(app, 'sort=title');
    expect(body.total).toBe(5);
    expect(body.items.map((t) => t.id)).toEqual(['l:t1', 'l:t4', 'l:t5', 'l:t7', 'l:t2']);

    const genres = await getJson<GenreFacet[]>(app, '/genres');
    expect(genres.find((g) => g.genre === 'Rock')!.albumCount).toBe(3); // a1, a4, a6
    const rock = await getJson<Page<{ id: string }>>(app, '/genres/rock/albums');
    expect(rock.total).toBe(3);
    expect(rock.items.map((a) => a.id).sort()).toEqual(['la:a1', 'la:a4', 'la:a6']);

    const labels = await getJson<{ label: string; albumCount: number }[]>(app, '/labels');
    expect(labels).toEqual([
      { label: 'Label One', albumCount: 2 },
      { label: 'Label Two', albumCount: 1 },
    ]);
    const years = await getJson<{ year: number }[]>(app, '/years');
    expect(years.map((y) => y.year)).toEqual([2003, 1999, 1980, 1975]);
  });
});

describe('GET /genres', () => {
  it('merges genres case-insensitively, title-cases them and ignores empty values', async () => {
    const app = await makeApp(seededDb());
    const genres = await getJson<GenreFacet[]>(app, '/genres');
    expect(genres).toEqual([
      { genre: 'Rock', albumCount: 5, coverAlbumIds: ['la:a6', 'la:a5', 'la:a4', 'la:a1'] },
      { genre: 'Pop Punk', albumCount: 2, coverAlbumIds: ['la:a4'] },
      { genre: 'R&B', albumCount: 2, coverAlbumIds: ['la:a4', 'la:a3'] },
      { genre: 'Alternative', albumCount: 1, coverAlbumIds: ['la:a1'] },
    ]);
    expect(genres.some((g) => g.genre.trim() === '')).toBe(false);
  });

  it('title-cases words, slashes, hyphens and ampersands', () => {
    expect(titleCase('pop punk')).toBe('Pop Punk');
    expect(titleCase('r&b')).toBe('R&B');
    expect(titleCase('alternative/indie pop')).toBe('Alternative/Indie Pop');
    expect(titleCase('singer-songwriter')).toBe('Singer-Songwriter');
    expect(titleCase('IDM')).toBe('IDM');
  });
});

describe('GET /genres/:genre/albums', () => {
  it('returns a Page<AlbumSummary> for the genre, case-insensitively', async () => {
    const app = await makeApp(seededDb());
    const body = await getJson<Page<Record<string, unknown>>>(app, '/genres/rock/albums');
    expect(body.total).toBe(5);
    expect(body.items).toHaveLength(5);
    expect(body.items.map((a) => a.id).sort()).toEqual(['la:a1', 'la:a2', 'la:a4', 'la:a5', 'la:a6']);
    const first = body.items[0] as {
      artist: { id: string; name: string };
      source: string;
      coverUrl?: string;
      addedAt: number;
    };
    expect(first.artist).toEqual({ id: 'ar:1', name: 'Alpha' });
    expect(first.source).toBe('local');
    expect(first.coverUrl).toBe('/api/cover/la%3Aa1?size=600');
    expect(first.addedAt).toBe(1000);
    // album summaries never carry folder paths either
    expect(JSON.stringify(body)).not.toContain('/music/secret');

    const upper = await getJson<Page<{ id: string }>>(app, '/genres/ROCK/albums');
    expect(upper.total).toBe(5);

    const enc = await getJson<Page<{ id: string }>>(app, '/genres/R%26B/albums');
    expect(enc.total).toBe(2);
    expect(enc.items.map((a) => a.id)).toEqual(['la:a3', 'la:a4']);
  });

  it('supports pagination and unknown genres', async () => {
    const app = await makeApp(seededDb());
    const page = await getJson<Page<{ id: string }>>(app, '/genres/rock/albums?sort=title&limit=2&offset=0');
    expect(page.total).toBe(5);
    // title asc: Fifth Album (a5), First Album (a1) …
    expect(page.items.map((a) => a.id)).toEqual(['la:a5', 'la:a1']);

    const none = await getJson<Page<{ id: string }>>(app, '/genres/nonexistent/albums');
    expect(none).toEqual({ items: [], total: 0 });
  });
});

describe('GET /labels and GET /years', () => {
  it('merges labels case-insensitively and counts albums', async () => {
    const app = await makeApp(seededDb());
    const labels = await getJson<{ label: string; albumCount: number }[]>(app, '/labels');
    expect(labels).toEqual([
      { label: 'Label One', albumCount: 3 },
      { label: 'Label Two', albumCount: 2 },
    ]);
  });

  it('groups years with album counts, newest first, with a decade field', async () => {
    const app = await makeApp(seededDb());
    const years = await getJson<{ year: number; albumCount: number; decade: number }[]>(app, '/years');
    expect(years).toEqual([
      { year: 2003, albumCount: 2, decade: 2000 },
      { year: 1999, albumCount: 1, decade: 1990 },
      { year: 1980, albumCount: 1, decade: 1980 },
      { year: 1979, albumCount: 1, decade: 1970 },
      { year: 1975, albumCount: 1, decade: 1970 },
    ]);
  });
});
