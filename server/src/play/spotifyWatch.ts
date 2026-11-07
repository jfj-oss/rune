// Phase 0 of the server-queue plan: what the Spotify app on this PC says about itself (MPRIS), what PipeWire says
// about its stream, and what rune's Connect zone for it believes, side by side with timestamps. It only listens:
// it sends no MPRIS method, no Spotify request, and no command to any zone. Track ids only, never titles.
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PlayerState } from '@liner/shared';
import { parseStreams, type PlaybackProbe, type StreamSample } from './playbackLog.js';

export const SPOTIFY_WATCH_FILE = 'spotify-watch.jsonl';
/** About 150 bytes a line: the file and its one old copy hold several days of normal listening. */
const MAX_BYTES = 1024 * 1024;
const MPRIS_NAME = 'org.mpris.MediaPlayer2.spotify';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER = 'org.mpris.MediaPlayer2.Player';
/** While MPRIS says Playing, its Position is read this often (a local D-Bus call, not Spotify). */
const POSITION_EVERY_MS = 10_000;
/** pactl subscribe sends several events per change: sample once they settle. */
const STREAM_SETTLE_MS = 250;
/** A listener that died is started again after this. */
const RESTART_MS = 30_000;
const PROBE_TIMEOUT_MS = 2000;

/** Just enough of a child process: its stdout lines and a way to stop it (tests inject a fake). */
export interface WatchChild {
  onLine(fn: (line: string) => void): void;
  onExit(fn: () => void): void;
  kill(): void;
}
export type WatchSpawn = (command: string, args: string[]) => WatchChild;

export interface MprisEntry {
  at: string;
  src: 'mpris';
  /** signal = PropertiesChanged, seeked = Seeked, owner = the app came or went, position = a periodic read. */
  ev: 'signal' | 'seeked' | 'owner' | 'position';
  status?: string;
  trackId?: string | null;
  lengthMs?: number;
  positionMs?: number | null;
  volume?: number;
  owned?: boolean;
}
export interface StreamEntry {
  at: string;
  src: 'stream';
  /** No Spotify stream at all = []; null = PipeWire could not be asked. */
  streams: StreamSample[] | null;
}
export interface ConnectEntry {
  at: string;
  src: 'connect';
  zone: string;
  status: PlayerState['status'];
  trackId: string | null;
  positionMs: number;
  volume: number;
  elsewhere?: boolean;
}
export type WatchEntry = MprisEntry | StreamEntry | ConnectEntry;

export interface SpotifyWatchOptions {
  dataDir: string;
  /** File name inside dataDir (default spotify-watch.jsonl). */
  file?: string;
  spawn?: WatchSpawn;
  probe?: PlaybackProbe;
  logger?: { warn(obj: unknown, msg: string): void };
  now?: () => number;
  positionEveryMs?: number;
}

export interface SpotifyWatch {
  /** A state of the Connect zone for this PC's Spotify app, as rune's own polling found it. Logged when it changes. */
  connect(state: PlayerState): void;
  close(): void;
}

const defaultSpawn: WatchSpawn = (command, args) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const rl = createInterface({ input: child.stdout! });
  return {
    onLine: (fn) => rl.on('line', fn),
    onExit: (fn) => {
      child.on('exit', fn);
      child.on('error', fn);
    },
    kill: () => {
      rl.close();
      child.kill();
    },
  };
};

const defaultProbe: PlaybackProbe = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });

/** spotify:track:abc, /com/spotify/track/abc → sp:abc; anything else (an ad, NoTrack) → null. */
function trackIdOf(raw: string): string | null {
  if (!/(^|[/:])track[/:][A-Za-z0-9]+$/.test(raw)) return null;
  return `sp:${raw.split(/[/:]/).pop()}`;
}

/**
 * One line of `gdbus monitor` output, reduced to ids and numbers. Only the keys asked for are read: titles and
 * artists in the same line are never copied.
 */
