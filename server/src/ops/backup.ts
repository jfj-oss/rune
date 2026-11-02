// Online database backups and retention.
//
// Nightly (and on demand) a consistent copy of the live SQLite database is made
// with better-sqlite3's db.backup() (SQLite's online backup API — safe while scans
// and playback write to the DB). Files live in <dataDir>/backups:
//
//   liner-YYYYMMDD.db          one per day, keep the newest 7
//   liner-week-YYYYMMDD.db     first backup of each ISO week, keep the newest 4
//   liner-compact-YYYYMM.db    VACUUM INTO snapshot, once a month, keep newest 3
//
// The clock (and the scheduler) is injectable so retention can be tested without
// touching the real clock or waiting for 3 am.
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/index.js';

export const DAILY_RE = /^liner-(\d{4})(\d{2})(\d{2})\.db$/;
export const WEEKLY_RE = /^liner-week-(\d{4})(\d{2})(\d{2})\.db$/;
export const MONTHLY_RE = /^liner-compact-(\d{4})(\d{2})\.db$/;

export const DEFAULT_KEEP_DAILIES = 7;
export const DEFAULT_KEEP_WEEKLIES = 4;
export const DEFAULT_KEEP_MONTHLIES = 3;
/** Local hour (0-23) of the nightly backup. */
export const DEFAULT_NIGHTLY_HOUR = 3;

export interface Logger {
  warn: (obj: unknown, msg?: string) => void;
  info?: (obj: unknown, msg?: string) => void;
}

export interface BackupServiceOptions {
  dataDir: string;
  /** Injectable clock (tests use a fake one). */
  now?: () => Date;
  keepDailies?: number;
  keepWeeklies?: number;
  keepMonthlies?: number;
  /** Local hour for the nightly job (default 03:00). */
  nightlyHour?: number;
  logger?: Logger;
}

export interface RotationPlan {
  /** File names to keep. */
  keep: string[];
  /** File names (absolute after applyRotation) to delete. */
  remove: string[];
}

export interface BackupResult {
  daily: string;
  weekly?: string;
  compacted?: string;
  /** Paths deleted by retention. */
  removed: string[];
  at: number;
  kind: 'nightly' | 'manual';
}

export interface BackupService {
  /** Make a backup now, create the weekly/monthly snapshots if due, then rotate. */
  backup(kind?: 'nightly' | 'manual'): Promise<BackupResult>;
  /** Only rotate existing files (safe to call repeatedly). */
  rotate(): string[];
  /** VACUUM INTO this month's compacted copy (no-op when it already exists). */
  compact(now?: Date): Promise<string | undefined>;
  /** Start the nightly timer (03:00 local by default). Idempotent. */
  start(): void;
  /** Stop the nightly timer. */
  stop(): void;
  /** Resolve when no backup is running (wire this into graceful shutdown's flushDb). */
  idle(): Promise<void>;
  list(): { dailies: string[]; weeklies: string[]; monthlies: string[] };
}

// ---------------------------------------------------------------- naming

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** Local calendar date as YYYYMMDD. */
export function dateStamp(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/** Local year+month as YYYYMM. */
export function monthStamp(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}`;
}

/** Date part of a daily/weekly backup name, or undefined. */
function parseDate(name: string): Date | undefined {
  const m = DAILY_RE.exec(name) ?? WEEKLY_RE.exec(name);
  if (!m) return undefined;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** ISO week key (Monday-based), used to create at most one weekly per week. */
export function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7; // Mon=1 ... Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${pad(week)}`;
}

// ---------------------------------------------------------------- retention

/** Pure retention decision over file *names*. Newest names sort highest (zero-padded). */
export function planRotation(
  names: readonly string[],
  keep: { dailies?: number; weeklies?: number; monthlies?: number } = {},
): RotationPlan {
  const keepDailies = keep.dailies ?? DEFAULT_KEEP_DAILIES;
  const keepWeeklies = keep.weeklies ?? DEFAULT_KEEP_WEEKLIES;
  const keepMonthlies = keep.monthlies ?? DEFAULT_KEEP_MONTHLIES;

  const dailies = names.filter((n) => DAILY_RE.test(n)).sort().reverse();
  const weeklies = names.filter((n) => WEEKLY_RE.test(n)).sort().reverse();
  const monthlies = names.filter((n) => MONTHLY_RE.test(n)).sort().reverse();

  const removed = [
    ...dailies.slice(Math.max(0, keepDailies)),
    ...weeklies.slice(Math.max(0, keepWeeklies)),
    ...monthlies.slice(Math.max(0, keepMonthlies)),
  ];
  const removeSet = new Set(removed);
  return { keep: names.filter((n) => !removeSet.has(n)), remove: removed };
}

/** Delete excess backups from `dir`; returns the paths removed. */
export function applyRotation(dir: string, plan: RotationPlan): string[] {
  const removed: string[] = [];
  for (const name of plan.remove) {
    const path = join(dir, name);
    try {
      unlinkSync(path);
      removed.push(path);
    } catch {
      // already gone
    }
  }
  return removed;
}

// ---------------------------------------------------------------- service

export function createBackupService(db: Db, opts: BackupServiceOptions): BackupService {
  return new BackupServiceImpl(db, opts);
}

class BackupServiceImpl implements BackupService {
  private readonly db: Db;
  private readonly dir: string;
  private readonly now: () => Date;
  private readonly keepDailies: number;
  private readonly keepWeeklies: number;
  private readonly keepMonthlies: number;
  private readonly nightlyHour: number;
  private readonly logger?: Logger;

