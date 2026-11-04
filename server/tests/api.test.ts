// Integration tests for the main HTTP API layer (src/api/server.ts + src/api/library.ts).
//
// Everything runs offline: no Spotify client id in the config (so no Spotify
// module / network) and scanOnStart + pcZone are disabled. The database is an
// in-memory SQLite DB seeded with realistic local (including a cue album) and
// Spotify rows; covers are real tiny images generated into a temp dataDir.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Album, AlbumSummary, Artist, ArtistRef, Page, ServerEvent, Track } from '@liner/shared';
import { buildApp } from '../src/api/server.js';
import { ids, openDb, type Db } from '../src/db/index.js';
import { ensureSpotifyLibrarySchema } from '../src/spotify/library-schema.js';
import type { Config } from '../src/config.js';

// Fastify logs would drown the test output.
process.env.LOG_LEVEL = 'silent';

// ---------------------------------------------------------------- ids

const OYSTER_ARTIST = 'ar:' + '11111111-1111-1111-1111-111111111111';
const LOCAL_ARTIST = ids.artistByName('Local Band');
const GUEST_ARTIST = ids.artistByName('Guest Vocalist');
const SPOTIFY_ARTIST = ids.artistByName('Spotify Artist');

// Fake library paths. Using the real library root prefix makes the "no path leak"
// assertions meaningful: any track path in a response contains "/mnt/".
const LIB = '/mnt/BIG data/Music';
const CUE_FILE = `${LIB}/Cue Album/album.flac`;
const CUE_ALBUM = ids.localAlbum(`${LIB}/Cue Album`);
const MATCHED_ALBUM = ids.localAlbum(`${LIB}/Matched Album`);
const UNMATCHED_ALBUM = ids.localAlbum(`${LIB}/Unmatched One`);
const ZEBRA_ALBUM = ids.localAlbum(`${LIB}/Zebra Tapes`);
const SPOTIFY_SAVED = 'sp:albumSaved';
const SPOTIFY_HIDDEN = 'sp:albumHidden';

const MATCHED_D1N1 = ids.localTrack(`${LIB}/Matched Album/d1-01.flac`);
const MATCHED_D1N2 = ids.localTrack(`${LIB}/Matched Album/d1-02.flac`);
const MATCHED_D2N1 = ids.localTrack(`${LIB}/Matched Album/d2-01.flac`);
const UNMATCHED_TRACK = ids.localTrack(`${LIB}/Unmatched One/one.flac`);
const ZEBRA_TRACK = ids.localTrack(`${LIB}/Zebra Tapes/zebra.mp3`);
const SPOTIFY_TRACK = 'sp:trackSaved';
const SPOTIFY_HIDDEN_TRACK = 'sp:trackHidden';
const CUE_TRACKS = [1, 2, 3].map((n) => ids.localTrack(CUE_FILE, n));
const CUE_T1 = CUE_TRACKS[0]!;
const CUE_T2 = CUE_TRACKS[1]!;
const CUE_T3 = CUE_TRACKS[2]!;

// ---------------------------------------------------------------- seed

interface SeedPaths {
  coverFile: string;
}

