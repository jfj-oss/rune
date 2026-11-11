// Spotify Soloist in rune: the process (supervisor.ts), its WebSocket (client.ts), the zone (zone.ts) and the sound
// (audio.ts), plus the HTTP routes the pages use. Nothing here calls the Spotify Web API.
//
// On when config.json has `soloist.enabled: true`, or when both the binary and the key file exist; `enabled: false`
// turns it off. Tests pass a fake Soloist's url and fake runners, and no process is started.
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { QueueItem } from '@liner/shared';
import type { Config } from '../config.js';
import { SoloistAudio, type AudioRunner, type SoloistOutput } from './audio.js';
import { SoloistClient, type SocketCtor } from './client.js';
import { soloistAvailable } from './pcRoute.js';
import { SoloistSupervisor, type ChildLike, type SoloistRun } from './supervisor.js';
import { SOLOIST_ZONE, SoloistZone, type SoloistLink } from './zone.js';

export * from './audio.js';
export * from './client.js';
export * from './output.js';
export * from './pcRoute.js';
export * from './supervisor.js';
export * from './zone.js';

export interface SoloistOptions {
  loadItems(ids: string[]): QueueItem[];
  log?: (obj: Record<string, unknown>, msg: string) => void;
  /** Tests: no process is started and the client connects to this URL (a fake Soloist on the loopback). With `spawn`
   *  given as well, a supervisor runs that fake process (for the expired / crashed / not-installed states). */
  url?: string;
  /** Tests: a link in place of the WebSocket client altogether. */
  link?: SoloistLink;
  spawn?: (binary: string, args: string[]) => ChildLike;
  runner?: AudioRunner;
  socket?: SocketCtor;
  hlsDir?: string;
  exists?: (path: string) => boolean;
  readKey?: (path: string) => string;
  now?: () => number;
}

export interface SoloistInfo {
  id: typeof SOLOIST_ZONE;
  name: string;
  /** Where its sound goes now: the PC speakers, or the phone stream. */
  output: SoloistOutput;
  run: SoloistRun;
  connected: boolean;
  loggedIn: boolean;
  isActive: boolean;
  deviceName: string;
  /** Running, connected and signed in: it can play a song right now. */
  available: boolean;
  /** Why it cannot play right now, in plain words, or null. */
  problem: string | null;
}

export interface Soloist {
  zone: SoloistZone;
  info(): SoloistInfo;
  /** Can it play a song right now (the pc zone then sends Spotify songs here instead of to the app)? */
  available(): boolean;
  setOutput(output: SoloistOutput): Promise<SoloistInfo>;
  /** Switch only when the output differs (a play on the PC speakers must not move a stream that is already there). */
  ensureOutput(output: SoloistOutput): Promise<void>;
  /** Mounted inside the /api plugin: /soloist/status, /soloist/output, /soloist/stream/… */
  registerRoutes(app: FastifyInstance): void;
  close(): Promise<void>;
}

export interface SoloistSettings {
  binary: string;
  keyFile: string;
  deviceName: string;
  wsPort: number;
  sink: string;
  kbps: number;
  dataDir?: string;
}

export function soloistSettings(cfg: Config): SoloistSettings {
  const s = cfg.soloist ?? {};
  return {
    binary: s.binary ?? join(homedir(), '.local/bin/soloist'),
    keyFile: s.keyFile ?? join(homedir(), '.config/rune/soloist-key'),
    deviceName: s.deviceName ?? 'rune',
    wsPort: s.wsPort ?? 4547,
    sink: s.sink ?? 'rune-phone',
    kbps: s.hlsKbps ?? 256,
    ...(s.dataDir ? { dataDir: s.dataDir } : {}),
  };
}

/** On when asked for, or when both the binary and the key are there (soloist.enabled: false turns it off). */
export function soloistEnabled(cfg: Config, exists: (path: string) => boolean): boolean {
  if (cfg.soloist?.enabled === false) return false;
  if (cfg.soloist?.enabled === true) return true;
  const set = soloistSettings(cfg);
  return exists(set.binary) && exists(set.keyFile);
}

/** How long the playlist route waits for a fresh program's first segments. */
const PLAYLIST_WAIT_MS = 6000;

