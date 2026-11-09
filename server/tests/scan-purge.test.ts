// Regression: a scan while one of several library roots is unreadable or emptied must not purge that
// root's tracks/albums (the foreign keys cascade into hidden flags, loudness, album details...).
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { ensureDupesSchema } from '../src/library/dupes.js';
import { ensureLoudnessSchema } from '../src/loudness/index.js';
import { createScanner } from '../src/scan/index.js';

function flac(path: string, title: string, artist: string, album: string, n = 1): void {
  execFileSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', '-c:a', 'flac',
      '-metadata', `title=${title}`, '-metadata', `artist=${artist}`, '-metadata', `album=${album}`,
      '-metadata', `track=${n}`, path],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

let root: string;
let libA: string;
let libB: string;
let db: ReturnType<typeof openDb>;
let scanner: ReturnType<typeof createScanner>;

const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'rune-scan-purge-'));
  libA = join(root, 'libA');
  libB = join(root, 'libB');
  const dataDir = join(root, 'data');
  mkdirSync(join(libA, 'Artist A - Album A'), { recursive: true });
  mkdirSync(join(libB, 'Artist B - Album B'), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  flac(join(libA, 'Artist A - Album A', '01.flac'), 'Song A', 'Artist A', 'Album A');
  flac(join(libB, 'Artist B - Album B', '01.flac'), 'Song B', 'Artist B', 'Album B');
  flac(join(libB, 'Artist B - Album B', '02.flac'), 'Song B2', 'Artist B', 'Album B', 2);
  const cfg: Config = { libraryRoots: [libA, libB], dataDir, port: 0, audioDevice: 'null', userAgent: 'test' };
  db = openDb(join(root, 'scan.db'));
  ensureDupesSchema(db);
  ensureLoudnessSchema(db);
  scanner = createScanner(db, cfg);
  await scanner.scan();
  const albumB = db.prepare("SELECT id FROM albums WHERE title = 'Album B'").get() as { id: string };
  const trackB = db.prepare('SELECT id FROM tracks WHERE album_id = ? LIMIT 1').get(albumB.id) as { id: string };
  db.prepare('INSERT INTO album_prefs (album_id, hidden) VALUES (?, 1)').run(albumB.id);
  db.prepare(
    'INSERT INTO track_loudness (track_id, lufs, true_peak_db, analysed_at, file_mtime) VALUES (?, -12.0, -1.0, 1, 1)',
  ).run(trackB.id);
});

afterEach(() => {
  try {
    chmodSync(libB, 0o755);
  } catch {
    // ignore
  }
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('scan purge safety', () => {
  it('keeps everything under a root that is missing while another root is fine', async () => {
    expect(count('SELECT count(*) n FROM tracks')).toBe(3);
    renameSync(libB, libB + '.unmounted');
    const stats = await scanner.scan();
    expect(stats.deletedTracks).toBe(0);
    expect(stats.deletedAlbums).toBe(0);
    expect(count('SELECT count(*) n FROM tracks')).toBe(3);
    expect(count('SELECT count(*) n FROM album_prefs')).toBe(1);
    expect(count('SELECT count(*) n FROM track_loudness')).toBe(1);
    renameSync(libB + '.unmounted', libB);
    await scanner.scan();
    expect(count('SELECT count(*) n FROM album_prefs')).toBe(1);
    expect(count('SELECT count(*) n FROM track_loudness')).toBe(1);
  });

  it('keeps the tracks of a root that has become an empty directory (unmounted mountpoint)', async () => {
    rmSync(join(libB, 'Artist B - Album B'), { recursive: true });
    const stats = await scanner.scan();
    expect(stats.deletedTracks).toBe(0);
    expect(count('SELECT count(*) n FROM tracks')).toBe(3);
    expect(count('SELECT count(*) n FROM track_loudness')).toBe(1);
  });

  it('keeps a root that cannot be listed (permission error)', async () => {
    if (process.getuid?.() === 0) return;
    chmodSync(libB, 0o000);
    const stats = await scanner.scan();
    chmodSync(libB, 0o755);
    expect(stats.deletedTracks).toBe(0);
    expect(count('SELECT count(*) n FROM album_prefs')).toBe(1);
  });

  it('still deletes a file that vanished from a healthy root', async () => {
    unlinkSync(join(libA, 'Artist A - Album A', '01.flac'));
    writeFileSync(join(libA, 'Artist A - Album A', 'note.txt'), 'x');
    flac(join(libA, 'Artist A - Album A', '02.flac'), 'Song A2', 'Artist A', 'Album A', 2);
    const stats = await scanner.scan();
    expect(stats.deletedTracks).toBe(1);
    expect(count("SELECT count(*) n FROM tracks WHERE title = 'Song A'")).toBe(0);
    expect(count('SELECT count(*) n FROM tracks')).toBe(3);
  });
});
