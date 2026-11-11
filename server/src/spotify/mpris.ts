// Phase 2 of the server-queue plan: the Spotify desktop app on this PC describes itself over MPRIS, for free. While
// it owns its MPRIS name and reports a track, its Connect zone (this PC) is read from there instead of GET /me/player:
// the answer is shaped like /me/player, as LocalPlaybackSource does for the browser SDK, so the zone logic is the
// same. Commands still go through the Web API, and nothing here sends an MPRIS method: it reads properties only.
//
// Spotify is still asked, once, when MPRIS cannot be the whole truth: the app went away, its state makes no sense,
// a command to it brought no MPRIS change, a song rune cannot describe, and every ten minutes while it plays, in
// case another device took over (whether the app mirrors a phone is not known).
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { QueueItem } from '@liner/shared';
import type { SpotifyBudgetLevel, SpotifyPlaybackState, SpotifyTrack } from './api.js';
import { parseMonitorLine, trackIdOf, type WatchChild, type WatchSpawn } from '../play/spotifyWatch.js';
import { parseStreams, type PlaybackProbe, type StreamSample } from '../play/playbackLog.js';

const MPRIS_NAME = 'org.mpris.MediaPlayer2.spotify';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER = 'org.mpris.MediaPlayer2.Player';
const PROBE_TIMEOUT_MS = 2000;
/** A monitor that died is started again after this. */
const RESTART_MS = 30_000;

/** While MPRIS says playing, Spotify itself is read this often: another device may have taken over. */
export const MPRIS_SLOW_READ_MS = 600_000;
/** After a command to this device, how long a read waits for the app to signal the change. */
const COMMAND_WAIT_MS = 2000;
/** Signals come in bursts (status, then metadata): act once they settle. */
const SETTLE_MS = 150;
/** A position past the song's end by more than this makes no sense (MPRIS ends ~1 s early, lengths differ ~0.4 s). */
const PAST_END_SLACK_MS = 5000;
/** Playing for this long with no open, uncorked Spotify stream on this PC: the sound is somewhere else. */
const SILENT_MS = 5000;
/** After a signal while another device plays, when to look for this PC's own Spotify sound. */
const TAKEOVER_CHECK_MS = 1500;
/** Each odd state and unknown song is asked about once; the memory of that is cleared past this size. */
const FELL_BACK_MAX = 1000;
/** Real /me/player items remembered by id, so a song rune's database lacks is described after one read. */
const ITEM_CACHE = 200;

/** What the app reports, from one GetAll of org.mpris.MediaPlayer2.Player. */
export interface MprisProps {
  status: string;
  /** sp:<id>, or null for an ad or no track. */
  trackId: string | null;
  lengthMs: number;
  positionMs: number;
  /** 0..1, null when not reported. */
  volume: number | null;
  shuffle: boolean | null;
  loop: string | null;
  /** Shown only when rune's database does not know the song. */
  title: string | null;
  artists: string[];
  album: string | null;
  artUrl: string | null;
}

export type MprisEvent = NonNullable<ReturnType<typeof parseMonitorLine>>;

/** The D-Bus side: one read of the app's state, the change signals, and Spotify's audio streams on this PC. */
export interface MprisBus {
  /** null when the name has no owner or the read failed. */
  read(): Promise<MprisProps | null>;
  /** Spotify's PipeWire streams; null when PipeWire could not be asked. */
  streams(): Promise<StreamSample[] | null>;
  onEvent(fn: (ev: MprisEvent) => void): void;
  close(): void;
}