function seed(db: Db, paths: SeedPaths): void {
  // The Spotify-library migration adds albums.in_library and playlists tables.
  ensureSpotifyLibrarySchema(db);

  const artist = db.prepare(
    'INSERT INTO artists (id, name, sort_name, mbid, image_path) VALUES (?, ?, NULL, ?, NULL)',
  );
  artist.run(OYSTER_ARTIST, 'The Öyster Cult', '11111111-1111-1111-1111-111111111111');
  artist.run(LOCAL_ARTIST, 'Local Band', null);
  artist.run(GUEST_ARTIST, 'Guest Vocalist', null);
  artist.run(SPOTIFY_ARTIST, 'Spotify Artist', null);

  const album = db.prepare(
    `INSERT INTO albums
       (id, source, title, artist_id, year, release_date, label, genres, format,
        folder_path, cover_path, mb_release_id, match_confidence, added_at, in_library)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
  );
  album.run(
    CUE_ALBUM, 'local', 'Öyster Sessions', OYSTER_ARTIST, 1975, null, 'Blue Note',
    JSON.stringify(['Jazz', 'Fusion']), 'FLAC 16/44.1', paths.coverFile, null, null, 1000, 1,
  );
  album.run(
    MATCHED_ALBUM, 'local', 'Matched Album', OYSTER_ARTIST, 1980, '1980-05-01', 'ECM',
    JSON.stringify(['Ambient']), 'FLAC 24/96', paths.coverFile,
    '22222222-2222-4222-8222-222222222222', 0.95, 2000, 1,
  );
  album.run(
    UNMATCHED_ALBUM, 'local', 'Unmatched One', LOCAL_ARTIST, 1999, null, 'blue note',
    JSON.stringify(['Rock']), 'MP3 320', null, null, null, 3000, 1,
  );
  album.run(
    ZEBRA_ALBUM, 'local', 'Zebra Tapes', LOCAL_ARTIST, 2003, null, 'ECM',
    JSON.stringify(['Rock', 'Pop']), 'MP3 320', null, null, null, 500, 1,
  );
  album.run(
    SPOTIFY_SAVED, 'spotify', 'Spotify Saved', SPOTIFY_ARTIST, 2020, null, null,
    JSON.stringify(['Pop']), 'Spotify', null, null, null, 4000, 1,
  );
  album.run(
    SPOTIFY_HIDDEN, 'spotify', 'Spotify Hidden', SPOTIFY_ARTIST, 2021, null, null,
    JSON.stringify(['Pop']), 'Spotify', null, null, null, 5000, 0,
  );

  const track = db.prepare(
    `INSERT INTO tracks
       (id, album_id, source, title, disc, number, duration_ms, path,
        cue_start_ms, cue_end_ms, format, sample_rate, bit_depth, bitrate_kbps, spotify_uri)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const local = (
    id: string,
    albumId: string,
    title: string,
    disc: number,
    number: number,
    path: string,
    extra: {
      durationMs?: number;
      cueStart?: number;
      cueEnd?: number;
      format?: string;
      sampleRate?: number;
      bitDepth?: number;
      bitrateKbps?: number;
    } = {},
  ) =>
    track.run(
      id, albumId, 'local', title, disc, number, extra.durationMs ?? 200_000, path,
      extra.cueStart ?? null, extra.cueEnd ?? null, extra.format ?? 'FLAC',
      extra.sampleRate ?? 44_100, extra.bitDepth ?? 16, extra.bitrateKbps ?? null, null,
    );

  // Cue album: three tracks inside one big file.
  local(CUE_T1, CUE_ALBUM, 'Öyster Part 1', 1, 1, CUE_FILE, { durationMs: 0, cueStart: 0, cueEnd: 180_000 });
  local(CUE_T2, CUE_ALBUM, 'Öyster Part 2', 1, 2, CUE_FILE, { durationMs: 0, cueStart: 180_000, cueEnd: 300_000 });
  local(CUE_T3, CUE_ALBUM, 'Second Wind', 1, 3, CUE_FILE, { durationMs: 0, cueStart: 300_000, cueEnd: 400_000 });

  // Insert out of order: getAlbum must sort by disc/number, not insertion order.
  local(MATCHED_D2N1, MATCHED_ALBUM, 'Matched Disc Two', 2, 1, `${LIB}/Matched Album/d2-01.flac`, { format: 'FLAC 24/96', bitDepth: 24 });
  local(MATCHED_D1N2, MATCHED_ALBUM, 'Matched Second', 1, 2, `${LIB}/Matched Album/d1-02.flac`);
  local(MATCHED_D1N1, MATCHED_ALBUM, 'Matched First', 1, 1, `${LIB}/Matched Album/d1-01.flac`);

  local(UNMATCHED_TRACK, UNMATCHED_ALBUM, 'Unmatched Song', 1, 1, `${LIB}/Unmatched One/one.flac`, {
    format: 'MP3',
    bitrateKbps: 320,
  });
  local(ZEBRA_TRACK, ZEBRA_ALBUM, 'Zebra Song', 1, 1, `${LIB}/Zebra Tapes/zebra.mp3`, {
    format: 'MP3',
    bitrateKbps: 320,
  });
  track.run(SPOTIFY_TRACK, SPOTIFY_SAVED, 'spotify', 'Spotify Song', 1, 1, 180_000, null, null, null, null, null, null, null, 'spotify:track:saved');
  track.run(SPOTIFY_HIDDEN_TRACK, SPOTIFY_HIDDEN, 'spotify', 'Hidden Song', 1, 1, 180_000, null, null, null, null, null, null, null, 'spotify:track:hidden');

  const trackArtist = db.prepare('INSERT INTO track_artists (track_id, artist_id, position) VALUES (?, ?, ?)');
  trackArtist.run(MATCHED_D1N1, OYSTER_ARTIST, 0);
  trackArtist.run(MATCHED_D1N1, GUEST_ARTIST, 1);
  trackArtist.run(UNMATCHED_TRACK, GUEST_ARTIST, 0);

  const credit = db.prepare('INSERT INTO credits (album_id, artist_id, role, track_ids) VALUES (?, ?, ?, ?)');
  credit.run(MATCHED_ALBUM, OYSTER_ARTIST, 'Producer', null);
  credit.run(MATCHED_ALBUM, GUEST_ARTIST, 'Lead Vocals', JSON.stringify([MATCHED_D1N1]));
  credit.run(MATCHED_ALBUM, LOCAL_ARTIST, 'Engineer', null);

  // search_fts exactly as the scanner populates it: one row per album/track/artist.
  const fts = db.prepare('INSERT INTO search_fts (kind, ref_id, text) VALUES (?, ?, ?)');
  for (const [id, title, artistId] of [
    [CUE_ALBUM, 'Öyster Sessions', OYSTER_ARTIST],
    [MATCHED_ALBUM, 'Matched Album', OYSTER_ARTIST],
    [UNMATCHED_ALBUM, 'Unmatched One', LOCAL_ARTIST],
    [ZEBRA_ALBUM, 'Zebra Tapes', LOCAL_ARTIST],
    [SPOTIFY_SAVED, 'Spotify Saved', SPOTIFY_ARTIST],
  ] as const) {
    fts.run('album', id, `${title} ${artistName(db, artistId)}`);
  }
  for (const [id, title, artistText] of [
    [CUE_T1, 'Öyster Part 1', 'The Öyster Cult'],
    [CUE_T2, 'Öyster Part 2', 'The Öyster Cult'],
    [CUE_T3, 'Second Wind', 'The Öyster Cult'],
    [MATCHED_D1N1, 'Matched First', 'The Öyster Cult Guest Vocalist'],
    [MATCHED_D1N2, 'Matched Second', 'The Öyster Cult'],
    [MATCHED_D2N1, 'Matched Disc Two', 'The Öyster Cult'],
    [UNMATCHED_TRACK, 'Unmatched Song', 'Guest Vocalist'],
    [ZEBRA_TRACK, 'Zebra Song', 'Local Band'],
    [SPOTIFY_TRACK, 'Spotify Song', 'Spotify Artist'],
  ] as const) {
    fts.run('track', id, `${title} ${artistText}`);
  }
  for (const [id, name] of [
    [OYSTER_ARTIST, 'The Öyster Cult'],
    [LOCAL_ARTIST, 'Local Band'],
    [GUEST_ARTIST, 'Guest Vocalist'],
    [SPOTIFY_ARTIST, 'Spotify Artist'],
  ] as const) {
    fts.run('artist', id, name);
  }

}

function artistName(db: Db, id: string): string {
  const row = db.prepare('SELECT name FROM artists WHERE id = ?').get(id) as { name: string } | undefined;
  return row?.name ?? '';
}

// ---------------------------------------------------------------- harness

let root: string;
let dataDir: string;
let coverFile: string;
let db: Db;
let app: FastifyInstance;
let closeApp: () => Promise<void>;
let libraryDir: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'liner-api-test-'));
  dataDir = join(root, 'data');
  libraryDir = join(root, 'library');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(libraryDir, { recursive: true });
  const coverDir = join(dataDir, 'covers');
  mkdirSync(coverDir, { recursive: true });
  coverFile = join(coverDir, 'cover.png');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', coverFile]);

  db = openDb(':memory:');
  seed(db, { coverFile });

  const cfg: Config = {
    libraryRoots: [libraryDir],
    dataDir,
    port: 0,
    audioDevice: 'pipewire',
    userAgent: 'Liner test',
    // No spotifyClientId: the Spotify module (and any network calls) stays off.
  };
  const built = await buildApp(db, cfg, {
    pcZone: false,
    scanOnStart: false,
    webDist: join(root, 'no-web-dist'),
  });
  app = built.app;
  closeApp = built.close;
});