export function createSoloist(cfg: Config, opts: SoloistOptions): Soloist {
  const set = soloistSettings(cfg);
  const ws = `127.0.0.1:${set.wsPort}`;
  const audio = new SoloistAudio({ sink: set.sink, kbps: set.kbps, runner: opts.runner, hlsDir: opts.hlsDir, log: opts.log, now: opts.now });
  const supervisor = opts.link || (opts.url && !opts.spawn)
    ? null
    : new SoloistSupervisor({
        binary: set.binary,
        keyFile: set.keyFile,
        deviceName: set.deviceName,
        ws,
        pipewireDevice: set.sink,
        dataDir: set.dataDir,
        spawn: opts.spawn,
        exists: opts.exists,
        readKey: opts.readKey,
        log: opts.log,
      });
  const client = opts.link ? null : new SoloistClient({ url: opts.url ?? `ws://${ws}`, socket: opts.socket, log: opts.log, now: opts.now });
  const link: SoloistLink = opts.link ?? client!;
  const zone = new SoloistZone({
    link,
    loadItems: opts.loadItems,
    output: () => audio.output,
    // A play, skip or seek while the phone listens: a fresh HLS program, so the change is heard after one segment.
    newProgram: () => audio.restart(),
    now: opts.now,
    log: opts.log,
  });
  // Soloist's PipeWire stream appears when it starts to sound: put it where the user wants it each time.
  let lastStatus = link.view.status;
  link.onView((v) => {
    if (v.status === 'playing' && lastStatus !== 'playing') void audio.applyOutput().catch(() => undefined);
    lastStatus = v.status;
  });
  void audio.ensureSink().then((ok) => {
    if (!ok) opts.log?.({}, 'soloist: no phone sink; PC playback still works, the phone stream does not');
    supervisor?.start();
    client?.connect();
  });

  const problem = (): string | null => {
    const fromProcess = supervisor?.problem();
    if (fromProcess) return fromProcess;
    const v = link.view;
    if (!v.connected) return 'Soloist is not running yet — try again in a moment';
    if (!v.loggedIn) return 'Soloist is not signed in to Spotify — pair it once (soloist --pair), then try again';
    return null;
  };
  const run = (): SoloistRun => supervisor?.run ?? (link.view.connected ? 'running' : 'starting');
  const available = (): boolean => soloistAvailable({ run: run(), connected: link.view.connected, loggedIn: link.view.loggedIn });
  const info = (): SoloistInfo => ({
    id: SOLOIST_ZONE,
    name: 'Spotify (Soloist)',
    output: audio.output,
    run: run(),
    connected: link.view.connected,
    loggedIn: link.view.loggedIn,
    isActive: link.view.isActive,
    deviceName: link.view.deviceName || set.deviceName,
    available: available(),
    problem: problem(),
  });

  const setOutput = async (output: SoloistOutput): Promise<SoloistInfo> => {
    await audio.setOutput(output);
    // Switching to the phone mid-song: a program must exist for the phone to join.
    if (output === 'phone' && zone.state().status === 'playing') audio.listen();
    return info();
  };

  return {
    zone,
    info,
    available,
    setOutput,
    async ensureOutput(output) {
      if (audio.output !== output) await setOutput(output);
    },
    registerRoutes(app) {
      app.get('/soloist/status', async () => info());
      app.post<{ Body: { output?: unknown } }>('/soloist/output', async (req, reply) => {
        const output = req.body?.output;
        if (output !== 'pc' && output !== 'phone') return reply.code(400).send({ error: 'output must be "pc" or "phone"' });
        return setOutput(output);
      });
      // The phone's <audio> plays this: native HLS, so it keeps going on the lock screen. A program that ended (skip,
      // seek) stalls the player, which reloads this same URL and lands on the new one.
      app.get('/soloist/stream/live.m3u8', async (_req, reply) => {
        if (audio.output !== 'phone') return reply.code(409).send({ error: 'Soloist plays on the PC speakers — switch it to this phone first' });
        const until = Date.now() + PLAYLIST_WAIT_MS;
        for (;;) {
          const text = audio.playlist();
          if (text && /seg\d+\.ts/.test(text)) {
            return reply.header('content-type', 'application/vnd.apple.mpegurl').header('cache-control', 'no-store').send(text);
          }
          if (Date.now() >= until) break;
          await new Promise((r) => setTimeout(r, 150));
        }
        return reply.code(503).header('retry-after', '1').send({ error: 'the phone stream is starting' });
      });
      app.get<{ Params: { gen: string; file: string } }>('/soloist/stream/:gen/:file', async (req, reply) => {
        const gen = Number(/^g(\d+)$/.exec(req.params.gen)?.[1] ?? NaN);
        const file = audio.segmentPath(gen, req.params.file);
        if (!file) return reply.code(404).send({ error: 'segment gone' });
        return reply.header('content-type', 'video/mp2t').header('cache-control', 'no-store').send(createReadStream(file));
      });
    },
    async close() {
      supervisor?.stop();
      client?.close();
      await zone.close();
      await audio.close();
    },
  };
}
