// A mixed queue loads mpv ONE track at a time. Real buildApp + real PC zone; only the mpv process is a fake socket.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { buildApp } from '../src/api/server.js';
import { startFakeMpvSocket, type FakeMpvSocket } from './support/fake-mpv-socket.js';
import type { Config } from '../src/config.js';

process.env.LOG_LEVEL = 'silent';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock('node:child_process', async (orig) => ({ ...(await orig<typeof import('node:child_process')>()), spawn: (...a: unknown[]) => mocks.spawn(...a), execFile: (...a: unknown[]) => mocks.execFile(...a) }));

const child = () => { const c = new EventEmitter() as EventEmitter & Record<string, unknown>; Object.assign(c, { pid: 1, stderr: new EventEmitter(), exitCode: null, signalCode: null, kill: () => true }); return c; };

/** A throwaway copy of the real library, made by hand. Without it the test below is skipped; the seeded ones always run. */
const REAL_COPY = `${process.env.HOME}/data/agent-tmp/rune-audit/data/liner.db`;

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

describe('auto-radio and mixed queues', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  async function boot(open: (dir: string) => Db) {
    const dir = mkdtempSync(join(tmpdir(), 'audit-radio-')); dirs.push(dir);
    const db = open(dir);
    let fake!: Promise<FakeMpvSocket>;
    const mpvState = { idle: false };
    mocks.spawn.mockImplementation((cmd: string) => {
      if (cmd !== 'mpv') throw new Error('nothing else runs in this test');
      fake = startFakeMpvSocket(join(dir, 'mpv.sock'), (c) => ({ error: 'success', data: c[0] === 'get_property' && c[1] === 'idle-active' ? mpvState.idle : null }));
      return child();
    });
    mocks.execFile.mockImplementation((...a: unknown[]) => { const cb = a.at(-1); if (typeof cb === 'function') (cb as (e: Error) => void)(new Error('no')); });
    const cfg: Config = { libraryRoots: [], dataDir: dir, port: 0, audioDevice: 'null', userAgent: 't', normalize: 'album' };
    const { app, shutdown } = await buildApp(db, cfg, { pcZone: true, scanOnStart: false, watch: false, backups: false });
    await app.ready();
    const mpv = await fake;
    const warn = vi.spyOn(app.log, 'warn');
    const loads = () => mpv.received.filter((r) => r.command?.[0] === 'loadfile').map((r) => String(r.command?.[1]));
    const play = (ids: string[]) => app.inject({ method: 'POST', url: '/api/player/pc', payload: { type: 'play', trackIds: ids, startIndex: ids.length - 1, positionMs: 0, paused: false } });
    /** mpv ran out of songs: it goes idle. No client sends anything. */
    const runOut = async () => {
      mpvState.idle = true;
      mpv.sendEvent({ event: 'property-change', name: 'playlist-pos', data: -1 } as never);
      mpv.sendEvent({ event: 'property-change', name: 'idle-active', data: true } as never);
      await new Promise((r) => setTimeout(r, 500));
      mpvState.idle = false;
    };
    const started = () => warn.mock.calls.filter((c) => c[1] === 'auto-radio started a song');
    const close = async () => { await mpv.close(); await shutdown('test').catch(() => undefined); };
    return { app, db, loads, play, runOut, started, close };
  }
  const setting = (db: Db, value: '0' | '1') => db.prepare("INSERT INTO app_state (key, value) VALUES ('settings.autoRadio', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(value);

  it('R1 the end of one local song in a mixed queue starts nothing on the server, even with auto-radio on', { timeout: 30000 }, async () => {
    const t = await boot((dir) => seedLibrary(join(dir, 'liner.db')));
    setting(t.db, '1');
    await t.play(['l:1']);                 // exactly what ZoneEngine.load sends for the local song of a mixed queue
    expect(t.loads()).toHaveLength(1);
    await t.runOut();
    expect(t.loads()).toHaveLength(1);
    expect(t.started()).toEqual([]);
    await t.close();
  });

  it('R1 on a copy of the real library', { timeout: 30000, skip: !existsSync(REAL_COPY) }, async () => {
    const t = await boot((dir) => {
      copyFileSync(REAL_COPY, join(dir, 'liner.db'));
      const db = openDb(join(dir, 'liner.db'));
      db.prepare("DELETE FROM app_state WHERE key='player.pc.session'").run();
      return db;
    });
    setting(t.db, '1');
    const seed = t.db.prepare("SELECT id FROM tracks WHERE source='local' AND path IS NOT NULL AND cue_start_ms IS NULL ORDER BY id LIMIT 1").get() as { id: string };
    await t.play([seed.id]);
    expect(t.loads()).toHaveLength(1);
    await t.runOut();
    expect(t.loads()).toHaveLength(1);
    expect(t.started()).toEqual([]);
    await t.close();
  });

  it('auto-radio is off unless switched on: a queue running out starts nothing', { timeout: 30000 }, async () => {
    const t = await boot((dir) => seedLibrary(join(dir, 'liner.db')));
    expect((await t.app.inject({ url: '/api/settings/autoRadio' })).json()).toEqual({ enabled: false });
    await t.play(['l:1', 'l:2']);
    const before = t.loads().length;
    await t.runOut();
    expect(t.loads()).toHaveLength(before);
    expect(t.started()).toEqual([]);
    await t.close();
  });

  it('switched on, a real queue running out continues, and the start is logged at warn with its reason', { timeout: 30000 }, async () => {
    const t = await boot((dir) => seedLibrary(join(dir, 'liner.db')));
    setting(t.db, '1');
    await t.play(['l:1', 'l:2']);
    const before = t.loads().length;
    await t.runOut();
    await vi.waitFor(() => expect(t.started()).toHaveLength(1), { timeout: 8000 });
    expect(t.loads().length).toBeGreaterThan(before);
    expect(t.started()[0]![0]).toMatchObject({ reason: 'queue ran out', queueLength: 2 });
    await t.close();
  });
});
