import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/index.js';
import {
  applyRotation,
  createBackupService,
  dateStamp,
  isoWeekKey,
  nextNightlyRun,
  planRotation,
} from '../src/ops/backup.js';

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

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'liner-backup-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seededDb() {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)').run('ar:1', 'Artist');
  db.prepare(
    `INSERT INTO albums (id, source, title, artist_id, added_at) VALUES ('la:1', 'local', 'Album', 'ar:1', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO tracks (id, album_id, source, title, number, duration_ms)
     VALUES ('l:1', 'la:1', 'local', 'Track', 1, 1000)`,
  ).run();
  return db;
}

function fakeClock(date = new Date(2026, 0, 5, 3, 0, 0)): { now: () => Date; set: (d: Date) => void } {
  let current = date;
  return { now: () => new Date(current), set: (d) => (current = d) };
}

describe('backup rotation', () => {
  it('keeps 7 dailies, 4 weeklies and 3 monthlies; leaves unrelated files alone', () => {
    const names = [
      ...Array.from({ length: 10 }, (_, i) => `liner-202610${String(i + 1).padStart(2, '0')}.db`),
      ...Array.from({ length: 6 }, (_, i) => `liner-week-2026090${i + 1}.db`),
      ...Array.from({ length: 5 }, (_, i) => `liner-compact-2026${String(i + 1).padStart(2, '0')}.db`),
      'README.txt',
      'liner-notes.db',
      'other.db',
    ];
    const plan = planRotation(names);
    expect(plan.keep).toContain('liner-20261010.db');
    expect(plan.keep).toContain('liner-20261004.db');
    expect(plan.remove).toEqual(
      expect.arrayContaining([
        'liner-20261001.db',
        'liner-20261002.db',
        'liner-20261003.db',
        'liner-week-20260901.db',
        'liner-week-20260902.db',
        'liner-compact-202601.db',
        'liner-compact-202602.db',
      ]),
    );
    expect(plan.remove).not.toContain('liner-20261004.db');
    expect(plan.remove).not.toContain('README.txt');
    expect(plan.remove).not.toContain('liner-notes.db');

    expect(plan.keep.filter((n) => /^liner-\d{8}\.db$/.test(n))).toHaveLength(7);
    expect(plan.keep.filter((n) => n.startsWith('liner-week-'))).toHaveLength(4);
    expect(plan.keep.filter((n) => n.startsWith('liner-compact-'))).toHaveLength(3);
  });

  it('deletes the planned files from disk', () => {
    const dir = tempDir();
    for (const name of ['liner-20260101.db', 'liner-20260102.db', 'keep.txt']) {
      writeFileSync(join(dir, name), '');
    }
    const removed = applyRotation(dir, planRotation(readdirSync(dir), { dailies: 1 }));
    expect(removed.map((p) => p.slice(dir.length + 1))).toEqual(['liner-20260101.db']);
    expect(existsSync(join(dir, 'liner-20260102.db'))).toBe(true);
    expect(existsSync(join(dir, 'keep.txt'))).toBe(true);
  });

  it('computes the next 03:00 run and ISO week keys', () => {
    const before = new Date(2026, 0, 5, 1, 30);
    expect(nextNightlyRun(before, 3)).toEqual(new Date(2026, 0, 5, 3, 0, 0, 0));
    const after = new Date(2026, 0, 5, 4, 0);
    expect(nextNightlyRun(after, 3)).toEqual(new Date(2026, 0, 6, 3, 0, 0, 0));
    // Mon 2026-01-05 and Tue 2026-01-06 are the same ISO week.
    expect(isoWeekKey(new Date(2026, 0, 5))).toBe(isoWeekKey(new Date(2026, 0, 6)));
    expect(isoWeekKey(new Date(2026, 0, 12))).not.toBe(isoWeekKey(new Date(2026, 0, 5)));
  });
});

