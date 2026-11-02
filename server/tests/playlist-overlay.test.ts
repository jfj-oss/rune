import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb, type Db } from '../src/db/index.js';
import { ensureMyPlaylistSchema } from '../src/myplaylists/schema.js';
import {
  getPlaylistDetail,
  listAllPlaylists,
  registerMyPlaylistRoutes,
  type RunePlaylistDetail,
} from '../src/myplaylists/index.js';
import { ensureOverlaySchema } from '../src/myplaylists/overlay.js';
import {
  getPlaylist,
  listPlaylists,
  syncPlaylists,
  type PlaylistSyncSource,
} from '../src/spotify/library.js';
import { ensureSpotifyLibrarySchema } from '../src/spotify/library-schema.js';
import type { SpotifyPlaylist, SpotifyTrack } from '../src/spotify/api.js';

const NOW = 1_700_000_000_000;
const MIX = 'pl:sp:mix';
const BASE_TRACKS = 12;

// ---------------------------------------------------------------- seed helpers

function seed(db: Db): void {
  ensureMyPlaylistSchema(db);
  ensureSpotifyLibrarySchema(db);
  db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)').run('ar:one', 'Overlay Artist');
  db.prepare(
    `INSERT INTO albums (id, source, title, artist_id, genres, format, added_at)
     VALUES ('sp:alb', 'spotify', 'Spotify Album', 'ar:one', '[]', 'Spotify', ?)`,
  ).run(NOW);
  db.prepare(
    `INSERT INTO albums (id, source, title, artist_id, genres, format, added_at)
     VALUES ('la:loc', 'local', 'Local Album', 'ar:one', '[]', 'FLAC 16/44.1', ?)`,
  ).run(NOW);

  const track = db.prepare(
    `INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms, format, path, spotify_uri)
     VALUES (?, ?, ?, ?, 1, ?, 180000, ?, ?, ?)`,
  );
  for (let i = 0; i < BASE_TRACKS; i++) {
    track.run(`sp:s${i}`, 'sp:alb', 'spotify', `Spotify ${i}`, i + 1, null, null, `spotify:track:s${i}`);
  }
  for (let i = 1; i <= 6; i++) {
    track.run(`l:${i}`, 'la:loc', 'local', `Local ${i}`, i, 'flac', `/music/local/${i}.flac`, null);
  }

  db.prepare(
    `INSERT INTO playlists
       (id, source, name, description, owner, image_url, snapshot_id, track_count, position, updated_at)
     VALUES (?, 'spotify', 'Mixed Mix', 'synced', 'Listener', NULL, 'snap-1', ?, 1, ?)`,
  ).run(MIX, BASE_TRACKS, NOW);
  const entry = db.prepare(
    'INSERT INTO playlist_tracks (playlist_id, position, track_id, added_at) VALUES (?, ?, ?, ?)',
  );
  for (let i = 0; i < BASE_TRACKS; i++) entry.run(MIX, i, `sp:s${i}`, NOW + i);
}

function freshDb(): Db {
  const db = openDb(':memory:');
  seed(db);
  return db;
}