export interface MprisBusOptions {
  spawn?: WatchSpawn;
  probe?: PlaybackProbe;
  logger?: { warn(obj: unknown, msg: string): void };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
/** busctl --json=short wraps every variant as {type, data}. */
function unwrap(v: unknown): unknown {
  return isRecord(v) && 'data' in v ? v.data : undefined;
}
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** `busctl --json=short call … GetAll s org.mpris.MediaPlayer2.Player` → MprisProps; null when unreadable. */
export function parseGetAll(text: string | null): MprisProps | null {
  if (text === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const out = unwrap(v);
  const props = Array.isArray(out) ? out[0] : out;
  if (!isRecord(props)) return null;
  const status = str(unwrap(props.PlaybackStatus));
  if (status === null) return null;
  const meta = unwrap(props.Metadata);
  const m = isRecord(meta) ? meta : {};
  const rawId = str(unwrap(m['mpris:trackid']));
  const artists = unwrap(m['xesam:artist']);
  const position = num(unwrap(props.Position));
  const length = num(unwrap(m['mpris:length']));
  const shuffle = unwrap(props.Shuffle);
  return {
    status,
    trackId: rawId === null ? null : trackIdOf(rawId),
    lengthMs: length === null ? 0 : Math.round(length / 1000),
    positionMs: position === null ? 0 : Math.max(0, Math.round(position / 1000)),
    volume: num(unwrap(props.Volume)),
    shuffle: typeof shuffle === 'boolean' ? shuffle : null,
    loop: str(unwrap(props.LoopStatus)),
    title: str(unwrap(m['xesam:title'])),
    artists: Array.isArray(artists) ? artists.filter((a): a is string => typeof a === 'string') : [],
    album: str(unwrap(m['xesam:album'])),
    artUrl: str(unwrap(m['mpris:artUrl'])),
  };
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

/** The real bus: `gdbus monitor` for signals, `busctl` for reads (never a method that controls the app), `pactl`. */
export function createMprisBus(opts: MprisBusOptions = {}): MprisBus {
  const spawnChild = opts.spawn ?? defaultSpawn;
  const probe = opts.probe ?? defaultProbe;
  const listeners = new Set<(ev: MprisEvent) => void>();
  let child: WatchChild | null = null;
  let restart: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  /** Known from the monitor; null until it said. A read is skipped only when the name surely has no owner. */
  let owned: boolean | null = null;

  const start = (): void => {
    if (closed) return;
    let c: WatchChild;
    try {
      c = spawnChild('gdbus', ['monitor', '--session', '--dest', MPRIS_NAME, '--object-path', MPRIS_PATH]);
    } catch (err) {
      opts.logger?.warn({ err }, 'mpris: could not start gdbus monitor');
      restart = setTimeout(start, RESTART_MS);
      restart.unref?.();
      return;
    }
    child = c;
    c.onLine((line) => {
      const ev = parseMonitorLine(line);
      if (!ev) return;
      if (ev.ev === 'owner') owned = ev.owned ?? null;
      else owned = true;
      for (const fn of listeners) fn(ev);
    });
    let gone = false;
    c.onExit(() => {
      if (gone) return;
      gone = true;
      if (child === c) child = null;
      owned = null;
      if (closed) return;
      restart = setTimeout(start, RESTART_MS);
      restart.unref?.();
    });
  };
  start();

  return {
    async read() {
      if (owned === false) return null;
      // --auto-start=no: a read must never be what starts the app.
      return parseGetAll(
        await probe('busctl', ['--user', '--json=short', '--auto-start=no', 'call', MPRIS_NAME, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'GetAll', 's', MPRIS_PLAYER]),
      );
    },
    async streams() {
      const [inputs, sinks] = await Promise.all([probe('pactl', ['--format=json', 'list', 'sink-inputs']), probe('pactl', ['--format=json', 'list', 'sinks'])]);
      return parseStreams(inputs, sinks);
    },
    onEvent(fn) {
      listeners.add(fn);
    },
    close() {
      closed = true;
      listeners.clear();
      if (restart) clearTimeout(restart);
      restart = null;
      child?.kill();
      child = null;
    },
  };
}

// ---------- the read source ----------

/** A /me/player answer built from MPRIS: the zone takes it like any other. */
export interface MprisPlaybackState extends SpotifyPlaybackState {
  source: 'mpris';
  /** When the app was seen to start playing (a signal, not a poll); null when not seen. */
  playingSince: number | null;
}

export interface MprisSourceOptions {
  /** The Connect device id of this PC's Spotify app, once the device list named it. */
  deviceId: () => string | null;
  /** Songs rune already has, by 'sp:' id: titles and covers without asking Spotify. */
  knownTracks?: (ids: string[]) => QueueItem[];
  budgetLevel?: () => SpotifyBudgetLevel;
  now?: () => number;
  logger?: { warn(obj: unknown, msg: string): void };
  slowReadMs?: number;
  commandWaitMs?: number;
}

/** Why a read went to Spotify instead (counted, for the request-rate report). */
export type MprisFallback = 'unavailable' | 'first' | 'slow' | 'command' | 'nonsense' | 'unknown-song' | 'elsewhere';

export class MprisPlaybackSource {
  private readonly now: () => number;
  private readonly slowReadMs: number;
  private readonly commandWaitMs: number;
  private wakeFn: () => void = () => {};
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private takeoverTimer: ReturnType<typeof setTimeout> | null = null;
  private ownerChanged = false;
  private described: { id: string; value: SpotifyTrack & { rune?: QueueItem } } | null = null;
  private zoneKnown: (trackId: string) => QueueItem | undefined = () => undefined;
  private waiters: (() => void)[] = [];
  /** The last state read or signalled (null = no owner / unreadable). */
  private last: MprisProps | null = null;
  private owned: boolean | null = null;
  private lastEventAt = Number.NEGATIVE_INFINITY;
  private lastStatus: string | null = null;
  private playingSince: number | null = null;
  /** Last real /me/player answer from any zone, and what it said about this device. */
  private lastRealAt = Number.NEGATIVE_INFINITY;
  private realShuffle: boolean | null = null;
  private realRepeat: SpotifyPlaybackState['repeat_state'] | null = null;
  private realVolume: number | null = null;
  /** What MPRIS said the moment Spotify was last read for this device: a field MPRIS changed since is newer. */
  private mprisAtReal: { shuffle: boolean | null; loop: string | null; volume: number | null } | null = null;
  /** Spotify said another device is active, or rune sent playback to one: Spotify is the truth until it says otherwise. */
  private elsewhere = false;
  /** A command to this device, sent at this time, still waiting for the app to signal it. */
  private pendingCommandAt: number | null = null;
  private readonly fellBack = new Set<string>();
  private silentSince: number | null = null;
  private readonly items = new Map<string, SpotifyTrack>();
  private closed = false;
  readonly counts = { mpris: 0, spotify: 0, byReason: {} as Partial<Record<MprisFallback, number>> };

  constructor(
    private readonly bus: MprisBus,
    private readonly opts: MprisSourceOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.slowReadMs = opts.slowReadMs ?? MPRIS_SLOW_READ_MS;
    this.commandWaitMs = opts.commandWaitMs ?? COMMAND_WAIT_MS;
    bus.onEvent((ev) => this.onEvent(ev));
  }

  /** SpotifyZones calls this so a signal makes this device's zone read at once. */
  setWake(fn: () => void): void {
    this.wakeFn = fn;
  }

  /** SpotifyZones calls this: songs the device's zone already describes (the queue it started or showed). */
  setKnown(fn: (trackId: string) => QueueItem | undefined): void {
    this.zoneKnown = fn;
  }

  deviceId(): string | null {
    return this.opts.deviceId();
  }

  /** Will a read for this device most likely cost nothing? Then budget and breaker need not slow its loop. */
  readsFree(deviceId: string): boolean {
    return !this.closed && deviceId === this.deviceId() && this.owned !== false && !!this.last?.trackId && !this.elsewhere;
  }

  /** A write went to Spotify (sent at `sentAt`). One to this device waits for the app's signal; one elsewhere moves playback away. */
  noteCommand(deviceId: string | undefined, sentAt: number, expectsSignal: boolean): void {
    const mine = this.deviceId();
    if (!mine) return;
    if (deviceId && deviceId !== mine) {
      this.elsewhere = true;
      this.pendingCommandAt = null;
      return;
    }
    if (deviceId === mine) this.elsewhere = false;
    if (expectsSignal) this.pendingCommandAt = sentAt;
  }

  /** Every real /me/player answer, whichever zone asked: it says which device is active. */
  noteReal(playback: SpotifyPlaybackState | null): void {
    this.lastRealAt = this.now();
    const mine = this.deviceId();
    const active = playback?.device?.id ?? null;
    if (playback?.item?.id) {
      this.items.delete(playback.item.id);
      this.items.set(playback.item.id, playback.item);
      if (this.items.size > ITEM_CACHE) this.items.delete(this.items.keys().next().value!);
    }
    if (!mine) return;
    if (active && active !== mine) {
      // The account's active device is another one: this app is not what plays, whatever it shows.
      this.elsewhere = true;
      return;
    }
    this.elsewhere = false;
    if (active === mine && playback) {
      this.realShuffle = playback.shuffle_state ?? null;
      this.realRepeat = playback.repeat_state ?? null;
      this.realVolume = playback.device?.volume_percent ?? null;
    }
  }

  /**
   * The /me/player answer for this device: built from MPRIS when that is the whole truth, otherwise `real()` (one
   * Web API read). A failed real read falls back to MPRIS when it has an answer.
   */
  async answer(real: () => Promise<SpotifyPlaybackState | null>): Promise<SpotifyPlaybackState | null> {
    const viaSpotify = async (why: MprisFallback, props: MprisProps | null): Promise<SpotifyPlaybackState | null> => {
      this.counts.spotify++;
      this.counts.byReason[why] = (this.counts.byReason[why] ?? 0) + 1;
      try {
        const playback = await real();
        if (props && this.deviceId() && playback?.device?.id === this.deviceId()) {
          this.mprisAtReal = { shuffle: props.shuffle, loop: props.loop, volume: props.volume };
        }
        return playback;
      } catch (err) {
        const fallback = props && !this.elsewhere ? this.synthesize(props) : null;
        if (fallback) return fallback;
        throw err;
      }
    };
    if (this.closed || !this.deviceId()) return viaSpotify('unavailable', null);
    // A command to this app: wait for its signal, so the answer is the new state and not the one before it.
    const pending = this.pendingCommandAt;
    if (pending !== null && this.owned === false) this.pendingCommandAt = null;
    else if (pending !== null) {
      if (this.lastEventAt < pending) await this.waitForSignal(pending + this.commandWaitMs - this.now());
      this.pendingCommandAt = null;
      if (this.lastEventAt < pending) {
        const props = await this.read();
        return viaSpotify(props?.trackId ? 'command' : 'unavailable', props);
      }
    }
    const props = await this.read();
    if (!props?.trackId) return viaSpotify('unavailable', props);
    if (this.lastRealAt === Number.NEGATIVE_INFINITY) return viaSpotify('first', props);
    if (this.elsewhere) {
      // Sound from this PC's own Spotify stream means the app plays here after all.
      if (props.status === 'Playing' && (await this.soundHere()) === true) this.elsewhere = false;
      else return viaSpotify('elsewhere', props);
    }
    const odd = await this.oddity(props);
    if (this.fellBack.size > FELL_BACK_MAX) this.fellBack.clear();
    if (odd && !this.fellBack.has(odd)) {
      this.fellBack.add(odd);
      this.opts.logger?.warn({ reason: odd.split('|')[0], trackId: props.trackId, status: props.status }, 'mpris state makes no sense: asking Spotify once');
      return viaSpotify('nonsense', props);
    }
    if (props.status === 'Playing' && this.now() - this.lastRealAt >= this.slowReadMs) return viaSpotify('slow', props);
    if (!this.describe(props.trackId) && !this.fellBack.has(`unknown|${props.trackId}`) && (this.opts.budgetLevel?.() ?? 'normal') !== 'out') {
      // One read describes a song rune has never stored (artist and album links, cover); MPRIS has the title only.
      this.fellBack.add(`unknown|${props.trackId}`);
      return viaSpotify('unknown-song', props);
    }
    const synthetic = this.synthesize(props);
    if (!synthetic) return viaSpotify('nonsense', props);
    this.counts.mpris++;
    return synthetic;
  }

  close(): void {
    this.closed = true;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    if (this.takeoverTimer) clearTimeout(this.takeoverTimer);
    this.takeoverTimer = null;
    for (const w of this.waiters.splice(0)) w();
    this.bus.close();
  }

  // ---------- internals ----------

  private async read(): Promise<MprisProps | null> {
    const props = await this.bus.read();
    this.last = props;
    if (props) {
      this.owned = true;
      this.noteStatus(props.status, null);
    }
    return props;
  }

  private noteStatus(status: string, at: number | null): void {
    if (status === 'Playing' && this.lastStatus !== 'Playing') this.playingSince = at;
    else if (status !== 'Playing') this.playingSince = null;
    if (status !== 'Playing') this.silentSince = null;
    this.lastStatus = status;
  }

  private onEvent(ev: MprisEvent): void {
    if (this.closed) return;
    const at = this.now();
    this.lastEventAt = at;
    if (ev.ev === 'owner') {
      this.owned = ev.owned ?? null;
      if (!ev.owned) {
        this.last = null;
        this.lastStatus = null;
        this.playingSince = null;
      }
    } else this.owned = true;
    if (ev.status) this.noteStatus(ev.status, at);
    if (ev.trackId !== undefined && this.last) this.last = { ...this.last, trackId: ev.trackId };
    if (ev.ev === 'owner') this.ownerChanged = true;
    if (this.settleTimer) return;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      for (const w of this.waiters.splice(0)) w();
      const owner = this.ownerChanged;
      this.ownerChanged = false;
      if (this.closed) return;
      // While another device plays, a read of this one costs a Spotify request: wake it only when the app came or
      // went, or when its own sound shows it took over (a mirrored phone would make no sound here).
      if (!this.elsewhere || owner) this.wakeFn();
      else if (this.lastStatus === 'Playing') this.checkTakeover();
    }, SETTLE_MS);
    this.settleTimer.unref?.();
  }

  /** In a moment (the stream opens after the signal): sound from this PC's Spotify stream ends 'elsewhere'. */
  private checkTakeover(): void {
    if (this.takeoverTimer) return;
    this.takeoverTimer = setTimeout(() => {
      this.takeoverTimer = null;
      if (this.closed || !this.elsewhere || this.lastStatus !== 'Playing') return;
      void this.soundHere().then((sound) => {
        if (sound !== true || this.closed || !this.elsewhere) return;
        this.elsewhere = false;
        this.wakeFn();
      });
    }, TAKEOVER_CHECK_MS);
    this.takeoverTimer.unref?.();
  }

  private waitForSignal(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        const i = this.waiters.indexOf(done);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.push(done);
    });
  }

  /** true = an open, uncorked Spotify stream on this PC; false = none; null = PipeWire could not be asked. */
  private async soundHere(): Promise<boolean | null> {
    const streams = await this.bus.streams();
    if (streams === null) return null;
    return streams.some((s) => s.corked === false);
  }

  /** A reason this state cannot be the truth, keyed so each one is asked about once; null when it is fine. */
  private async oddity(p: MprisProps): Promise<string | null> {
    const key = (why: string) => `${why}|${p.trackId}|${p.status}`;
    if (p.status !== 'Playing' && p.status !== 'Paused') return key('status');
    const length = this.durationOf(p);
    if (length <= 0) return key('length');
    if (p.positionMs > length + PAST_END_SLACK_MS) return key('past-end');
    if (p.status === 'Playing') {
      const sound = await this.soundHere();
      if (sound === false) {
        const at = this.now();
        this.silentSince ??= at;
        if (at - this.silentSince >= SILENT_MS) return key('silent');
      } else this.silentSince = null;
    }
    return null;
  }

  private durationOf(p: MprisProps): number {
    const known = p.trackId ? this.describe(p.trackId) : null;
    return known?.duration_ms || p.lengthMs;
  }

  /** The song as rune's database has it, else as a real /me/player answer had it; null when neither knows it. */
  private describe(trackId: string): (SpotifyTrack & { rune?: QueueItem }) | null {
    // Asked several times per read: a song once found is not looked up again.
    if (this.described?.id === trackId) return this.described.value;
    const value = this.lookup(trackId);
    if (value) this.described = { id: trackId, value };
    return value;
  }

  private lookup(trackId: string): (SpotifyTrack & { rune?: QueueItem }) | null {
    let known: QueueItem | undefined;
    try {
      known = this.opts.knownTracks?.([trackId])[0];
    } catch {
      known = undefined;
    }
    // A song the zone itself started or showed in its queue (rune looked it up then).
    if (!known?.track.title) known = this.zoneKnown(trackId);
    const raw = trackId.slice(3);
    if (known?.track.title) {
      const t = known.track;
      return {
        id: raw,
        name: t.title,
        uri: t.spotifyUri ?? `spotify:track:${raw}`,
        duration_ms: t.durationMs,
        disc_number: t.disc,
        track_number: t.number,
        artists: [],
        rune: known,
      };
    }
    return this.items.get(raw) ?? null;
  }

  private synthesize(p: MprisProps): MprisPlaybackState | null {
    const deviceId = this.deviceId();
    // Anything but Playing (Paused, an odd Stopped once Spotify was asked about it) is shown as not playing.
    if (!deviceId || !p.trackId) return null;
    const raw = p.trackId.slice(3);
    const item: SpotifyTrack & { rune?: QueueItem } = this.describe(p.trackId) ?? {
      id: raw,
      name: p.title ?? '',
      uri: `spotify:track:${raw}`,
      duration_ms: p.lengthMs,
      disc_number: 1,
      track_number: 1,
      artists: p.artists.map((name) => ({ id: '', name })),
      album: p.album === null ? undefined : { id: 'unknown', name: p.album, artists: [], images: p.artUrl ? [{ url: p.artUrl, width: null, height: null }] : [] },
    } as SpotifyTrack;
    const duration = item.duration_ms || p.lengthMs;
    // A field MPRIS changed since Spotify was last read is newer than Spotify's; otherwise Spotify's own word wins
    // (whether this app reports shuffle, repeat and its Connect volume faithfully is not known).
    const since = this.mprisAtReal;
    const shuffle = this.realShuffle !== null && (!since || since.shuffle === p.shuffle) ? this.realShuffle : (p.shuffle ?? false);
    const repeat =
      this.realRepeat !== null && (!since || since.loop === p.loop)
        ? this.realRepeat
        : p.loop === 'Track'
          ? 'track'
          : p.loop === 'Playlist'
            ? 'context'
            : 'off';
    const mprisVolume = p.volume === null ? null : Math.round(Math.max(0, Math.min(1, p.volume)) * 100);
    const volume = this.realVolume !== null && (!since || since.volume === p.volume) ? this.realVolume : (mprisVolume ?? this.realVolume ?? 0);
    return {
      source: 'mpris',
      playingSince: p.status === 'Playing' ? this.playingSince : null,
      device: { id: deviceId, is_active: true, is_private_session: false, is_restricted: false, name: '', type: 'Computer', volume_percent: volume },
      repeat_state: repeat,
      shuffle_state: shuffle,
      timestamp: this.now(),
      progress_ms: duration > 0 ? Math.min(duration, p.positionMs) : p.positionMs,
      is_playing: p.status === 'Playing',
      item,
    };
  }
}
