import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPcSpotify,
  registerPcSpotifyRoutes,
  type CommandResult,
  type CommandRunner,
  type LibrespotProbe,
  type PcSpotify,
} from '../src/play/pcSpotify.js';

/** Fake flatpak / qdbus / which: records every command, never touches the machine. */
class FakeRunner implements CommandRunner {
  running = false;
  /** qdbus binary to pretend exists (null = neither). */
  qdbus: string | null = 'qdbus6';
  launches: string[][] = [];
  calls: { command: string; args: string[] }[] = [];

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.calls.push({ command, args });
    if (command === 'flatpak' && args[0] === 'ps') {
      return { ok: true, stdout: this.running ? 'org.kde.konsole\ncom.spotify.Client\n' : 'org.kde.konsole\n', stderr: '' };
    }
    if (command === 'which') {
      const name = args[0];
      return name === this.qdbus ? { ok: true, stdout: `/usr/bin/${name}\n`, stderr: '' } : { ok: false, stdout: '', stderr: '' };
    }
    if (this.qdbus && command === this.qdbus) {
      if (args.includes('org.kde.kwin.Scripting.loadScript')) return { ok: true, stdout: '7\n', stderr: '' };
      return { ok: true, stdout: '', stderr: '' };
    }
    return { ok: false, stdout: '', stderr: 'unexpected command' };
  }

  spawnDetached(command: string, args: string[]): void {
    this.launches.push([command, ...args]);
  }

  qdbusCalls(method: string): string[][] {
    return this.calls
      .filter((c) => c.command === this.qdbus && c.args.some((a) => a === method || a.endsWith(`.${method}`)))
      .map((c) => c.args);
  }
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
});

function service(
  overrides: {
    now?: () => number;
    setTimeout?: (fn: () => void, ms: number) => unknown;
    librespotUrl?: string;
    librespotProbe?: LibrespotProbe;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'liner-pc-spotify-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const runner = new FakeRunner();
  let t = 1_000_000;
  const scheduled: { fn: () => void; ms: number }[] = [];
  const pcSpotify = createPcSpotify(
    { dataDir: dir, librespotUrl: overrides.librespotUrl },
    {
      runner,
      now: overrides.now ?? (() => t),
      librespotProbe: overrides.librespotProbe,
      setTimeout:
        overrides.setTimeout ??
        ((fn, ms) => {
          scheduled.push({ fn, ms });
          return 0;
        }),
    },
  );
  return { runner, pcSpotify, dir, scheduled, advance: (ms: number) => (t += ms) };
}

async function routeApp(pcSpotify: PcSpotify): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(async (r) => registerPcSpotifyRoutes(r, pcSpotify), { prefix: '/api' });
  await app.ready();
  cleanups.push(() => void app.close());
  return app;
}