export function parseMonitorLine(line: string): Omit<MprisEntry, 'at' | 'src'> | null {
  if (line.includes(`${MPRIS_PLAYER}.Seeked`)) {
    const m = /\((?:int64|uint64)?\s*(-?\d+),?\)/.exec(line);
    return { ev: 'seeked', positionMs: m ? Math.round(Number(m[1]) / 1000) : null };
  }
  const owner = /The name \S+ (is owned by|does not have an owner)/.exec(line);
  if (owner) return { ev: 'owner', owned: owner[1] === 'is owned by' };
  if (!line.includes('PropertiesChanged') || !line.includes(MPRIS_PLAYER)) return null;
  const out: Omit<MprisEntry, 'at' | 'src'> = { ev: 'signal' };
  const status = /'PlaybackStatus': <'(\w+)'>/.exec(line);
  if (status) out.status = status[1];
  const track = /'mpris:trackid': <(?:objectpath )?'([^']*)'>/.exec(line);
  if (track) out.trackId = trackIdOf(track[1]!);
  const length = /'mpris:length': <(?:u?int64 )?(\d+)>/.exec(line);
  if (length) out.lengthMs = Math.round(Number(length[1]) / 1000);
  const volume = /'Volume': <(?:double )?([\d.]+)>/.exec(line);
  if (volume) out.volume = Number(volume[1]);
  const position = /'Position': <(?:int64 )?(-?\d+)>/.exec(line);
  if (position) out.positionMs = Math.round(Number(position[1]) / 1000);
  return out;
}

/** busctl --json=short get-property … Position → ms. */
export function parsePosition(text: string | null): number | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as { data?: unknown };
    return typeof v.data === 'number' ? Math.round(v.data / 1000) : null;
  } catch {
    return null;
  }
}

