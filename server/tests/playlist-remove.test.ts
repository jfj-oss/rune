import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb, type Db } from '../src/db/index.js';
import { registerMyPlaylistRoutes } from '../src/myplaylists/index.js';
import { removeSpotifyPlaylistTracks } from '../src/api/spotifyPlaylistWrite.js';
import { SpotifyApi } from '../src/spotify/api.js';
import { ensureSpotifySchema } from '../src/spotify/auth.js';
import { ensureSpotifyLibrarySchema } from '../src/spotify/library-schema.js';
import { ensureOverlaySchema } from '../src/myplaylists/overlay.js';
import { fakeFetch, jsonResponse, type FetchCall } from './spotify-helpers.js';

process.env.LOG_LEVEL ??= 'silent';

const OWNED = 'pl:sp:owned';
const LIKED = 'pl:sp:liked';

interface SetupOptions {
  /** Scopes stored on the login (default: both playlist writes + library writes). */
  scopes?: string[];
  /** owner_id stored on the playlist (default: the signed-in user's id). */
  ownerId?: string;
  collaborative?: boolean;
  /** Fail the request that changes Spotify with this status. */
  fail?: { status: number; retryAfter?: string };
}

const ALL_SCOPES = [
  'playlist-modify-private',
  'playlist-modify-public',
  'user-library-modify',
];

function seed(db: Db, opts: SetupOptions = {}): void {
  ensureSpotifySchema(db);
  ensureSpotifyLibrarySchema(db);
  ensureOverlaySchema(db);
  db.prepare(
    `INSERT INTO spotify_auth
       (id, access_token, refresh_token, token_type, scope, expires_at, user_id, user_name, updated_at)
     VALUES (1, 'access', 'refresh', 'Bearer', ?, 9999999999999, 'me', 'Me', 0)`,
  ).run((opts.scopes ?? ALL_SCOPES).join(' '));

  db.prepare("INSERT INTO artists (id, name) VALUES ('ar:sp:a', 'A')").run();
  db.prepare(
    "INSERT INTO albums (id, source, title, artist_id, in_library, added_at) VALUES ('sp:al', 'spotify', 'Album', 'ar:sp:a', 0, 0)",
  ).run();
  const track = db.prepare(
    "INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms) VALUES (?, 'sp:al', 'spotify', ?, 1, 1, 1000)",
  );
  for (const id of ['t1', 't2', 't3']) track.run(`sp:${id}`, id);

  insertPlaylist(db, OWNED, opts);
  insertPlaylist(db, LIKED, opts);
}

function insertPlaylist(db: Db, id: string, opts: SetupOptions): void {
  db.prepare(
    `INSERT INTO playlists
       (id, source, name, owner, owner_id, collaborative, snapshot_id, track_count, position, updated_at)
     VALUES (?, 'spotify', ?, 'Me', ?, ?, 'snap1', 0, 0, 0)`,
  ).run(id, id === LIKED ? 'Liked Songs' : 'Owned', opts.ownerId ?? 'me', opts.collaborative ? 1 : 0);
}

