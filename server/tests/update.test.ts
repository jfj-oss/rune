import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createUpdateService, isSameOriginRequest, registerUpdateRoutes } from '../src/update.js';

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
    fetchMinGapMs?: number;
    now?: () => number;
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
    fetchMinGapMs: opts.fetchMinGapMs,
    now: opts.now,
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

  it('accepts an install while a song plays and restarts only after it ends', async () => {
    const { repoRoot, webDist } = initRepos();
    addRemoteCommit(repoRoot, 'B');
    let playing = true;
    let polls = 0;
    let restartedWhilePlaying: boolean | null = null;
    const s = svc({
      repoRoot,
      webDist,
      underSystemd: () => true,
      musicPollMs: 1,
      isPlayingOnPc: () => {
        if (playing && ++polls >= 4) playing = false;
        return playing;
      },
      build: okBuild(),
      restart: () => {
        restartedWhilePlaying = playing;
      },
    });
    expect(await s.install()).toEqual({ ok: true, stage: 'restarting' });
    expect(restartedWhilePlaying).toBe(false);
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

/** A new local commit that origin does not have (ahead by one). */
function addLocalCommit(repoRoot: string, name: string, content = name): string {
  writeFileSync(join(repoRoot, name), content);
  git(repoRoot, 'add', name);
  return commit(repoRoot, name);
}

const okBuild = (label = 'built') => async (toDir: string) => {
  mkdirSync(toDir, { recursive: true });
  writeFileSync(join(toDir, 'index.html'), label);
};

describe('local pending updates', () => {
  it('is not pending or available when running == HEAD and origin is level; stamps the build', async () => {
    const { repoRoot, webDist, commitA } = initRepos();
    const s = svc({ repoRoot, webDist });
    const st = await s.status();
    expect(st.running).toBe(commitA.slice(0, 7));
    expect(st.pendingLocal).toBe(false);
    expect(st.available).toBe(false);
    expect(readFileSync(join(webDist, '.built-from'), 'utf8').trim()).toBe(commitA);
  });

  it('pendingLocal and available when HEAD moved past the running commit', async () => {
    const { repoRoot, webDist, commitA } = initRepos();
    const s = svc({ repoRoot, webDist });
    await s.status(); // capture the running commit
    const b = addLocalCommit(repoRoot, 'b.txt');
    const st = await s.status();
    expect(st.running).toBe(commitA.slice(0, 7));
    expect(st.current).toBe(b.slice(0, 7));
    expect(st.ahead).toBe(1);
    expect(st.behind).toBe(0);
    expect(st.pendingLocal).toBe(true);
    expect(st.available).toBe(true);
  });

  it('pendingLocal when web/dist was built from an older commit than HEAD', async () => {
    const { repoRoot, webDist, commitA } = initRepos();
    writeFileSync(join(webDist, '.built-from'), `${commitA}\n`);
    const b = addLocalCommit(repoRoot, 'b.txt');
    // a process that starts on B with a dist still built from A
    const st = await svc({ repoRoot, webDist }).status();
    expect(st.running).toBe(b.slice(0, 7));
    expect(st.pendingLocal).toBe(true);
    expect(st.available).toBe(true);
  });

  it('available (not pendingLocal) when only behind origin', async () => {
    const { repoRoot, webDist } = initRepos();
    addRemoteCommit(repoRoot, 'B');
    const st = await svc({ repoRoot, webDist }).status();
    expect(st.pendingLocal).toBe(false);
    expect(st.available).toBe(true);
  });

  it('installs local-only commits without fetching or merging, builds, stamps and swaps', async () => {
    const { repoRoot, webDist } = initRepos();
    const s = svc({ repoRoot, webDist, build: okBuild(), install: async () => { throw new Error('should not install'); } });
    await s.status();
    const b = addLocalCommit(repoRoot, 'b.txt');
    // break the remote: a fetch would fail, proving the local path does not depend on it
    git(repoRoot, 'remote', 'set-url', 'origin', join(repoRoot, 'nope.git'));
    expect(await s.install()).toEqual({ ok: true, stage: 'restart-needed' });
    expect(git(repoRoot, 'rev-parse', 'HEAD')).toBe(b);
    expect(readFileSync(join(webDist, 'index.html'), 'utf8')).toBe('built');
    expect(readFileSync(join(webDist, '.built-from'), 'utf8').trim()).toBe(b);
  });

  it('local-only install runs dependencies only when the lockfile changed since the running commit', async () => {
    const { repoRoot, webDist } = initRepos();
    let installs = 0;
    const s = svc({ repoRoot, webDist, build: okBuild(), install: async () => void installs++ });
    await s.status();
    addLocalCommit(repoRoot, 'b.txt');
    await s.install();
    expect(installs).toBe(0);

    const s2 = svc({ repoRoot, webDist, build: okBuild(), install: async () => void installs++ });
    await s2.status();
    addLocalCommit(repoRoot, 'pnpm-lock.yaml', 'lock v2');
    await s2.install();
    expect(installs).toBe(1);
  });

  it('local-only: a song started during the build delays the restart', async () => {
    const { repoRoot, webDist } = initRepos();
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
        await okBuild()(toDir);
        playing = true;
      },
      restart: () => {
        restartedWhilePlaying = playing;
      },
    });
    await s.status();
    addLocalCommit(repoRoot, 'b.txt');
    expect(await s.install()).toEqual({ ok: true, stage: 'restarting' });
    expect(restartedWhilePlaying).toBe(false);
  });

  it('rolls back a failed local build: keeps HEAD (the user\'s commit) and the old dist', async () => {
    const { repoRoot, webDist } = initRepos();
    const s = svc({
      repoRoot,
      webDist,
      build: async (toDir) => {
        mkdirSync(toDir, { recursive: true });
        writeFileSync(join(toDir, 'partial'), 'x');
        throw new Error('boom');
      },
    });
    await s.status();
    const b = addLocalCommit(repoRoot, 'b.txt');
    const res = await s.install();
    expect(res).toEqual({ ok: false, status: 500, error: 'building: boom' });
    expect(git(repoRoot, 'rev-parse', 'HEAD')).toBe(b);
    expect(readFileSync(join(webDist, 'index.html'), 'utf8')).toBe('old-dist');
    expect(existsSync(join(repoRoot, 'web', '.dist-update'))).toBe(false);
    const st = await s.status();
    expect(st.pendingLocal).toBe(true);
    expect(st.error).toBe('building: boom');
  });
});

