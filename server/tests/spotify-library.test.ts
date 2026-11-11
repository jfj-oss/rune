import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/api/server.js';
import {
  SpotifyApi,
  type SpotifyAlbum,
  type SpotifyPlaylist,
  type SpotifyPlaylistTrack,
  type SpotifyTrack,
} from '../src/spotify/api.js';
import { openDb, type Db } from '../src/db/index.js';
import { ensureSpotifySchema } from '../src/spotify/auth.js';
import { SpotifyCatalog, mergeSearchResults } from '../src/spotify/catalog.js';
import {
  fetchSpotifyAlbum,
  spotifyAlbumIsFull,
  getPlaylist,
  listPlaylists,
  setSpotifyAlbumSaved,
  syncPlaylists,
  LIKED_FULL_SYNC_TTL_MS,
} from '../src/spotify/library.js';
import { ensureSpotifyLibrarySchema } from '../src/spotify/library-schema.js';
import { syncSavedAlbums } from '../src/spotify/map.js';
import { getAlbum, listAlbums, search } from '../src/api/library.js';
import {
  ABBEY_COVER,
  BEATLES,
  TEST_CONFIG,
  fakeFetch,
  jsonResponse,
  paging,
  sampleAlbum,
  sampleTrack,
} from './spotify-helpers.js';

// The route-level test builds the real app; keep its request logging out of the output.
process.env.LOG_LEVEL ??= 'silent';

function freshDb(): Db {
  const db = openDb(':memory:');
  ensureSpotifySchema(db);
  ensureSpotifyLibrarySchema(db);
  return db;
}