async function makeApp(db: Db): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(
    async (r) => {
      registerMyPlaylistRoutes(r, db);
      // The main session wires these GETs in api/server.ts; mirrored so the tests
      // exercise the whole HTTP surface.
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

/** Replace the synced Spotify entries, like a resync with a changed snapshot. */
function rewriteBase(db: Db, trackIds: string[]): void {
  db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(MIX);
  const insert = db.prepare(
    'INSERT INTO playlist_tracks (playlist_id, position, track_id, added_at) VALUES (?, ?, ?, ?)',
  );
  trackIds.forEach((trackId, position) => insert.run(MIX, position, trackId, NOW + position));
  db.prepare('UPDATE playlists SET track_count = ? WHERE id = ?').run(trackIds.length, MIX);
}

async function addLocal(
  app: FastifyInstance,
  trackIds: string[],
  position?: number,
): Promise<RunePlaylistDetail> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/playlists/${MIX}/tracks`,
    payload: { trackIds, ...(position === undefined ? {} : { position }) },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as RunePlaylistDetail;
}

function spotifyTrack(id: string): SpotifyTrack {
  const artist = { id: 'artist-1', name: 'Overlay Artist' };
  return {
    id,
    name: `Spotify ${id}`,
    artists: [artist],
    album: {
      id: 'alb',
      name: 'Spotify Album',
      album_type: 'album',
      artists: [artist],
      images: [],
      release_date: '2023-01-01',
      release_date_precision: 'day',
      total_tracks: 1,
    },
    disc_number: 1,
    track_number: 1,
    duration_ms: 180000,
    uri: `spotify:track:${id}`,
  };
}

/** A fake Spotify account whose one playlist has the given tracks and snapshot. */
function spotifySource(trackIds: string[], snapshotId: string): PlaylistSyncSource {
  const playlist: SpotifyPlaylist = {
    id: 'mix',
    name: 'Mixed Mix',
    description: 'synced',
    owner: { id: 'listener', display_name: 'Listener' },
    snapshot_id: snapshotId,
    tracks: { total: trackIds.length },
  };
  return {
    allPlaylists: async () => [playlist],
    allPlaylistTracks: async () =>
      trackIds.map((id, index) => ({
        added_at: new Date(NOW + index).toISOString(),
        track: spotifyTrack(id),
      })),
    allSavedTracks: async () => [],
  };
}

function spotifyRange(from: number, toExclusive: number): string[] {
  const out: string[] = [];
  for (let i = from; i < toExclusive; i++) out.push(`sp:s${i}`);
  return out;
}

const ALL_BASE = spotifyRange(0, BASE_TRACKS);

// ---------------------------------------------------------------- tests

describe('playlist overlay: insert positions', () => {
  it('inserts local tracks at the top, middle and end and marks their source', async () => {
    const db = freshDb();
    const app = await makeApp(db);

    const top = await addLocal(app, ['l:1'], 0);
    expect(ids(top)).toEqual(['l:1', ...ALL_BASE]);

    const middle = await addLocal(app, ['l:2'], 5);
    expect(ids(middle)).toEqual([
      'l:1',
      ...spotifyRange(0, 4),
      'l:2',
      ...spotifyRange(4, BASE_TRACKS),
    ]);

    const end = await addLocal(app, ['l:3']);
    expect(ids(end)).toEqual(['l:1', ...spotifyRange(0, 4), 'l:2', ...spotifyRange(4, BASE_TRACKS), 'l:3']);

    // Each row says which side of the merge it came from, with a stable entry id.
    const byId = new Map(end.tracks.map((t) => [t.id, t]));
    expect(byId.get('l:1')?.entrySource).toBe('rune-overlay');
    expect(byId.get('l:1')?.entryId).toMatch(/^ovl:/);
    expect(byId.get('sp:s0')?.entrySource).toBe('spotify-playlist');
    expect(byId.get('sp:s0')?.entryId).toBe('sp:sp:s0#0');
    // Track.source keeps its original local/Spotify meaning.
    expect(byId.get('l:1')?.source).toBe('local');
    expect(byId.get('sp:s0')?.source).toBe('spotify');

    // Both playlist reads (the library path and the rune-playlist path) count them.
    expect(listPlaylists(db).find((p) => p.id === MIX)?.trackCount).toBe(BASE_TRACKS + 3);
    expect(listAllPlaylists(db).find((p) => p.id === MIX)?.trackCount).toBe(BASE_TRACKS + 3);
    expect(getPlaylistDetail(db, MIX)?.trackCount).toBe(BASE_TRACKS + 3);
    expect(getPlaylist(db, MIX)?.trackCount).toBe(BASE_TRACKS + 3);

    // A second insert at position 0 lands at the very top, before the first one.
    const topAgain = await addLocal(app, ['l:4'], 0);
    expect(ids(topAgain).slice(0, 2)).toEqual(['l:4', 'l:1']);
    await app.close();
  });

  it('rejects Spotify ids on a Spotify playlist and unknown tracks', async () => {
    const db = freshDb();
    const app = await makeApp(db);

    const sp = await app.inject({
      method: 'POST',
      url: `/api/playlists/${MIX}/tracks`,
      payload: { trackIds: ['sp:s0'] },
    });
    expect(sp.statusCode).toBe(409);
    expect(String(sp.json().error)).toContain('Spotify write access');

    const unknown = await app.inject({
      method: 'POST',
      url: `/api/playlists/${MIX}/tracks`,
      payload: { trackIds: ['l:nope'] },
    });
    expect(unknown.statusCode).toBe(400);
    expect(String(unknown.json().error)).toContain('l:nope');

    const missing = await app.inject({
      method: 'POST',
      url: '/api/playlists/pl:sp:nope/tracks',
      payload: { trackIds: ['l:1'] },
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});

describe('playlist overlay: resync resilience', () => {
  it('keeps its place when Spotify inserts and removes other songs', async () => {
    const db = freshDb();
    const app = await makeApp(db);

    await addLocal(app, ['l:1'], 0); // top
    await addLocal(app, ['l:2'], 5); // after sp:s3
    await addLocal(app, ['l:3']); // after sp:s11 (end)

    // Spotify resync: a song is added at the front, sp:s2 is removed, sp:s12 appended.
    const insertTrack = db.prepare(
      `INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms)
       VALUES (?, 'sp:alb', 'spotify', ?, 1, 99, 180000)`,
    );
    insertTrack.run('sp:new', 'Spotify New');
    insertTrack.run('sp:s12', 'Spotify 12');
    rewriteBase(db, ['sp:new', 'sp:s0', 'sp:s1', 'sp:s3', ...spotifyRange(4, BASE_TRACKS), 'sp:s12']);

    const after = getPlaylistDetail(db, MIX) as RunePlaylistDetail;
    expect(ids(after)).toEqual([
      'l:1',
      'sp:new',
      'sp:s0',
      'sp:s1',
      'sp:s3',
      'l:2',
      ...spotifyRange(4, BASE_TRACKS),
      // l:3 was anchored after sp:s11, so an appended sp:s12 goes after it.
      'l:3',
      'sp:s12',
    ]);
    expect(after.trackCount).toBe(16);
    await app.close();
  });

  it('survives a real syncPlaylists run that rewrites the Spotify entries', async () => {
    const db = freshDb();
    const app = await makeApp(db);

    await addLocal(app, ['l:1'], 0); // top
    await addLocal(app, ['l:2'], 5); // after sp:s3
    await addLocal(app, ['l:3']); // after sp:s11 (end)
    const stored = db
      .prepare('SELECT id FROM playlist_overlay WHERE playlist_id = ? ORDER BY added_at')
      .all(MIX) as { id: string }[];
    expect(stored).toHaveLength(3);

    // The real sync (snapshot changed): one song inserted at the front, sp:s2 removed,
    // sp:s12 appended. syncPlaylists deletes + reinserts every playlist_tracks row; the
    // overlay rows must be untouched and re-merge against the new base order.
    const result = await syncPlaylists(
      // The fake source speaks raw Spotify ids; rune stores them as 'sp:<id>'.
      spotifySource(
        ['new', 's0', 's1', 's3', ...spotifyRange(4, BASE_TRACKS).map((id) => id.slice(3)), 's12'],
        'snap-2',
      ),
      db,
      { now: () => NOW + 1000 },
    );
    expect(result.tracks).toBe(13);

    expect(
      (db.prepare('SELECT id FROM playlist_overlay WHERE playlist_id = ?').all(MIX) as unknown[])
        .length,
    ).toBe(3);
    expect(ids(getPlaylistDetail(db, MIX) as RunePlaylistDetail)).toEqual([
      'l:1',
      'sp:new',
      'sp:s0',
      'sp:s1',
      'sp:s3',
      'l:2',
      ...spotifyRange(4, BASE_TRACKS),
      'l:3',
      'sp:s12',
    ]);
    // Merged counts include the overlays on both read paths.
    expect(getPlaylistDetail(db, MIX)?.trackCount).toBe(16);
    expect(listPlaylists(db).find((p) => p.id === MIX)?.trackCount).toBe(16);
    expect(getPlaylist(db, MIX)?.trackCount).toBe(16);
    await app.close();
  });

  it('falls back to the nearest previous surviving anchor, or the top', async () => {
    const db = freshDb();
    ensureOverlaySchema(db);
    rewriteBase(db, ['sp:s0', 'sp:s1', 'sp:s2', 'sp:s3', 'sp:s4']);

    // A after sp:s0, B after sp:s2.
    const insert = db.prepare(
      `INSERT INTO playlist_overlay
         (id, playlist_id, track_id, anchor_track_id, anchor_occurrence, added_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run('ovl:a', MIX, 'l:1', 'sp:s0', 0, NOW + 1);
    insert.run('ovl:b', MIX, 'l:2', 'sp:s2', 0, NOW + 2);

    // sp:s2 vanishes: B falls back to A's resolved anchor (after sp:s0).
    rewriteBase(db, ['sp:s0', 'sp:s1', 'sp:s3', 'sp:s4']);
    expect(ids(getPlaylistDetail(db, MIX) as RunePlaylistDetail)).toEqual([
      'sp:s0',
      'l:1',
      'l:2',
      'sp:s1',
      'sp:s3',
      'sp:s4',
    ]);

    // Now sp:s0 vanishes too: both entries fall back to the top, in insertion order.
    rewriteBase(db, ['sp:s1', 'sp:s3', 'sp:s4']);
    expect(ids(getPlaylistDetail(db, MIX) as RunePlaylistDetail)).toEqual([
      'l:1',
      'l:2',
      'sp:s1',
      'sp:s3',
      'sp:s4',
    ]);
  });

  it('anchors to a specific occurrence of a duplicated song', () => {
    const db = freshDb();
    ensureOverlaySchema(db);
    rewriteBase(db, ['sp:s0', 'sp:s1', 'sp:s0']);

    const insert = db.prepare(
      `INSERT INTO playlist_overlay
         (id, playlist_id, track_id, anchor_track_id, anchor_occurrence, added_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run('ovl:first', MIX, 'l:1', 'sp:s0', 0, NOW + 1);
    insert.run('ovl:second', MIX, 'l:2', 'sp:s0', 1, NOW + 2);

    expect(ids(getPlaylistDetail(db, MIX) as RunePlaylistDetail)).toEqual([
      'sp:s0',
      'l:1',
      'sp:s1',
      'sp:s0',
      'l:2',
    ]);
  });
});

describe('playlist overlay: delete and move', () => {
  it('deletes only overlay entries, by entry id or merged position', async () => {
    const db = freshDb();
    const app = await makeApp(db);

    const top = await addLocal(app, ['l:1'], 0);
    const overlayId = top.tracks[0]?.entryId as string;
    await addLocal(app, ['l:2'], 5);

    // A Spotify entry cannot be removed (position or entry id).
    const byPosition = await app.inject({
      method: 'DELETE',
      url: `/api/playlists/${MIX}/tracks`,
      payload: { positions: [1] },
    });
    expect(byPosition.statusCode).toBe(409);

    const bySpotifyId = await app.inject({
      method: 'DELETE',
      url: `/api/playlists/${MIX}/tracks`,
      payload: { entryIds: ['sp:sp:s0#0'] },
    });
    expect(bySpotifyId.statusCode).toBe(409);

    const byEntry = await app.inject({
      method: 'DELETE',
      url: `/api/playlists/${MIX}/tracks`,
      payload: { entryIds: [overlayId] },
    });
    expect(byEntry.statusCode).toBe(200);
    expect(ids(byEntry.json() as RunePlaylistDetail)).not.toContain('l:1');

    // The remaining overlay (l:2, now at merged position 4) can go by position.
    const byPos = await app.inject({
      method: 'DELETE',
      url: `/api/playlists/${MIX}/tracks`,
      payload: { positions: [4] },
    });
    expect(byPos.statusCode).toBe(200);
    expect(ids(byPos.json() as RunePlaylistDetail)).toEqual(ALL_BASE);

    const unknown = await app.inject({
      method: 'DELETE',
      url: `/api/playlists/${MIX}/tracks`,
      payload: { entryIds: ['ovl:nope'] },
    });
    expect(unknown.statusCode).toBe(400);
    await app.close();
  });

  it('moves overlay entries, including inside an existing overlay group', async () => {
    const db = freshDb();
    const app = await makeApp(db);
    rewriteBase(db, ['sp:s0', 'sp:s1', 'sp:s2']);

    await addLocal(app, ['l:1']);
    await addLocal(app, ['l:2']);
    await addLocal(app, ['l:3']);
    expect(ids(getPlaylistDetail(db, MIX) as RunePlaylistDetail)).toEqual([
      'sp:s0',
      'sp:s1',
      'sp:s2',
      'l:1',
      'l:2',
      'l:3',
    ]);

    // Move the last entry to the front of the same overlay group.
    const inside = await app.inject({
      method: 'POST',
      url: `/api/playlists/${MIX}/move`,
      payload: { from: 5, to: 3 },
    });
    expect(inside.statusCode).toBe(200);
    expect(ids(inside.json() as RunePlaylistDetail)).toEqual([
      'sp:s0',
      'sp:s1',
      'sp:s2',
      'l:3',
      'l:1',
      'l:2',
    ]);

    // Move an overlay to the top (new anchor).
    const toTop = await app.inject({
      method: 'POST',
      url: `/api/playlists/${MIX}/move`,
      payload: { from: 5, to: 0 },
    });
    expect(toTop.statusCode).toBe(200);
    expect(ids(toTop.json() as RunePlaylistDetail)).toEqual([
      'l:2',
      'sp:s0',
      'sp:s1',
      'sp:s2',
      'l:3',
      'l:1',
    ]);

    // Spotify entries cannot be moved; out-of-range is a 400.
    const spotifyMove = await app.inject({
      method: 'POST',
      url: `/api/playlists/${MIX}/move`,
      payload: { from: 1, to: 4 },
    });
    expect(spotifyMove.statusCode).toBe(409);

    const outOfRange = await app.inject({
      method: 'POST',
      url: `/api/playlists/${MIX}/move`,
      payload: { from: 0, to: 99 },
    });
    expect(outOfRange.statusCode).toBe(400);
    await app.close();
  });
});

describe('playlist overlay: duplicate as rune playlist', () => {
  it('copies the merged order (overlay entries included) into a rune playlist', async () => {
    const db = freshDb();
    const app = await makeApp(db);
    rewriteBase(db, ['sp:s0', 'sp:s1', 'sp:s2']);

    await addLocal(app, ['l:1'], 0);
    await addLocal(app, ['l:2'], 2);
    const before = ids(getPlaylistDetail(db, MIX) as RunePlaylistDetail);
    expect(before).toEqual(['l:1', 'sp:s0', 'l:2', 'sp:s1', 'sp:s2']);

    const copy = await app.inject({
      method: 'POST',
      url: `/api/playlists/${MIX}/duplicate`,
    });
    expect(copy.statusCode).toBe(201);
    const duplicated = copy.json() as RunePlaylistDetail;
    expect(duplicated.id.startsWith('pl:rune:')).toBe(true);
    expect(duplicated.source).toBe('local');
    expect(ids(duplicated)).toEqual(before);
    expect(duplicated.trackCount).toBe(before.length);
    await app.close();
  });
});