describe('background fetch rate limit', () => {
  it('fetches at most once per gap (default 15 min), and force bypasses it', async () => {
    const { repoRoot, webDist } = initRepos();
    let t = 1_000_000;
    const s = svc({ repoRoot, webDist, now: () => t });
    await s.status();
    // someone publishes B; our remote-tracking ref only learns of it on a fetch
    const other = join(tempDir(), 'other');
    git(repoRoot, 'clone', '-q', git(repoRoot, 'config', '--get', 'remote.origin.url'), other);
    writeFileSync(join(other, 'file.txt'), 'B');
    git(other, 'add', 'file.txt');
    commit(other, 'B');
    git(other, 'push', 'origin', 'master');

    t += 14 * 60_000;
    expect((await s.status()).behind).toBe(0); // inside the gap: no fetch
    expect((await s.status({ force: true })).behind).toBe(1); // forced
  });

  it('fetches again after the gap passes', async () => {
    const { repoRoot, webDist } = initRepos();
    let t = 1_000_000;
    const s = svc({ repoRoot, webDist, now: () => t });
    await s.status();
    const other = join(tempDir(), 'other');
    git(repoRoot, 'clone', '-q', git(repoRoot, 'config', '--get', 'remote.origin.url'), other);
    writeFileSync(join(other, 'file.txt'), 'B');
    git(other, 'add', 'file.txt');
    commit(other, 'B');
    git(other, 'push', 'origin', 'master');
    t += 15 * 60_000 + 1;
    expect((await s.status()).behind).toBe(1);
  });

  it('the status route passes ?check=1 as a forced fetch', async () => {
    const app = Fastify({ logger: false });
    const seen: unknown[] = [];
    registerUpdateRoutes(app, { status: async (o: unknown) => (seen.push(o), {}), install: async () => ({ ok: true, stage: 'restart-needed' }) } as never);
    await app.ready();
    await app.inject({ method: 'GET', url: '/update/status' });
    await app.inject({ method: 'GET', url: '/update/status?check=1' });
    expect(seen).toEqual([{ force: false }, { force: true }]);
    await app.close();
  });
});

