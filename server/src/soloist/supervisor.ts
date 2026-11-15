// Runs the soloist binary as a child of the rune server and keeps it running.
//
// A child process, not a systemd unit: rune already owns mpv the same way, the key file and the output sink are rune's
// to choose, and a child stops with rune (nothing keeps playing with no server to control it). Restarts back off from
// 2 s to 60 s. Exit code 10 means the build expired (Spotify's builds live 90 days): no restart, and the zone says so.
//
// Sign-in: Soloist keeps its Spotify session in its own data directory (plain files, no desktop keyring), restores it
// when it starts, and tries the sign-in exactly ONCE. If the network or DNS is not ready at that moment (right after
// boot) it stays signed out for good. So the first start waits for the network (`online`, capped), and `restart()`
// lets the sign-in watchdog (signin.ts) start it again when it still came up signed out.
//
// The API key is read from a file (default ~/.config/rune/soloist-key, mode 600) and passed with -k. It is never logged:
// log lines carry the argument list with the key replaced.
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

export type SoloistRun = 'off' | 'starting' | 'running' | 'crashed' | 'expired' | 'no-binary' | 'no-key';

export interface ChildLike {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
}

export interface SupervisorOptions {
  binary: string;
  keyFile: string;
  deviceName: string;
  /** 127.0.0.1:PORT for the WebSocket API. Never anything but loopback: the API has no authentication. */
  ws: string;
  /** PipeWire node Soloist plays into (the silent phone sink): nothing is audible until rune moves the stream. */
  pipewireDevice?: string;
  dataDir?: string;
  cacheDir?: string;
  spawn?: (binary: string, args: string[]) => ChildLike;
  exists?: (path: string) => boolean;
  readKey?: (path: string) => string;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  /** Can Spotify be reached (a DNS lookup)? Given: the first start waits for it, at most `startWaitMs`. */
  online?: () => Promise<boolean>;
  /** How long the first start waits for the network before starting anyway (default 60 s). */
  startWaitMs?: number;
  now?: () => number;
  log?: (obj: Record<string, unknown>, msg: string) => void;
  onChange?: (run: SoloistRun) => void;
}

export const EXPIRED_EXIT = 10;
const BACKOFF_MS = [2000, 5000, 15_000, 30_000, 60_000];
const START_POLL_MS = 2000;
/** A Soloist that ignores SIGTERM on a restart is killed after this long. */
const KILL_AFTER_MS = 5000;

/** Read the key; warns (never fails) when others can read the file. */
export function readSoloistKey(path: string, log?: SupervisorOptions['log']): string {
  const key = readFileSync(path, 'utf8').trim();
  try {
    if (statSync(path).mode & 0o077) log?.({ path }, 'soloist key file is readable by others: chmod 600 it');
  } catch { /* stat failed: the read above already worked */ }
  return key;
}

export class SoloistSupervisor {
  run: SoloistRun = 'off';
  private child: ChildLike | null = null;
  private stopped = true;
  private crashes = 0;
  private timer: unknown = null;
  /** Set while restart() waits for the child to exit: the delay before the next start. */
  private restarting: { delayMs: number } | null = null;

