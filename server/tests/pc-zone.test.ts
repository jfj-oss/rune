import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import type { Config } from '../src/config.js';
import { createPcZone, type PcZone } from '../src/play/zone.js';
import { loadQueueItems } from '../src/play/rows.js';
import {
  startFakeMpvSocket,
  type FakeMpvSocket,
  type ReceivedMpvCommand,
} from './support/fake-mpv-socket.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mocks.spawn(...args),
  execFile: (...args: unknown[]) => mocks.execFile(...args),
}));

interface FakeChild extends EventEmitter {
  pid: number;
  stderr: EventEmitter;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: string): boolean;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    if (child.exitCode === null) {
      child.exitCode = 0;
      setImmediate(() => child.emit('exit', 0, null));
    }
    return true;
  };
  return child;
}

function makeDb(): Db {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO artists (id, name) VALUES ('ar:a', 'Artist')").run();
  db.prepare(
    "INSERT INTO albums (id, source, title, artist_id, added_at) VALUES ('la:a', 'local', 'Album', 'ar:a', 0)",
  ).run();
  const insert = db.prepare(
    `INSERT INTO tracks
       (id, album_id, source, title, disc, number, duration_ms, path, format)
     VALUES (?, 'la:a', 'local', ?, 1, ?, 200000, ?, 'flac')`,
  );
  for (let i = 1; i <= 5; i++) insert.run(`l:${i}`, `Track ${i}`, i, `/tmp/music/${i}.flac`);
  return db;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await flush();
  }
}

describe('PcZone: runs of local songs in mpv', () => {
  let dir: string;
  let db: Db;
  let zone: PcZone;
  let fake: FakeMpvSocket;
  let fakeStarted: Promise<FakeMpvSocket>;

  const commands = () => fake.received.map((r: ReceivedMpvCommand) => r.command ?? []);
  const names = () => commands().map((c) => String(c[0]));
  const clearCommands = () => {
    fake.received.length = 0;
  };

  const run = (ids: string[], opts: { positionMs?: number; paused?: boolean } = {}) =>
    zone.loadRun(loadQueueItems(db, ids), { positionMs: opts.positionMs ?? 0, paused: opts.paused ?? false });
  const playFive = () => run(['l:1', 'l:2', 'l:3', 'l:4', 'l:5']);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'liner-pc-zone-'));
    mocks.spawn.mockReset();
    mocks.execFile.mockReset();
    db = makeDb();
    // spawnMpv unlinks a stale socket before spawning, so start the fake server
    // when spawn is called (it then acts as the mpv process's IPC socket).
    mocks.spawn.mockImplementation(() => {
      fakeStarted = startFakeMpvSocket(join(dir, 'mpv.sock'));
      return fakeChild();
    });
    const cfg: Config = {
      libraryRoots: [],
      dataDir: dir,
      port: 0,
      audioDevice: 'null',
      userAgent: 'test',
      normalize: 'album',
    };
    zone = await createPcZone(db, cfg);
    fake = await fakeStarted;
  });

  afterEach(async () => {
    if (zone) await zone.close();
    if (fake) await fake.close();
    if (db) db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a run loads the current song and the next two, gaplessly, and follows mpv from song to song', async () => {
    const state = await playFive();
    expect(commands().filter((c) => c[0] === 'loadfile').map((c) => c[1])).toEqual(['/tmp/music/1.flac', '/tmp/music/2.flac', '/tmp/music/3.flac']);
    expect(state.status).toBe('playing');
    fake.sendEvent({ event: 'property-change', name: 'playlist-pos', data: 1 });
    await waitFor(() => zone.state().index === 1);
    // the window moved on: two more are kept loaded ahead
    await waitFor(() => commands().filter((c) => c[0] === 'loadfile').length === 4);
  });

  it('setUpcoming replaces what is loaded after the song now playing, and never touches that song', async () => {
    await playFive();
    clearCommands();
    await zone.setUpcoming(loadQueueItems(db, ['l:4', 'l:5']));
    expect(names()).not.toContain('stop');
    expect(names()).not.toContain('playlist-clear');
    expect(commands().filter((c) => c[0] === 'loadfile').map((c) => c[1])).toEqual(['/tmp/music/4.flac', '/tmp/music/5.flac']);
    expect(zone.state().queue.map((q) => q.track.id)).toEqual(['l:1', 'l:4', 'l:5']);
    expect(zone.state().index).toBe(0);
  });

  it('A paused start pauses mpv before it loads the file, so nothing sounds', async () => {
    await run(['l:1', 'l:2'], { paused: true });

    const sent = commands();
    const pausedAt = sent.findIndex((c) => c[0] === 'set_property' && c[1] === 'pause' && c[2] === true);
    expect(pausedAt).toBeGreaterThanOrEqual(0);
    expect(pausedAt).toBeLessThan(sent.findIndex((c) => c[0] === 'loadfile'));
    expect(sent).not.toContainEqual(['set_property', 'pause', false]);
    expect(zone.state().status).toBe('paused');
  });

  it('A load with nothing to play tells clients it stopped', async () => {
    await zone.loadRun([], { positionMs: 0, paused: false });
    const seen: string[] = [];
    const off = zone.onChange((s) => seen.push(s.status));
    await (zone as unknown as { startPlayback(): Promise<void> }).startPlayback();
    off();
    expect(seen).toEqual(['loading', 'stopped']);
  });

  it('A pause that arrives during a load finishes it paused, so it never shows as a new start', async () => {
    const seen: string[] = [];
    let pausing: Promise<unknown> | undefined;
    const off = zone.onChange((s) => {
      seen.push(s.status);
      if (s.status === 'loading' && !pausing) pausing = zone.command({ type: 'pause' });
    });
    await run(['l:1', 'l:2']);
    await pausing;
    off();

    expect(seen).not.toContain('playing'); // the speaker guard would pause the newer Spotify song
    expect(zone.state().status).toBe('paused');
    expect(commands()).toContainEqual(['set_property', 'pause', true]);
  });

  it('A pause during one load does not leak into the next song', async () => {
    let pausing: Promise<unknown> | undefined;
    const off = zone.onChange((s) => {
      if (s.status === 'loading' && !pausing) pausing = zone.command({ type: 'pause' });
    });
    await run(['l:1']);
    await pausing;
    off();
    const state = await run(['l:2']);
    expect(state.status).toBe('playing');
  });

  it('A new song after a pause tells mpv to play: its pause flag survives loading a file', async () => {
    await playFive();
    await zone.command({ type: 'pause' });
    clearCommands();

    const state = await run(['l:1', 'l:2']);

    expect(commands()).toContainEqual(['set_property', 'pause', false]);
    expect(state.status).toBe('playing');
  });

  it('Clear empties the queue, stops playback and broadcasts once', async () => {
    await playFive();
    clearCommands();
    const states: number[] = [];
    const off = zone.onChange((s) => states.push(s.queue.length));

    const state = await zone.command({ type: 'clear' });

    expect(state.queue).toEqual([]);
    expect(state.index).toBe(-1);
    expect(state.status).toBe('stopped');
    expect(state.positionMs).toBe(0);
    expect(names()).toContain('stop');
    expect(names()).toContain('playlist-clear');
    expect(states).toEqual([0]);
    off();
    expect(zone.state().queue).toEqual([]);
  });
});