afterAll(async () => {
  await closeApp?.();
  db?.close();
  rmSync(root, { recursive: true, force: true });
});

async function getJson<T>(url: string): Promise<T> {
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode, `${url} → ${res.body}`).toBe(200);
  return res.json() as T;
}

function albumIds(page: Page<AlbumSummary>): string[] {
  return page.items.map((a) => a.id);
}

function coverUrlFor(id: string): string {
  return `/api/cover/${encodeURIComponent(id)}?size=600`;
}

// ---------------------------------------------------------------- /library/albums

describe('GET /api/library/albums', () => {
  it('lists in-library albums newest-first, hiding in_library = 0', async () => {
    const page = await getJson<Page<AlbumSummary>>('/api/library/albums');
    expect(page.total).toBe(5);
    expect(albumIds(page)).toEqual([SPOTIFY_SAVED, UNMATCHED_ALBUM, MATCHED_ALBUM, CUE_ALBUM, ZEBRA_ALBUM]);
    const cue = page.items.find((a) => a.id === CUE_ALBUM)!;
    expect(cue).toEqual({
      id: CUE_ALBUM,
      source: 'local',
      title: 'Öyster Sessions',
      artist: { id: OYSTER_ARTIST, name: 'The Öyster Cult' },
      year: 1975,
      coverUrl: coverUrlFor(CUE_ALBUM),
      format: 'FLAC 16/44.1',
      addedAt: 1000,
    });
    expect(JSON.stringify(page)).not.toContain(root);
    expect(JSON.stringify(page)).not.toContain('/mnt/');
  });

  it('filters by source, genre, label and year (case-insensitive genre/label)', async () => {
    const local = await getJson<Page<AlbumSummary>>('/api/library/albums?source=local');
    expect(local.total).toBe(4);
    expect(new Set(local.items.map((a) => a.source))).toEqual(new Set(['local']));

    const spotify = await getJson<Page<AlbumSummary>>('/api/library/albums?source=spotify');
    expect(spotify.total).toBe(1);
    expect(albumIds(spotify)).toEqual([SPOTIFY_SAVED]);

    const jazz = await getJson<Page<AlbumSummary>>('/api/library/albums?genre=JAZZ');
    expect(albumIds(jazz)).toEqual([CUE_ALBUM]);

    const rock = await getJson<Page<AlbumSummary>>('/api/library/albums?genre=rock');
    expect(albumIds(rock)).toEqual([UNMATCHED_ALBUM, ZEBRA_ALBUM]);

    expect((await getJson<Page<AlbumSummary>>('/api/library/albums?genre=nope')).total).toBe(0);

    const label = await getJson<Page<AlbumSummary>>('/api/library/albums?label=BLUE%20NOTE');
    expect(albumIds(label)).toEqual([UNMATCHED_ALBUM, CUE_ALBUM]);

    const year = await getJson<Page<AlbumSummary>>('/api/library/albums?year=2003');
    expect(albumIds(year)).toEqual([ZEBRA_ALBUM]);
    expect((await getJson<Page<AlbumSummary>>('/api/library/albums?year=1234')).total).toBe(0);
  });

  it('batches summaries for ?ids= in the caller order, skipping unknown ids', async () => {
    const want = [ZEBRA_ALBUM, SPOTIFY_SAVED, UNMATCHED_ALBUM, 'la:does-not-exist', ZEBRA_ALBUM];
    const url = `/api/library/albums?ids=${want.map((id) => encodeURIComponent(id)).join(',')}`;
    const body = await getJson<{ items: AlbumSummary[]; total: number }>(url);
    expect(body.total).toBe(4);
    expect(body.items.map((a) => a.id)).toEqual([
      ZEBRA_ALBUM,
      SPOTIFY_SAVED,
      UNMATCHED_ALBUM,
      ZEBRA_ALBUM,
    ]);

    // Identical row shape to the album grid.
    const grid = await getJson<Page<AlbumSummary>>('/api/library/albums');
    const expected = want
      .map((id) => grid.items.find((a) => a.id === id))
      .filter((a): a is AlbumSummary => a !== undefined);
    expect(body.items).toEqual(expected);

    for (const ids of ['', ',,,%20']) {
      const res = await app.inject({ method: 'GET', url: `/api/library/albums?ids=${ids}` });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'ids required' });
    }
    const tooMany = Array.from({ length: 101 }, (_, i) => `sp:bulk${i}`).join(',');
    const over = await app.inject({ method: 'GET', url: `/api/library/albums?ids=${tooMany}` });
    expect(over.statusCode).toBe(400);
    expect(over.json()).toEqual({ error: 'at most 100 ids' });
  });

  it('searches with FTS, including diacritics ("Öyster" ↔ "oyster") and prefixes', async () => {
    for (const q of ['oyster', encodeURIComponent('Öyster'), 'oys']) {
      const page = await getJson<Page<AlbumSummary>>(`/api/library/albums?q=${q}`);
      expect(page.total, `q=${q}`).toBe(2);
      expect(albumIds(page)).toEqual([MATCHED_ALBUM, CUE_ALBUM]); // added desc
    }
    // Track and artist names feed the album search too.
    const zebra = await getJson<Page<AlbumSummary>>('/api/library/albums?q=zebra');
    expect(albumIds(zebra)).toEqual([ZEBRA_ALBUM]);
    expect((await getJson<Page<AlbumSummary>>('/api/library/albums?q=zzzzz')).total).toBe(0);
  });

  it('supports every sort and keeps the unpaged total', async () => {
    const byTitle = await getJson<Page<AlbumSummary>>('/api/library/albums?sort=title');
    expect(albumIds(byTitle)).toEqual([MATCHED_ALBUM, SPOTIFY_SAVED, UNMATCHED_ALBUM, ZEBRA_ALBUM, CUE_ALBUM]);

    const byArtist = await getJson<Page<AlbumSummary>>('/api/library/albums?sort=artist');
    expect(albumIds(byArtist)).toEqual([UNMATCHED_ALBUM, ZEBRA_ALBUM, SPOTIFY_SAVED, CUE_ALBUM, MATCHED_ALBUM]);

    const byYear = await getJson<Page<AlbumSummary>>('/api/library/albums?sort=year');
    expect(albumIds(byYear)).toEqual([SPOTIFY_SAVED, ZEBRA_ALBUM, UNMATCHED_ALBUM, MATCHED_ALBUM, CUE_ALBUM]);

    const paged = await getJson<Page<AlbumSummary>>('/api/library/albums?limit=2&offset=1');
    expect(paged.total).toBe(5);
    expect(albumIds(paged)).toEqual([UNMATCHED_ALBUM, MATCHED_ALBUM]);

    const tail = await getJson<Page<AlbumSummary>>('/api/library/albums?limit=2&offset=4');
    expect(tail.total).toBe(5);
    expect(albumIds(tail)).toEqual([ZEBRA_ALBUM]);
  });

  it('tolerates repeated query parameters', async () => {
    const page = await getJson<Page<AlbumSummary>>('/api/library/albums?q=oyster&q=oys');
    expect(page.total).toBe(2);
  });

  it('uses defaults for non-numeric or fractional limit/offset instead of a 500', async () => {
    for (const query of ['limit=abc', 'offset=abc', 'limit=NaN', 'offset=Infinity', 'limit=&offset=']) {
      const res = await app.inject({ method: 'GET', url: `/api/library/albums?${query}` });
      expect(res.statusCode, `${query} → ${res.body}`).toBe(200);
      const page = res.json() as Page<AlbumSummary>;
      expect(page.total, query).toBe(5);
      expect(page.items.length, query).toBe(5); // fall back to the default page size
    }
    // Fractions are truncated, not passed to SQLite as reals.
    const paged = await getJson<Page<AlbumSummary>>('/api/library/albums?limit=2.9&offset=1.9');
    expect(albumIds(paged)).toEqual([UNMATCHED_ALBUM, MATCHED_ALBUM]);
  });

  it('treats % and _ in q as literal characters, not LIKE wildcards', async () => {
    for (const q of ['%25', '_']) {
      const page = await getJson<Page<AlbumSummary>>(`/api/library/albums?q=${q}`);
      expect(page.total, `q=${q}`).toBe(0);
    }
    const search = await getJson<{ albums: AlbumSummary[]; artists: ArtistRef[]; tracks: Track[] }>('/api/search?q=%25');
    expect(search).toEqual({ albums: [], artists: [], tracks: [] });
    expect(await getJson<ArtistRef[]>('/api/artists?q=%25')).toEqual([]);
  });
});