  constructor(private readonly opts: SupervisorOptions) {
    if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(opts.ws)) throw new Error('the Soloist WebSocket must bind the loopback interface');
  }

  /** The running child's process id (its PipeWire streams carry it), or null. */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** The one line for the page when Soloist cannot play, or null. */
  problem(): string | null {
    switch (this.run) {
      case 'expired':
        return 'Soloist build expired: update it (download the current build from Spotify, replace the binary, restart rune)';
      case 'no-binary':
        return `Soloist is not installed (${this.opts.binary})`;
      case 'no-key':
        return `Soloist has no API key (${this.opts.keyFile})`;
      case 'crashed':
        return 'Soloist stopped and is being restarted — try again in a moment';
      default:
        return null;
    }
  }

  start(): void {
    this.stopped = false;
    const exists = this.opts.exists ?? existsSync;
    // Nothing to wait for when it cannot start anyway: launch() says what is missing.
    if (!this.opts.online || !exists(this.opts.binary) || !exists(this.opts.keyFile)) return this.launch();
    this.set('starting');
    void this.waitOnline().then(() => this.launch());
  }

  /**
   * Stop the running Soloist and start it again after `delayMs` (the sign-in watchdog: a start that came up signed
   * out). Not a crash: the crash backoff is untouched. False when there is no running process to restart.
   */
  restart(reason: string, delayMs = 1000): boolean {
    const child = this.child;
    if (this.stopped || !child || this.restarting) return false;
    this.restarting = { delayMs };
    this.opts.log?.({ reason }, 'restarting soloist');
    this.set('starting');
    try { child.kill('SIGTERM'); } catch { /* already gone: its exit event follows */ }
    this.later(() => {
      if (this.child === child) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }, KILL_AFTER_MS);
    return true;
  }

  private later(fn: () => void, ms: number): unknown {
    return (this.opts.setTimeout ?? ((f, m) => { const t = setTimeout(f, m); t.unref?.(); return t; }))(fn, ms);
  }

  /** Resolves when the network answers, or after startWaitMs (Soloist is started anyway; the watchdog takes over). */
  private async waitOnline(): Promise<void> {
    const now = this.opts.now ?? Date.now;
    const until = now() + (this.opts.startWaitMs ?? 60_000);
    let said = false;
    for (;;) {
      if (this.stopped) return;
      let ok = false;
      try { ok = await this.opts.online!(); } catch { /* not reachable */ }
      if (ok || this.stopped) return;
      if (now() >= until) {
        this.opts.log?.({}, 'soloist: still no network; starting it anyway');
        return;
      }
      if (!said) this.opts.log?.({}, 'soloist: waiting for the network before starting (it signs in only once, at its start)');
      said = true;
      await new Promise<void>((r) => this.later(r, START_POLL_MS));
    }
  }

  stop(): void {
    this.stopped = true;
    this.restarting = null;
    const child = this.child;
    this.child = null;
    try { child?.kill('SIGTERM'); } catch { /* already gone */ }
    this.set('off');
  }

  private set(run: SoloistRun): void {
    if (this.run === run) return;
    this.run = run;
    this.opts.onChange?.(run);
  }

  private launch(): void {
    if (this.stopped || this.child) return;
    const exists = this.opts.exists ?? existsSync;
    if (!exists(this.opts.binary)) return this.set('no-binary');
    if (!exists(this.opts.keyFile)) return this.set('no-key');
    let key: string;
    try {
      key = (this.opts.readKey ?? ((p) => readSoloistKey(p, this.opts.log)))(this.opts.keyFile);
    } catch {
      return this.set('no-key');
    }
    if (!key) return this.set('no-key');
    const args = ['-n', this.opts.deviceName, '-k', key, '-w', this.opts.ws];
    if (this.opts.pipewireDevice) args.push('-d', this.opts.pipewireDevice);
    if (this.opts.dataDir) args.push('-D', this.opts.dataDir);
    if (this.opts.cacheDir) args.push('-C', this.opts.cacheDir);
    this.opts.log?.({ args: args.map((a, i) => (args[i - 1] === '-k' ? '<key>' : a)) }, 'starting soloist');
    this.set('starting');
    const startedAt = Date.now();
    let child: ChildLike;
    try {
      child = (this.opts.spawn ?? ((b, a) => nodeSpawn(b, a, { stdio: 'ignore' })))(this.opts.binary, args);
    } catch (err) {
      this.opts.log?.({ err: String(err) }, 'soloist failed to start');
      return this.retry();
    }
    this.child = child;
    this.set('running');
    child.on('error', (err) => this.opts.log?.({ err: String(err) }, 'soloist process error'));
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopped) return;
      const restarting = this.restarting;
      this.restarting = null;
      if (restarting && code !== EXPIRED_EXIT) {
        this.timer = this.later(() => { this.timer = null; this.launch(); }, restarting.delayMs);
        return;
      }
      if (code === EXPIRED_EXIT) {
        this.opts.log?.({ code }, 'Soloist build expired: update it');
        return this.set('expired');
      }
      this.opts.log?.({ code, signal }, 'soloist exited; restarting');
      // A run that lasted a while was healthy: start the backoff over.
      if (Date.now() - startedAt > 120_000) this.crashes = 0;
      this.retry();
    });
  }

  private retry(): void {
    this.set('crashed');
    const delay = BACKOFF_MS[Math.min(this.crashes++, BACKOFF_MS.length - 1)]!;
    this.timer = this.later(() => {
      this.timer = null;
      this.launch();
    }, delay);
  }
}
