import { describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb, type Db } from '../src/db/index.js';
import { ensureHistorySchema } from '../src/history/index.js';
import { ensureMyPlaylistSchema } from '../src/myplaylists/schema.js';
import {
  createPlaylist,
  createSmartPlaylist,
  getPlaylistDetail,
  listAllPlaylists,
  registerMyPlaylistRoutes,
  type RunePlaylistDetail,
} from '../src/myplaylists/index.js';
import { ensureOverlaySchema, mergedEntries } from '../src/myplaylists/overlay.js';
import { publicTrack } from '../src/api/library.js';
import { loadTrack } from '../src/play/rows.js';
import { syncPlaylists } from '../src/spotify/library.js';

const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------- seed helpers

function artist(db: Db, id: string, name: string): void {
  db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)').run(id, name);
}

interface AlbumSeed {
  id: string;
  source?: 'local' | 'spotify';
  title: string;
  artistId: string;
  year?: number;
  genres?: string[];
  format?: string;
  addedAt?: number;
}

function album(db: Db, seed: AlbumSeed): void {
  db.prepare(
    `INSERT INTO albums (id, source, title, artist_id, year, genres, format, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    seed.id,
    seed.source ?? 'local',
    seed.title,
    seed.artistId,
    seed.year ?? null,
    JSON.stringify(seed.genres ?? []),
    seed.format ?? null,
    seed.addedAt ?? NOW,
  );
}

interface TrackSeed {
  id: string;
  albumId: string;
  source?: 'local' | 'spotify';
  title?: string;
  durationMs?: number;
  number?: number;
  path?: string;
  format?: string;
  spotifyUri?: string;
  artistId?: string;
}

function track(db: Db, seed: TrackSeed): void {
  db.prepare(
    `INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms, path, format, spotify_uri)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    seed.id,
    seed.albumId,
    seed.source ?? 'local',
    seed.title ?? seed.id,
    seed.number ?? 1,
    seed.durationMs ?? 180_000,
    seed.path ?? null,
    seed.format ?? null,
    seed.spotifyUri ?? null,
  );
  if (seed.artistId) {
    db.prepare('INSERT INTO track_artists (track_id, artist_id, position) VALUES (?, ?, 0)').run(
      seed.id,
      seed.artistId,
    );
  }
}

function play(db: Db, trackId: string, albumId: string, startedAt: number): void {
  db.prepare(
    `INSERT INTO plays (track_id, album_id, zone, started_at, played_ms, completed)
     VALUES (?, ?, 'pc', ?, 200000, 1)`,
  ).run(trackId, albumId, startedAt);
}