// ---------------------------------------------------------------- /albums/:id

describe('GET /api/albums/:id', () => {
  it('returns a cue album with ordered tracks and cue windows, never file paths', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/albums/${encodeURIComponent(CUE_ALBUM)}` });
    expect(res.statusCode, res.body).toBe(200);
    const album = res.json() as Album;
    expect(album.id).toBe(CUE_ALBUM);
    expect(album.title).toBe('Öyster Sessions');
    expect(album.genres).toEqual(['Jazz', 'Fusion']);
    expect(album.label).toBe('Blue Note');
    expect(album.releaseDate).toBeUndefined();
    expect(album.musicbrainzReleaseId).toBeUndefined();
    expect(album.folderPath).toBeUndefined();
    expect(album.tracks.map((t) => t.id)).toEqual(CUE_TRACKS);
    expect(album.tracks.map((t) => t.number)).toEqual([1, 2, 3]);
    const [first, second, third] = album.tracks as [Track, Track, Track];
    expect(first.cue).toEqual({ startMs: 0, endMs: 180_000 });
    expect(first.durationMs).toBe(180_000);
    expect(second.cue).toEqual({ startMs: 180_000, endMs: 300_000 });
    expect(second.durationMs).toBe(120_000);
    expect(third.cue).toEqual({ startMs: 300_000, endMs: 400_000 });
    expect(first.format).toBe('flac');
    expect(first.sampleRate).toBe(44_100);
    expect(first.bitDepth).toBe(16);
    for (const t of album.tracks) expect(t).not.toHaveProperty('path');
    expect(JSON.stringify(album)).not.toContain(root);
    expect(JSON.stringify(album)).not.toContain('/mnt/');
  });

  it('returns matched metadata, credits (album- and track-scoped) and disc/number order', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/albums/${encodeURIComponent(MATCHED_ALBUM)}` });
    expect(res.statusCode, res.body).toBe(200);
    const album = res.json() as Album;
    expect(album.musicbrainzReleaseId).toBe('22222222-2222-4222-8222-222222222222');
    expect(album.matchConfidence).toBeCloseTo(0.95);
    expect(album.releaseDate).toBe('1980-05-01');
    expect(album.tracks.map((t) => t.id)).toEqual([MATCHED_D1N1, MATCHED_D1N2, MATCHED_D2N1]);
    expect(album.tracks.map((t) => `${t.disc}/${t.number}`)).toEqual(['1/1', '1/2', '2/1']);
    expect(album.tracks[0]!.artists).toEqual([
      { id: OYSTER_ARTIST, name: 'The Öyster Cult' },
      { id: GUEST_ARTIST, name: 'Guest Vocalist' },
    ]);

    expect(album.credits).toHaveLength(3);
    const producer = album.credits.find((c) => c.role === 'Producer')!;
    expect(producer.artist).toEqual({ id: OYSTER_ARTIST, name: 'The Öyster Cult' });
    expect(producer.trackIds).toBeUndefined();
    const vocals = album.credits.find((c) => c.role === 'Lead Vocals')!;
    expect(vocals.artist).toEqual({ id: GUEST_ARTIST, name: 'Guest Vocalist' });
    expect(vocals.trackIds).toEqual([MATCHED_D1N1]);
    expect(album.credits.find((c) => c.role === 'Engineer')!.artist.id).toBe(LOCAL_ARTIST);

    for (const t of album.tracks) expect(t).not.toHaveProperty('path');
    expect(JSON.stringify(album)).not.toContain(root);
    expect(JSON.stringify(album)).not.toContain('/mnt/');
  });

  it('returns unmatched albums without match fields', async () => {
    const album = await getJson<Album>(`/api/albums/${encodeURIComponent(UNMATCHED_ALBUM)}`);
    expect(album.musicbrainzReleaseId).toBeUndefined();
    expect(album.matchConfidence).toBeUndefined();
    expect(album.coverUrl).toBeUndefined();
    expect(album.tracks).toHaveLength(1);
    expect(album.tracks[0]!.id).toBe(UNMATCHED_TRACK);
  });

  it('serves a Spotify album stored with in_library = 0 directly by id', async () => {
    const album = await getJson<Album>(`/api/albums/${encodeURIComponent(SPOTIFY_HIDDEN)}`);
    expect(album.source).toBe('spotify');
    expect(album.title).toBe('Spotify Hidden');
    expect(album.tracks.map((t) => t.id)).toEqual([SPOTIFY_HIDDEN_TRACK]);
  });

  it('404s for unknown album ids', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/albums/la:does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
  });
});

