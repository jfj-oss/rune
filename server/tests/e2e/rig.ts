// The silent end-to-end rig: real audio files made with ffmpeg in a temp library, a REAL rune server (real mpv on a null
// audio output, real scanner, real stream route) on its own port with a temp data dir, and a websocket watcher.
// Nothing is audible, nothing touches the user's music, the live rune or its data, and no Spotify exists in it
// (no client id, no Soloist): see CONTRACTS.md "Rules for all workers".
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlayerCommand, PlayerState } from '@liner/shared';
import { buildApp, type BuiltApp } from '../../src/api/server.js';
import type { Config } from '../../src/config.js';
import { openDb } from '../../src/db/index.js';
import { createScanner } from '../../src/scan/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export const hasTool = (name: string): boolean => spawnSync(name, ['-version'], { stdio: 'ignore' }).status === 0 || spawnSync(name, ['--version'], { stdio: 'ignore' }).status === 0;
export const haveAudioTools = (): boolean => hasTool('ffmpeg') && hasTool('mpv');

/** A Chromium to drive (env RUNE_E2E_CHROMIUM, else the system one); null when there is none. */
export function chromiumPath(): string | null {
  const wanted = [process.env.RUNE_E2E_CHROMIUM, '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter((p): p is string => !!p);
  return wanted.find((p) => existsSync(p)) ?? null;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn` returns something truthy (or throws no more); the failure names what was waited for. */
export async function until<T>(what: string, fn: () => T | Promise<T>, ms = 15_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as NonNullable<T>;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last ? ` (${String(last)})` : ''}`);
    await sleep(40);
  }
}

// ------------------------------------------------------------------ the library

export interface E2eTrack { title: string; id: string }
export interface E2eAlbum { title: string; id: string; tracks: E2eTrack[] }
export interface E2eLibrary { root: string; alpha: E2eAlbum; bravo: E2eAlbum; charlie: E2eAlbum; byTitle: Map<string, string> }

/** (title, seconds) per album; silent FLACs, tagged. */
const ALBUMS: [string, [string, number][]][] = [
  ['Alpha', [['A1', 1.4], ['A2', 1.4], ['A3', 1.4], ['A4', 1.4]]],
  ['Bravo', [['B1', 1.4], ['B2', 1.4], ['B3', 1.4]]],
  ['Charlie', [['C1', 12]]],
];

export function writeLibrary(root: string): void {
  for (const [album, tracks] of ALBUMS) {
    const dir = join(root, 'E2E Artist', album);
    mkdirSync(dir, { recursive: true });
    tracks.forEach(([title, seconds], i) => {
      execFileSync(
        'ffmpeg',
        ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(seconds), '-c:a', 'flac',
          '-metadata', `title=${title}`, '-metadata', 'artist=E2E Artist', '-metadata', `album=${album}`, '-metadata', 'album_artist=E2E Artist',
          '-metadata', `track=${i + 1}`, '-metadata', 'date=2001', join(dir, `${String(i + 1).padStart(2, '0')} ${title}.flac`)],
        { stdio: 'ignore' },
      );
    });
  }
}

// ------------------------------------------------------------------ the server

export interface Server {
  readonly port: number;
  readonly base: string;
  readonly library: E2eLibrary;
  /** The zone's state as the server reports it. */
  state(zone: string): Promise<PlayerState>;
  /** One player command; resolves with the state the server answered. */
  send(zone: string, cmd: PlayerCommand): Promise<PlayerState>;
  /** Watch one zone's websocket events. */
  watch(zone: string): Watcher;
  /** Graceful stop (the queue is saved), then the same data dir and port again: what a restart of rune does. */
  restart(): Promise<void>;
  stop(): Promise<void>;
}

export interface Watcher {
  readonly states: PlayerState[];
  last(): PlayerState | undefined;
  /** Where the next state will land: pass it to waitFor/played to ignore everything before this moment. */
  mark(): number;
  /** Titles of the songs that were current while playing, in order, each once per stretch (from `from`). */
  played(from?: number): string[];
  waitFor(what: string, pred: (s: PlayerState) => boolean, ms?: number, from?: number): Promise<PlayerState>;
  close(): void;
}

const titleOf = (s: PlayerState): string | undefined => s.queue[s.index]?.track.title;

