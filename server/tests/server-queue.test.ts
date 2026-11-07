// Phase 3 wired into the real app: config spotify.serverQueue on, the real PC zone, a fake mpv socket. Spotify is not
// configured here (the driver tests cover the app); nothing sounds and nothing leaves the machine.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlayerState } from '@liner/shared';
import { openDb, type Db } from '../src/db/index.js';
import { buildApp } from '../src/api/server.js';
import { startFakeMpvSocket, type FakeMpvSocket } from './support/fake-mpv-socket.js';
import type { Config } from '../src/config.js';

process.env.LOG_LEVEL = 'silent';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock('node:child_process', async (orig) => ({ ...(await orig<typeof import('node:child_process')>()), spawn: (...a: unknown[]) => mocks.spawn(...a), execFile: (...a: unknown[]) => mocks.execFile(...a) }));

const child = () => { const c = new EventEmitter() as EventEmitter & Record<string, unknown>; Object.assign(c, { pid: 1, stderr: new EventEmitter(), exitCode: null, signalCode: null, kill: () => true }); return c; };

function seedLibrary(file: string): Db {
  const db = openDb(file);
  db.prepare("INSERT INTO artists (id, name) VALUES ('ar:a', 'Artist A'), ('ar:b', 'Artist B')").run();
  const album = db.prepare("INSERT INTO albums (id, source, title, artist_id, year, genres, added_at) VALUES (?, 'local', ?, ?, 1990, '[\"grunge\"]', 0)");
  album.run('la:a', 'Album A', 'ar:a');
  album.run('la:b', 'Album B', 'ar:b');
  const add = db.prepare("INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms, path, format) VALUES (?, ?, 'local', ?, 1, ?, 200000, ?, 'flac')");
  const credit = db.prepare('INSERT INTO track_artists (track_id, artist_id, position) VALUES (?, ?, 0)');
  for (let i = 1; i <= 12; i++) {
    add.run(`l:${i}`, i <= 6 ? 'la:a' : 'la:b', `Song ${i}`, i, `/tmp/music/${i}.flac`);
    credit.run(`l:${i}`, i <= 6 ? 'ar:a' : 'ar:b');
  }
  return db;
}