describe('same-origin guard', () => {
  const req = (headers: Record<string, string | string[] | undefined>, remoteAddress = '192.168.1.50') =>
    ({ headers, socket: { remoteAddress } } as unknown as Parameters<typeof isSameOriginRequest>[0]);

  it('allows requests with no Origin header', () => {
    expect(isSameOriginRequest(req({ host: 'rune.local' }))).toBe(true);
  });

  it('allows a matching Origin', () => {
    expect(isSameOriginRequest(req({ origin: 'https://rune.local', host: 'rune.local' }))).toBe(true);
  });

  it('blocks a foreign Origin', () => {
    expect(isSameOriginRequest(req({ origin: 'https://evil.example', host: 'rune.local' }))).toBe(false);
  });

  it('ignores a forged X-Forwarded-Host from a non-local peer', () => {
    expect(
      isSameOriginRequest(req({ origin: 'https://evil.example', host: 'rune.local:4545', 'x-forwarded-host': 'evil.example' })),
    ).toBe(false);
    expect(
      isSameOriginRequest(
        req({ origin: 'https://evil.example', host: 'rune.local:4545', 'x-forwarded-host': 'evil.example' }, '100.64.1.2'),
      ),
    ).toBe(false);
  });

  it('a real Origin that matches Host from a LAN peer still passes, forwarded header or not', () => {
    expect(isSameOriginRequest(req({ origin: 'http://192.168.1.9:4545', host: '192.168.1.9:4545' }))).toBe(true);
    expect(
      isSameOriginRequest(req({ origin: 'http://192.168.1.9:4545', host: '192.168.1.9:4545', 'x-forwarded-host': 'evil.example' })),
    ).toBe(true);
  });

  it('behind Tailscale serve (loopback peer) the forwarded host is the page host', () => {
    const headers = {
      origin: 'https://pc.example-tailnet.ts.net:8445',
      host: '127.0.0.1:4545',
      'x-forwarded-host': 'pc.example-tailnet.ts.net:8445',
    };
    for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect(isSameOriginRequest(req(headers, peer))).toBe(true);
    // and a foreign page through the same proxy is still refused
    expect(isSameOriginRequest(req({ ...headers, origin: 'https://evil.example' }, '127.0.0.1'))).toBe(false);
  });

  it('through the route: forged header from a non-loopback peer is 403, Tailscale-style request reaches the service', async () => {
    const app = Fastify({ logger: false });
    let installs = 0;
    registerUpdateRoutes(app, { install: async () => (installs++, { ok: true, stage: 'restart-needed' }), status: async () => ({}) } as never);
    await app.ready();
    const forged = await app.inject({
      method: 'POST',
      url: '/update/install',
      remoteAddress: '192.168.1.50',
      headers: { origin: 'https://evil.example', host: 'rune.local:4545', 'x-forwarded-host': 'evil.example' },
    });
    expect(forged.statusCode).toBe(403);
    const tailscale = await app.inject({
      method: 'POST',
      url: '/update/install',
      remoteAddress: '127.0.0.1',
      headers: {
        origin: 'https://pc.example-tailnet.ts.net:8445',
        host: '127.0.0.1:4545',
        'x-forwarded-host': 'pc.example-tailnet.ts.net:8445',
      },
    });
    expect(tailscale.statusCode).toBe(200);
    expect(installs).toBe(1);
    await app.close();
  });
});