  private timer: NodeJS.Timeout | null = null;
  private active = false;
  private inFlight: Promise<BackupResult> | null = null;

  constructor(db: Db, opts: BackupServiceOptions) {
    this.db = db;
    this.dir = join(opts.dataDir, 'backups');
    this.now = opts.now ?? (() => new Date());
    this.keepDailies = Math.max(1, opts.keepDailies ?? DEFAULT_KEEP_DAILIES);
    this.keepWeeklies = Math.max(0, opts.keepWeeklies ?? DEFAULT_KEEP_WEEKLIES);
    this.keepMonthlies = Math.max(0, opts.keepMonthlies ?? DEFAULT_KEEP_MONTHLIES);
    this.nightlyHour = Math.min(23, Math.max(0, opts.nightlyHour ?? DEFAULT_NIGHTLY_HOUR));
    this.logger = opts.logger;
  }

  async backup(kind: 'nightly' | 'manual' = 'manual'): Promise<BackupResult> {
    // One backup at a time; a second caller joins the one already running.
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doBackup(kind).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doBackup(kind: 'nightly' | 'manual'): Promise<BackupResult> {
    const date = this.now();
    mkdirSync(this.dir, { recursive: true });

    const daily = join(this.dir, `liner-${dateStamp(date)}.db`);
    // SQLite's online backup API: consistent even while the server is writing.
    await this.db.backup(daily);

    let weekly: string | undefined;
    if (!this.hasWeeklyForWeek(date)) {
      const candidate = join(this.dir, `liner-week-${dateStamp(date)}.db`);
      try {
        copyFileSync(daily, candidate);
        weekly = candidate;
      } catch (err) {
        this.warn({ err, path: candidate }, 'weekly backup copy failed');
      }
    }

    let compacted: string | undefined;
    try {
      compacted = await this.compact(date);
    } catch (err) {
      // A failed VACUUM must not lose the backup that just succeeded.
      this.warn({ err }, 'monthly VACUUM INTO failed');
    }

    const removed = this.rotate();
    return { daily, ...(weekly ? { weekly } : {}), ...(compacted ? { compacted } : {}), removed, at: date.getTime(), kind };
  }

  async idle(): Promise<void> {
    if (this.inFlight) await this.inFlight.then(
      () => undefined,
      () => undefined,
    );
  }

  rotate(): string[] {
    if (!existsSync(this.dir)) return [];
    const plan = planRotation(readdirSync(this.dir), {
      dailies: this.keepDailies,
      weeklies: this.keepWeeklies,
      monthlies: this.keepMonthlies,
    });
    return applyRotation(this.dir, plan);
  }

  async compact(now?: Date): Promise<string | undefined> {
    const date = now ?? this.now();
    mkdirSync(this.dir, { recursive: true });
    const dest = join(this.dir, `liner-compact-${monthStamp(date)}.db`);
    if (existsSync(dest)) return undefined; // once per month

    const tmp = `${dest}.tmp`;
    rmSync(tmp, { force: true });
    try {
      // VACUUM INTO writes a compacted copy and does not touch the live DB.
      this.db.prepare('VACUUM INTO ?').run(tmp);
      renameSync(tmp, dest);
      return dest;
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }

  list(): { dailies: string[]; weeklies: string[]; monthlies: string[] } {
    let names: string[] = [];
    try {
      names = readdirSync(this.dir);
    } catch {
      names = [];
    }
    return {
      dailies: names.filter((n) => DAILY_RE.test(n)).sort(),
      weeklies: names.filter((n) => WEEKLY_RE.test(n)).sort(),
      monthlies: names.filter((n) => MONTHLY_RE.test(n)).sort(),
    };
  }

  // ---------------------------------------------------------------- scheduling

  start(): void {
    if (this.active) return;
    this.active = true;
    this.scheduleNext();
  }

  stop(): void {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleNext(): void {
    const now = this.now();
    const next = nextNightlyRun(now, this.nightlyHour);
    const delay = Math.max(1_000, next.getTime() - now.getTime());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.backup('nightly')
        .then((r) => this.log({ result: r }, 'nightly backup complete'))
        .catch((err) => this.warn({ err }, 'nightly backup failed'))
        .finally(() => {
          if (this.active) this.scheduleNext();
        });
    }, delay);
    this.timer.unref?.();
  }

  private hasWeeklyForWeek(date: Date): boolean {
    let names: string[] = [];
    try {
      names = readdirSync(this.dir);
    } catch {
      return false;
    }
    const week = isoWeekKey(date);
    for (const name of names) {
      if (!WEEKLY_RE.test(name)) continue;
      const d = parseDate(name);
      if (d && isoWeekKey(d) === week) return true;
    }
    return false;
  }

  private warn(obj: unknown, msg: string): void {
    try {
      this.logger?.warn(obj, msg);
    } catch {
      // logging must not break backups
    }
  }

  private log(obj: unknown, msg: string): void {
    try {
      this.logger?.info?.(obj, msg);
    } catch {
      // ignore
    }
  }
}

/** Next occurrence of `hour:00` local time strictly after `from`. */
export function nextNightlyRun(from: Date, hour: number): Date {
  const next = new Date(from.getFullYear(), from.getMonth(), from.getDate(), hour, 0, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/** Size of a backup file in MB (helper for reports/health). */
export function fileSizeMB(path: string): number {
  try {
    return Math.round((statSync(path).size / (1024 * 1024)) * 100) / 100;
  } catch {
    return 0;
  }
}
