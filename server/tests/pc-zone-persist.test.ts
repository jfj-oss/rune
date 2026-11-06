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

function savedSession(db: Db): Record<string, unknown> | undefined {
  const row = db
    .prepare('SELECT value FROM app_state WHERE key = ?')
    .get('player.pc.session') as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as Record<string, unknown>) : undefined;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('PcZone session persistence', () => {
  let db: Db;
  const zones: PcZone[] = [];
  const fakes: FakeMpvSocket[] = [];
  const dirs: string[] = [];

  /** A new zone (and its own fake mpv/data dir) on the same DB. */
  async function makeZone(): Promise<{ zone: PcZone; fake: FakeMpvSocket }> {
    const dir = mkdtempSync(join(tmpdir(), 'liner-pc-persist-'));
    dirs.push(dir);
    let started: Promise<FakeMpvSocket> | undefined;
    mocks.spawn.mockImplementationOnce(() => {
      started = startFakeMpvSocket(join(dir, 'mpv.sock'));
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
    const zone = await createPcZone(db, cfg);
    const fake = await started!;
    zones.push(zone);
    fakes.push(fake);
    return { zone, fake };
  }

  const names = (fake: FakeMpvSocket) =>
    fake.received.map((r) => String(r.command?.[0] ?? ''));

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

  it('restores the queue, ids, index, position, shuffle, repeat and volume, paused', async () => {
    const { zone: z1 } = await makeZone();
    await z1.command({
      type: 'play',
      trackIds: ['l:1', 'l:2', 'l:3', 'l:4', 'l:5'],
      startIndex: 2,
    });
    await z1.command({ type: 'seek', positionMs: 42_000 });
    await z1.command({ type: 'shuffle', on: true });
    await z1.command({ type: 'repeat', mode: 'all' });
    await z1.command({ type: 'volume', volume: 42 });
    await z1.command({ type: 'pause' });
    const before = z1.state();
    const trackIds = before.queue.map((q) => q.track.id);
    const queueIds = before.queue.map((q) => q.queueId);
    await z1.close();

    const { zone: z2, fake } = await makeZone();
    const after = z2.state();

    expect(after.status).toBe('paused');
    expect(after.queue.map((q) => q.track.id)).toEqual(trackIds);
    expect(after.queue.map((q) => q.queueId)).toEqual(queueIds);
    expect(after.index).toBe(2);
    expect(after.positionMs).toBe(42_000);
    expect(after.shuffle).toBe(true);
    expect(after.repeat).toBe('all');
    expect(after.volume).toBe(42);

    // Restoring must not hand anything to mpv: no sound until the user presses play.
    expect(names(fake)).not.toContain('loadfile');
    expect(names(fake)).not.toContain('playlist-clear');
    expect(names(fake)).not.toContain('playlist-next');
  });

  it('resumes a restored queue from the saved position', async () => {
    const { zone: z1 } = await makeZone();
    await z1.command({ type: 'play', trackIds: ['l:1', 'l:2'] });
    await z1.command({ type: 'seek', positionMs: 42_000 });
    await z1.command({ type: 'pause' });
    await z1.close();

    const { zone: z2, fake } = await makeZone();
    fake.received.length = 0;
    const state = await z2.command({ type: 'resume' });

    expect(state.status).toBe('playing');
    const load = fake.received.find((r) => r.command?.[0] === 'loadfile');
    expect(load?.command).toContain('start=42');
  });

  it('starts a restored queue over when it had finished, within 100 ms of the end', async () => {
    const { zone: z1 } = await makeZone();
    await z1.command({ type: 'play', trackIds: ['l:1', 'l:2'] });
    await z1.close();
    const row = savedSession(db)!;
    db.prepare('UPDATE app_state SET value = ? WHERE key = ?').run(JSON.stringify({ ...row, positionMs: 199_950 }), 'player.pc.session');

    const { zone: z2, fake } = await makeZone();
    expect(z2.state().positionMs).toBe(0);
    await z2.command({ type: 'resume' });
    const load = fake.received.map((r) => r.command ?? []).find((c) => c[0] === 'loadfile');
    expect(String(load?.[4] ?? '')).not.toContain('start=');
  });

  it('keeps the position of a restored queue that is not that close to the end', async () => {
    const { zone: z1 } = await makeZone();
    await z1.command({ type: 'play', trackIds: ['l:1', 'l:2'] });
    await z1.close();
    const row = savedSession(db)!;
    db.prepare('UPDATE app_state SET value = ? WHERE key = ?').run(JSON.stringify({ ...row, positionMs: 199_800 }), 'player.pc.session');

    const { zone: z2 } = await makeZone();
    expect(z2.state().positionMs).toBe(199_800);
  });

  it('drops tracks that no longer exist and fixes the index', async () => {
    const { zone: z1 } = await makeZone();
    await z1.command({
      type: 'play',
      trackIds: ['l:1', 'l:2', 'l:3', 'l:4', 'l:5'],
      startIndex: 2, // current: l:3
    });
    const savedIds = z1.state().queue.map((q) => q.queueId);
    await z1.close();

    // l:1 disappears before the current track, l:3 (the current one) disappears.
    db.prepare("DELETE FROM tracks WHERE id IN ('l:1', 'l:3')").run();

    const { zone: z2 } = await makeZone();
    const state = z2.state();

    expect(state.queue.map((q) => q.track.id)).toEqual(['l:2', 'l:4', 'l:5']);
    expect(state.queue.map((q) => q.queueId)).toEqual([savedIds[1], savedIds[3], savedIds[4]]);
    // Continue from the next surviving entry; the missing current resets the position.
    expect(state.index).toBe(1);
    expect(state.queue[state.index]?.track.id).toBe('l:4');
    expect(state.positionMs).toBe(0);
    expect(state.status).toBe('paused');
  });

  it('starts empty and does not throw when the saved state is corrupt', async () => {
    const { zone: z1 } = await makeZone();
    await z1.command({ type: 'play', trackIds: ['l:1', 'l:2'] });
    await z1.close();
    db.prepare('UPDATE app_state SET value = ? WHERE key = ?').run(
      '{not valid json',
      'player.pc.session',
    );

    const { zone: z2 } = await makeZone();
    const state = z2.state();

    expect(state.queue).toEqual([]);
    expect(state.index).toBe(-1);
    expect(state.positionMs).toBe(0);
    expect(state.status).toBe('stopped');
    expect(state.volume).toBe(100);
    expect(state.shuffle).toBe(false);
    expect(state.repeat).toBe('off');
  });

  it('treats an old or malformed payload as no session at all', async () => {
    const { zone: z1 } = await makeZone();
    await z1.close();
    db.prepare('UPDATE app_state SET value = ? WHERE key = ?').run(
      JSON.stringify({ v: 0, queue: [{ queueId: 'q', trackId: 'l:1' }], index: 0 }),
      'player.pc.session',
    );

    const { zone: z2 } = await makeZone();
    expect(z2.state().queue).toEqual([]);
    expect(z2.state().volume).toBe(100);
  });

  it('starts with defaults when nothing was ever saved', async () => {
    const { zone } = await makeZone();
    const state = zone.state();

    expect(state.queue).toEqual([]);
    expect(state.index).toBe(-1);
    expect(state.status).toBe('stopped');
    expect(state.shuffle).toBe(false);
    expect(state.repeat).toBe('off');
    expect(state.volume).toBe(100);
    expect(savedSession(db)).toBeUndefined();
  });

  it('writes a change to the DB shortly after it happens, without closing', async () => {
    const { zone } = await makeZone();
    await zone.command({ type: 'play', trackIds: ['l:1', 'l:2'] });

    await waitFor(() => savedSession(db) !== undefined);
    const saved = savedSession(db)!;
    expect((saved.queue as { trackId: string }[]).map((e) => e.trackId)).toEqual(['l:1', 'l:2']);
    expect(saved.index).toBe(0);
  });
});
