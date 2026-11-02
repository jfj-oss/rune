// Worker R self-check (run: pnpm -C server exec tsx scripts/watch-selfcheck.ts)
//
// 1. Library watcher on a temp dir: create/rename/delete 50 files rapidly, show
//    onChange fired exactly once per burst; then make the root vanish/reappear
//    and show no follow-up scan on vanish + a reattach on reappear.
// 2. Real backup of a TEMP COPY of ~/.local/share/liner/liner.db (the original is
//    only ever read by copyFileSync) via better-sqlite3's online backup, then a
//    rotation demo showing which backup files survive.
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/index.js';
import { createBackupService } from '../src/ops/backup.js';
import { createLibraryWatcher, type WatchBatch } from '../src/watch/index.js';

const REAL_DB = join(homedir(), '.local/share/liner/liner.db');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

async function watcherSelfCheck(): Promise<void> {
  console.log('== 1. library watcher ==');
  const root = mkdtempSync(join(tmpdir(), 'liner-watch-selfcheck-'));
  mkdirSync(join(root, 'Album', 'Disc 1'), { recursive: true });
  writeFileSync(join(root, 'Album', 'Disc 1', '01.flac'), 'seed');

  const batches: WatchBatch[] = [];
  const watcher = createLibraryWatcher({
    roots: [root],
    debounceMs: 1_000, // the production default is 10 s; shortened for the demo
    pollIntervalMs: 10 * 60_000,
    onChange: (batch) => {
      batches.push(batch);
    },
  });
  await watcher.start();

  const burst = (n: number, label: string): void => {
    const started = Date.now();
    const dir = join(root, 'Album', 'Disc 1');
    for (let i = 0; i < n; i++) writeFileSync(join(dir, `${label}-${String(i).padStart(2, '0')}.flac`), `x${i}`);
    renameSync(join(dir, `${label}-00.flac`), join(dir, `${label}-renamed.flac`));
    unlinkSync(join(dir, `${label}-01.flac`));
    writeFileSync(join(dir, 'cover.jpg'), 'jpeg');
    writeFileSync(join(dir, 'album.cue'), 'FILE "x.flac" WAVE');
    const elapsed = Date.now() - started;
    console.log(`  burst ${label}: 50 creates + 1 rename + 1 delete + image + cue in ${elapsed} ms`);
  };

  burst(50, 'one');
  await waitFor(() => batches.length >= 1, 'first debounced batch');
  const firstAt = Date.now();
  await sleep(1_600); // > debounce + slack
  console.log(`  onChange #1 after quiet period: reason=${batches[0]!.reason} files=${batches[0]!.files.length} (${Date.now() - firstAt} ms of extra silence, still exactly ${batches.length} callback)`);

  burst(50, 'two');
  await waitFor(() => batches.length >= 2, 'second debounced batch');
  await sleep(1_600);
  console.log(`  onChange #2: reason=${batches[1]!.reason} files=${batches[1]!.files.length}; callbacks total=${batches.length}`);

  if (batches.length !== 2) throw new Error(`expected one onChange per burst, got ${batches.length}`);

  // Root disappears (drive unmounted) — must not trigger a scan.
  rmSync(root, { recursive: true, force: true });
  await sleep(400);
  const vanishedPoll = await watcher.pollNow();
  console.log(`  root removed: mounted=${vanishedPoll.roots[0]!.mounted}, onChange callbacks still=${batches.length}`);
  if (batches.length !== 2) throw new Error('vanish triggered onChange');

  // Drive comes back — poll reattaches and asks for one scan.
  mkdirSync(join(root, 'Album'), { recursive: true });
  writeFileSync(join(root, 'Album', 'restored.flac'), 'x');
  const backPoll = await watcher.pollNow();
  await waitFor(() => batches.length >= 3, 'reappear batch');
  console.log(`  root restored: appeared=${JSON.stringify(backPoll.appeared)} notified=${backPoll.notified} reason=${batches[2]!.reason}`);
  console.log(`  live fs.watch roots after reattach: ${JSON.stringify(watcher.watchedRoots())}`);

  watcher.stop();
  rmSync(root, { recursive: true, force: true });
  console.log('  RESULT: one onChange per burst; vanish suppressed; reappear reattached — OK');
}

function stamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
}