describe('server queue in the app (flag on)', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  async function boot(pre?: (db: Db) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'server-queue-')); dirs.push(dir);
    const db = seedLibrary(join(dir, 'liner.db'));
    pre?.(db);
    const web = join(dir, 'web'); mkdirSync(web);
    writeFileSync(join(web, 'build-id.txt'), 'build-42\n');
    let fake!: Promise<FakeMpvSocket>;
    const mpvState = { idle: false };
    mocks.spawn.mockImplementation((cmd: string) => {
      if (cmd !== 'mpv') throw new Error('nothing else runs in this test');
      fake = startFakeMpvSocket(join(dir, 'mpv.sock'), (c) => ({ error: 'success', data: c[0] === 'get_property' && c[1] === 'idle-active' ? mpvState.idle : null }));
      return child();
    });
    mocks.execFile.mockImplementation((...a: unknown[]) => { const cb = a.at(-1); if (typeof cb === 'function') (cb as (e: Error) => void)(new Error('no')); });
    const cfg: Config = { libraryRoots: [], dataDir: dir, port: 0, audioDevice: 'null', userAgent: 't', normalize: 'album', spotify: { serverQueue: true } };
    const { app, shutdown } = await buildApp(db, cfg, { pcZone: true, scanOnStart: false, watch: false, backups: false, webDist: web });
    await app.ready();
    const mpv = await fake;
    const warn = vi.spyOn(app.log, 'warn');
    const loads = () => mpv.received.filter((r) => r.command?.[0] === 'loadfile').map((r) => String(r.command?.[1]));
    const send = (payload: object) => app.inject({ method: 'POST', url: '/api/player/pc', payload });
    const state = async () => (await app.inject({ url: '/api/player/pc' })).json() as PlayerState;
    const at = async (pos: number) => { mpv.sendEvent({ event: 'property-change', name: 'playlist-pos', data: pos } as never); await new Promise((r) => setTimeout(r, 100)); };
    const runOut = async () => {
      mpvState.idle = true;
      mpv.sendEvent({ event: 'property-change', name: 'playlist-pos', data: -1 } as never);
      mpv.sendEvent({ event: 'property-change', name: 'idle-active', data: true } as never);
      await new Promise((r) => setTimeout(r, 500));
      mpvState.idle = false;
    };
    const started = () => warn.mock.calls.filter((c) => c[1] === 'auto-radio started a song');
    const close = async () => { await mpv.close(); await shutdown('test').catch(() => undefined); };
    return { app, db, loads, send, state, at, runOut, started, close };
  }
  const setting = (db: Db, value: '0' | '1') => db.prepare("INSERT INTO app_state (key, value) VALUES ('settings.autoRadio', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(value);
  const row = (db: Db, key: string) => (db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as { value: string } | undefined)?.value;

  it('the pc zone says its queue is on the server, and the socket says hello with the web build first', { timeout: 30000 }, async () => {
    const t = await boot();
    const zones = (await t.app.inject({ url: '/api/zones' })).json() as { id: string; serverQueue?: boolean }[];
    expect(zones.find((z) => z.id === 'pc')?.serverQueue).toBe(true);
    const got: string[] = [];
    const ws = await t.app.injectWS('/api/ws', {}, { onInit: (w) => w.on('message', (m: Buffer) => got.push(String(m))) });
    await vi.waitFor(() => expect(got.length).toBeGreaterThanOrEqual(2));
    expect(JSON.parse(got[0]!)).toEqual({ type: 'hello', build: 'build-42', serverQueue: true });
    expect(JSON.parse(got[1]!)).toMatchObject({ type: 'player', state: { zone: 'pc', output: null } });
    ws.terminate();
    await t.close();
  });

  it('a local queue is one gapless mpv run under the driver\'s queue ids, with rev and output in the state', { timeout: 30000 }, async () => {
    const t = await boot();
    const res = await t.send({ type: 'play', trackIds: ['l:1', 'l:2', 'l:3'], startIndex: 0 });
    expect(res.statusCode).toBe(200);
    expect(t.loads()).toEqual(['/tmp/music/1.flac', '/tmp/music/2.flac', '/tmp/music/3.flac']);
    const s = await t.state();
    expect(s.status).toBe('playing');
    expect(s.output).toBe('mpv');
    expect(typeof s.rev).toBe('number');
    expect(s.queue.map((q) => q.track.id)).toEqual(['l:1', 'l:2', 'l:3']);
    await t.at(1);
    expect((await t.state()).index).toBe(1);
    await t.close();
  });

  it('auto-radio continues on the explicit queue-ended event, and only when switched on', { timeout: 30000 }, async () => {
    for (const on of [false, true]) {
      const t = await boot();
      setting(t.db, on ? '1' : '0');
      await t.send({ type: 'play', trackIds: ['l:1', 'l:2'], startIndex: 0 });
      await t.at(1);
      const before = t.loads().length;
      await t.runOut();
      if (on) {
        await vi.waitFor(() => expect(t.started()).toHaveLength(1), { timeout: 8000 });
        expect(t.loads().length).toBeGreaterThan(before);
        expect(t.started()[0]![0]).toMatchObject({ reason: 'queue ran out', queueLength: 2 });
      } else {
        await new Promise((r) => setTimeout(r, 300));
        expect(t.loads()).toHaveLength(before);
        expect(t.started()).toEqual([]);
        expect((await t.state()).status).toBe('stopped');
      }
      await t.close();
    }
  });

  it('a Spotify song with Spotify not connected waits with a reason; mpv starts nothing', { timeout: 30000 }, async () => {
    const t = await boot();
    await t.send({ type: 'play', trackIds: ['sp:abc', 'l:2'], startIndex: 0 });
    const s = await t.state();
    expect(s.status).toBe('paused');
    expect(s.hold?.reason).toBe('spotify-unavailable');
    expect(s.queue.map((q) => q.track.id)).toEqual(['sp:abc', 'l:2']);
    expect(t.loads()).toEqual([]);
    await t.close();
  });

  it('boot: the old mpv session comes back paused, moved to player.queue.pc; the old row is kept and mpv no longer writes it', { timeout: 30000 }, async () => {
    const old = JSON.stringify({ v: 1, queue: [{ queueId: 'x1', trackId: 'l:4' }, { queueId: 'x2', trackId: 'l:5' }], index: 1, positionMs: 5000, shuffle: false, repeat: 'off', order: [0, 1], volume: 70 });
    const t = await boot((db) => {
      db.exec('CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      db.prepare("INSERT INTO app_state (key, value) VALUES ('player.pc.session', ?)").run(old);
    });
    const s = await t.state();
    expect(s.status).toBe('paused');
    expect(s.queue.map((q) => q.queueId)).toEqual(['x1', 'x2']);
    expect(s.index).toBe(1);
    expect(s.positionMs).toBe(5000);
    expect(t.loads()).toEqual([]);                 // nothing sounds at boot
    expect(row(t.db, 'player.queue.pc')).toContain('l:5');
    await t.send({ type: 'resume' });
    expect(t.loads()[0]).toBe('/tmp/music/5.flac');
    await new Promise((r) => setTimeout(r, 1300));
    expect(row(t.db, 'player.pc.session')).toBe(old);
    await t.close();
  });
});
