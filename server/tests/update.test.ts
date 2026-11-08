import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createUpdateService, isSameOriginRequest } from '../src/update.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'liner-update-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Run git in `cwd` with fixed args (no shell) and return trimmed stdout. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Commit without touching any git config file. */
function commit(cwd: string, message: string): string {
  git(cwd, '-c', 'user.name=Update Test', '-c', 'user.email=test@liner.local', 'commit', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

/** A real work repo with a local bare origin on `master`, plus an untracked web/dist. */
function initRepos(): { repoRoot: string; webDist: string; webDir: string; commitA: string } {
  const base = tempDir();
  const originDir = join(base, 'origin.git');
  const repoRoot = join(base, 'work');
  mkdirSync(originDir);
  git(base, 'init', '--bare', originDir);
  git(base, 'init', '-b', 'master', repoRoot);
  git(repoRoot, 'remote', 'add', 'origin', originDir);
  writeFileSync(join(repoRoot, 'file.txt'), 'A');
  git(repoRoot, 'add', 'file.txt');
  const commitA = commit(repoRoot, 'A');
  git(repoRoot, 'push', '-u', 'origin', 'master');

  const webDir = join(repoRoot, 'web');
  const webDist = join(webDir, 'dist');
  mkdirSync(webDist, { recursive: true });
  writeFileSync(join(webDist, 'index.html'), 'old-dist');
  return { repoRoot, webDist, webDir, commitA };
}

/** Put a new commit on origin/master and move the work HEAD back, so it is 1 behind. */
function addRemoteCommit(repoRoot: string, message: string): string {
  writeFileSync(join(repoRoot, 'file.txt'), message);
  git(repoRoot, 'add', 'file.txt');
  const sha = commit(repoRoot, message);
  git(repoRoot, 'push', 'origin', 'master');
  git(repoRoot, 'reset', '--hard', 'HEAD~1');
  return sha;
}

function svc(
  opts: {
    repoRoot: string;
    webDist: string;
    underSystemd?: () => boolean;
    isPlayingOnPc?: () => boolean;
    build?: (toDir: string) => Promise<void>;
    install?: () => Promise<void>;
    restart?: () => void | Promise<void>;
    musicPollMs?: number;
  },
) {
  return createUpdateService({
    repoRoot: opts.repoRoot,
    webDist: opts.webDist,
    underSystemd: opts.underSystemd ?? (() => false),
    isPlayingOnPc: opts.isPlayingOnPc ?? (() => false),
    build: opts.build,
    install: opts.install,
    restart: opts.restart,
    musicPollMs: opts.musicPollMs,
  });
}

describe('update status', () => {
  it('reports up to date when work and origin are on the same commit', async () => {
    const { repoRoot, webDist, commitA } = initRepos();
    const s = await svc({ repoRoot, webDist }).status();
    expect(s.supported).toBe(true);
    expect(s.current).toBe(commitA.slice(0, 7));
    expect(s.latest).toBe(commitA.slice(0, 7));
    expect(s.behind).toBe(0);
    expect(s.ahead).toBe(0);
    expect(s.dirty).toBe(false);
    expect(s.playing).toBe(false);
    expect(s.stage).toBeNull();
  });

  it('reports behind when origin has a newer commit', async () => {
    const { repoRoot, webDist, commitA } = initRepos();
    addRemoteCommit(repoRoot, 'B');
    const s = await svc({ repoRoot, webDist }).status();
    expect(s.current).toBe(commitA.slice(0, 7));
    expect(s.behind).toBe(1);
    expect(s.ahead).toBe(0);
  });

  it('reports not supported outside a git checkout', async () => {
    const dir = tempDir();
    const s = await svc({ repoRoot: dir, webDist: join(dir, 'dist') }).status();
    expect(s.supported).toBe(false);
    expect(s.current).toBeNull();
  });
});

describe('update install', () => {
  it('refuses when already up to date', async () => {
    const { repoRoot, webDist } = initRepos();
    expect(await svc({ repoRoot, webDist }).install()).toEqual({ ok: false, status: 400, error: 'already up to date' });
  });

  it('updates a behind copy: merge, build, swap, and ask for a manual restart', async () => {
    const { repoRoot, webDist, commitA } = initRepos();
    const commitB = addRemoteCommit(repoRoot, 'B');
    let buildDir = '';
    const s = svc({
      repoRoot,
      webDist,
      build: async (toDir) => {
        buildDir = toDir;
        mkdirSync(toDir, { recursive: true });
        writeFileSync(join(toDir, 'index.html'), 'built');
      },
    });

    const res = await s.install();
    expect(res).toEqual({ ok: true, stage: 'restart-needed' });
    expect(buildDir).toBe(join(repoRoot, 'web', '.dist-update'));
    expect(git(repoRoot, 'rev-parse', 'HEAD')).toBe(commitB);
    expect(readFileSync(join(webDist, 'index.html'), 'utf8')).toBe('built');
    expect(existsSync(buildDir)).toBe(false); // temp dir consumed by the swap
    expect(git(repoRoot, 'rev-parse', 'HEAD')).not.toBe(commitA);
  });

  it('exits under systemd and lets Restart=on-failure bring it back', async () => {
    const { repoRoot, webDist } = initRepos();
    addRemoteCommit(repoRoot, 'B');
    let restarted = false;
    const s = svc({
      repoRoot,
      webDist,
      underSystemd: () => true,
      build: async (toDir) => {
        mkdirSync(toDir, { recursive: true });
        writeFileSync(join(toDir, 'index.html'), 'built');
      },
      restart: () => {
        restarted = true;
      },
    });
    const res = await s.install();
    expect(res).toEqual({ ok: true, stage: 'restarting' });
    expect(restarted).toBe(true);
  });

  it('waits for a song that started during the build before restarting', async () => {
    const { repoRoot, webDist } = initRepos();
    addRemoteCommit(repoRoot, 'B');
    let playing = false;
    let polls = 0;
    let restartedWhilePlaying: boolean | null = null;
    const s = svc({
      repoRoot,
      webDist,
      underSystemd: () => true,
      musicPollMs: 1,
      isPlayingOnPc: () => {
        if (playing && ++polls >= 3) playing = false;
        return playing;
      },
      build: async (toDir) => {
        mkdirSync(toDir, { recursive: true });
        writeFileSync(join(toDir, 'index.html'), 'built');
        playing = true;
      },
      restart: () => {
        restartedWhilePlaying = playing;
      },
    });
    expect(await s.install()).toEqual({ ok: true, stage: 'restarting' });
    expect(restartedWhilePlaying).toBe(false);
  });

  it('refuses when tracked files are dirty', async () => {
    const { repoRoot, webDist } = initRepos();
    writeFileSync(join(repoRoot, 'file.txt'), 'local edit');
    const res = await svc({ repoRoot, webDist }).install();
    expect(res).toEqual({ ok: false, status: 400, error: 'tracked files changed' });
  });

  it('refuses when the histories have diverged', async () => {
    const { repoRoot, webDist } = initRepos();
    // Fork: put B on origin/master from a side branch, then commit C locally.
    git(repoRoot, 'checkout', '-b', 'side');
    writeFileSync(join(repoRoot, 'side.txt'), 'B');
    git(repoRoot, 'add', 'side.txt');
    commit(repoRoot, 'B');
    git(repoRoot, 'push', 'origin', 'side:master');
    git(repoRoot, 'checkout', 'master');
    writeFileSync(join(repoRoot, 'c.txt'), 'C');
    git(repoRoot, 'add', 'c.txt');
    commit(repoRoot, 'C');

    const res = await svc({ repoRoot, webDist }).install();
    expect(res).toEqual({ ok: false, status: 400, error: 'history has diverged' });
  });

  it('refuses while music is playing', async () => {
    const { repoRoot, webDist } = initRepos();
    const res = await svc({ repoRoot, webDist, isPlayingOnPc: () => true }).install();
    expect(res).toEqual({ ok: false, status: 400, error: 'music is playing' });
  });

  it('refuses on a detached HEAD', async () => {
    const { repoRoot, webDist } = initRepos();
    git(repoRoot, 'checkout', '--detach');
    const res = await svc({ repoRoot, webDist }).install();
    expect(res).toEqual({ ok: false, status: 400, error: 'HEAD is detached' });
  });

  it('refuses outside a git checkout', async () => {
    const dir = tempDir();
    const res = await svc({ repoRoot: dir, webDist: join(dir, 'dist') }).install();
    expect(res).toEqual({ ok: false, status: 400, error: 'not a git checkout' });
  });

  it('rolls back the merge and keeps the old dist when the build fails', async () => {
    const { repoRoot, webDist, commitA } = initRepos();
    addRemoteCommit(repoRoot, 'B');
    const res = await svc({
      repoRoot,
      webDist,
      build: async () => {
        throw new Error('boom');
      },
    }).install();

    expect(res).toEqual({ ok: false, status: 500, error: 'building: boom' });
    expect(git(repoRoot, 'rev-parse', 'HEAD')).toBe(commitA);
    expect(readFileSync(join(webDist, 'index.html'), 'utf8')).toBe('old-dist');
  });

  it('refuses a second install while one is running', async () => {
    const { repoRoot, webDist } = initRepos();
    addRemoteCommit(repoRoot, 'B');
    let releaseBuild!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const s = svc({
      repoRoot,
      webDist,
      build: async (toDir) => {
        await gate;
        mkdirSync(toDir, { recursive: true });
        writeFileSync(join(toDir, 'index.html'), 'built');
      },
    });

    const first = s.install();
    const second = await s.install();
    expect(second).toEqual({ ok: false, status: 409, error: 'update already running' });

    releaseBuild();
    const firstResult = await first;
    expect(firstResult).toEqual({ ok: true, stage: 'restart-needed' });
  });
});

describe('same-origin guard', () => {
  const req = (headers: Record<string, string | string[] | undefined>) =>
    ({ headers } as unknown as Parameters<typeof isSameOriginRequest>[0]);

  it('allows requests with no Origin header', () => {
    expect(isSameOriginRequest(req({ host: 'rune.local' }))).toBe(true);
  });

  it('allows a matching Origin', () => {
    expect(isSameOriginRequest(req({ origin: 'https://rune.local', host: 'rune.local' }))).toBe(true);
  });

  it('blocks a foreign Origin', () => {
    expect(isSameOriginRequest(req({ origin: 'https://evil.example', host: 'rune.local' }))).toBe(false);
  });
});