// ---------------------------------------------------------------- /artists

describe('GET /api/artists/:id', () => {
  it('splits own albums from appearsOn and computes similar artists', async () => {
    const artist = await getJson<Artist>(`/api/artists/${encodeURIComponent(OYSTER_ARTIST)}`);
    expect(artist.name).toBe('The Öyster Cult');
    expect(artist.musicbrainzArtistId).toBe('11111111-1111-1111-1111-111111111111');
    expect(artist.albums.map((a) => a.id)).toEqual([CUE_ALBUM, MATCHED_ALBUM]); // by year
    expect(artist.appearsOn).toEqual([]);
    expect(artist.similar).toEqual([{ id: LOCAL_ARTIST, name: 'Local Band' }]);
    expect(JSON.stringify(artist)).not.toContain(root);
    expect(JSON.stringify(artist)).not.toContain('/mnt/');
  });

  it('finds an artist that only appears as a credit / track artist', async () => {
    const artist = await getJson<Artist>(`/api/artists/${encodeURIComponent(GUEST_ARTIST)}`);
    expect(artist.name).toBe('Guest Vocalist');
    expect(artist.albums).toEqual([]);
    expect(artist.appearsOn.map((a) => a.id)).toEqual([MATCHED_ALBUM, UNMATCHED_ALBUM]); // by year
    expect(artist.similar.map((a) => a.id).sort()).toEqual([OYSTER_ARTIST, LOCAL_ARTIST].sort());
    expect(artist.musicbrainzArtistId).toBeUndefined();
    expect(artist.imageUrl).toBeUndefined();
    expect(JSON.stringify(artist)).not.toContain(root);
    expect(JSON.stringify(artist)).not.toContain('/mnt/');
  });

  it('404s for unknown artist ids', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/artists/ar:nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
  });
});

