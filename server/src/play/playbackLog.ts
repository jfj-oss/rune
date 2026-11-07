// What really happened 5 s after each Spotify start: when a song is silent while rune shows it playing, this says which
// link broke. It lives in rune's own small file because the journal rotates in hours. Track ids only, no titles.
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PlayerCommand, PlayerState } from '@liner/shared';

const SAMPLE_AFTER_MS = 5000;
const PROBE_TIMEOUT_MS = 2000;
/** One sample is about 300 bytes, so the file and its one old copy hold a few thousand starts. */
const MAX_BYTES = 512 * 1024;
export const PLAYBACK_LOG_FILE = 'playback-log.jsonl';

const MPRIS_ARGS = ['org.mpris.MediaPlayer2.spotify', '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player'];
/** Stream properties that name the app (the flatpak fills in some of them). */
const STREAM_APP_KEYS = ['application.name', 'application.process.binary', 'application.id', 'pipewire.access.portal.app_id'];

/** Run a read-only command and give its stdout, or null if that failed. Swapped for a fake in tests. */
export type PlaybackProbe = (command: string, args: string[]) => Promise<string | null>;

export interface StreamSample {
  sink: string | null;
  muted: boolean | null;
  volume: number | null;
  corked: boolean | null;
  sinkMuted: boolean | null;
  sinkVolume: number | null;
}

export interface PlaybackSample {
  at: string;
  zone: string;
  /** What rune thinks: the song, its status and the Connect volume from the last poll (no extra Spotify request). */
  trackId: string | null;
  status: PlayerState['status'];
  connectVolume: number;
  /** What the Spotify app itself says; null when it could not be asked. */
  mpris: { status: string | null; trackId: string | null } | null;
  /** Its PipeWire streams; empty = nothing reaches the speakers, null = PipeWire could not be asked. */
  streams: StreamSample[] | null;
}

export interface PlaybackLogOptions {
  dataDir: string;
  probe?: PlaybackProbe;
  logger?: { warn(obj: unknown, msg: string): void };
  now?: () => number;
}

export interface PlaybackLog {
  /** A Spotify zone was just told to play: sample it in 5 s. A newer start on the zone replaces the waiting sample. */
  started(zone: { zone: string; state(): PlayerState }): void;
  close(): void;
}

/** Does this command, when it worked, start sound? */
export function startsSound(cmd: PlayerCommand): boolean {
  if (cmd.type === 'play') return !cmd.paused;
  return cmd.type === 'resume' || cmd.type === 'next' || cmd.type === 'prev' || cmd.type === 'jump';
}

const defaultProbe: PlaybackProbe = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });

function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The status from busctl's JSON for PlaybackStatus. */
export function parseMprisStatus(text: string | null): string | null {
  const v = parseJson(text);
  return isRecord(v) && typeof v.data === 'string' ? v.data : null;
}

/** The track id from busctl's JSON for Metadata, which also holds the title and artist: only the id is taken. */
export function parseMprisTrackId(text: string | null): string | null {
  const v = parseJson(text);
  const entry = isRecord(v) && isRecord(v.data) ? v.data['mpris:trackid'] : undefined;
  const raw = isRecord(entry) ? entry.data : undefined;
  if (typeof raw !== 'string') return null;
  const id = raw.split(/[/:]/).pop() ?? '';
  return /^[A-Za-z0-9]+$/.test(id) ? `sp:${id}` : null;
}

/** The loudest channel, in percent, from pactl's `volume` object. */
function percent(volume: unknown): number | null {
  if (!isRecord(volume)) return null;
  const levels = Object.values(volume)
    .map((c) => (isRecord(c) && typeof c.value_percent === 'string' ? Number.parseInt(c.value_percent, 10) : Number.NaN))
    .filter((n) => Number.isFinite(n));
  return levels.length > 0 ? Math.max(...levels) : null;
}

const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** The Spotify streams from `pactl --format=json list sink-inputs`, each with its sink from `list sinks`. */
export function parseStreams(inputsText: string | null, sinksText: string | null): StreamSample[] | null {
  const inputs = parseJson(inputsText);
  if (!Array.isArray(inputs)) return null;
  const sinks = parseJson(sinksText);
  const sinkList = Array.isArray(sinks) ? sinks.filter(isRecord) : [];
  return inputs.filter(isRecord).flatMap((input) => {
    const props = isRecord(input.properties) ? input.properties : {};
    if (!STREAM_APP_KEYS.some((k) => /spotify/i.test(String(props[k] ?? '')))) return [];
    const sink = sinkList.find((s) => s.index === input.sink);
    return [{
      sink: typeof sink?.name === 'string' ? sink.name : null,
      muted: bool(input.mute),
      volume: percent(input.volume),
      corked: bool(input.corked),
      sinkMuted: bool(sink?.mute),
      sinkVolume: percent(sink?.volume),
    }];
  });
}

export function createPlaybackLog(opts: PlaybackLogOptions): PlaybackLog {
  const probe = opts.probe ?? defaultProbe;
  const now = opts.now ?? Date.now;
  const file = join(opts.dataDir, PLAYBACK_LOG_FILE);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let closed = false;

  const write = (sample: PlaybackSample): void => {
    const line = `${JSON.stringify(sample)}\n`;
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
      opts.logger?.warn({ err }, 'could not write the playback log');
    }
  };

  const sample = async (zone: { zone: string; state(): PlayerState }): Promise<void> => {
    const busctl = (property: string) => probe('busctl', ['--user', '--json=short', 'get-property', ...MPRIS_ARGS, property]);
    const pactl = (kind: string) => probe('pactl', ['--format=json', 'list', kind]);
    const [status, metadata, inputs, sinks] = await Promise.all([busctl('PlaybackStatus'), busctl('Metadata'), pactl('sink-inputs'), pactl('sinks')]);
    if (closed) return;
    const s = zone.state();
    write({
      at: new Date(now()).toISOString(),
      zone: zone.zone,
      trackId: s.queue[s.index]?.track.id ?? null,
      status: s.status,
      connectVolume: s.volume,
      mpris: status === null && metadata === null ? null : { status: parseMprisStatus(status), trackId: parseMprisTrackId(metadata) },
      streams: parseStreams(inputs, sinks),
    });
  };

  return {
    started(zone) {
      if (closed) return;
      const waiting = timers.get(zone.zone);
      if (waiting) clearTimeout(waiting);
      const timer = setTimeout(() => {
        timers.delete(zone.zone);
        sample(zone).catch((err: unknown) => opts.logger?.warn({ err }, 'could not sample playback'));
      }, SAMPLE_AFTER_MS);
      timer.unref?.();
      timers.set(zone.zone, timer);
    },
    close() {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