/** Store playlist entries in order, keeping track_count in step. */
function addEntries(db: Db, playlistId: string, trackIds: string[]): void {
  const insert = db.prepare(
    'INSERT INTO playlist_tracks (playlist_id, position, track_id, added_at) VALUES (?, ?, ?, 1000)',
  );
  trackIds.forEach((trackId, position) => insert.run(playlistId, position, trackId));
  db.prepare('UPDATE playlists SET track_count = ? WHERE id = ?').run(trackIds.length, playlistId);
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function setup(opts: SetupOptions = {}) {
  const db = openDb(':memory:');
  seed(db, opts);
  let changes = 0;
  const { fetch, calls } = fakeFetch((url, init) => {
    const method = init?.method ?? 'GET';
    if (opts.fail) {
      return jsonResponse(
        opts.fail.status,
        { error: 'no' },
        opts.fail.retryAfter ? { 'retry-after': opts.fail.retryAfter } : {},
      );
    }
    if (method === 'DELETE' && url.pathname.startsWith('/v1/playlists/') && url.pathname.endsWith('/items')) {
      return jsonResponse(200, { snapshot_id: 'snap-after' });
    }
    if (method === 'DELETE' && url.pathname === '/v1/me/library') {
      return jsonResponse(204, '');
    }
    return jsonResponse(404, { error: `unexpected ${method} ${url.pathname}` });
  });
  const api = new SpotifyApi({ fetch, getToken: async () => 'token', baseUrl: 'http://api.test/v1' });
  app = Fastify();
  await app.register(
    async (r) =>
      registerMyPlaylistRoutes(r, db, {
        removeFromSpotifyPlaylist: (playlistId, trackIds) =>
          removeSpotifyPlaylistTracks(
            {
              auth: {
                status: () => ({ connected: true, configured: true }),
                grantedScopes: () => opts.scopes ?? ALL_SCOPES,
              },
              api,
              db,
              onChange: () => {
                changes++;
              },
            },
            playlistId,
            trackIds,
          ),
      }),
    { prefix: '/api' },
  );
  return { db, calls, changes: () => changes };
}

const entries = (db: Db, playlistId: string) =>
  db
    .prepare('SELECT position, track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position')
    .all(playlistId) as { position: number; track_id: string }[];

const playlistRow = (db: Db, id: string) =>
  db.prepare('SELECT track_count, snapshot_id FROM playlists WHERE id = ?').get(id) as {
    track_count: number;
    snapshot_id: string | null;
  };

const itemDeletes = (calls: FetchCall[]) =>
  calls.filter(
    (c) =>
      (c.init?.method ?? 'GET') === 'DELETE' &&
      c.url.pathname.startsWith('/v1/playlists/') &&
      c.url.pathname.endsWith('/items'),
  );

const libraryDeletes = (calls: FetchCall[]) =>
  calls.filter(
    (c) => (c.init?.method ?? 'GET') === 'DELETE' && c.url.pathname === '/v1/me/library',
  );

function jsonBody(call: FetchCall | undefined): unknown {
  return JSON.parse(String(call?.init?.body ?? 'null')) as unknown;
}

describe('DELETE /playlists/:id/tracks on an owned Spotify playlist', () => {
  it('removes the song through /playlists/{id}/items with its snapshot and mirrors it locally', async () => {
    const s = await setup();
    addEntries(s.db, OWNED, ['sp:t1', 'sp:t2', 'sp:t3']);

    const res = await app!.inject({
      method: 'DELETE',
      url: `/api/playlists/${encodeURIComponent(OWNED)}/tracks`,
      payload: { positions: [1] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().tracks.map((t: { id: string }) => t.id)).toEqual(['sp:t1', 'sp:t3']);

    const deletes = itemDeletes(s.calls);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.url.pathname).toBe('/v1/playlists/owned/items');
    expect(jsonBody(deletes[0])).toEqual({
      items: [{ uri: 'spotify:track:t2' }],
      snapshot_id: 'snap1',
    });

    expect(entries(s.db, OWNED)).toEqual([
      { position: 0, track_id: 'sp:t1' },
      { position: 1, track_id: 'sp:t3' },
    ]);
    expect(playlistRow(s.db, OWNED)).toEqual({ track_count: 2, snapshot_id: 'snap-after' });
    expect(s.changes()).toBe(1);
  });

  it('accepts the entry ids the web client sends for merged rows', async () => {
    const s = await setup();
    addEntries(s.db, OWNED, ['sp:t1', 'sp:t2']);

    const res = await app!.inject({
      method: 'DELETE',
      url: `/api/playlists/${encodeURIComponent(OWNED)}/tracks`,
      payload: { entryIds: ['sp:sp:t2#0'] },
    });

    expect(res.statusCode).toBe(200);
    expect(jsonBody(itemDeletes(s.calls)[0])).toEqual({
      items: [{ uri: 'spotify:track:t2' }],
      snapshot_id: 'snap1',
    });
    expect(entries(s.db, OWNED)).toEqual([{ position: 0, track_id: 'sp:t1' }]);
  });

  it('allows a collaborative playlist owned by someone else', async () => {
    const s = await setup({ ownerId: 'someone-else', collaborative: true });
    addEntries(s.db, OWNED, ['sp:t1', 'sp:t2']);

    const res = await app!.inject({
      method: 'DELETE',
      url: `/api/playlists/${encodeURIComponent(OWNED)}/tracks`,
      payload: { positions: [1] },
    });

    expect(res.statusCode).toBe(200);
    expect(jsonBody(itemDeletes(s.calls)[0])).toMatchObject({
      items: [{ uri: 'spotify:track:t2' }],
    });
    expect(entries(s.db, OWNED)).toEqual([{ position: 0, track_id: 'sp:t1' }]);
  });
});

describe('duplicate copies', () => {
  it('removes every local copy when Spotify removes every copy of the URI', async () => {
    const s = await setup();
    addEntries(s.db, OWNED, ['sp:t1', 'sp:t2', 'sp:t3', 'sp:t2']);

    const res = await app!.inject({
      method: 'DELETE',
      url: `/api/playlists/${encodeURIComponent(OWNED)}/tracks`,
      payload: { positions: [1] }, // the first copy; Spotify drops both
    });

    expect(res.statusCode).toBe(200);
    // one URI in the request, but both copies are gone locally
    expect(jsonBody(itemDeletes(s.calls)[0])).toMatchObject({
      items: [{ uri: 'spotify:track:t2' }],
    });
    expect(entries(s.db, OWNED)).toEqual([
      { position: 0, track_id: 'sp:t1' },
      { position: 1, track_id: 'sp:t3' },
    ]);
    expect(playlistRow(s.db, OWNED).track_count).toBe(2);
  });
});

describe('Liked Songs', () => {
  it('removing a row unlikes it through DELETE /me/library', async () => {
    const s = await setup();
    addEntries(s.db, LIKED, ['sp:t1', 'sp:t2']);

    const res = await app!.inject({
      method: 'DELETE',
      url: `/api/playlists/${encodeURIComponent(LIKED)}/tracks`,
      payload: { positions: [0] },
    });

    expect(res.statusCode).toBe(200);
    expect(itemDeletes(s.calls)).toHaveLength(0);
    const deletes = libraryDeletes(s.calls);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.url.searchParams.get('uris')).toBe('spotify:track:t1');
    expect(entries(s.db, LIKED)).toEqual([{ position: 0, track_id: 'sp:t2' }]);
    expect(playlistRow(s.db, LIKED).track_count).toBe(1);
  });

  it('needs the library-modify scope', async () => {
    const s = await setup({ scopes: ['playlist-modify-private'] });
    addEntries(s.db, LIKED, ['sp:t1']);

    const res = await app!.inject({
      method: 'DELETE',
      url: `/api/playlists/${encodeURIComponent(LIKED)}/tracks`,
      payload: { positions: [0] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Reconnect Spotify.*unlike/i);
    expect(s.calls).toHaveLength(0);
    expect(entries(s.db, LIKED)).toEqual([{ position: 0, track_id: 'sp:t1' }]);
  });
});

describe('playlists the user may not edit', () => {
  it('refuses Spotify rows server-side without calling Spotify', async () => {
    const s = await setup({ ownerId: 'someone-else' });
    addEntries(s.db, OWNED, ['sp:t1', 'sp:t2']);

    const res = await app!.inject({
      method: 'DELETE',
      url: `/api/playlists/${encodeURIComponent(OWNED)}/tracks`,
      payload: { positions: [0] },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/not yours|collaborative/i);
    expect(s.calls).toHaveLength(0);
    expect(entries(s.db, OWNED)).toHaveLength(2);
    expect(s.changes()).toBe(0);
  });

  it('still removes rune overlay rows locally', async () => {
    const s = await setup({ ownerId: 'someone-else' });
    addEntries(s.db, OWNED, ['sp:t1']);
    s.db
      .prepare(
        `INSERT INTO playlist_overlay (id, playlist_id, track_id, anchor_track_id, anchor_occurrence, added_at)
         VALUES ('ovl:1', ?, 'sp:t2', 'sp:t1', 0, 1000)`,
      )
      .run(OWNED);

    const res = await app!.inject({
      method: 'DELETE',
      url: `/api/playlists/${encodeURIComponent(OWNED)}/tracks`,
      payload: { entryIds: ['ovl:1'] },
    });

    expect(res.statusCode).toBe(200);
    expect(s.calls).toHaveLength(0);
    expect(res.json().tracks.map((t: { id: string }) => t.id)).toEqual(['sp:t1']);
  });
});

describe('missing Spotify permission', () => {
  it('answers "reconnect Spotify" and changes nothing when playlist writes were not granted', async () => {
    const s = await setup({ scopes: ['user-library-modify'] });
    addEntries(s.db, OWNED, ['sp:t1']);

    const res = await app!.inject({
      method: 'DELETE',
      url: `/api/playlists/${encodeURIComponent(OWNED)}/tracks`,
      payload: { positions: [0] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Reconnect Spotify.*remove songs/i);
    expect(s.calls).toHaveLength(0);
    expect(entries(s.db, OWNED)).toHaveLength(1);
  });
});

describe('Spotify rate limit', () => {
  it('reports 429 and leaves the local mirror alone', async () => {
    const s = await setup({ fail: { status: 429, retryAfter: '120' } });
    addEntries(s.db, OWNED, ['sp:t1', 'sp:t2']);

    const res = await app!.inject({
      method: 'DELETE',
      url: `/api/playlists/${encodeURIComponent(OWNED)}/tracks`,
      payload: { positions: [1] },
    });

    expect(res.statusCode).toBe(429);
    expect(res.json().error).toMatch(/rate limit/i);
    expect(entries(s.db, OWNED)).toEqual([
      { position: 0, track_id: 'sp:t1' },
      { position: 1, track_id: 'sp:t2' },
    ]);
    expect(playlistRow(s.db, OWNED)).toEqual({ track_count: 2, snapshot_id: 'snap1' });
    expect(s.changes()).toBe(0);
  });
});
