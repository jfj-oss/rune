// Pins: albums / playlists kept at the top of the Library lists (rune's own table, no Spotify).
import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { registerPinRoutes, setPinned } from '../src/api/pins.js';
import { listAlbums, getAlbum } from '../src/api/library.js';
import { listAllPlaylists, getPlaylistDetail } from '../src/myplaylists/index.js';
import { ensureMyPlaylistSchema } from '../src/myplaylists/schema.js';

process.env.LOG_LEVEL ??= 'silent';

// A real file under the agent's temp dir (never the user's ~/.local/share/liner): the schema's
// CREATE TABLE IF NOT EXISTS pins must land in an existing database on reopen.
const TMP = join(process.env.HOME ?? '/tmp', 'data/agent-tmp/rune-bugs/tmp');

function seed(db: Db): void {
  ensureMyPlaylistSchema(db);
  db.prepare("INSERT INTO artists (id, name) VALUES ('ar:a', 'Aster')").run();
  const album = db.prepare('INSERT INTO albums (id, source, title, artist_id, in_library, added_at) VALUES (?, ?, ?, ?, 1, ?)');
  album.run('la:old', 'local', 'Old One', 'ar:a', 100);
  album.run('la:mid', 'local', 'Middle', 'ar:a', 200);
  album.run('la:new', 'local', 'Newest', 'ar:a', 300);
  db.prepare("INSERT INTO playlists (id, source, name, track_count, position, updated_at) VALUES ('pl:sp:liked', 'spotify', 'Liked Songs', 0, 0, 0)").run();
  db.prepare("INSERT INTO playlists (id, source, name, track_count, position, updated_at) VALUES ('pl:sp:x', 'spotify', 'Mix', 0, 1, 0)").run();
  db.prepare("INSERT INTO playlists (id, source, name, track_count, position, updated_at, kind, created_at) VALUES ('pl:rune:1', 'local', 'Mine', 0, 0, 0, 'static', 0)").run();
}

let app: FastifyInstance | null = null;
afterEach(async () => { await app?.close(); app = null; });

async function setup() {
  const db = openDb(':memory:');
  seed(db);
  let changes = 0;
  app = Fastify();
  await app.register(async (r) => registerPinRoutes(r, db, { onChange: () => { changes++; } }), { prefix: '/api' });
  return { db, changes: () => changes };
}

describe('pins', () => {
  it('pins and unpins albums and playlists, and says what is pinned', async () => {
    const s = await setup();
    expect((await app!.inject({ method: 'PUT', url: '/api/pins/la:mid' })).json()).toEqual({ pinned: true, kind: 'album' });
    expect((await app!.inject({ method: 'PUT', url: '/api/pins/pl:sp:x' })).json()).toEqual({ pinned: true, kind: 'playlist' });
    expect((await app!.inject({ method: 'PUT', url: '/api/pins/la:mid' })).statusCode).toBe(200); // idempotent
    expect(s.changes()).toBe(2);
    expect((await app!.inject({ method: 'GET', url: '/api/pins' })).json()).toEqual({ albums: ['la:mid'], playlists: ['pl:sp:x'] });
    expect((await app!.inject({ method: 'DELETE', url: '/api/pins/la:mid' })).json()).toEqual({ pinned: false, kind: 'album' });
    expect((await app!.inject({ method: 'GET', url: '/api/pins' })).json()).toEqual({ albums: [], playlists: ['pl:sp:x'] });
    expect(s.changes()).toBe(3);
  });

  it('refuses to pin something rune does not know', async () => {
    await setup();
    expect((await app!.inject({ method: 'PUT', url: '/api/pins/la:nope' })).statusCode).toBe(404);
    expect((await app!.inject({ method: 'PUT', url: '/api/pins/pl:rune:nope' })).statusCode).toBe(404);
  });

  it('puts pinned albums first in the Library grid (newest pin on top) and flags them everywhere', async () => {
    const s = await setup();
    const ids = (q: Parameters<typeof listAlbums>[1]) => listAlbums(s.db, q).items.map((a) => a.id);
    expect(ids({ pinnedFirst: true })).toEqual(['la:new', 'la:mid', 'la:old']);
    setPinned(s.db, 'la:old', true, 10);
    setPinned(s.db, 'la:mid', true, 20);
    expect(ids({ pinnedFirst: true })).toEqual(['la:mid', 'la:old', 'la:new']);
    expect(ids({ pinnedFirst: true, sort: 'title' })).toEqual(['la:mid', 'la:old', 'la:new']);
    // other callers (artist pages, search) keep the plain order
    expect(ids({})).toEqual(['la:new', 'la:mid', 'la:old']);
    expect(listAlbums(s.db, { pinnedFirst: true }).items.map((a) => a.pinned)).toEqual([true, true, undefined]);
    expect(getAlbum(s.db, 'la:mid')?.pinned).toBe(true);
    expect(getAlbum(s.db, 'la:new')?.pinned).toBeUndefined();
  });

  it('flags pinned playlists in the list and the detail', async () => {
    const s = await setup();
    setPinned(s.db, 'pl:sp:x', true);
    setPinned(s.db, 'pl:rune:1', true);
    const list = listAllPlaylists(s.db);
    expect(Object.fromEntries(list.map((p) => [p.id, p.pinned]))).toEqual({ 'pl:rune:1': true, 'pl:sp:liked': undefined, 'pl:sp:x': true });
    expect(getPlaylistDetail(s.db, 'pl:sp:x')?.pinned).toBe(true);
    expect(getPlaylistDetail(s.db, 'pl:sp:liked')?.pinned).toBeUndefined();
  });

  it('is a safe migration: an existing database gains the table on reopen and keeps its rows', () => {
    mkdirSync(TMP, { recursive: true });
    const file = join(TMP, `pins-${process.pid}-${Date.now()}.db`);
    try {
      const first = openDb(file);
      seed(first);
      first.exec('DROP TABLE pins'); // pretend the database predates pins
      expect(() => listAlbums(first, {})).toThrow(); // the join needs the table…
      first.close();
      const again = openDb(file); // …which the next start creates
      expect(listAlbums(again, { pinnedFirst: true }).items).toHaveLength(3);
      expect(setPinned(again, 'la:new', true)).toBe(true);
      expect(setPinned(again, 'la:new', true)).toBe(false);
      again.close();
      const third = openDb(file);
      expect(getAlbum(third, 'la:new')?.pinned).toBe(true);
      third.close();
    } finally {
      for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
    }
  });
});