export function createSpotifyWatch(opts: SpotifyWatchOptions): SpotifyWatch {
  const spawnChild = opts.spawn ?? defaultSpawn;
  const probe = opts.probe ?? defaultProbe;
  const now = opts.now ?? Date.now;
  const file = join(opts.dataDir, opts.file ?? SPOTIFY_WATCH_FILE);
  const positionEvery = opts.positionEveryMs ?? POSITION_EVERY_MS;
  let closed = false;
  const children = new Map<string, WatchChild>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let mprisStatus: string | null = null;
  let positionTimer: ReturnType<typeof setInterval> | null = null;
  let streamTimer: ReturnType<typeof setTimeout> | null = null;
  let lastStreams = '';
  let lastConnect = '';

  const at = () => new Date(now()).toISOString();
  const write = (entry: WatchEntry): void => {
    if (closed) return;
    const line = `${JSON.stringify(entry)}\n`;
    try {
      mkdirSync(opts.dataDir, { recursive: true });
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        // no file yet
      }
      if (size + line.length > MAX_BYTES) renameSync(file, `${file}.1`);
      appendFileSync(file, line);
    } catch (err) {
      opts.logger?.warn({ err }, 'could not write the spotify watch log');
    }
  };

  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    t.unref?.();
    timers.add(t);
  };

  /** Run a listener for as long as the watch is open; one that dies is started again in 30 s. */
  const keep = (key: string, command: string, args: string[], onLine: (line: string) => void): void => {
    if (closed) return;
    let child: WatchChild;
    try {
      child = spawnChild(command, args);
    } catch (err) {
      opts.logger?.warn({ err, command }, 'spotify watch: could not start a listener');
      later(() => keep(key, command, args, onLine), RESTART_MS);
      return;
    }
    children.set(key, child);
    child.onLine(onLine);
    let gone = false;
    child.onExit(() => {
      if (gone) return;
      gone = true;
      if (children.get(key) === child) children.delete(key);
      if (!closed) later(() => keep(key, command, args, onLine), RESTART_MS);
    });
  };

  const readPosition = async (): Promise<number | null> =>
    parsePosition(await probe('busctl', ['--user', '--json=short', 'get-property', MPRIS_NAME, MPRIS_PATH, MPRIS_PLAYER, 'Position']));

  const setPositionTimer = (): void => {
    const playing = mprisStatus === 'Playing';
    if (playing && !positionTimer) {
      positionTimer = setInterval(() => {
        void readPosition().then((positionMs) => write({ at: at(), src: 'mpris', ev: 'position', positionMs }));
      }, positionEvery);
      positionTimer.unref?.();
    } else if (!playing && positionTimer) {
      clearInterval(positionTimer);
      positionTimer = null;
    }
  };

  const onMonitor = (line: string): void => {
    const parsed = parseMonitorLine(line);
    if (!parsed) return;
    if (parsed.status) mprisStatus = parsed.status;
    if (parsed.ev === 'owner' && !parsed.owned) mprisStatus = null;
    const stamp = at();
    if (parsed.ev === 'signal' && parsed.positionMs === undefined) {
      // Where the position stood when the signal came: does it move, and does a track change reset it?
      void readPosition().then((positionMs) => write({ at: stamp, src: 'mpris', ...parsed, positionMs }));
    } else write({ at: stamp, src: 'mpris', ...parsed });
    setPositionTimer();
  };

  const sampleStreams = async (): Promise<void> => {
    const [inputs, sinks] = await Promise.all([
      probe('pactl', ['--format=json', 'list', 'sink-inputs']),
      probe('pactl', ['--format=json', 'list', 'sinks']),
    ]);
    const streams = parseStreams(inputs, sinks);
    const key = JSON.stringify(streams);
    if (key === lastStreams) return;
    lastStreams = key;
    write({ at: at(), src: 'stream', streams });
  };

  const onPactl = (line: string): void => {
    if (!/on (sink-input|sink) #/.test(line)) return;
    if (streamTimer) return;
    streamTimer = setTimeout(() => {
      streamTimer = null;
      void sampleStreams();
    }, STREAM_SETTLE_MS);
    streamTimer.unref?.();
  };

  keep('mpris', 'gdbus', ['monitor', '--session', '--dest', MPRIS_NAME, '--object-path', MPRIS_PATH], onMonitor);
  keep('pactl', 'pactl', ['subscribe'], onPactl);
  // Where things stand at the start.
  void (async () => {
    const status = await probe('busctl', ['--user', '--json=short', 'get-property', MPRIS_NAME, MPRIS_PATH, MPRIS_PLAYER, 'PlaybackStatus']);
    let s: string | null = null;
    try {
      const v = status === null ? null : (JSON.parse(status) as { data?: unknown });
      s = typeof v?.data === 'string' ? v.data : null;
    } catch {
      s = null;
    }
    if (closed) return;
    mprisStatus = s;
    write({ at: at(), src: 'mpris', ev: 'position', status: s ?? undefined, positionMs: s ? await readPosition() : null });
    setPositionTimer();
    await sampleStreams();
  })();

  return {
    connect(state) {
      const entry: ConnectEntry = {
        at: at(),
        src: 'connect',
        zone: state.zone,
        status: state.status,
        trackId: state.queue[state.index]?.track.id ?? null,
        positionMs: Math.round(state.positionMs),
        volume: state.volume,
        ...(state.elsewhere ? { elsewhere: true } : {}),
      };
      // While playing every poll is a line (they are sparse, and the position is the point); otherwise changes only.
      const key = JSON.stringify({ ...entry, at: undefined, positionMs: undefined });
      if (key === lastConnect && state.status !== 'playing') return;
      lastConnect = key;
      write(entry);
    },
    close() {
      closed = true;
      for (const c of children.values()) c.kill();
      children.clear();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      if (positionTimer) clearInterval(positionTimer);
      positionTimer = null;
      if (streamTimer) clearTimeout(streamTimer);
      streamTimer = null;
    },
  };
}