function seed(db: Db, opts: { plays?: boolean } = {}): void {
  ensureMyPlaylistSchema(db);
  if (opts.plays !== false) ensureHistorySchema(db);

  artist(db, 'ar:one', 'Rock Artist');
  artist(db, 'ar:two', 'Pop Artist');

  album(db, { id: 'la:r75', title: 'Seventies Rock', artistId: 'ar:one', year: 1975, genres: ['Rock', 'Pop Rock'], format: 'FLAC 24/96', addedAt: NOW - 6000 });
  album(db, { id: 'la:r77', title: 'Seventies Rock II', artistId: 'ar:one', year: 1977, genres: ['Rock'], format: 'FLAC 16/44.1', addedAt: NOW - 5000 });
  album(db, { id: 'la:p00', title: 'Pop Record', artistId: 'ar:two', year: 2000, genres: ['Pop'], format: 'MP3 320', addedAt: NOW - 4000 });
  album(db, { id: 'la:r79', title: 'Late Seventies', artistId: 'ar:one', year: 1979, genres: ['Rock'], format: 'FLAC 24/192', addedAt: NOW - 3000 });
  album(db, { id: 'sp:al1', source: 'spotify', title: 'Spotify Rock', artistId: 'ar:one', year: 1975, genres: ['Rock'], format: 'Spotify', addedAt: NOW - 2000 });

  track(db, { id: 'l:a', albumId: 'la:r75', title: 'Alpha', number: 1, path: '/music/one/a.flac', format: 'flac', artistId: 'ar:one' });
  track(db, { id: 'l:b', albumId: 'la:r75', title: 'Beta', number: 2, path: '/music/one/b.flac', format: 'flac', artistId: 'ar:one' });
  track(db, { id: 'l:c', albumId: 'la:r77', title: 'Gamma', path: '/music/two/c d.flac', format: 'flac', artistId: 'ar:one' });
  track(db, { id: 'l:d', albumId: 'la:p00', title: 'Delta', path: '/music/three/d.mp3', format: 'mp3', artistId: 'ar:two' });
  track(db, { id: 'l:e', albumId: 'la:r79', title: 'Epsilon', path: '/music/four/e.flac', format: 'flac', artistId: 'ar:one' });
  track(db, { id: 'sp:t1', albumId: 'sp:al1', source: 'spotify', title: 'Spotify One', spotifyUri: 'spotify:track:t1', artistId: 'ar:one' });
  track(db, { id: 'sp:t2', albumId: 'sp:al1', source: 'spotify', title: 'Spotify Two', spotifyUri: 'spotify:track:t2', artistId: 'ar:one' });

  if (opts.plays !== false) {
    play(db, 'l:a', 'la:r75', NOW - 60_000);
    play(db, 'l:a', 'la:r75', NOW - 50_000);
    play(db, 'l:a', 'la:r75', NOW - 40_000);
    play(db, 'l:c', 'la:r77', NOW - 30_000);
    play(db, 'l:d', 'la:p00', NOW - 20_000);
    play(db, 'l:d', 'la:p00', NOW - 10_000);
  }
}

function freshDb(opts: { plays?: boolean } = {}): Db {
  const db = openDb(':memory:');
  seed(db, opts);
  return db;
}

function spotifyPlaylistRow(db: Db, id = 'pl:sp:mine', position = 5): void {
  db.prepare(
    `INSERT INTO playlists
       (id, source, name, description, owner, image_url, snapshot_id, track_count, position, updated_at)
     VALUES (?, 'spotify', 'Synced Mix', NULL, 'Listener', 'http://img/x.jpg', 'snap', 1, ?, ?)`,
  ).run(id, position, NOW);
  db.prepare(
    `INSERT INTO playlist_tracks (playlist_id, position, track_id, added_at) VALUES (?, 0, 'sp:t1', ?)`,
  ).run(id, NOW);
}

async function makeApp(db: Db): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(
    async (r) => {
      registerMyPlaylistRoutes(r, db);
      // The main session wires these two GETs in api/server.ts; mirrored here so
      // the routes are exercised through HTTP in the tests.
      r.get('/playlists', () => listAllPlaylists(db));
      r.get<{ Params: { id: string } }>('/playlists/:id', (req, reply) => {
        return getPlaylistDetail(db, req.params.id) ?? reply.code(404).send({ error: 'not found' });
      });
    },
    { prefix: '/api' },
  );
  await app.ready();
  return app;
}

function ids(detail: RunePlaylistDetail): string[] {
  return detail.tracks.map((t) => t.id);
}

// The pre-batching implementation of toPlaylistTracks (one loadTrack + one album
// lookup per entry), kept here as the oracle for the batched rewrite.
type OldEntry =
  | string
  | {
      trackId: string;
      addedAt?: number | null;
      entrySource?: string;
      entryId?: string;
    };

function oldToPlaylistTracks(db: Db, entries: OldEntry[]): unknown[] {
  const albumStmt = db.prepare('SELECT title, cover_path FROM albums WHERE id = ?');
  const result: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const item = typeof entry === 'string' ? { trackId: entry } : entry;
    const track = loadTrack(db, item.trackId);
    if (!track) continue;
    const album = albumStmt.get(track.albumId) as
      | { title: string | null; cover_path: string | null }
      | undefined;
    const coverUrl = album?.cover_path
      ? `/api/cover/${encodeURIComponent(track.albumId)}?size=200`
      : undefined;
    const row: Record<string, unknown> = {
      ...publicTrack(track),
      album: {
        id: track.albumId,
        title: album?.title ?? '',
        ...(coverUrl ? { coverUrl } : {}),
      },
    };
    if (typeof entry !== 'string' && 'entryId' in entry) {
      row.entrySource = entry.entrySource;
      row.entryId = entry.entryId;
    }
    if (typeof entry !== 'string' && entry.addedAt != null) row.addedAt = entry.addedAt;
    result.push(row);
  }
  return result;
}

