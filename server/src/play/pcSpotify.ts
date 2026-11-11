// Starts the Spotify desktop app on this PC on demand, so rune can move Spotify
// tracks to the "Linux PC speakers" zone. The app is a flatpak (com.spotify.Client)
// and is usually closed; starting it is enough for it to appear as the Connect
// device named after this PC. On KDE a temporary KWin script minimizes its window as it opens.
//
// Everything that touches the machine goes through an injectable CommandRunner so
// tests never run flatpak/qdbus and never launch the real app.
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';

const APP_ID = 'com.spotify.Client';
/**
 * Spotify 1.2.95 hangs at start-up on KDE's Wayland (its first Wayland request is never answered, so it
 * never signs in or appears as a device). Under XWayland it starts normally.
 */
const LAUNCH_ARGS = ['run', '--socket=x11', '--nosocket=wayland', APP_ID, '--ozone-platform=x11'];
const SCRIPT_NAME = 'rune-spotify-minimize';
const SCRIPT_FILE = 'spotify-minimize.js';
const UNLOAD_AFTER_MS = 45_000;
const DEBOUNCE_MS = 60_000;
const COMMAND_TIMEOUT_MS = 10_000;

/** The KWin script the autostart helper used: minimize Spotify's windows as they open. */
const KWIN_SCRIPT = `workspace.windowAdded.connect(function (w) {
  var c = String(w.resourceClass).toLowerCase();
  if ((c === "com.spotify.client" || c === "spotify") && w.normalWindow) w.minimized = true;
});
`;

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Every external command the service runs. Swapped for a fake in tests. */
export interface CommandRunner {
  run(command: string, args: string[]): Promise<CommandResult>;
  spawnDetached(command: string, args: string[]): void;
}

export interface PcSpotifyOptions {
  runner?: CommandRunner;
  /** Clock for debounce (tests inject one; the default follows fake timers). */
  now?: () => number;
  /** Schedule the delayed KWin-script unload (tests use fake timers). */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  /** Where spotify-minimize.js is written (defaults to the rune data dir). */
  dataDir?: string;
  log?: (message: string, err?: unknown) => void;
}

export interface PcSpotifyStatus {
  running: boolean;
}

export interface PcSpotifyStartResult {
  started: boolean;
  running: boolean;
}

export interface PcSpotify {
  /** Is the flatpak running? Only flatpak ps — no Spotify API call. */
  status(): Promise<PcSpotifyStatus>;
  /** Launch it if needed (debounced). Does not wait for its Connect device. */
  start(): Promise<PcSpotifyStartResult>;
}

const defaultRun = (command: string, args: string[]): Promise<CommandResult> =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: COMMAND_TIMEOUT_MS }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? err?.message ?? ''),
      });
    });
  });

const defaultRunner: CommandRunner = {
  run: defaultRun,
  spawnDetached(command, args) {
    // rune.service uses KillMode=control-group: a plain child would be killed with every rune
    // restart. systemd-run starts it as its own transient user unit, outside rune's cgroup.
    const unit = `rune-spotify-${Date.now()}`;
    const child = spawn('systemd-run', ['--user', '--collect', '--quiet', `--unit=${unit}`, '--', command, ...args], { detached: true, stdio: 'ignore' });
    child.on('error', () => spawn(command, args, { detached: true, stdio: 'ignore' }).unref());
    child.unref();
  },
};

export function createPcSpotify(
  cfg: Pick<Config, 'dataDir'>,
  opts: PcSpotifyOptions = {},
): PcSpotify {
  const runner = opts.runner ?? defaultRunner;
  const now = opts.now ?? Date.now;
  const schedule = opts.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const dataDir = opts.dataDir ?? cfg.dataDir;
  const log = opts.log ?? (() => undefined);
  /** Last launch attempt: a second start within a minute must not launch a second copy. */
  let lastStartAt = 0;

  const isRunning = async (): Promise<boolean> => {
    try {
      const ps = await runner.run('flatpak', ['ps', '--columns=application']);
      return ps.ok && ps.stdout.split(/\r?\n/).some((line) => line.trim() === APP_ID);
    } catch (err) {
      log('could not list flatpak apps', err);
      return false;
    }
  };

  const findQdbus = async (): Promise<string | null> => {
    for (const name of ['qdbus6', 'qdbus']) {
      try {
        const found = await runner.run('which', [name]);
        if (found.ok && found.stdout.trim()) return name;
      } catch {
        /* try the next one */
      }
    }
    return null;
  };

  /** Load (and later unload) the minimize script; failing to reach KWin must never stop playback. */
  const loadMinimizeScript = async (qdbus: string): Promise<void> => {
    try {
      mkdirSync(dataDir, { recursive: true });
      const file = join(dataDir, SCRIPT_FILE);
      writeFileSync(file, KWIN_SCRIPT);
      // A previous run may still have it loaded (e.g. rune restarted within 45 s).
      await runner.run(qdbus, ['org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting.unloadScript', SCRIPT_NAME]);
      const loaded = await runner.run(qdbus, [
        'org.kde.KWin',
        '/Scripting',
        'org.kde.kwin.Scripting.loadScript',
        file,
        SCRIPT_NAME,
      ]);
      const id = loaded.ok ? loaded.stdout.trim() : '';
      if (id) {
        await runner.run(qdbus, ['org.kde.KWin', `/Scripting/Script${id}`, 'org.kde.kwin.Script.run']);
      }
    } catch (err) {
      log('could not load the KWin minimize script', err);
    }
  };

  return {
    async status() {
      return { running: await isRunning() };
    },

    async start() {
      if (await isRunning()) return { started: false, running: true };

      const at = now();
      if (at - lastStartAt < DEBOUNCE_MS) return { started: false, running: false };
      lastStartAt = at;

      // Load the minimize script first, while Spotify's window does not exist yet.
      const qdbus = await findQdbus();
      if (qdbus) await loadMinimizeScript(qdbus);

      try {
        runner.spawnDetached('flatpak', LAUNCH_ARGS);
      } catch (err) {
        log('could not start Spotify', err);
        return { started: false, running: false };
      }

      if (qdbus) {
        const timer = schedule(() => {
          void runner
            .run(qdbus, ['org.kde.KWin', '/Scripting', 'org.kde.kwin.Scripting.unloadScript', SCRIPT_NAME])
            .catch(() => undefined);
        }, UNLOAD_AFTER_MS);
        (timer as { unref?: () => void } | undefined)?.unref?.();
      }
      return { started: true, running: false };
    },
  };
}

/** GET /api/pc/spotify/status and POST /api/pc/spotify/start (registered under the /api prefix). */
export function registerPcSpotifyRoutes(app: FastifyInstance, pcSpotify: PcSpotify): void {
  app.get('/pc/spotify/status', async () => pcSpotify.status());
  app.post('/pc/spotify/start', async () => pcSpotify.start());
}
