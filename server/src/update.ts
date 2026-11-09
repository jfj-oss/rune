// Self-update: `GET /api/update/status` and `POST /api/update/install`.
//
// rune runs from a git checkout under systemd (Restart=on-failure). This module
// fetches the current branch, fast-forwards it, installs when the lockfile
// changed, builds the web UI into a temporary folder and only swaps it in when
// the build succeeds. Any failure after the merge resets to the previous commit
// and restores dependencies, so the running copy keeps serving.
//
// The install route takes no request body, so it has no JSON content-type to
// force a CORS preflight; it therefore checks the Origin against the Host
// itself (same-origin only). See registerUpdateRoutes.
import { execFile } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export type UpdateStage = 'downloading' | 'installing' | 'building' | 'waiting-for-music' | 'restarting' | 'restart-needed' | null;

export interface UpdateStatus {
  /** True when this copy can self-update: a git checkout, on a branch, with an origin remote. */
  supported: boolean;
  /** Short (7 hex) commit rune is on now. */
  current: string | null;
  /** Short (7 hex) commit of origin/<branch>, after the (rate-limited) fetch. */
  latest: string | null;
  /** Commits behind origin/<branch>. */
  behind: number;
  /** Commits ahead of origin/<branch> (not published). */
  ahead: number;
  /** Tracked files changed in the working tree. */
  dirty: boolean;
  /** Music is playing or paused mid-song on the PC. */
  playing: boolean;
  /** The update step currently running, or null when idle. */
  stage: UpdateStage;
  /** Last failure as `<step>: <reason>`, or null. */
  error: string | null;
}

export type UpdateInstallResult =
  | { ok: true; stage: 'restarting' | 'restart-needed' }
  | { ok: false; status: number; error: string };

export interface UpdateService {
  status(): Promise<UpdateStatus>;
  install(): Promise<UpdateInstallResult>;
}

export interface UpdateOptions {
  /** The git repository root every command runs in, or a lazy resolver for it.
   *  The resolver keeps the (possibly mocked) git call out of server startup and
   *  only runs it when an update route is first used. */
  repoRoot: string | (() => Promise<string>);
  /** The served web build directory to swap (normally <repoRoot>/web/dist). */
  webDist: string;
  /** The web package directory (normally the parent of webDist). */
  webDir?: string;
  /** Build the web UI into `toDir` (typecheck + vite build + compress). Injected by tests. */
  build?: (toDir: string) => Promise<void>;
  /** Install dependencies after the lockfile changed. Injected by tests. */
  install?: () => Promise<void>;
  /** Restart the process after a successful update. Injected by tests. */
  restart?: () => void | Promise<void>;
  /** Whether music is playing or paused mid-song on the PC. Injected by tests. */
  isPlayingOnPc?: () => boolean;
  /** Whether rune runs under systemd (INVOCATION_ID set). Injected by tests. */
  underSystemd?: () => boolean;
  now?: () => number;
  /** How often to look again while a song started during the build is still going. */
  musicPollMs?: number;
  /** Minimum gap between background fetches triggered by GET status. */
  fetchMinGapMs?: number;
  logger?: {
    info?: (obj: unknown, msg?: string) => void;
    warn?: (obj: unknown, msg?: string) => void;
  };
}

const SHORT_LEN = 7;
const FETCH_TIMEOUT_MS = 20_000;
const MERGE_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 300_000;
const TYPECHECK_TIMEOUT_MS = 300_000;
const BUILD_TIMEOUT_MS = 600_000;
const COMPRESS_TIMEOUT_MS = 120_000;

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** execFile with no shell, fixed arguments and a timeout. */
function runFile(file: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr ?? '').trim();
        const code = (err as NodeJS.ErrnoException & { code?: string | number }).code;
        reject(new Error(detail ? `${code ?? 'error'}: ${detail}` : String(err.message ?? err)));
      } else {
        resolve(String(stdout ?? ''));
      }
    });
  });
}

/** The connection comes from this machine (Tailscale serve proxies from 127.0.0.1; a LAN peer never does). */
function fromLoopback(req: FastifyRequest): boolean {
  const addr = req.socket?.remoteAddress ?? '';
  return addr === '::1' || addr === '127.0.0.1' || /^::ffff:127\./i.test(addr) || /^127\./.test(addr);
}

/**
 * The request came from the same origin that serves the page (or has no Origin header, e.g. curl: a browser
 * always sends one on a POST, so this check is about cross-site pages, not about who may use the API).
 *
 * The page's host is the Host header, except behind the local reverse proxy (Tailscale serve): there the proxy
 * connects from loopback and its X-Forwarded-Host names the host the browser used. A forwarded host sent by any
 * other peer is attacker-controlled and ignored.
 */