function insertEntries(db: Db, playlistId: string, entries: OldEntry[]): void {
  const insert = db.prepare(
    'INSERT INTO playlist_tracks (playlist_id, position, track_id, added_at) VALUES (?, ?, ?, ?)',
  );
  entries.forEach((entry, position) => {
    const item = typeof entry === 'string' ? { trackId: entry } : entry;
    insert.run(playlistId, position, item.trackId, item.addedAt ?? null);
  });
}

// ---------------------------------------------------------------- tests

describe('rune playlists: CRUD and ordering', () => {
  it('creates, edits, orders (insert/move/delete), and deletes a playlist', async () => {
    const db = freshDb();
    const app = await makeApp(db);

    const created = await app.inject({
      method: 'POST',
      url: '/api/playlists',
      payload: { name: '  Road Trip  ', description: 'in the car' },
    });
    expect(created.statusCode).toBe(201);
    const playlist = created.json() as RunePlaylistDetail;
    expect(playlist.id.startsWith('pl:rune:')).toBe(true);
    expect(playlist.name).toBe('Road Trip');
    expect(playlist.description).toBe('in the car');
    expect(playlist.source).toBe('local');
    expect(playlist.kind).toBe('static');
    expect(playlist.trackCount).toBe(0);
    expect(playlist.tracks).toEqual([]);
    const id = playlist.id;

    const appended = await app.inject({
      method: 'POST',
      url: `/api/playlists/${id}/tracks`,
      payload: { trackIds: ['l:a', 'l:b', 'l:c'] },
    });
    expect(appended.statusCode).toBe(200);
    expect(ids(appended.json() as RunePlaylistDetail)).toEqual(['l:a', 'l:b', 'l:c']);

    const inserted = await app.inject({
      method: 'POST',
      url: `/api/playlists/${id}/tracks`,
      payload: { trackIds: ['sp:t1'], position: 1 },
    });
    expect(ids(inserted.json() as RunePlaylistDetail)).toEqual(['l:a', 'sp:t1', 'l:b', 'l:c']);

    const moved = await app.inject({
      method: 'POST',
      url: `/api/playlists/${id}/move`,
      payload: { from: 0, to: 3 },
    });
    expect(ids(moved.json() as RunePlaylistDetail)).toEqual(['sp:t1', 'l:b', 'l:c', 'l:a']);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/playlists/${id}/tracks`,
      payload: { positions: [1, 2] },
    });
    expect(ids(removed.json() as RunePlaylistDetail)).toEqual(['sp:t1', 'l:a']);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/playlists/${id}`,
      payload: { name: 'Long Drive', description: null },
    });
    expect(patched.statusCode).toBe(200);
    const patchedBody = patched.json() as RunePlaylistDetail;
    expect(patchedBody.name).toBe('Long Drive');
    expect(patchedBody.description).toBeUndefined(); // cleared

    const deleted = await app.inject({ method: 'DELETE', url: `/api/playlists/${id}` });
    expect(deleted.statusCode).toBe(200);
    expect(getPlaylistDetail(db, id)).toBeUndefined();
    const missing = await app.inject({ method: 'GET', url: `/api/playlists/${id}` });
    expect(missing.statusCode).toBe(404);

    await app.close();
  });

  it('builds a 2×2 cover mosaic from up to four distinct albums', async () => {
    const db = freshDb();
    const playlist = createPlaylist(db, { name: 'Mosaic' });
    const updated = await addTracks(db, playlist.id, ['l:a', 'l:b', 'l:c', 'l:d', 'l:e']);
    expect(updated.coverAlbumIds).toEqual(['la:r75', 'la:r77', 'la:p00', 'la:r79']);
    // Duplicate albums in the track list do not repeat in the mosaic.
    const again = await addTracks(db, playlist.id, ['sp:t1', 'sp:t2']);
    expect(again.coverAlbumIds).toEqual(['la:r75', 'la:r77', 'la:p00', 'la:r79']);
  });

  it('rejects unknown tracks, bad smart rules and out-of-range moves', async () => {
    const db = freshDb();
    const app = await makeApp(db);
    const playlist = createPlaylist(db, { name: 'Validation' });

    const unknown = await app.inject({
      method: 'POST',
      url: `/api/playlists/${playlist.id}/tracks`,
      payload: { trackIds: ['l:a', 'l:nope'] },
    });
    expect(unknown.statusCode).toBe(400);
    expect(String(unknown.json().error)).toContain('l:nope');

    const badRule = await app.inject({
      method: 'POST',
      url: '/api/playlists/smart',
      payload: { name: 'Bad', rules: [{ field: 'tempo', op: 'eq', value: 1 }] },
    });
    expect(badRule.statusCode).toBe(400);

    await addTracks(db, playlist.id, ['l:a']);
    const badMove = await app.inject({
      method: 'POST',
      url: `/api/playlists/${playlist.id}/move`,
      payload: { from: 0, to: 9 },
    });
    expect(badMove.statusCode).toBe(400);

    const noName = await app.inject({ method: 'POST', url: '/api/playlists', payload: {} });
    expect(noName.statusCode).toBe(400);

    await app.close();
  });

  it('deletes only rune playlists; Spotify playlists are 409 (and survive a sync)', async () => {
    const db = freshDb();
    const app = await makeApp(db);
    spotifyPlaylistRow(db);
    const rune = createPlaylist(db, { name: 'Mine' });

    const list = listAllPlaylists(db);
    expect(list[0]?.id).toBe(rune.id); // rune first
    expect(list[1]?.id).toBe('pl:sp:mine');

    const delSpotify = await app.inject({ method: 'DELETE', url: '/api/playlists/pl:sp:mine' });
    expect(delSpotify.statusCode).toBe(409);
    const patchSpotify = await app.inject({
      method: 'PATCH',
      url: '/api/playlists/pl:sp:mine',
      payload: { name: 'Nope' },
    });
    expect(patchSpotify.statusCode).toBe(409);

    // A Spotify sync deletes vanished synced playlists, never rune-owned ones.
    await syncPlaylists(
      { allPlaylists: async () => [], allPlaylistTracks: async () => [], allSavedTracks: async () => [] },
      db,
    );
    expect(getPlaylistDetail(db, rune.id)).toBeDefined();
    expect(getPlaylistDetail(db, 'pl:sp:mine')).toBeUndefined();

    await app.close();
  });
});