describe('backup service', () => {
  it('makes an online backup that can be reopened and rotates old files', async () => {
    const dataDir = tempDir();
    const db = seededDb();
    cleanups.push(() => db.close());
    const clock = fakeClock(new Date(2026, 0, 5, 3, 0));

    // Pre-existing backups that should fall off after a few more days.
    mkdirSync(join(dataDir, 'backups'), { recursive: true });
    for (const d of ['01', '02', '03']) writeFileSync(join(dataDir, 'backups', `liner-202511${d}.db`), '');

    const svc = createBackupService(db, { dataDir, now: clock.now, nightlyHour: 3 });

    const first = await svc.backup('nightly');
    expect(first.daily).toBe(join(dataDir, 'backups', 'liner-20260105.db'));
    expect(existsSync(first.daily)).toBe(true);
    expect(first.weekly).toBe(join(dataDir, 'backups', 'liner-week-20260105.db'));
    expect(first.compacted).toBe(join(dataDir, 'backups', 'liner-compact-202601.db'));

    // The backup is a real, openable SQLite database with the data in it.
    const copy = openDb(first.daily);
    try {
      expect((copy.prepare('SELECT COUNT(*) AS n FROM albums').get() as { n: number }).n).toBe(1);
      expect((copy.prepare('SELECT COUNT(*) AS n FROM tracks').get() as { n: number }).n).toBe(1);
    } finally {
      copy.close();
    }

    // Same day / same week: overwrite today's, no second weekly, no second compact.
    const again = await svc.backup('manual');
    expect(again.daily).toBe(first.daily);
    expect(again.weekly).toBeUndefined();
    expect(again.compacted).toBeUndefined();

    // Ten days total: rotation leaves 7 dailies even though we wrote 10.
    for (let day = 6; day <= 14; day++) {
      clock.set(new Date(2026, 0, day, 3, 0));
      await svc.backup('nightly');
    }
    const list = svc.list();
    expect(list.dailies).toHaveLength(7);
    expect(list.dailies[list.dailies.length - 1]).toBe('liner-20260114.db');
    expect(list.dailies[0]).toBe('liner-20260108.db');
    expect(list.weeklies.length).toBeGreaterThanOrEqual(1);
    expect(list.weeklies.length).toBeLessThanOrEqual(4);
    expect(existsSync(join(dataDir, 'backups', 'liner-20251101.db'))).toBe(false);
  });

  it('creates at most one weekly per ISO week and one compaction per month', async () => {
    const dataDir = tempDir();
    const db = seededDb();
    cleanups.push(() => db.close());
    const clock = fakeClock(new Date(2026, 0, 5, 3, 0)); // Monday
    const svc = createBackupService(db, { dataDir, now: clock.now });

    const monday = await svc.backup();
    expect(monday.weekly).toBeDefined();
    expect(monday.compacted).toBeDefined();

    clock.set(new Date(2026, 0, 6, 3, 0)); // Tuesday, same ISO week/month
    const tuesday = await svc.backup();
    expect(tuesday.weekly).toBeUndefined();
    expect(tuesday.compacted).toBeUndefined();

    clock.set(new Date(2026, 0, 12, 3, 0)); // next Monday
    const nextWeek = await svc.backup();
    expect(nextWeek.weekly).toBeDefined();
    expect(nextWeek.compacted).toBeUndefined();

    clock.set(new Date(2026, 1, 2, 3, 0)); // next month
    const nextMonth = await svc.backup();
    expect(nextMonth.compacted).toBe(join(dataDir, 'backups', 'liner-compact-202602.db'));
    expect(existsSync(join(dataDir, 'backups', 'liner-compact-202601.db'))).toBe(true);
  });

  it('nightly scheduler stops without leaving a timer behind', () => {
    const dataDir = tempDir();
    const db = seededDb();
    cleanups.push(() => db.close());
    const svc = createBackupService(db, { dataDir });
    svc.start();
    svc.start(); // idempotent
    svc.stop();
    svc.stop();
  });

  it('formats backup dates from local calendar parts', () => {
    expect(dateStamp(new Date(2026, 10, 1))).toBe('20261101');
    expect(dateStamp(new Date(2026, 0, 9))).toBe('20260109');
  });
});