async function backupSelfCheck(): Promise<void> {
  console.log('\n== 2. online backup of a temp copy of the real DB ==');
  if (!existsSync(REAL_DB)) {
    console.log(`  SKIPPED: ${REAL_DB} does not exist`);
    return;
  }
  const work = mkdtempSync(join(tmpdir(), 'liner-backup-selfcheck-'));
  const dataDir = join(work, 'data');
  const dbCopy = join(work, 'liner.db');
  try {
    // Never open the original: copy (db + WAL + SHM) into a temp dir first.
    copyFileSync(REAL_DB, dbCopy);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(REAL_DB + suffix)) copyFileSync(REAL_DB + suffix, dbCopy + suffix);
    }
    console.log(`  copied ${REAL_DB} -> ${dbCopy} (${(statSync(dbCopy).size / 1024 / 1024).toFixed(1)} MB; original untouched)`);

    const db = openDb(dbCopy);
    try {
      const before = {
        albums: (db.prepare('SELECT COUNT(*) AS n FROM albums').get() as { n: number }).n,
        tracks: (db.prepare('SELECT COUNT(*) AS n FROM tracks').get() as { n: number }).n,
      };
      const service = createBackupService(db, { dataDir });
      const result = await service.backup('nightly');
      console.log(`  online backup -> ${result.daily} (${(statSync(result.daily).size / 1024 / 1024).toFixed(1)} MB)`);
      console.log(`  weekly:  ${result.weekly ?? '(already have one for this ISO week)'}`);
      console.log(`  compact: ${result.compacted ?? '(already compacted this month)'}`);

      const copy = openDb(result.daily);
      try {
        const after = {
          albums: (copy.prepare('SELECT COUNT(*) AS n FROM albums').get() as { n: number }).n,
          tracks: (copy.prepare('SELECT COUNT(*) AS n FROM tracks').get() as { n: number }).n,
        };
        const integrity = (copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
        console.log(`  reopened backup: albums=${after.albums}/${before.albums} tracks=${after.tracks}/${before.tracks} integrity_check=${integrity}`);
        if (after.albums !== before.albums || after.tracks !== before.tracks) throw new Error('backup row counts differ');
        if (integrity !== 'ok') throw new Error(`integrity_check: ${integrity}`);
      } finally {
        copy.close();
      }

      // Rotation demo: seed older daily/weekly/monthly files, rotate, show survivors.
      const backupsDir = join(dataDir, 'backups');
      const today = new Date();
      const older = (days: number): string => {
        const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - days);
        return stamp(d);
      };
      for (let day = 1; day <= 10; day++) writeFileSync(join(backupsDir, `liner-${older(day)}.db`), '');
      for (let week = 1; week <= 6; week++) writeFileSync(join(backupsDir, `liner-week-${older(week * 7)}.db`), '');
      for (let month = 1; month <= 5; month++) {
        const d = new Date(today.getFullYear(), today.getMonth() - month, 1);
        writeFileSync(join(backupsDir, `liner-compact-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}.db`), '');
      }
      console.log(`  seeded rotation demo dir (${readdirSync(backupsDir).length} files incl. the real backup)`);
      const removed = service.rotate();
      console.log(`  rotation removed ${removed.length} files:`);
      for (const path of removed.sort()) console.log(`    - ${path.slice(backupsDir.length + 1)}`);
      const list = service.list();
      console.log('  surviving backup files:');
      for (const name of [...list.dailies, ...list.weeklies, ...list.monthlies]) {
        const marker = name === `liner-${stamp(today)}.db` ? '  <- real online backup' : '';
        console.log(`    ${name}${marker}`);
      }
      if (list.dailies.length !== 7) throw new Error(`expected 7 dailies, got ${list.dailies.length}`);
      if (list.weeklies.length !== 4) throw new Error(`expected 4 weeklies, got ${list.weeklies.length}`);
      if (list.monthlies.length !== 3) throw new Error(`expected 3 monthlies, got ${list.monthlies.length}`);
    } finally {
      db.close();
    }
    console.log('  RESULT: real online backup verified + rotation (7 daily / 4 weekly / 3 monthly) — OK');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const sqlite = execFileSync('sqlite3', ['--version'], { encoding: 'utf8' }).trim();
console.log(`node ${process.version}; ${sqlite}\n`);
await watcherSelfCheck();
await backupSelfCheck();
console.log('\nself-check complete');