describe('rune playlists: batched track reads', () => {
  it('keeps order, duplicates, dangling entries, addedAt and overlay entries identical', () => {
    const db = freshDb();
    const staticId = 'pl:rune:batched';
    db.prepare(
      `INSERT INTO playlists (id, source, name, position, updated_at)
       VALUES (?, 'local', 'Batched', 0, ?)`,
    ).run(staticId, NOW);
    insertEntries(db, staticId, [
      { trackId: 'l:b', addedAt: NOW - 5 },
      { trackId: 'l:a', addedAt: NOW - 4 },
      { trackId: 'l:b', addedAt: NOW - 3 }, // duplicate entry
      { trackId: 'l:missing', addedAt: NOW - 2 }, // dangling: no track row
      { trackId: 'l:d', addedAt: NOW - 1 },
    ]);

    const staticDetail = getPlaylistDetail(db, staticId) as RunePlaylistDetail;
    expect(staticDetail.tracks).toEqual(
      oldToPlaylistTracks(db, [
        { trackId: 'l:b', addedAt: NOW - 5 },
        { trackId: 'l:a', addedAt: NOW - 4 },
        { trackId: 'l:b', addedAt: NOW - 3 },
        { trackId: 'l:missing', addedAt: NOW - 2 },
        { trackId: 'l:d', addedAt: NOW - 1 },
      ]),
    );
    expect(ids(staticDetail)).toEqual(['l:b', 'l:a', 'l:b', 'l:d']);
    expect(staticDetail.tracks.map((t) => t.addedAt)).toEqual([NOW - 5, NOW - 4, NOW - 3, NOW - 1]);

    // A synced Spotify playlist with two base entries and two overlay entries.
    ensureOverlaySchema(db);
    const spotifyId = 'pl:sp:overlay';
    spotifyPlaylistRow(db, spotifyId);
    db.prepare(
      `INSERT INTO playlist_tracks (playlist_id, position, track_id, added_at)
       VALUES (?, 1, 'sp:t2', ?)`,
    ).run(spotifyId, NOW - 100);
    const addOverlay = db.prepare(
      `INSERT INTO playlist_overlay
         (id, playlist_id, track_id, anchor_track_id, anchor_occurrence, added_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    addOverlay.run('ov:top', spotifyId, 'l:d', null, 0, NOW + 1);
    addOverlay.run('ov:after', spotifyId, 'l:a', 'sp:t1', 0, NOW + 2);

    const merged = mergedEntries(db, spotifyId);
    expect(merged.map((e) => e.trackId)).toEqual(['l:d', 'sp:t1', 'l:a', 'sp:t2']);
    const spotifyDetail = getPlaylistDetail(db, spotifyId) as RunePlaylistDetail;
    expect(spotifyDetail.tracks).toEqual(oldToPlaylistTracks(db, merged));
    expect(spotifyDetail.tracks.map((t) => t.entryId)).toEqual(merged.map((e) => e.entryId));
    expect(spotifyDetail.tracks.map((t) => t.entrySource)).toEqual(
      merged.map((e) => e.entrySource),
    );
    expect(spotifyDetail.tracks.map((t) => t.entrySource)).toEqual([
      'rune-overlay',
      'spotify-playlist',
      'rune-overlay',
      'spotify-playlist',
    ]);
  });

  it('loads smart-playlist candidates once per GET /playlists, not once per smart row', () => {
    const db = freshDb({ plays: false });
    createSmartPlaylist(db, { name: 'Smart one', rules: [], sort: 'title:asc' });
    createSmartPlaylist(db, { name: 'Smart two', rules: [], sort: 'album:asc' });

    const original = db.prepare.bind(db);
    let candidateLoads = 0;
    const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (sql.includes('AS track_format') && sql.includes('FROM tracks t')) candidateLoads++;
      return original(sql);
    }) as typeof db.prepare);
    try {
      const all = listAllPlaylists(db);
      expect(all).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
    expect(candidateLoads).toBe(1);
  });
});

describe('rune playlists: smart rules', () => {
  const FLAC_24_ROCK_70S = {
    name: 'FLAC 24-bit rock from the 70s',
    rules: [
      { field: 'format', op: 'contains', value: 'FLAC 24' },
      { field: 'genre', op: 'contains', value: 'rock' },
      { field: 'year', op: 'between', value: [1970, 1979] },
    ],
    match: 'all' as const,
    sort: 'year:desc',
    limit: 10,
  };

  it('evaluates format/genre/year rules live and sorts/limits', async () => {
    const db = freshDb();
    const smart = createSmartPlaylist(db, FLAC_24_ROCK_70S);
    expect(smart.kind).toBe('smart');
    expect(smart.source).toBe('local');
    expect(ids(smart)).toEqual(['l:e', 'l:a', 'l:b']);
    expect(smart.trackCount).toBe(3);

    // Live: a new matching track shows up without touching the playlist row.
    track(db, { id: 'l:f', albumId: 'la:r79', title: 'Zeta', number: 2, path: '/music/four/f.flac', format: 'flac', artistId: 'ar:one' });
    expect(ids(getPlaylistDetail(db, smart.id) as RunePlaylistDetail)).toEqual([
      'l:e',
      'l:f',
      'l:a',
      'l:b',
    ]);

    // limit is applied on read.
    const limited = createSmartPlaylist(db, { ...FLAC_24_ROCK_70S, name: 'Top 2', limit: 2 });
    expect(ids(limited)).toEqual(['l:e', 'l:f']);
  });

  it('uses plays/lastPlayed from the plays table when it exists', async () => {
    const db = freshDb({ plays: true });
    const played = createSmartPlaylist(db, {
      name: 'Heavy rotation',
      rules: [{ field: 'plays', op: 'gte', value: 2 }],
      sort: 'plays:desc',
    });
    expect(ids(played)).toEqual(['l:a', 'l:d']);

    const never = createSmartPlaylist(db, {
      name: 'Never played',
      rules: [{ field: 'lastPlayed', op: 'never' }],
      sort: 'title:asc',
    });
    expect(ids(never)).toEqual(['l:b', 'l:e', 'sp:t1', 'sp:t2']);

    const recently = createSmartPlaylist(db, {
      name: 'Recently played',
      rules: [{ field: 'lastPlayed', op: 'gte', value: NOW - 35_000 }],
      sort: 'lastPlayed:desc',
    });
    expect(ids(recently)).toEqual(['l:d', 'l:c']);
  });

  it('treats missing plays table as zero plays', () => {
    const db = freshDb({ plays: false });
    const smart = createSmartPlaylist(db, {
      name: 'Any plays',
      rules: [{ field: 'plays', op: 'gt', value: 0 }],
    });
    expect(smart.tracks).toEqual([]);
    const never = createSmartPlaylist(db, {
      name: 'Unplayed',
      rules: [{ field: 'lastPlayed', op: 'never' }],
    });
    expect(never.trackCount).toBe(7); // all seeded tracks
  });

  it('supports match any, artist ids and source rules', () => {
    const db = freshDb();
    const any = createSmartPlaylist(db, {
      name: 'Pop or Spotify',
      rules: [
        { field: 'genre', op: 'eq', value: 'pop' },
        { field: 'source', op: 'eq', value: 'spotify' },
      ],
      match: 'any',
      sort: 'title:asc',
    });
    expect(ids(any)).toEqual(['l:d', 'sp:t1', 'sp:t2']);

    const byArtist = createSmartPlaylist(db, {
      name: 'Rock Artist tracks',
      rules: [{ field: 'artist', op: 'eq', value: 'ar:one' }],
      sort: 'album:asc',
    });
    expect(ids(byArtist)).toEqual(['l:e', 'l:a', 'l:b', 'l:c', 'sp:t1', 'sp:t2']);
  });

  it('duplicates a smart playlist with its rules intact', async () => {
    const db = freshDb();
    const app = await makeApp(db);
    const smart = createSmartPlaylist(db, FLAC_24_ROCK_70S);
    const copy = await app.inject({ method: 'POST', url: `/api/playlists/${smart.id}/duplicate` });
    expect(copy.statusCode).toBe(201);
    const copied = copy.json() as RunePlaylistDetail;
    expect(copied.id).not.toBe(smart.id);
    expect(copied.kind).toBe('smart');
    expect(copied.name).toBe('FLAC 24-bit rock from the 70s copy');
    expect(ids(copied)).toEqual(ids(smart));
    await app.close();
  });

  it('refuses manual track edits on smart playlists', async () => {
    const db = freshDb();
    const app = await makeApp(db);
    const smart = createSmartPlaylist(db, FLAC_24_ROCK_70S);
    const add = await app.inject({
      method: 'POST',
      url: `/api/playlists/${smart.id}/tracks`,
      payload: { trackIds: ['l:a'] },
    });
    expect(add.statusCode).toBe(409);
    await app.close();
  });
});

describe('rune playlists: M3U8 export/import', () => {
  it('round-trips local paths and Spotify URIs', async () => {
    const db = freshDb();
    const app = await makeApp(db);
    const playlist = createPlaylist(db, { name: 'Mixed / List' });
    await addTracks(db, playlist.id, ['l:a', 'sp:t1', 'l:c']);

    const exported = await app.inject({
      method: 'GET',
      url: `/api/playlists/${playlist.id}/export.m3u8`,
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toContain('audio/x-mpegurl');
    expect(String(exported.headers['content-disposition'])).toContain('Mixed _ List.m3u8');
    const text = exported.body;
    expect(text.startsWith('#EXTM3U\n')).toBe(true);
    expect(text).toContain('#PLAYLIST:Mixed / List');
    expect(text).toContain('#EXTINF:180,Rock Artist - Alpha');
    expect(text).toContain('/music/one/a.flac');
    expect(text).toContain('spotify:track:t1');
    expect(text).toContain('/music/two/c d.flac');

    // Raw text/plain import.
    const imported = await app.inject({
      method: 'POST',
      url: '/api/playlists/import',
      headers: { 'content-type': 'text/plain' },
      payload: text,
    });
    expect(imported.statusCode).toBe(201);
    const result = imported.json() as RunePlaylistDetail & {
      imported: number;
      skipped: number;
      unmatched: string[];
    };
    expect(result.name).toBe('Mixed / List');
    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);
    expect(ids(result)).toEqual(['l:a', 'sp:t1', 'l:c']);

    // Second export is byte-identical: a true round trip.
    const exportedAgain = await app.inject({
      method: 'GET',
      url: `/api/playlists/${result.id}/export.m3u8`,
    });
    expect(exportedAgain.body).toBe(text);
    await app.close();
  });

  it('imports JSON with a name override, skips unknown entries, and decodes %20', async () => {
    const db = freshDb();
    const app = await makeApp(db);
    const content = [
      '#EXTM3U',
      '#EXTINF:1,Someone - A song',
      '/music/one/a.flac',
      '/music/two/c%20d.flac',
      '/music/missing/nope.flac',
      'spotify:track:doesnotexist',
      'spotify:track:t2',
      '#EXTINF:1,Someone - moved',
      'c d.flac',
    ].join('\n');

    const imported = await app.inject({
      method: 'POST',
      url: '/api/playlists/import',
      payload: { name: 'Imported Mix', content },
    });
    expect(imported.statusCode).toBe(201);
    const result = imported.json() as RunePlaylistDetail & {
      imported: number;
      skipped: number;
      unmatched: string[];
    };
    expect(result.name).toBe('Imported Mix');
    expect(ids(result)).toEqual(['l:a', 'l:c', 'sp:t2', 'l:c']);
    expect(result.imported).toBe(4);
    expect(result.skipped).toBe(2);
    expect(result.unmatched).toEqual(['/music/missing/nope.flac', 'spotify:track:doesnotexist']);

    const empty = await app.inject({
      method: 'POST',
      url: '/api/playlists/import',
      payload: { content: '#EXTM3U\n' },
    });
    expect(empty.statusCode).toBe(400);
    await app.close();
  });

  it('exports a smart playlist live and 404s for unknown ids', async () => {
    const db = freshDb();
    const app = await makeApp(db);
    const smart = createSmartPlaylist(db, {
      name: 'Smart',
      rules: [{ field: 'source', op: 'eq', value: 'spotify' }],
      sort: 'title:asc',
    });
    const exported = await app.inject({
      method: 'GET',
      url: `/api/playlists/${smart.id}/export.m3u8`,
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).toContain('spotify:track:t1');
    expect(exported.body).toContain('spotify:track:t2');

    const missing = await app.inject({
      method: 'GET',
      url: '/api/playlists/pl:rune:nope/export.m3u8',
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});

async function addTracks(
  db: Db,
  playlistId: string,
  trackIds: string[],
): Promise<RunePlaylistDetail> {
  const app = await makeApp(db);
  const res = await app.inject({
    method: 'POST',
    url: `/api/playlists/${playlistId}/tracks`,
    payload: { trackIds },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as RunePlaylistDetail;
  await app.close();
  return body;
}