describe('createPcSpotify', () => {
  it('does not launch the flatpak when go-librespot already answers', async () => {
    const probes: string[] = [];
    const { runner, pcSpotify } = service({
      librespotUrl: 'http://librespot.test/',
      librespotProbe: async (url) => {
        probes.push(url);
        return { status: 200 };
      },
    });

    expect(await pcSpotify.start()).toEqual({ started: false, running: true });
    expect(probes).toEqual(['http://librespot.test/status']);
    expect(runner.launches).toEqual([]);
    expect(runner.qdbusCalls('loadScript')).toEqual([]);
  });

  it('still launches the flatpak when go-librespot is not up', async () => {
    const { runner, pcSpotify } = service({
      librespotUrl: 'http://librespot.test',
      librespotProbe: async () => ({ status: 204 }),
    });
    expect(await pcSpotify.start()).toEqual({ started: true, running: false });
    expect(runner.launches).toEqual([['flatpak', 'run', 'com.spotify.Client']]);
  });

  it('reports running from flatpak ps without starting anything', async () => {
    const { runner, pcSpotify } = service();
    runner.running = true;
    expect(await pcSpotify.status()).toEqual({ running: true });
    expect(runner.launches).toEqual([]);
    expect(runner.qdbusCalls('loadScript')).toEqual([]);
  });

  it('launches the flatpak detached once, with a temporary KWin minimize script loaded first', async () => {
    const { runner, pcSpotify, dir, scheduled } = service();

    const first = await pcSpotify.start();
    expect(first).toEqual({ started: true, running: false });
    expect(runner.launches).toEqual([['flatpak', 'run', 'com.spotify.Client']]);

    // The script lives in the rune data dir and matches the autostart helper's logic.
    const script = readFileSync(join(dir, 'spotify-minimize.js'), 'utf8');
    expect(script).toContain('w.resourceClass === "com.spotify.Client"');
    expect(script).toContain('w.normalWindow');
    expect(script).toContain('w.minimized = true');

    // unload any stale copy → load → run the numbered script
    const qdbus = runner.calls.filter((c) => c.command === 'qdbus6');
    expect(qdbus.map((c) => c.args.at(-1))).toEqual([
      'rune-spotify-minimize', // unloadScript
      'rune-spotify-minimize', // loadScript takes the id as its last arg too
      'org.kde.kwin.Script.run',
    ]);
    expect(qdbus[1]!.args).toContain(join(dir, 'spotify-minimize.js'));
    expect(qdbus[2]!.args).toContain('/Scripting/Script7');

    // The script is unloaded again after 45 s, so the app behaves normally afterwards.
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.ms).toBe(45_000);
    scheduled[0]!.fn();
    await vi.waitFor(() => expect(runner.qdbusCalls('unloadScript')).toHaveLength(2));
  });

  it('debounces a second start within 60 s and allows one again after it', async () => {
    const { runner, pcSpotify, advance } = service();

    expect(await pcSpotify.start()).toEqual({ started: true, running: false });
    advance(59_999);
    expect(await pcSpotify.start()).toEqual({ started: false, running: false });
    expect(runner.launches).toHaveLength(1);

    advance(1); // exactly 60 s after the first attempt
    expect(await pcSpotify.start()).toEqual({ started: true, running: false });
    expect(runner.launches).toHaveLength(2);
  });

  it('does not relaunch when the app is already running', async () => {
    const { runner, pcSpotify } = service();
    runner.running = true;
    expect(await pcSpotify.start()).toEqual({ started: false, running: true });
    expect(runner.launches).toEqual([]);
  });

  it('starts the app even when qdbus is not installed', async () => {
    const { runner, pcSpotify } = service();
    runner.qdbus = null;
    expect(await pcSpotify.start()).toEqual({ started: true, running: false });
    expect(runner.launches).toEqual([['flatpak', 'run', 'com.spotify.Client']]);
    expect(runner.calls.some((c) => c.command === 'qdbus6' || c.command === 'qdbus')).toBe(false);
  });

  it('falls back to qdbus when qdbus6 is missing', async () => {
    const { runner, pcSpotify } = service();
    runner.qdbus = 'qdbus';
    await pcSpotify.start();
    expect(runner.calls.some((c) => c.command === 'qdbus')).toBe(true);
    expect(runner.calls.some((c) => c.command === 'qdbus6')).toBe(false);
  });
});

describe('PC Spotify routes', () => {
  it('POST /api/pc/spotify/start launches once and debounces the next call', async () => {
    const { runner, pcSpotify } = service();
    const app = await routeApp(pcSpotify);

    const first = await app.inject({ method: 'POST', url: '/api/pc/spotify/start' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ started: true, running: false });
    expect(runner.launches).toHaveLength(1);

    const second = await app.inject({ method: 'POST', url: '/api/pc/spotify/start' });
    expect(second.json()).toEqual({ started: false, running: false });
    expect(runner.launches).toHaveLength(1);

    // Once the app is up, a call reports it instead of launching another copy.
    runner.running = true;
    const third = await app.inject({ method: 'POST', url: '/api/pc/spotify/start' });
    expect(third.json()).toEqual({ started: false, running: true });
    expect(runner.launches).toHaveLength(1);
  });

  it('GET /api/pc/spotify/status only reads flatpak ps', async () => {
    const { runner, pcSpotify } = service();
    const app = await routeApp(pcSpotify);

    const off = await app.inject({ method: 'GET', url: '/api/pc/spotify/status' });
    expect(off.json()).toEqual({ running: false });

    runner.running = true;
    const on = await app.inject({ method: 'GET', url: '/api/pc/spotify/status' });
    expect(on.json()).toEqual({ running: true });

    expect(runner.launches).toEqual([]);
    expect(runner.calls.every((c) => c.command === 'flatpak')).toBe(true);
  });
});