export function isSameOriginRequest(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const forwarded = req.headers['x-forwarded-host'];
  const trusted = fromLoopback(req) ? (Array.isArray(forwarded) ? forwarded[0] : forwarded) : undefined;
  const host = String(trusted ?? req.headers.host ?? '').split(',')[0]?.trim() ?? '';
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

class UpdateServiceImpl implements UpdateService {
  private readonly repoRootInput: string | (() => Promise<string>);
  private repoRootResolved: string | null = null;
  private readonly webDist: string;
  private readonly webDir: string;
  private readonly buildFn: (toDir: string) => Promise<void>;
  private readonly installFn: () => Promise<void>;
  private readonly restartFn: () => void | Promise<void>;
  private readonly isPlayingOnPc: () => boolean;
  private readonly underSystemd: () => boolean;
  private readonly now: () => number;
  private readonly fetchMinGapMs: number;
  private readonly musicPollMs: number;
  private readonly logger: UpdateOptions['logger'];

  private stage: UpdateStage = null;
  private error: string | null = null;
  private installRunning = false;
  private lastFetchAt = 0;
  private fetchPromise: Promise<void> | null = null;

  constructor(opts: UpdateOptions) {
    this.repoRootInput = opts.repoRoot;
    this.webDist = opts.webDist;
    this.webDir = opts.webDir ?? dirname(opts.webDist);
    this.buildFn = opts.build ?? ((toDir) => this.defaultBuild(toDir));
    this.installFn = opts.install ?? (() => this.defaultInstall());
    this.restartFn = opts.restart ?? (() => this.defaultRestart());
    this.isPlayingOnPc = opts.isPlayingOnPc ?? (() => false);
    this.underSystemd = opts.underSystemd ?? (() => process.env.INVOCATION_ID !== undefined && process.env.INVOCATION_ID !== '');
    this.now = opts.now ?? Date.now;
    this.fetchMinGapMs = opts.fetchMinGapMs ?? 60_000;
    this.musicPollMs = opts.musicPollMs ?? 5_000;
    this.logger = opts.logger;
  }

  // ------------------------------------------------------------- git helpers

  private async repo(): Promise<string> {
    if (this.repoRootResolved) return this.repoRootResolved;
    const resolved = typeof this.repoRootInput === 'function' ? await this.repoRootInput() : this.repoRootInput;
    this.repoRootResolved = resolved;
    return resolved;
  }

  private async git(args: string[], timeoutMs: number): Promise<string> {
    return runFile('git', args, { cwd: await this.repo(), timeoutMs });
  }

  private async insideWorkTree(): Promise<boolean> {
    try {
      return (await this.git(['rev-parse', '--is-inside-work-tree'], 10_000)).trim() === 'true';
    } catch {
      return false;
    }
  }

  private async currentBranch(): Promise<string | null> {
    try {
      return (await this.git(['symbolic-ref', '--short', 'HEAD'], 10_000)).trim() || null;
    } catch {
      return null;
    }
  }

  private async headSha(): Promise<string | null> {
    try {
      return (await this.git(['rev-parse', 'HEAD'], 10_000)).trim() || null;
    } catch {
      return null;
    }
  }

  private async remoteRef(branch: string): Promise<string | null> {
    try {
      return (await this.git(['rev-parse', '--verify', `origin/${branch}`], 10_000)).trim() || null;
    } catch {
      return null;
    }
  }

  private async hasOrigin(): Promise<boolean> {
    try {
      return (await this.git(['config', '--get', 'remote.origin.url'], 10_000)).trim() !== '';
    } catch {
      return false;
    }
  }

  private async aheadBehind(branch: string): Promise<{ ahead: number; behind: number }> {
    try {
      const out = (await this.git(['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`], 10_000)).trim();
      const parts = out.split(/\s+/);
      const ahead = Number(parts[0]);
      const behind = Number(parts[1]);
      return {
        ahead: Number.isFinite(ahead) ? ahead : 0,
        behind: Number.isFinite(behind) ? behind : 0,
      };
    } catch {
      return { ahead: 0, behind: 0 };
    }
  }

  private async trackedDirty(): Promise<boolean> {
    try {
      return (await this.git(['status', '--porcelain', '--untracked-files=no'], 10_000)).trim() !== '';
    } catch {
      return false;
    }
  }

  /** Background fetch for GET status: at most once per fetchMinGapMs. */
  private maybeFetch(branch: string): Promise<void> {
    const now = this.now();
    if (now - this.lastFetchAt < this.fetchMinGapMs) return Promise.resolve();
    if (this.fetchPromise) return this.fetchPromise;
    this.lastFetchAt = now;
    const run = this.git(['fetch', 'origin', branch], FETCH_TIMEOUT_MS)
      .then(() => undefined)
      .catch((err) => {
        this.logger?.warn?.({ err }, 'update fetch failed');
      })
      .finally(() => {
        this.fetchPromise = null;
      });
    this.fetchPromise = run;
    return run;
  }

  // ------------------------------------------------------------- status

  async status(): Promise<UpdateStatus> {
    const playing = this.isPlayingOnPc();
    const current = await this.headSha();
    const inside = await this.insideWorkTree();
    const branch = await this.currentBranch();
    const supported = inside && current !== null && branch !== null && (await this.hasOrigin());

    if (!supported) {
      return {
        supported,
        current: current ? current.slice(0, SHORT_LEN) : null,
        latest: null,
        behind: 0,
        ahead: 0,
        dirty: false,
        playing,
        stage: this.stage,
        error: this.error,
      };
    }

    await this.maybeFetch(branch!);
    const latest = await this.remoteRef(branch!);
    let ahead = 0;
    let behind = 0;
    if (latest) {
      const ab = await this.aheadBehind(branch!);
      ahead = ab.ahead;
      behind = ab.behind;
    }
    const dirty = await this.trackedDirty();
    return {
      supported,
      current: current ? current.slice(0, SHORT_LEN) : null,
      latest: latest ? latest.slice(0, SHORT_LEN) : null,
      behind,
      ahead,
      dirty,
      playing,
      stage: this.stage,
      error: this.error,
    };
  }

  // ------------------------------------------------------------- install

  async install(): Promise<UpdateInstallResult> {
    if (this.installRunning) return { ok: false, status: 409, error: 'update already running' };
    this.installRunning = true;
    this.error = null;
    try {
      if (!(await this.insideWorkTree())) {
        this.stage = null;
        return { ok: false, status: 400, error: 'not a git checkout' };
      }
      const branch = await this.currentBranch();
      if (!branch) {
        this.stage = null;
        return { ok: false, status: 400, error: 'HEAD is detached' };
      }
      if (this.isPlayingOnPc()) {
        this.stage = null;
        return { ok: false, status: 400, error: 'music is playing' };
      }
      if (await this.trackedDirty()) {
        this.stage = null;
        return { ok: false, status: 400, error: 'tracked files changed' };
      }
      const previous = await this.headSha();
      if (!previous) {
        this.stage = null;
        return { ok: false, status: 400, error: 'no HEAD commit' };
      }

      // Downloading: fetch the branch so origin/<branch> is current.
      this.stage = 'downloading';
      try {
        await this.git(['fetch', 'origin', branch], FETCH_TIMEOUT_MS);
        this.lastFetchAt = this.now();
      } catch (err) {
        this.stage = null;
        this.error = `downloading: ${messageOf(err)}`;
        return { ok: false, status: 500, error: this.error };
      }

      const latest = await this.remoteRef(branch);
      if (!latest) {
        this.stage = null;
        this.error = 'downloading: no upstream branch to update from';
        return { ok: false, status: 400, error: this.error };
      }

      const ab = await this.aheadBehind(branch);
      if (ab.ahead > 0 && ab.behind > 0) {
        this.stage = null;
        return { ok: false, status: 400, error: 'history has diverged' };
      }
      if (ab.ahead > 0 && ab.behind === 0) {
        this.stage = null;
        const noun = ab.ahead === 1 ? 'change' : 'changes';
        return { ok: false, status: 400, error: `This copy has ${ab.ahead} ${noun} that are not published` };
      }
      if (ab.behind === 0) {
        this.stage = null;
        return { ok: false, status: 400, error: 'already up to date' };
      }

      let lockfileChanged = false;
      try {
        const names = await this.git(['diff', '--name-only', previous, latest, '--', 'pnpm-lock.yaml'], 10_000);
        lockfileChanged = names
          .split('\n')
          .map((line) => line.trim())
          .some((line) => line !== '');
      } catch {
        lockfileChanged = false;
      }

      // Merge (still "downloading": the new code is fetched and applied).
      try {
        await this.git(['merge', '--ff-only', `origin/${branch}`], MERGE_TIMEOUT_MS);
      } catch (err) {
        await this.rollback(previous, false, 'downloading', messageOf(err));
        return { ok: false, status: 500, error: this.error! };
      }

      if (lockfileChanged) {
        this.stage = 'installing';
        try {
          await this.installFn();
        } catch (err) {
          await this.rollback(previous, true, 'installing', messageOf(err));
          return { ok: false, status: 500, error: this.error! };
        }
      }

      this.stage = 'building';
      const tempDir = join(this.webDir, '.dist-update');
      rmSync(tempDir, { recursive: true, force: true });
      try {
        await this.buildFn(tempDir);
      } catch (err) {
        await this.rollback(previous, lockfileChanged, 'building', messageOf(err));
        return { ok: false, status: 500, error: this.error! };
      }

      // Build succeeded: swap it in. The old dist is kept until this point.
      try {
        this.swapDist(tempDir);
      } catch (err) {
        await this.rollback(previous, lockfileChanged, 'restarting', messageOf(err));
        return { ok: false, status: 500, error: this.error! };
      }

      if (this.underSystemd()) {
        // The build takes minutes, so a song may have started since the check above. Never restart under it.
        if (this.isPlayingOnPc()) this.stage = 'waiting-for-music';
        while (this.isPlayingOnPc()) await new Promise((done) => setTimeout(done, this.musicPollMs));
        this.stage = 'restarting';
        try {
          await this.restartFn();
        } catch (err) {
          this.logger?.warn?.({ err }, 'update restart failed');
        }
        return { ok: true, stage: 'restarting' };
      }
      this.stage = 'restart-needed';
      return { ok: true, stage: 'restart-needed' };
    } finally {
      this.installRunning = false;
    }
  }

  private async rollback(previous: string, lockfileChanged: boolean, step: string, reason: string): Promise<void> {
    try {
      await this.git(['reset', '--hard', previous], MERGE_TIMEOUT_MS);
    } catch (err) {
      this.logger?.warn?.({ err }, 'update rollback reset failed');
    }
    if (lockfileChanged) {
      try {
        await this.installFn();
      } catch (err) {
        this.logger?.warn?.({ err }, 'update rollback dependency restore failed');
      }
    }
    this.stage = null;
    this.error = `${step}: ${reason}`;
  }

  private swapDist(tempDir: string): void {
    const backup = `${this.webDist}.old-${this.now()}`;
    if (existsSync(this.webDist)) renameSync(this.webDist, backup);
    try {
      renameSync(tempDir, this.webDist);
    } catch (err) {
      if (existsSync(backup) && !existsSync(this.webDist)) renameSync(backup, this.webDist);
      throw err;
    }
    if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
  }

  // ------------------------------------------------------------- defaults

  private async runInSystemd(file: string, args: string[], timeoutMs: number): Promise<string> {
    if (this.underSystemd()) {
      return runFile('systemd-run', ['--user', '--scope', '-q', '-p', 'MemoryMax=4G', '--', file, ...args], {
        cwd: await this.repo(),
        timeoutMs,
      });
    }
    return runFile(file, args, { cwd: await this.repo(), timeoutMs });
  }

  private async defaultInstall(): Promise<void> {
    await this.runInSystemd('pnpm', ['install', '--frozen-lockfile'], INSTALL_TIMEOUT_MS);
  }

  private async defaultBuild(toDir: string): Promise<void> {
    await this.runInSystemd('pnpm', ['-r', 'typecheck'], TYPECHECK_TIMEOUT_MS);
    await this.runInSystemd('pnpm', ['--filter', '@liner/web', 'exec', 'vite', 'build', '--outDir', toDir, '--emptyOutDir'], BUILD_TIMEOUT_MS);
    await this.runInSystemd('node', [join(this.webDir, 'scripts', 'compress.mjs'), toDir], COMPRESS_TIMEOUT_MS);
  }

  private defaultRestart(): void {
    // Restart=on-failure brings rune back. The delay lets the response flush first.
    setTimeout(() => process.exit(1), 500);
  }
}

export function createUpdateService(opts: UpdateOptions): UpdateService {
  return new UpdateServiceImpl(opts);
}

/** Register the update routes (on the /api-scoped instance). */
export function registerUpdateRoutes(r: FastifyInstance, service: UpdateService): void {
  r.get('/update/status', async (req, reply) => {
    if (!isSameOriginRequest(req)) return reply.code(403).send({ error: 'cross-origin request blocked' });
    return service.status();
  });

  r.post('/update/install', async (req, reply) => {
    if (!isSameOriginRequest(req)) return reply.code(403).send({ error: 'cross-origin request blocked' });
    const result = await service.install();
    if (result.ok) return result;
    return reply.code(result.status).send({ error: result.error });
  });
}
