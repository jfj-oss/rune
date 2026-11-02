import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import type { Config } from '../src/config.js';
import { createPcZone, type PcZone } from '../src/play/zone.js';
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

describe('PcZone gapless track switches', () => {
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

  async function playFive(): Promise<void> {
    await zone.command({
      type: 'play',
      trackIds: ['l:1', 'l:2', 'l:3', 'l:4', 'l:5'],
    });
  }

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

  it('Next switches to an already-preloaded entry with playlist-next', async () => {
    await playFive();
    clearCommands();

    const state = await zone.command({ type: 'next' });

    expect(names()).toContain('playlist-next');
    expect(names()).not.toContain('stop');
    expect(names()).not.toContain('playlist-clear');
    expect(names()).not.toContain('loadfile');
    expect(state.status).toBe('playing');

    // The queue follows mpv's playlist-pos event, not the command.
    fake.sendEvent({ event: 'property-change', name: 'playlist-pos', data: 1 });
    await waitFor(() => zone.state().index === 1);
  });

  it('Next while paused still uses playlist-next and stays paused', async () => {
    await playFive();
    await zone.command({ type: 'pause' });
    clearCommands();

    const state = await zone.command({ type: 'next' });

    expect(commands()).toContainEqual(['playlist-next']);
    expect(commands()).toContainEqual(['set_property', 'pause', true]);
    expect(names()).not.toContain('stop');
    expect(names()).not.toContain('playlist-clear');
    expect(state.status).toBe('paused');
  });

  it('Jump to a preloaded entry selects it with playlist-pos', async () => {
    await playFive();
    clearCommands();

    await zone.command({ type: 'jump', index: 2 });

    expect(commands()).toContainEqual(['set_property', 'playlist-pos', 2]);
    expect(names()).not.toContain('stop');
    expect(names()).not.toContain('playlist-clear');

    fake.sendEvent({ event: 'property-change', name: 'playlist-pos', data: 2 });
    await waitFor(() => zone.state().index === 2);
  });

  it('Jump to an entry outside the preloaded window reloads with startPlayback', async () => {
    await playFive();
    clearCommands();

    const state = await zone.command({ type: 'jump', index: 4 });

    expect(names()).toContain('stop');
    expect(names()).toContain('playlist-clear');
    expect(names()).toContain('loadfile');
    expect(names()).not.toContain('playlist-next');
    expect(state.index).toBe(4);
  });

  it('Next falls back to startPlayback when the next entry is not preloaded', async () => {
    await playFive();
    // repeat-one makes mpv's window the current entry repeated, so the next
    // queue entry is not loaded ahead.
    await zone.command({ type: 'repeat', mode: 'one' });
    clearCommands();

    const state = await zone.command({ type: 'next' });

    expect(names()).toContain('stop');
    expect(names()).toContain('playlist-clear');
    expect(names()).toContain('loadfile');
    expect(names()).not.toContain('playlist-next');
    expect(state.index).toBe(1);
  });
});