describe('GET /api/artists', () => {
  it('lists album artists only, with counts, and filters by name', async () => {
    const artists = await getJson<{ id: string; name: string; albumCount: number; coverAlbumId?: string }[]>('/api/artists');
    expect(artists.map((a) => [a.name, a.albumCount])).toEqual([
      ['Local Band', 2],
      ['Spotify Artist', 1],
      ['The Öyster Cult', 2],
    ]);
    expect(artists.some((a) => a.id === GUEST_ARTIST)).toBe(false);
    for (const a of artists) expect(typeof a.coverAlbumId).toBe('string');
    expect(JSON.stringify(artists)).not.toContain(root);
    expect(JSON.stringify(artists)).not.toContain('/mnt/');

    const filtered = await getJson<{ name: string }[]>('/api/artists?q=Local');
    expect(filtered.map((a) => a.name)).toEqual(['Local Band']);
  });
});

// ---------------------------------------------------------------- /search

describe('GET /api/search', () => {
  it('returns empty buckets for an empty query', async () => {
    for (const url of ['/api/search', '/api/search?q=', '/api/search?q=%20%20']) {
      expect(await getJson(url)).toEqual({ albums: [], artists: [], tracks: [] });
    }
  });

  it('finds albums, artists and tracks via FTS prefixes, including diacritics', async () => {
    for (const q of ['oyster', 'oys']) {
      const body = await getJson<{ albums: AlbumSummary[]; artists: ArtistRef[]; tracks: Track[] }>(`/api/search?q=${q}`);
      expect(body.albums.map((a) => a.id), `q=${q}`).toEqual([CUE_ALBUM, MATCHED_ALBUM]); // artist sort
      expect(body.artists.map((a) => a.id)).toContain(OYSTER_ARTIST);
      expect(body.tracks.map((t) => t.id).sort()).toEqual(
        [CUE_T1, CUE_T2, CUE_T3, MATCHED_D1N1, MATCHED_D1N2, MATCHED_D2N1].sort(),
      );
      for (const t of body.tracks) expect(t).not.toHaveProperty('path');
      expect(JSON.stringify(body)).not.toContain(root);
      expect(JSON.stringify(body)).not.toContain('/mnt/');
    }

    const stripped = encodeURIComponent('Öyster');
    const body = await getJson<{ albums: AlbumSummary[] }>(`/api/search?q=${stripped}`);
    expect(body.albums.map((a) => a.id)).toEqual([CUE_ALBUM, MATCHED_ALBUM]);
  });

  it('serves the same local result for ?local=1 and the full request', async () => {
    const local = await getJson<{ albums: AlbumSummary[]; artists: ArtistRef[]; tracks: Track[] }>(
      '/api/search?q=oys&local=1',
    );
    // No Spotify client is configured, so the plain request is the local half too;
    // both go through the one 15 s cache entry for this query.
    expect(await getJson('/api/search?q=oys')).toEqual(local);
    expect(await getJson('/api/search?q=oys&local=1')).toEqual(local);
  });

  it('tolerates repeated query parameters', async () => {
    const body = await getJson<{ albums: AlbumSummary[] }>('/api/search?q=oys&q=oyster');
    expect(body.albums.map((a) => a.id)).toEqual([CUE_ALBUM, MATCHED_ALBUM]);
  });

  it('finds a track and its album by title', async () => {
    const body = await getJson<{ albums: AlbumSummary[]; artists: ArtistRef[]; tracks: Track[] }>('/api/search?q=zebra');
    expect(body.albums.map((a) => a.id)).toEqual([ZEBRA_ALBUM]);
    expect(body.tracks.map((t) => t.id)).toEqual([ZEBRA_TRACK]);
    expect(body.artists).toEqual([]);
  });
});

// ---------------------------------------------------------------- /tracks/:id

describe('GET /api/tracks/:id', () => {
  it('returns a cue track with its window and no path', async () => {
    const track = await getJson<Track>(`/api/tracks/${encodeURIComponent(CUE_T1)}`);
    expect(track).toMatchObject({
      id: CUE_T1,
      albumId: CUE_ALBUM,
      source: 'local',
      title: 'Öyster Part 1',
      disc: 1,
      number: 1,
      durationMs: 180_000,
      format: 'flac',
      cue: { startMs: 0, endMs: 180_000 },
      artists: [{ id: OYSTER_ARTIST, name: 'The Öyster Cult' }],
    });
    expect(track).not.toHaveProperty('path');
    expect(JSON.stringify(track)).not.toContain(root);
    expect(JSON.stringify(track)).not.toContain('/mnt/');
  });

  it('returns explicit track artists for a local track', async () => {
    const track = await getJson<Track>(`/api/tracks/${encodeURIComponent(UNMATCHED_TRACK)}`);
    expect(track.artists).toEqual([{ id: GUEST_ARTIST, name: 'Guest Vocalist' }]);
    expect(track.bitrateKbps).toBe(320);
    expect(track).not.toHaveProperty('path');
  });

  it('returns a Spotify track with its URI', async () => {
    const track = await getJson<Track>(`/api/tracks/${encodeURIComponent(SPOTIFY_TRACK)}`);
    expect(track.source).toBe('spotify');
    expect(track.spotifyUri).toBe('spotify:track:saved');
    expect(track).not.toHaveProperty('path');
  });

  it('404s for unknown track ids', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tracks/l:nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
  });
});

// ---------------------------------------------------------------- /cover

