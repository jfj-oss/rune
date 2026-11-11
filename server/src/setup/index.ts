// First-run setup: the routes behind the "Set up rune" page (music folders, Spotify app id, Soloist key + pairing).
//
// Everything here edits the user's own files (server/config.json, the Soloist key file) and is therefore limited to
// requests that reach rune over loopback (the PC itself, or Tailscale serve proxying from it) from the page's own
// origin. A LAN peer on a 0.0.0.0 bind can read the status but cannot change anything. The Soloist key is written
// with mode 600 and is never sent back, logged, or put in an error message.
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, chmodSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { configFilePath, readUserConfig, type Config } from '../config.js';
import { soloistSettings, type SoloistRun } from '../soloist/index.js';
import { fromLoopback, isSameOriginRequest } from '../update.js';

/** The bits of a child process the pairing run uses. */
export interface PairChild {
  kill(signal?: NodeJS.Signals): boolean;
  stdout?: { on(event: 'data', fn: (chunk: unknown) => void): unknown } | null;
  stderr?: { on(event: 'data', fn: (chunk: unknown) => void): unknown } | null;
  on(event: 'exit', fn: (code: number | null) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
}

export interface SetupDeps {
  cfg: Config;
  /** The running Soloist supervisor's state, or null when Soloist is not started in this process. */
  soloistRun: () => SoloistRun | null;
  /** Restart the process (the service manager brings it back). Injected by tests. */
  restart?: () => void;
  underSystemd?: () => boolean;
  spawn?: (binary: string, args: string[]) => PairChild;
  /** Environment for the pairing run (tests). */
  home?: string;
}

const CLIENT_ID_RE = /^[0-9a-f]{32}$/i;
const KEY_MAX = 4096;
const PAIR_OUTPUT_MAX = 8000;
const PAIR_TIMEOUT_MS = 10 * 60_000;

/** Merge `patch` into the user's config file (atomic write); a key set to undefined is removed. */
export function patchUserConfig(patch: Record<string, unknown>): void {
  const file = configFilePath();
  const next = { ...readUserConfig(), ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Write the Soloist key to `path` (mode 600, directory 700). */
export function writeSoloistKey(path: string, key: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${key}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export type RootCheck = { ok: true; path: string } | { ok: false; path: string; reason: string };

export function checkRoot(raw: string): RootCheck {
  const input = raw.trim();
  if (!input) return { ok: false, path: input, reason: 'Empty path' };
  const expanded = input === '~' ? homedir() : input.startsWith('~/') ? join(homedir(), input.slice(2)) : input;
  if (!isAbsolute(expanded)) return { ok: false, path: input, reason: 'Use a full path, starting with /' };
  const path = resolve(expanded);
  if (path === '/') return { ok: false, path, reason: 'Pick the folder that holds your music, not the whole disk' };
  try {
    if (!statSync(path).isDirectory()) return { ok: false, path, reason: 'That is a file, not a folder' };
    accessSync(path, constants.R_OK | constants.X_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, path, reason: code === 'ENOENT' ? 'That folder does not exist' : 'rune cannot read that folder' };
  }
  return { ok: true, path };
}

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('<key>');
  return out;
}

interface PairState {
  running: boolean;
  output: string;
  exitCode: number | null;
  startedAt: number;
}

export function registerSetupRoutes(r: FastifyInstance, deps: SetupDeps): void {
  const { cfg } = deps;
  const underSystemd = deps.underSystemd ?? (() => !!process.env.INVOCATION_ID);
  const restart = deps.restart ?? (() => { setTimeout(() => process.exit(1), 500); });
  let pair: PairState | null = null;
  let pairChild: PairChild | null = null;

  /** Writes are for the machine rune runs on, from the page itself. */
  function guard(req: FastifyRequest, reply: FastifyReply): boolean {
    if (!isSameOriginRequest(req)) {
      void reply.code(403).send({ error: 'cross-origin request blocked' });
      return false;
    }
    if (!fromLoopback(req)) {
      void reply.code(403).send({ error: 'Setup can only be changed from the PC rune runs on (or over Tailscale serve). Open rune at http://127.0.0.1 there.' });
      return false;
    }
    return true;
  }

  function soloistInfo() {
    const s = soloistSettings(cfg);
    return {
      binary: s.binary,
      binaryInstalled: existsSync(s.binary),
      keyFile: s.keyFile,
      keySaved: existsSync(s.keyFile),
      deviceName: s.deviceName,
      run: deps.soloistRun(),
    };
  }

  r.get('/setup/status', async () => {
    const roots = cfg.libraryRoots;
    const user = readUserConfig();
    return {
      // True until a music folder is set: the page opens the setup on its own.
      needsSetup: roots.length === 0,
      libraryRoots: roots,
      port: cfg.port,
      // Spotify only allows a loopback redirect over plain http, so this is the same however rune is reached.
      redirectUri: `http://127.0.0.1:${cfg.port}/api/spotify/callback`,
      spotifyClientId: typeof user.spotifyClientId === 'string' ? user.spotifyClientId : '',
      // The running process was started with an app id (a changed id needs a restart to take effect).
      spotifyActive: !!cfg.spotifyClientId,
      spotifyPending: (typeof user.spotifyClientId === 'string' ? user.spotifyClientId : '') !== (cfg.spotifyClientId ?? ''),
      rootsPending: JSON.stringify(Array.isArray(user.libraryRoots) ? user.libraryRoots : []) !== JSON.stringify(roots),
      publicUrl: cfg.publicUrl ?? '',
      configFile: configFilePath(),
      home: homedir(),
      canRestart: underSystemd(),
      soloist: soloistInfo(),
    };
  });

  /** Subfolders of `path` (default: home) for the folder picker. Read only. */
  r.get<{ Querystring: { path?: string } }>('/setup/dirs', async (req, reply) => {
    if (!guard(req, reply)) return;
    const asked = req.query.path?.trim() || homedir();
    const check = checkRoot(asked === '/' ? '/' : asked);
    const path = resolve(asked === '~' ? homedir() : asked);
    if (!check.ok && path !== '/') return reply.code(400).send({ error: check.reason });
    let dirs: string[] = [];
    try {
      dirs = readdirSync(path, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || (e.isSymbolicLink() && safeIsDir(join(path, e.name)))))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return reply.code(400).send({ error: 'rune cannot read that folder' });
    }
    return { path, parent: path === '/' ? null : dirname(path), dirs };
  });

  /** Save the music folders and/or the Spotify app id. Takes effect after a restart. */
  r.post<{ Body: { libraryRoots?: unknown; spotifyClientId?: unknown; publicUrl?: unknown } }>('/setup/config', async (req, reply) => {
    if (!guard(req, reply)) return;
    const body = req.body ?? {};
    const patch: Record<string, unknown> = {};
    if (body.libraryRoots !== undefined) {
      if (!Array.isArray(body.libraryRoots) || body.libraryRoots.some((x) => typeof x !== 'string')) {
        return reply.code(400).send({ error: 'libraryRoots must be a list of folder paths' });
      }
      const checks = (body.libraryRoots as string[]).map(checkRoot);
      const bad = checks.find((c) => !c.ok);
      if (bad && !bad.ok) return reply.code(400).send({ error: `${bad.path || '(empty)'}: ${bad.reason}` });
      patch.libraryRoots = [...new Set(checks.map((c) => c.path))];
    }
    if (body.spotifyClientId !== undefined) {
      if (typeof body.spotifyClientId !== 'string') return reply.code(400).send({ error: 'spotifyClientId must be text' });
      const id = body.spotifyClientId.trim();
      if (id && !CLIENT_ID_RE.test(id)) return reply.code(400).send({ error: 'A Spotify client ID is 32 letters and digits (copy it from the dashboard).' });
      patch.spotifyClientId = id || undefined;
    }
    if (body.publicUrl !== undefined) {
      if (typeof body.publicUrl !== 'string') return reply.code(400).send({ error: 'publicUrl must be text' });
      const url = body.publicUrl.trim().replace(/\/+$/, '');
      if (url) {
        let ok = false;
        try { const u = new URL(url); ok = u.protocol === 'https:' && !u.search && !u.hash && (u.pathname === '/' || u.pathname === ''); } catch { /* not a URL */ }
        if (!ok) return reply.code(400).send({ error: 'The phone address must look like https://my-pc.my-tailnet.ts.net:8445' });
      }
      patch.publicUrl = url || undefined;
    }
    try {
      patchUserConfig(patch);
    } catch (err) {
      req.log.warn({ err }, 'setup: could not write config');
      return reply.code(500).send({ error: `Could not write ${configFilePath()}` });
    }
    return { ok: true, restartNeeded: true };
  });

  /** Save the Soloist API key. The key is never echoed back. */
  r.post<{ Body: { key?: unknown } }>('/setup/soloist-key', async (req, reply) => {
    if (!guard(req, reply)) return;
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
    if (!key || key.length > KEY_MAX || /\s/.test(key)) return reply.code(400).send({ error: 'Paste the whole key, as one line.' });
    try {
      writeSoloistKey(soloistSettings(cfg).keyFile, key);
    } catch (err) {
      req.log.warn({ err: (err as Error).message.replace(key, '<key>') }, 'setup: could not write the Soloist key');
      return reply.code(500).send({ error: 'Could not save the key file.' });
    }
    return { ok: true, restartNeeded: true };
  });

  /** Start `soloist --pair` and keep what it prints so the page can show the instructions. */
  r.post('/setup/soloist-pair', async (req, reply) => {
    if (!guard(req, reply)) return;
    const s = soloistSettings(cfg);
    if (!existsSync(s.binary)) return reply.code(409).send({ error: `Soloist is not installed at ${s.binary}` });
    if (!existsSync(s.keyFile)) return reply.code(409).send({ error: 'Save the Soloist key first.' });
    if (deps.soloistRun() === 'running' || deps.soloistRun() === 'starting') {
      return reply.code(409).send({ error: 'Soloist is already running (rune started it). Restart rune after removing its session to pair again.' });
    }
    if (pair?.running) return pair;
    let key = '';
    try { key = readFileSync(s.keyFile, 'utf8').trim(); } catch { return reply.code(409).send({ error: 'The key file cannot be read.' }); }
    const args = ['-n', s.deviceName, '-k', key, '--pair'];
    if (s.dataDir) args.push('-D', s.dataDir);
    const state: PairState = { running: true, output: '', exitCode: null, startedAt: Date.now() };
    pair = state;
    const add = (chunk: unknown) => {
      state.output = (state.output + redact(String(chunk), [key])).slice(-PAIR_OUTPUT_MAX);
    };
    try {
      const child: PairChild = (deps.spawn ?? ((b, a) => nodeSpawn(b, a, { stdio: ['ignore', 'pipe', 'pipe'] })))(s.binary, args);
      pairChild = child;
      child.stdout?.on('data', add);
      child.stderr?.on('data', add);
      child.on('error', (err) => { add(`\n${err.message}\n`); state.running = false; state.exitCode = -1; });
      child.on('exit', (code) => { state.running = false; state.exitCode = code ?? -1; if (pairChild === child) pairChild = null; });
      const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, PAIR_TIMEOUT_MS);
      timer.unref?.();
    } catch (err) {
      state.running = false;
      state.exitCode = -1;
      add(redact(String(err), [key]));
    }
    return state;
  });

  r.get('/setup/soloist-pair', async () => pair ?? { running: false, output: '', exitCode: null, startedAt: 0 });

  r.delete('/setup/soloist-pair', async (req, reply) => {
    if (!guard(req, reply)) return;
    try { pairChild?.kill('SIGTERM'); } catch { /* gone */ }
    return { ok: true };
  });

  /** Restart rune so saved settings apply (only when a service manager will bring it back). */
  r.post('/setup/restart', async (req, reply) => {
    if (!guard(req, reply)) return;
    if (!underSystemd()) return { ok: true, restarting: false };
    restart();
    return { ok: true, restarting: true };
  });
}

function safeIsDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
