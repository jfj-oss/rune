// Library watcher — wakes the incremental scanner when the music library changes.
//
// Watches every cfg.libraryRoots tree recursively (fs.watch({recursive:true}) works
// on Linux in Node 22, verified; on platforms/situations where it fails the watcher
// degrades to poll-only instead of crashing) for added/removed/changed audio, image
// and .cue files. Events are debounced with a quiet period so a copy of an album
// (thousands of events) triggers ONE onChange.
//
// A music drive is an NTFS disk that a watchdog can unmount or remount
// read-only at any time, so:
//   - a vanished root closes its watcher, discards pending events and does NOT call
//     onChange (a rescan against an empty mount would delete the whole library);
//   - roots are re-checked on a 10-minute poll; a root that comes back re-attaches
//     its watcher and calls onChange so the scanner restores anything that changed
//     while it was away;
//   - the same poll compares a per-root fingerprint (path -> mtime:size) so changes
//     missed by inotify are still caught;
//   - every failure path just marks the root unmounted and waits for the next poll;
//     nothing retries in a tight loop.
import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { existsSync, statSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { rootsStatus, type LibraryRootStatus } from './root-status.js';

/** File types whose change should trigger a rescan. Mirrors the scanner's sets. */
export const WATCHED_EXTENSIONS: ReadonlySet<string> = new Set([
  // audio
  '.flac',
  '.mp3',
  '.m4a',
  '.ogg',
  '.opus',
  '.wav',
  '.aiff',
  '.aif',
  // images (covers / artwork)
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  // cue sheets
  '.cue',
]);

export type WatchReason = 'events' | 'poll' | 'root-appeared';

export interface WatchBatch {
  /** What woke the scanner. */
  reason: WatchReason;
  /** Absolute paths involved (best effort; possibly empty for root-appeared). */
  files: string[];
  /** Roots that produced this batch. */
  roots: string[];
  /** Epoch ms the batch was emitted. */
  at: number;
}

export type LibraryChangeHandler = (batch: WatchBatch) => void | Promise<void>;

export interface Logger {
  warn: (obj: unknown, msg?: string) => void;
  info?: (obj: unknown, msg?: string) => void;
}

export interface LibraryWatcherOptions {
  /** cfg.libraryRoots. Stored as given; report/status uses these paths. */
  roots: readonly string[];
  /** Called once per debounced burst (and on root reappear / poll-detected change). */
  onChange: LibraryChangeHandler;
  /** Quiet period after the last event before onChange fires. Default 10 s. */
  debounceMs?: number;
  /** Upper bound on how long continuous events can postpone a scan. Default 5 min. */
  maxWaitMs?: number;
  /** Fallback poll interval (mount check + fingerprint). Default 10 min. */
  pollIntervalMs?: number;
  /**
   * How often to fingerprint a root whose fs.watch is healthy. inotify is the
   * source of truth there, so the full-tree walk only needs to catch whatever
   * it missed occasionally. Default 1 h; roots in poll-only mode use
   * `pollIntervalMs` instead.
   */
  healthyPollIntervalMs?: number;
  /** false = never use fs.watch (poll only). Useful on broken filesystems and in tests. */
  useFsWatch?: boolean;
  /** Override the watched extension set (tests). */
  extensions?: ReadonlySet<string>;
  logger?: Logger;
  now?: () => number;
}

export interface WatchPollResult {
  roots: LibraryRootStatus[];
  appeared: string[];
  vanished: string[];
  /** Files whose mtime/size changed since the previous poll (absolute paths). */
  changed: string[];
  /** True when onChange was called by this poll. */
  notified: boolean;
}

export interface LibraryWatcher {
  /** Attach watchers and start the fallback poll. Idempotent. */
  start(): Promise<void>;
  /** Detach everything and clear pending work. Idempotent; onChange may still be running. */
  stop(): void;
  /** Run the mount/fingerprint poll immediately (also used by tests). */
  pollNow(): Promise<WatchPollResult>;
  /** Current mount/read-only/free status for every configured root. */
  status(): LibraryRootStatus[];
  /** True when at least one root is mounted and watchable. */
  anyMounted(): boolean;
  /** Number of roots currently mounted. */
  mountedCount(): number;
  /** Roots that currently have a live fs.watch (empty in poll-only mode). */
  watchedRoots(): string[];
  /** Roots whose initial tree fingerprint has been captured. */
  seededRoots(): string[];
  /** Epoch ms of the last emitted batch, or null. */
  lastChangeAt(): number | null;
}

type Fingerprint = Map<string, string>;

interface RootState {
  /** Path as configured (used in reports/batches). */
  path: string;
  /** Resolved path used for joins/prefixing. */
  absolute: string;
  watcher?: FSWatcher;
  /** Whether the last check found a directory here. */
  mounted: boolean;
  pending: Set<string>;
  fingerprint: Fingerprint;
  /** False until the startup/reappear fingerprint walk has completed. */
  seeded: boolean;
  /** In-flight fingerprint walk (startup seeds in the background). */
  seeding: Promise<void> | null;
  /** Epoch ms of the last successful fingerprint walk. */
  lastFingerprintAt: number;
}

const DEFAULT_DEBOUNCE_MS = 10_000;
const DEFAULT_MAX_WAIT_MS = 5 * 60_000;
const DEFAULT_POLL_MS = 10 * 60_000;
const DEFAULT_HEALTHY_POLL_MS = 60 * 60_000;

export function createLibraryWatcher(opts: LibraryWatcherOptions): LibraryWatcher {
  return new LibraryWatcherImpl(opts);
}

class LibraryWatcherImpl implements LibraryWatcher {
  private readonly roots: RootState[];
  private readonly onChange: LibraryChangeHandler;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly pollIntervalMs: number;
  private readonly healthyPollIntervalMs: number;
  private readonly useFsWatch: boolean;
  private readonly extensions: ReadonlySet<string>;
  private readonly logger?: Logger;
  private readonly now: () => number;

  private started = false;
  private stopped = false;
  private debounceTimer: NodeJS.Timeout | null = null;
  private batchStartedAt = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;

  private lastChangeEpoch: number | null = null;

  constructor(opts: LibraryWatcherOptions) {
    this.roots = dedupeRoots(opts.roots).map((path) => ({
      path,
      absolute: resolve(path),
      mounted: false,
      pending: new Set<string>(),
      fingerprint: new Map<string, string>(),
      seeded: false,
      seeding: null,
      lastFingerprintAt: 0,
    }));
    this.onChange = opts.onChange;
    this.debounceMs = Math.max(0, opts.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.maxWaitMs = Math.max(this.debounceMs, opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
    this.pollIntervalMs = Math.max(1, opts.pollIntervalMs ?? DEFAULT_POLL_MS);
    this.healthyPollIntervalMs = Math.max(
      1,
      opts.healthyPollIntervalMs ?? DEFAULT_HEALTHY_POLL_MS,
    );
    this.useFsWatch = opts.useFsWatch !== false;
    this.extensions = opts.extensions ?? WATCHED_EXTENSIONS;
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    for (const root of this.roots) this.attach(root, true);
    // Seed fingerprints in the BACKGROUND so the HTTP port can open immediately:
    // walking the whole library tree is the slow part of startup. A root that is
    // not seeded yet never diffs against its empty map (see doPoll), so it cannot
    // report every file as new. Roots that are absent get none; when they appear
    // the transition itself notifies.
    for (const root of this.roots) {
      if (root.mounted) void this.seed(root);
    }
    this.pollTimer = setInterval(() => {
      void this.pollNow().catch((err) => this.warn({ err }, 'library watcher poll failed'));
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.started = false;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.debounceTimer = null;
    this.pollTimer = null;
    for (const root of this.roots) {
      this.detach(root);
      root.pending.clear();
    }
  }

  status(): LibraryRootStatus[] {
    return rootsStatus(this.roots.map((r) => r.path));
  }

  anyMounted(): boolean {
    return this.mountedCount() > 0;
  }

  mountedCount(): number {
    return this.roots.filter((r) => this.isMounted(r)).length;
  }

  watchedRoots(): string[] {
    return this.roots.filter((r) => r.watcher !== undefined).map((r) => r.path);
  }

  seededRoots(): string[] {
    return this.roots.filter((r) => r.seeded).map((r) => r.path);
  }

  lastChangeAt(): number | null {
    return this.lastChangeEpoch;
  }

  async pollNow(): Promise<WatchPollResult> {
    if (this.stopped || this.polling) {
      return { roots: this.status(), appeared: [], vanished: [], changed: [], notified: false };
    }
    this.polling = true;
    try {
      return await this.doPoll();
    } finally {
      this.polling = false;
    }
  }

  // ---------------------------------------------------------------- internals

  private async doPoll(): Promise<WatchPollResult> {
    const appeared: string[] = [];
    const vanished: string[] = [];
    const changed: string[] = [];
    let notified = false;

    for (const root of this.roots) {
      const mounted = this.isMounted(root);
      if (!mounted) {
        if (root.mounted) {
          this.markGone(root, 'root vanished');
          vanished.push(root.path);
        }
        continue;
      }

      const wasMissing = !root.mounted;
      if (wasMissing) {
        // Transition from gone (or never seen) to present. Anything might have
        // changed while it was away, so this always notifies. Do not report the
        // whole tree as "changed files" — just seed the new fingerprint.
        const attached = this.attach(root, true);
        appeared.push(root.path);
        if (!attached && this.useFsWatch) {
          this.warn({ root: root.path }, 'library root present but fs.watch failed; poll fallback active');
        }
      } else if (this.useFsWatch && root.watcher === undefined) {
        // Root stayed mounted but the watcher died/was never attached: retry here,
        // never in a tight loop.
        this.attach(root, false);
      }

      // Wait for the startup background seed before comparing anything. An empty
      // map would make every existing file look new (and trigger a full rescan).
      if (!root.seeded) {
        await this.seed(root);
        if (!root.seeded) continue; // still unreadable: never diff against nothing
      }

      if (wasMissing) {
        // seed() just captured the whole (new) tree; the appeared event is the
        // notification, and there is no useful diff to report.
        continue;
      }

      // While inotify is healthy it is the source of truth: skip the expensive
      // full-tree fingerprint walk until the hourly safety net is due.
      if (
        this.useFsWatch &&
        root.watcher !== undefined &&
        this.now() - root.lastFingerprintAt < this.healthyPollIntervalMs
      ) {
        continue;
      }

      const before = root.fingerprint;
      const after = await this.scanTree(root);
      root.fingerprint = after;
      root.lastFingerprintAt = this.now();
      const diff = diffFingerprints(root.absolute, before, after);
      if (diff.length > 0) changed.push(...diff);
    }

    if (appeared.length > 0 || changed.length > 0) {
      const files = [...new Set(changed)];
      const roots = new Set([...appeared, ...this.rootsContaining(files)]);
      this.emit({
        reason: appeared.length > 0 ? 'root-appeared' : 'poll',
        files,
        roots: roots.size > 0 ? [...roots] : this.roots.map((r) => r.path),
        at: this.now(),
      });
      notified = true;
    }

    return { roots: this.status(), appeared, vanished, changed, notified };
  }

  private attach(root: RootState, notifyOnFailure: boolean): boolean {
    if (this.stopped) return false;
    if (!this.isMounted(root)) {
      root.mounted = false;
      this.detach(root);
      return false;
    }
    root.mounted = true;
    if (!this.useFsWatch || root.watcher) return root.watcher !== undefined;

    try {
      const w = watch(root.absolute, { recursive: true }, (eventType, filename) =>
        this.onFsEvent(root, w, eventType, filename),
      );
      w.on('error', (err) => {
        // A late error from a watcher we already replaced must not detach the new one.
        if (root.watcher !== w) return;
        // ENOENT/ENOTDIR when the disk is yanked, EMFILE when inotify is full, ...
        if (!this.stopped) this.warn({ err, root: root.path }, 'library watcher error; waiting for poll');
        this.markGone(root, 'watch error', false);
      });
      w.on('close', () => {
        if (root.watcher === w) {
          root.watcher = undefined;
          if (!this.stopped) root.mounted = this.isMounted(root);
        }
      });
      root.watcher = w;
      return true;
    } catch (err) {
      // ERR_FEATURE_UNAVAILABLE_ON_PLATFORM (recursive unsupported), ENOENT, EACCES...
      if (notifyOnFailure) this.warn({ err, root: root.path }, 'library fs.watch unavailable; poll fallback active');
      root.watcher = undefined;
      return false;
    }
  }

  private detach(root: RootState): void {
    const w = root.watcher;
    root.watcher = undefined;
    if (!w) return;
    try {
      w.close();
    } catch {
      // already closed
    }
  }

  /** Root disappeared or its watcher failed: stop, drop pending events, do not notify. */
  private markGone(root: RootState, why: string, warn = true): void {
    if (warn && root.watcher !== undefined) this.warn({ root: root.path, why }, 'library root went away');
    this.detach(root);
    root.mounted = false;
    root.pending.clear();
    // A later reappearance must notify even if the content fingerprint happens
    // to match what we remembered: the scanner may have run in between.
    root.fingerprint = new Map();
    // Re-seed the tree before diffing again; an empty map would make every file
    // on the remounted drive look new (and trigger a full rescan).
    root.seeded = false;
  }

  private onFsEvent(
    root: RootState,
    source: FSWatcher,
    eventType: string,
    filename: string | null | undefined,
  ): void {
    if (this.stopped || root.watcher !== source) return; // stale callback from a replaced watcher
    if (!filename) {
      // Some kernels report a null filename for directory-level events.
      this.queue(root, root.absolute, 'rename');
      return;
    }
    const name = typeof filename === 'string' ? filename : String(filename);

    if (eventType === 'rename' && !existsSync(root.absolute)) {
      // The mount disappeared; deletion events for its subtree must not trigger
      // a scan that would purge the library.
      this.markGone(root, 'root vanished during event');
      return;
    }

    const absolute = isAbsolute(name) ? name : join(root.absolute, name);
    if (!this.isRelevant(absolute)) return;
    this.queue(root, absolute, eventType);
  }

  /**
   * Watched extension, or a directory (add/rename/remove of an album folder).
   * Deleted directories usually have no extension; deleted files are filtered.
   */
  private isRelevant(absolute: string): boolean {
    const ext = extname(absolute).toLowerCase();
    if (this.extensions.has(ext)) return true;
    try {
      return statSync(absolute).isDirectory();
    } catch {
      return ext === '';
    }
  }

  private queue(root: RootState, absolute: string, _eventType: string): void {
    root.pending.add(absolute);
    this.scheduleBatch();
  }

  private scheduleBatch(): void {
    const now = this.now();
    if (!this.debounceTimer) this.batchStartedAt = now;
    else clearTimeout(this.debounceTimer);

    const elapsed = now - this.batchStartedAt;
    const wait = Math.max(0, Math.min(this.debounceMs, this.maxWaitMs - elapsed));
    this.debounceTimer = setTimeout(() => this.flushBatch(), wait);
    this.debounceTimer.unref?.();
  }

  private flushBatch(): void {
    this.debounceTimer = null;
    if (this.stopped) return;
    const files: string[] = [];
    const roots: string[] = [];
    for (const root of this.roots) {
      if (!this.isMounted(root)) {
        // Went away mid-burst: discard rather than scan an empty mount.
        if (root.mounted) this.markGone(root, 'root vanished during debounce');
        root.pending.clear();
        continue;
      }
      if (root.pending.size === 0) continue;
      roots.push(root.path);
      files.push(...root.pending);
      root.pending.clear();
    }
    if (files.length === 0 && roots.length === 0) return;
    this.emit({ reason: 'events', files: [...new Set(files)], roots, at: this.now() });
  }

  private emit(batch: WatchBatch): void {
    if (this.stopped) return;
    this.lastChangeEpoch = batch.at;
    try {
      const result = this.onChange(batch);
      if (result && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).catch((err) => this.warn({ err }, 'library onChange handler failed'));
      }
    } catch (err) {
      this.warn({ err }, 'library onChange handler threw');
    }
  }

  private isMounted(root: RootState): boolean {
    try {
      return statSync(root.absolute).isDirectory();
    } catch {
      return false;
    }
  }

  private rootsContaining(files: readonly string[]): string[] {
    const roots: string[] = [];
    for (const root of this.roots) {
      const prefix = root.absolute.endsWith('/') ? root.absolute : root.absolute + '/';
      if (files.some((f) => f === root.absolute || f.startsWith(prefix))) roots.push(root.path);
    }
    return roots;
  }

  /**
   * Capture a root's baseline fingerprint. Never rejects (a failure is retried on
   * the next poll) and leaves `seeded` false when it could not read the tree, so
   * callers never diff against an empty map.
   */
  private seed(root: RootState): Promise<void> {
    if (root.seeding) return root.seeding;
    const job = this.scanTree(root)
      .then((fingerprint) => {
        // A seed that finished after the root vanished must not mark the (now
        // stale) tree as the baseline; the next poll re-seeds after reappearing.
        if (this.stopped || !root.mounted) return;
        root.fingerprint = fingerprint;
        root.seeded = true;
        root.lastFingerprintAt = this.now();
      })
      .catch((err) => {
        if (!this.stopped) {
          this.warn({ err, root: root.path }, 'library fingerprint failed; retrying on the next poll');
        }
      })
      .finally(() => {
        root.seeding = null;
      });
    root.seeding = job;
    return job;
  }

  /** Recursively collect relpath -> "mtimeMs:size" for watched files. */
  private async scanTree(root: RootState): Promise<Fingerprint> {
    const out: Fingerprint = new Map();
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return; // vanished permissions / unmounted: treat what we have as the truth
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!this.extensions.has(extname(entry.name).toLowerCase())) continue;
        try {
          const st = await fsp.stat(full);
          out.set(full.slice(root.absolute.length + 1), `${st.mtimeMs}:${st.size}`);
        } catch {
          // deleted between readdir and stat
        }
      }
    };
    await walk(root.absolute);
    return out;
  }

  private warn(obj: unknown, msg: string): void {
    try {
      this.logger?.warn(obj, msg);
    } catch {
      // logging must never take the watcher down
    }
  }
}

function dedupeRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of roots) {
    const key = resolve(root);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(root);
  }
  return out;
}

/** Absolute paths whose fingerprint changed (added, removed or modified). */
function diffFingerprints(rootAbs: string, before: Fingerprint, after: Fingerprint): string[] {
  const changed: string[] = [];
  for (const [rel, sig] of after) if (before.get(rel) !== sig) changed.push(join(rootAbs, rel));
  for (const rel of before.keys()) if (!after.has(rel)) changed.push(join(rootAbs, rel));
  return changed;
}

/** Small stable digest helper exported for callers that want one batch id. */
export function batchDigest(batch: WatchBatch): string {
  const h = createHash('sha1');
  h.update(batch.reason);
  for (const f of [...batch.files].sort()) h.update(`\0${f}`);
  return h.digest('hex').slice(0, 16);
}