export function watchZone(base: string, zone: string): Watcher {
  const states: PlayerState[] = [];
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/ws`);
  ws.onmessage = (m) => {
    try {
      const ev = JSON.parse(String(m.data)) as { type: string; state?: PlayerState };
      if (ev.type === 'player' && ev.state?.zone === zone) states.push(ev.state);
    } catch { /* not ours */ }
  };
  return {
    states,
    last: () => states.at(-1),
    mark: () => states.length,
    played(from = 0) {
      const out: string[] = [];
      let cur: string | undefined;
      for (const s of states.slice(from)) {
        const t = s.status === 'playing' ? titleOf(s) : undefined;
        if (t && t !== cur) { out.push(t); cur = t; }
        else if (s.status === 'stopped' || s.status === 'paused') cur = undefined;
      }
      return out;
    },
    waitFor: (what, pred, ms = 20_000, from = 0) => until(what, () => states.slice(from).find(pred), ms),
    close: () => ws.close(),
  };
}

/** The data dir, port and library of one server, kept across its restarts. */
export async function startServer(opts: { webDist?: string } = {}): Promise<Server> {
  const dir = mkdtempSync(join(tmpdir(), 'rune-e2e-'));
  const libRoot = join(dir, 'music');
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const cfg: Config = { libraryRoots: [libRoot], dataDir, port: 0, audioDevice: 'null', userAgent: 'rune-e2e', normalize: 'off', pcSpotifyDevice: 'rune-e2e-none' };
  let library!: E2eLibrary;
  let built: BuiltApp | undefined;
  let port = 0;
  const watchers: Watcher[] = [];

  async function launch(): Promise<void> {
    const db = openDb(join(dataDir, 'liner.db'));
    if (!library) {
      writeLibrary(libRoot);
      await createScanner(db, cfg).scan();
      library = readLibrary(db, libRoot);
    }
    built = await buildApp(db, { ...cfg, port }, { pcZone: true, scanOnStart: false, watch: false, backups: false, ...(opts.webDist ? { webDist: opts.webDist } : {}) });
    await built.app.listen({ host: '127.0.0.1', port });
    port = (built.app.server.address() as { port: number }).port;
  }
  await launch();

  const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { ...init, headers: init?.body ? { 'content-type': 'application/json' } : undefined });
    if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };
  const stopApp = async (reason: string) => {
    for (const w of watchers.splice(0)) w.close();
    await built?.shutdown(reason).catch(() => undefined);
    built = undefined;
  };
  return {
    get port() { return port; },
    get base() { return `http://127.0.0.1:${port}`; },
    get library() { return library; },
    state: (zone) => json<PlayerState>(`/player/${encodeURIComponent(zone)}`),
    send: (zone, cmd) => json<PlayerState>(`/player/${encodeURIComponent(zone)}`, { method: 'POST', body: JSON.stringify(cmd) }),
    watch(zone) { const w = watchZone(`http://127.0.0.1:${port}`, zone); watchers.push(w); return w; },
    async restart() {
      await stopApp('e2e restart');
      await sleep(200);
      await launch();
    },
    async stop() {
      await stopApp('e2e stop');
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function readLibrary(db: ReturnType<typeof openDb>, root: string): E2eLibrary {
  const albums = db.prepare("SELECT id, title FROM albums WHERE source = 'local' ORDER BY title").all() as { id: string; title: string }[];
  const byTitle = new Map<string, string>();
  const read = (title: string): E2eAlbum => {
    const a = albums.find((x) => x.title === title);
    if (!a) throw new Error(`album ${title} was not scanned`);
    const tracks = db.prepare('SELECT id, title FROM tracks WHERE album_id = ? ORDER BY disc, number').all(a.id) as E2eTrack[];
    for (const t of tracks) byTitle.set(t.title, t.id);
    return { title, id: a.id, tracks };
  };
  const alpha = read('Alpha');
  const bravo = read('Bravo');
  const charlie = read('Charlie');
  return { root, alpha, bravo, charlie, byTitle };
}

/** Build the web app once into a temp dir (the server serves it to the browser tests). */
export function buildWeb(): string {
  const out = mkdtempSync(join(tmpdir(), 'rune-e2e-web-'));
  const webDir = join(HERE, '../../../web');
  const r = spawnSync(process.execPath, [join(webDir, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', out, '--emptyOutDir'], { cwd: webDir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`the web build failed:\n${r.stdout}\n${r.stderr}`);
  return out;
}