describe('GET /api/cover/:id', () => {
  it('generates and caches a 200 px thumbnail', async () => {
    const url = `/api/cover/${encodeURIComponent(CUE_ALBUM)}?size=200`;
    const first = await app.inject({ method: 'GET', url });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers['content-type']).toBe('image/jpeg');
    expect(first.headers['cache-control']).toBe('public, max-age=86400');
    expect(first.rawPayload.length).toBeGreaterThan(100);
    expect(first.rawPayload[0]).toBe(0xff);
    expect(first.rawPayload[1]).toBe(0xd8); // JPEG SOI

    const thumbs = () => readdirSync(join(dataDir, 'thumbs')).filter((f) => f.endsWith('.jpg'));
    expect(thumbs()).toHaveLength(1);

    const second = await app.inject({ method: 'GET', url });
    expect(second.statusCode).toBe(200);
    expect(thumbs()).toHaveLength(1); // reused, not regenerated
    expect(second.rawPayload.equals(first.rawPayload)).toBe(true);
  });

  it('serves the original file for size=full', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/cover/${encodeURIComponent(CUE_ALBUM)}?size=full` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload.equals(readFileSync(coverFile))).toBe(true);
  });

  it('defaults to a 600 px jpeg thumbnail', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/cover/${encodeURIComponent(CUE_ALBUM)}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.rawPayload[0]).toBe(0xff);
  });

  it('returns the Spotify CDN URL directly and caches the old-client redirect', async () => {
    const id = 'sp:httpscover';
    const https = 'https://img.example/https-cover.jpg';
    db.prepare(
      `INSERT INTO albums (id, source, title, artist_id, cover_path, added_at, in_library)
       VALUES (?, 'spotify', 'HTTPS Cover', ?, ?, 4000, 0)`,
    ).run(id, SPOTIFY_ARTIST, https);
    try {
      // Summaries must not wrap an absolute CDN URL in /api/cover/<id>.
      const batch = await getJson<{ items: AlbumSummary[] }>(
        `/api/library/albums?ids=${encodeURIComponent(id)}`,
      );
      expect(batch.items[0]!.coverUrl).toBe(https);
      const album = await getJson<Album>(`/api/albums/${encodeURIComponent(id)}`);
      expect(album.coverUrl).toBe(https);

      const redirect = await app.inject({
        method: 'GET',
        url: `/api/cover/${encodeURIComponent(id)}?size=200`,
      });
      expect(redirect.statusCode).toBe(302);
      expect(redirect.headers.location).toBe(https);
      expect(redirect.headers['cache-control']).toBe('public, max-age=86400');
    } finally {
      db.prepare('DELETE FROM albums WHERE id = ?').run(id);
    }
  });

  it('404s when the album has no cover or does not exist', async () => {
    const noCover = await app.inject({ method: 'GET', url: `/api/cover/${encodeURIComponent(UNMATCHED_ALBUM)}?size=200` });
    expect(noCover.statusCode).toBe(404);
    expect(noCover.json()).toEqual({ error: 'no cover' });

    const missing = await app.inject({ method: 'GET', url: '/api/cover/la:missing?size=200' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'no cover' });
  });
});

// ---------------------------------------------------------------- /zones & match

describe('GET /api/zones', () => {
  it('has no PC zone when pcZone is disabled', async () => {
    expect(await getJson('/api/zones')).toEqual([]);
  });
});

describe('POST /api/player/:zone', () => {
  const url = '/api/player/pc';

  it('rejects every malformed command with a short 400 before the zone is reached', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ type: 'volume' }, 'volume must be a number between 0 and 100'],
      [{ type: 'volume', volume: null }, 'volume must be a number between 0 and 100'],
      [{ type: 'volume', volume: 'loud' }, 'volume must be a number between 0 and 100'],
      [{ type: 'seek' }, 'seek positionMs must be a number of milliseconds (0 or more)'],
      [{ type: 'seek', positionMs: -1 }, 'seek positionMs must be a number of milliseconds (0 or more)'],
      [{ type: 'repeat', mode: 'banana' }, 'repeat mode must be off, all or one'],
      [{ type: 'shuffle', on: 'yes' }, 'shuffle on must be true or false'],
      [{ type: 'play', trackId: 123 }, 'play needs trackIds: an array of track ids'],
      [{ type: 'play', trackIds: ['l:x'], startIndex: -1 }, 'play startIndex must be a whole number (0 or more)'],
      [{ type: 'jump', index: 1.5 }, 'jump index must be a whole number (0 or more)'],
      [{ type: 'remove' }, 'remove needs a queueId'],
      [{ type: 'move', queueId: 'q:a', toIndex: -1 }, 'move toIndex must be a whole number (0 or more)'],
      [{ type: 'nope', detail: 'internal' }, 'unknown player command'],
    ];
    for (const [payload, error] of cases) {
      const res = await app.inject({ method: 'POST', url, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toEqual({ error });
    }
    // A JSON body that is not an object is rejected too, without echoing it.
    for (const raw of ['null', '[]', '"volume"', '7']) {
      const res = await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: raw });
      expect(res.statusCode, raw).toBe(400);
      expect(res.json()).toEqual({ error: 'player command must be a JSON object' });
    }
  });

  it('accepts every real command and every command the queue UI sends', async () => {
    const commands = [
      { type: 'pause' },
      { type: 'resume' },
      { type: 'next' },
      { type: 'prev' },
      { type: 'seek', positionMs: 90_000 },
      { type: 'jump', index: 2 },
      { type: 'remove', queueId: 'q:a' },
      { type: 'move', queueId: 'q:a', toIndex: 1 },
      { type: 'clear' },
      { type: 'volume', volume: 62 },
      { type: 'shuffle', on: true },
      { type: 'repeat', mode: 'one' },
      { type: 'play', trackIds: [MATCHED_D1N1], startIndex: 0, positionMs: 1000, paused: false },
      { type: 'enqueue', trackIds: [MATCHED_D1N2], next: true },
    ];
    for (const payload of commands) {
      const res = await app.inject({ method: 'POST', url, payload });
      // Validation passed; with pcZone disabled the next step is "this zone does not exist".
      expect(res.statusCode, `${JSON.stringify(payload)} → ${res.body}`).toBe(404);
      expect(res.json()).toEqual({ error: 'unknown zone' });
    }
  });
});

describe('POST /api/albums/:id/match', () => {
  const url = (id: string) => `/api/albums/${encodeURIComponent(id)}/match`;

  it('rejects malformed MusicBrainz release ids with 400', async () => {
    for (const musicbrainzReleaseId of ['not-a-uuid', 'abc', '-'.repeat(36), '22222222222222222222222222222222zzzz']) {
      const res = await app.inject({ method: 'POST', url: url(CUE_ALBUM), payload: { musicbrainzReleaseId } });
      expect(res.statusCode, `mbid=${musicbrainzReleaseId} → ${res.body}`).toBe(400);
      expect(res.json()).toEqual({ error: 'musicbrainzReleaseId required' });
    }
  });

  it('404s for an unknown album instead of calling MusicBrainz', async () => {
    const res = await app.inject({
      method: 'POST',
      url: url('la:missing'),
      payload: { musicbrainzReleaseId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
  });
});

// ---------------------------------------------------------------- websocket

describe('/api/settings/hotkeys', () => {
  it('is empty at first, then returns what was saved', async () => {
    const empty = await app.inject({ method: 'GET', url: '/api/settings/hotkeys' });
    expect(empty.json()).toEqual({ hotkeys: null });
    const hotkeys = { albumKey: 'q', playlistKeys: { m: { id: 'pl:sp:abc', name: 'MUDs' } } };
    const saved = await app.inject({ method: 'POST', url: '/api/settings/hotkeys', payload: { hotkeys } });
    expect(saved.statusCode).toBe(200);
    const back = await app.inject({ method: 'GET', url: '/api/settings/hotkeys' });
    expect(back.json()).toEqual({ hotkeys });
  });

  it('rejects malformed values and keeps the saved ones', async () => {
    for (const hotkeys of [null, { albumKey: 'Q', playlistKeys: {} }, { albumKey: '', playlistKeys: { mm: { id: 'x', name: 'y' } } }, { albumKey: '', playlistKeys: { m: { id: 1, name: 'y' } } }, { albumKey: '', playlistKeys: [] }]) {
      const res = await app.inject({ method: 'POST', url: '/api/settings/hotkeys', payload: { hotkeys } });
      expect(res.statusCode).toBe(400);
    }
    const back = await app.inject({ method: 'GET', url: '/api/settings/hotkeys' });
    expect(back.json().hotkeys.albumKey).toBe('q');
  });

  it('allows the album key to be off', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/settings/hotkeys', payload: { hotkeys: { albumKey: '', playlistKeys: {} } } });
    expect(res.json()).toEqual({ hotkeys: { albumKey: '', playlistKeys: {} } });
  });
});

describe('GET /api/ws', () => {
  let wsBase: string | null = null;
  const wsUrl = async (): Promise<string> => {
    if (!wsBase) wsBase = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws');
    return wsBase;
  };

  it('sends the initial scan progress on connect', async () => {
    const event = await firstScanEvent((await wsUrl()) + '/api/ws');
    expect(event).toEqual({
      type: 'scan',
      progress: { running: false, filesSeen: 0, albumsFound: 0, matched: 0, errors: 0 },
    });
  }, 10_000);

  it('ignores garbage, oversized and unknown client messages without dropping the socket', async () => {
    const ws = new WebSocket((await wsUrl()) + '/api/ws');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for the socket')), 5_000);
      ws.addEventListener('error', () => reject(new Error('websocket connection failed')));
      ws.addEventListener('message', () => {
        clearTimeout(timer);
        // The initial scan event arrived: the socket is usable, now send junk at it.
        ws.send('not json');
        ws.send('{"type":"presence","visible":"yes"}'); // wrong type
        ws.send(JSON.stringify({ type: 'sdk-state', deviceId: 'x', active: false })); // no Spotify module here
        ws.send('x'.repeat(20 * 1024)); // over the 16 KB cap
        setTimeout(() => {
          expect(ws.readyState).toBe(WebSocket.OPEN);
          ws.close();
          resolve();
        }, 50);
      }, { once: true });
    });
  }, 10_000);
});

describe('GET /api/spotify/status without a Spotify client id', () => {
  it('answers 200 with configured:false instead of 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/spotify/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ connected: false, configured: false });
  });
});

describe('GET /api/scan/errors', () => {
  it('returns the stored scan errors (none before the first scan)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scan/errors' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

function firstScanEvent(url: string): Promise<ServerEvent> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('timed out waiting for the initial scan event'));
    }, 5_000);
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      let event: ServerEvent;
      try {
        event = JSON.parse(ev.data) as ServerEvent;
      } catch {
        return;
      }
      if (event.type !== 'scan') return;
      clearTimeout(timer);
      ws.addEventListener('close', () => resolve(event));
      ws.close();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('websocket connection failed'));
    });
  });
}
