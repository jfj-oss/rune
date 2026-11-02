import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLibraryWatcher,
  batchDigest,
  type LibraryWatcher,
  type WatchBatch,
} from '../src/watch/index.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await sleep(20);
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'liner-watch-'));
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {
      // best effort
    }
  }
});

function watcher(opts: Parameters<typeof createLibraryWatcher>[0]): LibraryWatcher {
  const w = createLibraryWatcher(opts);
  cleanups.push(() => w.stop());
  return w;
}

describe('library watcher', () => {
  it('fires once per debounced burst of created/renamed/deleted files', async () => {
    const root = tempDir();
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    const batches: WatchBatch[] = [];
    const w = watcher({
      roots: [root],
      debounceMs: 150,
      pollIntervalMs: 60_000,
      onChange: (b) => {
        batches.push(b);
      },
    });
    await w.start();

    // Burst 1: 50 new files, one rename, one delete — all inside the quiet period.
    for (let i = 0; i < 50; i++) writeFileSync(join(root, `track-${i}.flac`), `audio ${i}`);
    renameSync(join(root, 'track-0.flac'), join(root, 'renamed.flac'));
    unlinkSync(join(root, 'track-1.flac'));

    await waitFor(() => batches.length >= 1);
    await sleep(450); // well past another debounce window
    expect(batches).toHaveLength(1);
    expect(batches[0]!.reason).toBe('events');
    expect(batches[0]!.files.length).toBeGreaterThan(0);
    expect(batches[0]!.roots).toEqual([root]);
    expect(w.lastChangeAt()).toBeTypeOf('number');

    // Burst 2: a second, separate burst produces exactly one more callback.
    for (let i = 0; i < 10; i++) writeFileSync(join(root, `second-${i}.mp3`), 'x');
    await waitFor(() => batches.length >= 2);
    await sleep(450);
    expect(batches).toHaveLength(2);
    expect(batches[1]!.files.some((f) => f.includes('second-'))).toBe(true);
    expect(batchDigest(batches[0]!)).not.toBe(batchDigest(batches[1]!));
  });

  it('ignores non-library files but reacts to images and cue sheets', async () => {
    const root = tempDir();
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    const batches: WatchBatch[] = [];
    const w = watcher({
      roots: [root],
      debounceMs: 120,
      pollIntervalMs: 60_000,
      onChange: (b) => {
        batches.push(b);
      },
    });
    await w.start();

    writeFileSync(join(root, 'notes.txt'), 'nope');
    writeFileSync(join(root, 'playlist.m3u'), 'nope');
    await sleep(400);
    expect(batches).toHaveLength(0);

    writeFileSync(join(root, 'cover.jpg'), 'jpeg');
    writeFileSync(join(root, 'album.cue'), 'FILE "x.flac" WAVE');
    await waitFor(() => batches.length === 1);
    const files = batches[0]!.files.join('\n');
    expect(files).toContain('cover.jpg');
    expect(files).toContain('album.cue');
  });

  it('survives the root vanishing and reattaches when it reappears', async () => {
    const parent = tempDir();
    cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
    const root = join(parent, 'BIG data', 'Music');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.flac'), 'x');

    const batches: WatchBatch[] = [];
    const w = watcher({
      roots: [root],
      debounceMs: 100,
      pollIntervalMs: 60_000,
      onChange: (b) => {
        batches.push(b);
      },
    });
    await w.start();
    expect(w.anyMounted()).toBe(true);
    expect(w.watchedRoots()).toEqual([root]);

    // Let the initial fingerprint settle, then make a normal change.
    writeFileSync(join(root, 'b.flac'), 'x');
    await waitFor(() => batches.length === 1);

    // Yank the drive.
    rmSync(root, { recursive: true, force: true });
    await sleep(500);
    // No onChange for the disappearance: a scan against an empty mount would
    // delete the library.
    expect(batches).toHaveLength(1);
    const gone = await w.pollNow();
    expect(gone.roots[0]!.mounted).toBe(false);
    expect(w.anyMounted()).toBe(false);

    // Remount with different contents.
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'restored.flac'), 'x');
    const back = await w.pollNow();
    expect(back.appeared).toEqual([root]);
    expect(back.notified).toBe(true);
    await waitFor(() => batches.length === 2);
    expect(batches[1]!.reason).toBe('root-appeared');

    // The watcher is live again, not just the poll fallback.
    expect(w.watchedRoots()).toEqual([root]);
    writeFileSync(join(root, 'after-remount.flac'), 'x');
    await waitFor(() => batches.length === 3);
    expect(batches[2]!.reason).toBe('events');
    expect(batches[2]!.files.some((f) => f.includes('after-remount'))).toBe(true);
  });

  it('starts without waiting for the fingerprint walk, then seeds in the background', async () => {
    const root = tempDir();
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    for (let i = 0; i < 3; i++) writeFileSync(join(root, `existing-${i}.flac`), 'x');

    const w = watcher({
      roots: [root],
      useFsWatch: false,
      debounceMs: 50,
      pollIntervalMs: 60_000,
      onChange: () => undefined,
    });
    await w.start();
    // start() returned before the async directory walk finished.
    expect(w.seededRoots()).toEqual([]);

    // The first poll waits for that seed and reports a baseline, not "everything is new".
    const baseline = await w.pollNow();
    expect(baseline.changed).toEqual([]);
    expect(baseline.notified).toBe(false);
    expect(w.seededRoots()).toEqual([root]);
  });

  it('skips the full-tree poll while fs.watch is healthy, then runs the hourly safety net', async () => {
    const root = tempDir();
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, 'baseline.flac'), 'x');

    let clock = 1_000_000;
    const batches: WatchBatch[] = [];
    const w = watcher({
      roots: [root],
      debounceMs: 60_000, // keep event-driven batches out of the way
      pollIntervalMs: 60_000,
      healthyPollIntervalMs: 3_600_000,
      now: () => clock,
      onChange: (b) => {
        batches.push(b);
      },
    });
    await w.start();
    await waitFor(() => w.seededRoots().length === 1);
    writeFileSync(join(root, 'new.flac'), 'x');

    // inotify is healthy and the hourly fingerprint is not due: no tree walk, so
    // the poll sees nothing (the debounced fs event handles it in production).
    const early = await w.pollNow();
    expect(early.changed).toEqual([]);
    expect(early.notified).toBe(false);
    expect(batches).toHaveLength(0);

    clock += 3_600_000;
    const hourly = await w.pollNow();
    expect(hourly.changed.some((f) => f.endsWith('new.flac'))).toBe(true);
    expect(hourly.notified).toBe(true);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.reason).toBe('poll');
  });

  it('re-seeds after a poll-only root reappears instead of reporting every file', async () => {
    const parent = tempDir();
    cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
    const root = join(parent, 'Music');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'existing.flac'), 'x');

    const w = watcher({
      roots: [root],
      useFsWatch: false,
      debounceMs: 50,
      pollIntervalMs: 60_000,
      onChange: () => undefined,
    });
    await w.start();
    await waitFor(() => w.seededRoots().length === 1);

    rmSync(root, { recursive: true, force: true });
    const gone = await w.pollNow();
    expect(gone.vanished).toEqual([root]);

    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'existing.flac'), 'x');
    writeFileSync(join(root, 'fresh.flac'), 'x');
    const back = await w.pollNow();
    expect(back.appeared).toEqual([root]);

    // The baseline was captured on reappearance; the next poll must be quiet
    // rather than reporting the whole remounted drive as changed.
    const after = await w.pollNow();
    expect(after.changed).toEqual([]);
    expect(after.notified).toBe(false);
  });

  it('poll-only mode detects changes missed by inotify', async () => {
    const root = tempDir();
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, 'old.flac'), 'one');
    writeFileSync(join(root, 'other.flac'), 'two');

    const batches: WatchBatch[] = [];
    const w = watcher({
      roots: [root],
      useFsWatch: false,
      debounceMs: 50,
      pollIntervalMs: 60_000,
      onChange: (b) => {
        batches.push(b);
      },
    });
    await w.start();
    // Startup seeds fingerprints in the background now; wait for the baseline
    // before changing the tree (otherwise the change is part of the baseline).
    await waitFor(() => w.seededRoots().length === 1);

    // No watcher is attached, so nothing happens until the poll runs.
    writeFileSync(join(root, 'new.flac'), 'three');
    expect(batches).toHaveLength(0);

    const first = await w.pollNow();
    expect(first.notified).toBe(true);
    expect(first.changed.some((f) => f.endsWith('new.flac'))).toBe(true);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.reason).toBe('poll');

    writeFileSync(join(root, 'old.flac'), 'changed-content');
    unlinkSync(join(root, 'other.flac'));
    const second = await w.pollNow();
    expect(second.changed.some((f) => f.endsWith('old.flac'))).toBe(true);
    expect(second.changed.some((f) => f.endsWith('other.flac'))).toBe(true);

    // A poll with no changes at all stays quiet.
    const third = await w.pollNow();
    expect(third.notified).toBe(false);
    expect(third.changed).toEqual([]);
  });

  it('stop() detaches everything and never fires again', async () => {
    const root = tempDir();
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    const batches: WatchBatch[] = [];
    const w = watcher({
      roots: [root],
      debounceMs: 50,
      pollIntervalMs: 60_000,
      onChange: (b) => {
        batches.push(b);
      },
    });
    await w.start();
    w.stop();
    expect(w.watchedRoots()).toEqual([]);

    writeFileSync(join(root, 'late.flac'), 'x');
    await sleep(250);
    expect(batches).toHaveLength(0);
    const poll = await w.pollNow();
    expect(poll.notified).toBe(false);
  });

  it('reports configured roots in status()', async () => {
    const root = tempDir();
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const w = watcher({ roots: [root], pollIntervalMs: 60_000, onChange: () => undefined });
    await w.start();
    const status = w.status();
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ path: root, mounted: true });
    expect(status[0]!.free).toBeGreaterThan(0);
    expect(typeof status[0]!.readOnly).toBe('boolean');
  });
});
