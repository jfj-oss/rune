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

async function waitFor(predicate: () => boolean, timeoutMs = 2_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('PcZone: mpv dying', () => {
  let db: Db;
  const zones: PcZone[] = [];
  const fakes: FakeMpvSocket[] = [];
  const dirs: string[] = [];

  beforeEach(() => {
    mocks.spawn.mockReset();
    mocks.execFile.mockReset();
    db = makeDb();
  });

  afterEach(async () => {
    for (const zone of zones.splice(0)) await zone.close().catch(() => undefined);
    for (const fake of fakes.splice(0)) await fake.close();
    if (db) db.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });


  it('M1 mpv dying while the zone is STOPPED with a queue comes back silent; Play still works', async () => {
    const children: FakeChild[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'audit-respawn-'));
    dirs.push(dir);
    const started: Promise<FakeMpvSocket>[] = [];
    mocks.spawn.mockImplementation(() => {
      started.push(startFakeMpvSocket(join(dir, 'mpv.sock')));
      const c = fakeChild(); children.push(c); return c;
    });
    const cfg: Config = { libraryRoots: [], dataDir: dir, port: 0, audioDevice: 'null', userAgent: 'test', normalize: 'album' };
    const zone = await createPcZone(db, cfg);
    zones.push(zone);
    const f1 = await started[0]!; fakes.push(f1);
    await zone.command({ type: 'play', trackIds: ['l:1', 'l:2'], startIndex: 1 });
    await zone.command({ type: 'next' });          // past the end of the queue: stopPlayback, status stopped, index kept
    const before = zone.state();
    expect(before.status).toBe('stopped');
    expect(before.index).toBeGreaterThanOrEqual(0);
    children[0]!.exitCode = 1;
    children[0]!.emit('exit', 1, null);            // mpv crashes, gets OOM-killed, or PipeWire takes it down
    await waitFor(() => started.length === 2);
    const f2 = await started[1]!; fakes.push(f2);
    await waitFor(() => f2.received.some((r) => r.command?.[0] === 'set_property' && r.command?.[1] === 'volume'));
    await new Promise((r) => setTimeout(r, 100));
    const loads = () => f2.received.filter((r) => r.command?.[0] === 'loadfile');
    expect(loads()).toHaveLength(0);
    expect(zone.state().status).toBe('stopped');
    expect(zone.state().queue).toHaveLength(2);
    await zone.command({ type: 'resume' });
    expect(loads().length).toBeGreaterThan(0);
    expect(zone.state().status).toBe('playing');
  });

  it('M1b mpv dying while playing still comes back playing', async () => {
    const children: FakeChild[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'audit-respawn-'));
    dirs.push(dir);
    const started: Promise<FakeMpvSocket>[] = [];
    mocks.spawn.mockImplementation(() => {
      started.push(startFakeMpvSocket(join(dir, 'mpv.sock')));
      const c = fakeChild(); children.push(c); return c;
    });
    const cfg: Config = { libraryRoots: [], dataDir: dir, port: 0, audioDevice: 'null', userAgent: 'test', normalize: 'album' };
    const zone = await createPcZone(db, cfg);
    zones.push(zone);
    const f1 = await started[0]!; fakes.push(f1);
    await zone.command({ type: 'play', trackIds: ['l:1', 'l:2'], startIndex: 0 });
    children[0]!.exitCode = 1;
    children[0]!.emit('exit', 1, null);
    await waitFor(() => started.length === 2);
    const f2 = await started[1]!; fakes.push(f2);
    await waitFor(() => f2.received.some((r) => r.command?.[0] === 'loadfile'));
    await waitFor(() => zone.state().status === 'playing');
  });
});