function count(db: Db, table: string, where = '', ...args: unknown[]): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`).get(...args) as {
      n: number;
    }
  ).n;
}

function inLibrary(db: Db, albumId: string): number | undefined {
  const row = db.prepare('SELECT in_library FROM albums WHERE id = ?').get(albumId) as
    | { in_library: number }
    | undefined;
  return row?.in_library;
}

const PLAYLIST: SpotifyPlaylist = {
  id: 'pl1',
  name: 'Morning Mix',
  description: 'Wake up',
  images: [
    { url: 'http://img.example/pl-64.jpg', width: 64, height: 64 },
    { url: 'http://img.example/pl-640.jpg', width: 640, height: 640 },
  ],
  owner: { id: 'listener', display_name: 'Listener' },
  snapshot_id: 'snap-1',
  tracks: { total: 2 },
};

function entry(
  track: SpotifyTrack | null,
  addedAt = '2024-05-01T12:00:00Z',
  isLocal = false,
): SpotifyPlaylistTrack {
  return { added_at: addedAt, is_local: isLocal, track };
}

describe('syncPlaylists', () => {
  it('stores playlists + tracks, skips local/episode/null entries, and skips unchanged snapshots', async () => {
    const db = freshDb();
    const episode = { ...sampleTrack('ep1'), type: 'episode' } as SpotifyTrack;
    let playlistTrackFetches = 0;

    const source = {
      allPlaylists: async () => [PLAYLIST],
      allPlaylistTracks: async (id: string) => {
        expect(id).toBe('pl1');
        playlistTrackFetches++;
        return [
          entry(sampleTrack('t1', 1, 'Come Together')),
          entry(null),
          entry(sampleTrack('local1'), '2024-05-02T00:00:00Z', true),
          entry(episode),
          entry(sampleTrack('t2', 2, 'Something')),
        ];
      },
      allSavedTracks: async () => [],
    };

    const first = await syncPlaylists(source, db);
    expect(first).toEqual({ playlists: 2, tracks: 2, liked: 0, removed: 0 });
    expect(playlistTrackFetches).toBe(1);

    const rows = db
      .prepare(
        'SELECT id, name, owner, image_url, snapshot_id, track_count, position FROM playlists ORDER BY position',
      )
      .all();
    expect(rows).toEqual([
      {
        id: 'pl:sp:liked',
        name: 'Liked Songs',
        owner: null,
        image_url: null,
        snapshot_id: null,
        track_count: 0,
        position: 0,
      },
      {
        id: 'pl:sp:pl1',
        name: 'Morning Mix',
        owner: 'Listener',
        image_url: 'http://img.example/pl-640.jpg',
        snapshot_id: 'snap-1',
        track_count: 2,
        position: 1,
      },
    ]);

    expect(
      db
        .prepare('SELECT track_id, position FROM playlist_tracks WHERE playlist_id = ? ORDER BY position')
        .all('pl:sp:pl1'),
    ).toEqual([
      { track_id: 'sp:t1', position: 0 },
      { track_id: 'sp:t2', position: 1 },
    ]);

    // Albums referenced only by a playlist are stored but hidden from the library.
    expect(inLibrary(db, 'sp:abbey')).toBe(0);
    expect(count(db, 'tracks')).toBe(2);
    expect(count(db, 'artists')).toBe(1);

    // Unchanged snapshot: metadata refreshes, tracks are not refetched.
    const second = await syncPlaylists(
      {
        ...source,
        allPlaylists: async () => [{ ...PLAYLIST, name: 'Morning Mix (renamed)' }],
      },
      db,
    );
    expect(playlistTrackFetches).toBe(1);
    expect(second).toEqual({ playlists: 2, tracks: 0, liked: 0, removed: 0 });
    expect(db.prepare('SELECT name, track_count FROM playlists WHERE id = ?').get('pl:sp:pl1')).toEqual({
      name: 'Morning Mix (renamed)',
      track_count: 2,
    });

    // Changed snapshot: refetch and replace the entries.
    const third = await syncPlaylists(
      {
        ...source,
        allPlaylists: async () => [{ ...PLAYLIST, snapshot_id: 'snap-2' }],
        allPlaylistTracks: async () => [entry(sampleTrack('t2'))],
      },
      db,
    );
    expect(playlistTrackFetches).toBe(1); // this source has its own counter
    expect(third).toEqual({ playlists: 2, tracks: 1, liked: 0, removed: 0 });
    expect(
      db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ?').all('pl:sp:pl1'),
    ).toEqual([{ track_id: 'sp:t2' }]);
    expect(db.prepare('SELECT track_count FROM playlists WHERE id = ?').get('pl:sp:pl1')).toEqual({
      track_count: 1,
    });
  });

  it('probes Liked Songs and skips the full pass while unchanged and fresh', async () => {
    const db = freshDb();
    let clock = Date.parse('2024-06-01T00:00:00Z');
    const now = () => clock;
    let probeTotal = 1;
    let probeItems = [{ added_at: '2024-05-01T00:00:00Z', track: sampleTrack('t1') }];
    let all = probeItems;
    const counts = { probe: 0, full: 0 };
    const source = {
      allPlaylists: async () => [],
      allPlaylistTracks: async () => [],
      savedTracks: async () => {
        counts.probe++;
        return paging(probeItems, { total: probeTotal });
      },
      allSavedTracks: async () => {
        counts.full++;
        return all;
      },
    };
    const changes = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;

    const first = await syncPlaylists(source, db, { now });
    expect(first.liked).toBe(1);
    expect(counts).toEqual({ probe: 1, full: 1 });

    // Unchanged + under 24 h: exactly one request (the probe) and no DB writes at all.
    const beforeWrites = changes();
    const second = await syncPlaylists(source, db, { now });
    expect(counts).toEqual({ probe: 2, full: 1 });
    expect(second).toEqual({ playlists: 0, tracks: 0, liked: 0, removed: 0 });
    expect(changes()).toBe(beforeWrites);
    expect(count(db, 'playlist_tracks', 'playlist_id = ?', 'pl:sp:liked')).toBe(1);

    // Total / newest added_at changed: full pass as before.
    probeTotal = 2;
    probeItems = [{ added_at: '2024-06-01T00:00:00Z', track: sampleTrack('t2') }];
    all = [...probeItems, { added_at: '2024-05-01T00:00:00Z', track: sampleTrack('t1') }];
    const third = await syncPlaylists(source, db, { now });
    expect(counts).toEqual({ probe: 3, full: 2 });
    expect(third.liked).toBe(2);
    expect(getPlaylist(db, 'pl:sp:liked')?.tracks.map((t) => t.id)).toEqual(['sp:t2', 'sp:t1']);

    // Unchanged but the last full pass is older than the safety-net TTL (a week): full pass again. A day is not enough.
    clock += 24 * 60 * 60_000 + 1;
    await syncPlaylists(source, db, { now });
    expect(counts).toEqual({ probe: 4, full: 2 });
    clock += LIKED_FULL_SYNC_TTL_MS;
    await syncPlaylists(source, db, { now });
    expect(counts).toEqual({ probe: 5, full: 3 });
  });

  it('stores Liked Songs as a virtual playlist and removes playlists Spotify no longer returns', async () => {
    const db = freshDb();
    const source = {
      allPlaylists: async () => [PLAYLIST],
      allPlaylistTracks: async () => [entry(sampleTrack('t1'))],
      allSavedTracks: async () => [
        { added_at: '2024-01-01T00:00:00Z', track: sampleTrack('t1', 1, 'Come Together') },
        { added_at: '2024-01-02T00:00:00Z', track: null },
        { added_at: '2024-01-03T00:00:00Z', track: { ...sampleTrack('t2'), is_local: true } },
        { added_at: '2024-01-04T00:00:00Z', track: { ...sampleTrack('t3'), type: 'episode' } },
      ],
    };
    const result = await syncPlaylists(source, db);
    expect(result).toEqual({ playlists: 2, tracks: 2, liked: 1, removed: 0 });

    const summaries = listPlaylists(db);
    expect(summaries[0]).toEqual({
      id: 'pl:sp:liked',
      name: 'Liked Songs',
      imageUrl: ABBEY_COVER,
      trackCount: 1,
      source: 'spotify',
      canEdit: true, // liked songs can be unliked
    });
    expect(summaries[1]?.id).toBe('pl:sp:pl1');

    const liked = getPlaylist(db, 'pl:sp:liked');
    expect(liked?.tracks.map((t) => t.id)).toEqual(['sp:t1']);
    expect(liked?.tracks[0]?.album).toEqual({
      id: 'sp:abbey',
      title: 'Abbey Road',
      // Spotify stores an absolute CDN URL: return it instead of a redirect hop.
      coverUrl: ABBEY_COVER,
    });
    expect(liked?.tracks[0]?.spotifyUri).toBe('spotify:track:t1');

    // Spotify stops returning the user playlist.
    const removed = await syncPlaylists(
      { allPlaylists: async () => [], allPlaylistTracks: async () => [], allSavedTracks: async () => [] },
      db,
    );
    expect(removed.removed).toBe(1);
    expect(listPlaylists(db).map((p) => p.id)).toEqual(['pl:sp:liked']);
    expect(count(db, 'playlist_tracks', 'playlist_id = ?', 'pl:sp:pl1')).toBe(0);
  });
});

describe('albums.in_library bookkeeping', () => {
  it('keeps an unsaved album that a playlist references, then deletes it once unreferenced', async () => {
    const db = freshDb();
    const savedSource = {
      allSavedAlbums: async () => [{ added_at: '2024-01-01T00:00:00Z', album: sampleAlbum() }],
      allAlbumTracks: async () => [],
    };
    await syncSavedAlbums(savedSource, db);
    expect(inLibrary(db, 'sp:abbey')).toBe(1);

    await syncPlaylists(
      {
        allPlaylists: async () => [PLAYLIST],
        allPlaylistTracks: async () => [entry(sampleTrack('t1')), entry(sampleTrack('t2'))],
        allSavedTracks: async () => [],
      },
      db,
    );

    // Unsave: still referenced by the playlist -> hidden (0), not deleted.
    const afterUnsave = await syncSavedAlbums(
      { allSavedAlbums: async () => [], allAlbumTracks: async () => [] },
      db,
    );
    expect(afterUnsave.removed).toBe(0);
    expect(inLibrary(db, 'sp:abbey')).toBe(0);
    expect(count(db, 'albums')).toBe(1);
    expect(count(db, 'tracks')).toBe(2);

    // Playlist gone, still unsaved -> unreferenced, so it is deleted with its FTS rows.
    await syncPlaylists(
      { allPlaylists: async () => [], allPlaylistTracks: async () => [], allSavedTracks: async () => [] },
      db,
    );
    const afterPlaylistRemoval = await syncSavedAlbums(
      { allSavedAlbums: async () => [], allAlbumTracks: async () => [] },
      db,
    );
    expect(afterPlaylistRemoval.removed).toBe(1);
    expect(count(db, 'albums')).toBe(0);
    expect(count(db, 'tracks')).toBe(0);
    expect(
      count(db, 'search_fts', "ref_id IN ('sp:abbey', 'sp:t1', 'sp:t2')"),
    ).toBe(0);
  });

  it('flips an album back to in_library = 1 when it is saved again', async () => {
    const db = freshDb();
    await syncPlaylists(
      {
        allPlaylists: async () => [PLAYLIST],
        allPlaylistTracks: async () => [entry(sampleTrack('t1'))],
        allSavedTracks: async () => [],
      },
      db,
    );
    expect(inLibrary(db, 'sp:abbey')).toBe(0);
    await syncSavedAlbums(
      {
        allSavedAlbums: async () => [{ added_at: '2024-01-01T00:00:00Z', album: sampleAlbum() }],
        allAlbumTracks: async () => [],
      },
      db,
    );
    expect(inLibrary(db, 'sp:abbey')).toBe(1);
  });
});

describe('library reads', () => {
  it('applies the playlist/in_library migration lazily on a schema-only database', () => {
    const db = openDb(':memory:');
    expect(listAlbums(db, {}).total).toBe(0);
    const columns = (db.prepare('PRAGMA table_info(albums)').all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain('in_library');
    expect(count(db, 'playlists')).toBe(0);
  });

  it('hides in_library = 0 albums from listings/search but keeps album pages addressable', async () => {
    const db = freshDb();
    await syncPlaylists(
      {
        allPlaylists: async () => [PLAYLIST],
        allPlaylistTracks: async () => [entry(sampleTrack('t1')), entry(sampleTrack('t2'))],
        allSavedTracks: async () => [],
      },
      db,
    );

    expect(listAlbums(db, {}).total).toBe(0);
    expect(listAlbums(db, { inLibrary: false }).total).toBe(1);
    expect(getAlbum(db, 'sp:abbey')?.title).toBe('Abbey Road');

    const hidden = search(db, 'abbey');
    expect(hidden.albums).toEqual([]);
    expect(hidden.tracks).toEqual([]);

    db.prepare('UPDATE albums SET in_library = 1 WHERE id = ?').run('sp:abbey');
    expect(listAlbums(db, {}).total).toBe(1);
    expect(search(db, 'abbey').albums.map((a) => a.id)).toEqual(['sp:abbey']);
    expect(search(db, 'abbey').tracks.map((t) => t.id).sort()).toEqual(['sp:t1', 'sp:t2']);
  });
});

describe('Spotify catalogue search', () => {
  it('merges local results first and de-duplicates ids and artist names', () => {
    const localAlbum = {
      id: 'sp:abbey',
      source: 'spotify' as const,
      title: 'Abbey Road',
      artist: { id: 'ar:sp:beatles-sp', name: 'The Beatles' },
      addedAt: 1,
    };
    const local = {
      albums: [localAlbum],
      artists: [{ id: 'ar:n:beatles', name: 'The Beatles' }],
      tracks: [
        {
          id: 'sp:t1',
          albumId: 'sp:abbey',
          source: 'spotify' as const,
          title: 'Come Together',
          artists: [{ id: 'ar:n:beatles', name: 'The Beatles' }],
          disc: 1,
          number: 1,
          durationMs: 1,
        },
      ],
    };
    const catalog = {
      albums: [
        { ...localAlbum, id: 'sp:letitbe', title: 'Let It Be', addedAt: 2 },
        { ...localAlbum, id: 'sp:searchonly', title: 'Search Only', addedAt: 3 },
      ],
      artists: [
        { id: 'ar:sp:beatles-sp', name: 'The Beatles' },
        { id: 'ar:sp:new-sp', name: 'Brand New' },
      ],
      tracks: [
        {
          id: 'sp:t1',
          albumId: 'sp:abbey',
          source: 'spotify' as const,
          title: 'Come Together',
          artists: [],
          disc: 1,
          number: 1,
          durationMs: 1,
        },
        {
          id: 'sp:t9',
          albumId: 'sp:searchonly',
          source: 'spotify' as const,
          title: 'New Song',
          artists: [],
          disc: 1,
          number: 1,
          durationMs: 1,
        },
      ],
    };

    const merged = mergeSearchResults(local, catalog);
    expect(merged.albums.map((a) => a.id)).toEqual(['sp:abbey', 'sp:letitbe', 'sp:searchonly']);
    expect(merged.artists).toEqual([
      { id: 'ar:n:beatles', name: 'The Beatles' },
      { id: 'ar:sp:new-sp', name: 'Brand New' },
    ]);
    expect(merged.tracks.map((t) => t.id)).toEqual(['sp:t1', 'sp:t9']);
  });

  it('caches identical queries for 60 s and maps Spotify shapes', async () => {
    let calls = 0;
    let clock = 1_000;
    const catalog = new SpotifyCatalog(
      {
        search: async (q) => {
          calls++;
          expect(q.toLowerCase()).toBe('abbey');
          return {
            albums: paging([sampleAlbum()]),
            artists: paging([BEATLES]),
            tracks: paging([sampleTrack('t1')]),
          };
        },
      },
      { now: () => clock },
    );

    const first = await catalog.search('Abbey');
    const second = await catalog.search('  abbey ');
    expect(calls).toBe(1);
    expect(second).toBe(first);
    expect(first.albums[0]).toMatchObject({
      id: 'sp:abbey',
      source: 'spotify',
      title: 'Abbey Road',
      coverUrl: 'http://img.example/abbey-640.jpg',
    });
    expect(first.artists).toEqual([{ id: 'ar:sp:beatles-sp', name: 'The Beatles' }]);
    expect(first.tracks[0]).toMatchObject({ id: 'sp:t1', source: 'spotify' });

    clock += 60_001;
    await catalog.search('abbey');
    expect(calls).toBe(2);
  });
});

describe('on-demand album fetch + save/unsave', () => {
  it('fetches an unknown album, stores it with in_library = 0, and follows track pagination', async () => {
    const db = freshDb();
    const album: SpotifyAlbum = sampleAlbum({
      id: 'fetchme',
      name: 'Fetch Me',
      tracks: paging([sampleTrack('f1')], { total: 2, next: 'http://api.test/v1/albums/fetchme/tracks?offset=1' }),
    });
    let allTracksCalls = 0;
    const api = {
      album: async (id: string) => {
        expect(id).toBe('fetchme');
        return album;
      },
      allAlbumTracks: async () => {
        allTracksCalls++;
        return [sampleTrack('f1', 1, 'First'), sampleTrack('f2', 2, 'Second')];
      },
    };

    const fetched = await fetchSpotifyAlbum(api, db, 'sp:fetchme');
    expect(allTracksCalls).toBe(1);
    expect(fetched?.id).toBe('sp:fetchme');
    expect(fetched?.tracks.map((t) => t.id)).toEqual(['sp:f1', 'sp:f2']);
    expect(fetched?.source).toBe('spotify');
    expect(inLibrary(db, 'sp:fetchme')).toBe(0);
    expect(listAlbums(db, {}).total).toBe(0);
    expect(listAlbums(db, { inLibrary: false }).total).toBe(1);
    expect(spotifyAlbumIsFull(db, 'sp:fetchme')).toBe(true);
    expect(spotifyAlbumIsFull(db, 'sp:other')).toBe(false);

    // Non-Spotify ids are not fetched.
    await expect(fetchSpotifyAlbum(api, db, 'la:local')).resolves.toBeUndefined();
  });

  it('calls PUT/DELETE /me/albums semantics and flips in_library', async () => {
    const db = freshDb();
    await fetchSpotifyAlbum(
      { album: async () => sampleAlbum(), allAlbumTracks: async () => [] },
      db,
      'sp:abbey',
    );
    expect(inLibrary(db, 'sp:abbey')).toBe(0);

    const saved: string[][] = [];
    const removed: string[][] = [];
    const api = {
      saveAlbums: async (ids: string[]) => {
        saved.push(ids);
      },
      removeSavedAlbums: async (ids: string[]) => {
        removed.push(ids);
      },
    };

    await expect(setSpotifyAlbumSaved(api, db, 'sp:abbey', true)).resolves.toBe(true);
    expect(saved).toEqual([['abbey']]);
    expect(inLibrary(db, 'sp:abbey')).toBe(1);

    await expect(setSpotifyAlbumSaved(api, db, 'sp:abbey', false)).resolves.toBe(true);
    expect(removed).toEqual([['abbey']]);
    expect(inLibrary(db, 'sp:abbey')).toBe(0);

    // Unknown album: the Spotify call still happens, but nothing local changes.
    await expect(setSpotifyAlbumSaved(api, db, 'sp:missing', true)).resolves.toBe(false);
    expect(saved).toEqual([['abbey'], ['missing']]);
  });
});

describe('SpotifyApi playlist/library endpoints', () => {
  it('follows pagination for playlists, liked songs and playlist tracks', async () => {
    const { fetch, calls } = fakeFetch((url) => {
      const offset = url.searchParams.get('offset') ?? '0';
      if (url.pathname === '/v1/me/playlists') {
        return offset === '0'
          ? jsonResponse(200, paging([PLAYLIST], { total: 2, next: 'http://api.test/v1/me/playlists?offset=50' }))
          : jsonResponse(200, paging([{ ...PLAYLIST, id: 'pl2', snapshot_id: 'snap-2' }], { total: 2, offset: 50 }));
      }
      if (url.pathname === '/v1/me/tracks') {
        return offset === '0'
          ? jsonResponse(
              200,
              paging([{ added_at: '2024-01-01T00:00:00Z', track: sampleTrack('t1') }], {
                total: 2,
                next: 'http://api.test/v1/me/tracks?offset=50',
              }),
            )
          : jsonResponse(
              200,
              paging([{ added_at: '2024-01-02T00:00:00Z', track: sampleTrack('t2') }], { total: 2, offset: 50 }),
            );
      }
      if (url.pathname === '/v1/playlists/pl1/items') {
        return offset === '0'
          ? jsonResponse(
              200,
              paging([entry(sampleTrack('t1'))], { total: 2, next: 'http://api.test/v1/playlists/pl1/items?offset=50' }),
            )
          : jsonResponse(200, paging([entry(sampleTrack('t2'))], { total: 2, offset: 50 }));
      }
      return jsonResponse(404, { error: `unexpected ${url.pathname}` });
    });
    const api = new SpotifyApi({ fetch, getToken: async () => 'token', baseUrl: 'http://api.test/v1' });

    expect((await api.allPlaylists()).map((p) => p.id)).toEqual(['pl1', 'pl2']);
    expect((await api.allSavedTracks()).map((s) => s.track?.id)).toEqual(['t1', 't2']);
    expect((await api.allPlaylistTracks('pl1')).map((e) => e.track?.id)).toEqual(['t1', 't2']);
    expect(calls.every((c) => c.url.searchParams.get('limit') === '50')).toBe(true);
  });

  it('saves and removes through /me/library with album URIs', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(204, ''));
    const api = new SpotifyApi({ fetch, getToken: async () => 'token', baseUrl: 'http://api.test/v1' });

    await api.saveAlbums(['abbey', 'road']);
    await api.removeSavedAlbums(['abbey']);

    expect(calls.map((c) => c.init?.method)).toEqual(['PUT', 'DELETE']);
    expect(calls.map((c) => c.url.searchParams.get('uris'))).toEqual(['spotify:album:abbey,spotify:album:road', 'spotify:album:abbey']);
    expect(calls.every((c) => c.url.pathname === '/v1/me/library')).toBe(true);
  });
});

describe('HTTP routes (injected fake Spotify API)', () => {
  it('syncs playlists on request, merges catalogue search, fetches and saves albums', async () => {
    const db = freshDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO spotify_auth
         (id, access_token, refresh_token, token_type, scope, expires_at, updated_at)
       VALUES (1, 'access-token', 'refresh-token', 'Bearer', '', ?, ?)`,
    ).run(now + 60 * 60_000, now);

    const { fetch, calls } = fakeFetch((url, init) => {
      const method = init?.method ?? 'GET';
      switch (`${method} ${url.pathname}`) {
        case 'GET /v1/me/playlists':
          return jsonResponse(200, paging([PLAYLIST]));
        case 'GET /v1/playlists/pl1/items':
          return jsonResponse(200, paging([entry(sampleTrack('t1'))]));
        case 'GET /v1/me/tracks':
          return jsonResponse(200, paging([{ added_at: '2024-01-01T00:00:00Z', track: sampleTrack('t2') }]));
        case 'GET /v1/me/albums':
          return jsonResponse(200, paging([]));
        case 'GET /v1/albums/fetchme':
          return jsonResponse(200, sampleAlbum({ id: 'fetchme', name: 'Fetch Me' }));
        case 'GET /v1/search':
          return jsonResponse(200, {
            albums: paging([sampleAlbum()]),
            artists: paging([BEATLES]),
            tracks: paging([sampleTrack('t1')]),
          });
        case 'PUT /v1/me/library':
        case 'DELETE /v1/me/library':
          return jsonResponse(204, '');
        default:
          return jsonResponse(404, { error: `unexpected ${method} ${url.pathname}` });
      }
    });

    const { app, close } = await buildApp(db, TEST_CONFIG, {
      pcZone: false,
      scanOnStart: false,
      spotifySyncOnStart: false,
      webDist: '/nonexistent-web-dist',
      spotifyOptions: {
        fetch,
        endpoints: { api: 'http://api.test/v1', accounts: 'http://accounts.test' },
      },
    });

    try {
      // Manual sync starts in the background; the route must not wait for it.
      const sync = await app.inject({ method: 'POST', url: '/api/spotify/sync' });
      expect(sync.statusCode).toBe(200);
      expect(sync.json()).toEqual({ started: true, running: true });

      await vi.waitFor(
        () => {
          expect(listPlaylists(db).map((p) => p.id)).toEqual(['pl:sp:liked', 'pl:sp:pl1']);
        },
        { timeout: 3000, interval: 20 },
      );

      const playlists = await app.inject({ method: 'GET', url: '/api/playlists' });
      expect(playlists.statusCode).toBe(200);
      expect(playlists.json()).toEqual([
        expect.objectContaining({ id: 'pl:sp:liked', name: 'Liked Songs', trackCount: 1, source: 'spotify' }),
        expect.objectContaining({ id: 'pl:sp:pl1', name: 'Morning Mix', owner: 'Listener', trackCount: 1 }),
      ]);

      const detail = await app.inject({ method: 'GET', url: '/api/playlists/pl:sp:pl1' });
      expect(detail.statusCode).toBe(200);
      const body = detail.json();
      expect(body.tracks).toHaveLength(1);
      expect(body.tracks[0]).toMatchObject({
        id: 'sp:t1',
        title: 'Come Together',
        album: { id: 'sp:abbey', title: 'Abbey Road' },
      });
      expect(body.tracks[0].path).toBeUndefined();

      // Playlist-only albums are not in the library listing.
      expect((await app.inject({ method: 'GET', url: '/api/library/albums' })).json().total).toBe(0);

      // Local results (none here) would come first; catalogue results still show.
      const searchRes = await app.inject({ method: 'GET', url: '/api/search?q=abbey' });
      expect(searchRes.statusCode).toBe(200);
      expect(searchRes.json().albums[0]).toMatchObject({ id: 'sp:abbey', source: 'spotify' });
      expect(searchRes.json().tracks.map((t: { id: string }) => t.id)).toEqual(['sp:t1']);

      // On-demand album page for an album Spotify knows but the DB does not.
      const albumRes = await app.inject({ method: 'GET', url: '/api/albums/sp:fetchme' });
      expect(albumRes.statusCode).toBe(200);
      expect(albumRes.json()).toMatchObject({ id: 'sp:fetchme', title: 'Fetch Me', source: 'spotify' });
      expect(inLibrary(db, 'sp:fetchme')).toBe(0);

      const saved = await app.inject({ method: 'POST', url: '/api/albums/sp:fetchme/save' });
      expect(saved.statusCode).toBe(200);
      expect(inLibrary(db, 'sp:fetchme')).toBe(1);
      const put = calls.find((c) => (c.init?.method ?? 'GET') === 'PUT' && c.url.pathname === '/v1/me/library');
      expect(put?.url.searchParams.get('uris')).toBe('spotify:album:fetchme');

      const listed = (await app.inject({ method: 'GET', url: '/api/library/albums' })).json();
      expect(listed.total).toBe(1);
      expect(listed.items[0]).toMatchObject({ id: 'sp:fetchme', title: 'Fetch Me' });

      const unsaved = await app.inject({ method: 'DELETE', url: '/api/albums/sp:fetchme/save' });
      expect(unsaved.statusCode).toBe(200);
      expect(inLibrary(db, 'sp:fetchme')).toBe(0);
      const del = calls.find((c) => c.init?.method === 'DELETE' && c.url.pathname === '/v1/me/library');
      expect(del?.url.searchParams.get('uris')).toBe('spotify:album:fetchme');
      expect((await app.inject({ method: 'GET', url: '/api/library/albums' })).json().total).toBe(0);

      // Local (non-Spotify) album ids cannot be saved to Spotify.
      const local = await app.inject({ method: 'POST', url: '/api/albums/la:local/save' });
      expect(local.statusCode).toBe(400);
    } finally {
      await close();
    }
  });
});
