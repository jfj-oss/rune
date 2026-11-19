// The PC speakers' player: one long-lived mpv process driven over its JSON IPC socket.
//
// It holds no queue of its own: the server's queue (play/driver.ts) hands it a run of local songs (loadRun) and it
// plays them in order, gaplessly: mpv's playlist only ever holds the current track plus the next two, loaded with
// `loadfile <path> append-play`. Cue-sheet tracks pass per-file `start=`/`end=` options.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { PlayerCommand, PlayerState, QueueItem, Track } from '@liner/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { ensureLoudnessSchema, gainInfoForTrack } from '../loudness/index.js';
import { buildFileOptions } from './file-options.js';
import { markStationPlayed, resolveRadioStreamUrlForTrack } from '../iradio/playback.js';
import { StationUrlBlockedError, assertStationUrl } from '../iradio/guard.js';
import { nowPlayingFromMetadata } from '../iradio/nowplaying.js';
import { MpvIpc, type MpvArg, type MpvMessage } from './mpv-ipc.js';
import { levelingLabel } from './signal-path.js';
import { clear as queueClear, createQueue, currentItem, indexOfQueueId, jump as queueJump, play as queuePlay, upcoming as queueUpcoming, type QueueState } from './queue.js';
import { trackPath } from './rows.js';

/** Extra diagnostics exposed for the smoke script (not part of PlaybackZone). */
export interface PcZone extends MpvRunZone {
  close(): Promise<void>;
  readonly socketPath: string;
  /** PID of the current mpv process, if running. */
  mpvPid(): number | undefined;
}

/**
 * What the server-owned queue (play/driver.ts) needs from mpv: a run of local songs, played gaplessly in the order
 * given, under the driver's own queue ids. mpv's own queue then only ever holds that run.
 */
export interface MpvRunZone {
  state(): PlayerState;
  onChange(cb: (s: PlayerState) => void): () => void;
  command(cmd: RunCommand): Promise<PlayerState>;
  /** Play `items` from the first one, at `positionMs` (paused: loaded silent). */
  loadRun(items: QueueItem[], opts: { positionMs: number; paused: boolean }): Promise<PlayerState>;
  /** Keep the song now playing and replace everything after it (a queue edit): gapless preloads follow. */
  setUpcoming(items: QueueItem[]): Promise<PlayerState>;
}

/** What the driver asks of mpv besides loading a run: the transport, and silence (clear). */
export type RunCommand = Extract<PlayerCommand, { type: 'pause' | 'resume' | 'seek' | 'volume' | 'clear' }>;

export type CreatePcZone = (db: Db, cfg: Config, opts?: PcZoneOptions) => Promise<PcZone>;

export interface PcZoneOptions {
  /** Warning sink (defaults to console.warn). */
  log?: (message: string, err?: unknown) => void;
}

interface MpvParams {
  samplerate?: number;
  format?: string;
  [key: string]: unknown;
}

interface WindowEntry {
  queueId: string;
  track: Track;
}

const OBSERVED_PROPERTIES: [number, string][] = [
  [1, 'time-pos'],
  [2, 'pause'],
  [3, 'playlist-pos'],
  [4, 'idle-active'],
  [5, 'eof-reached'],
  [6, 'audio-params'],
  [7, 'audio-out-params'],
  [8, 'audio-device'],
  // Live radio: ICY headers and the stream title mpv derives from them.
  [9, 'metadata'],
  [10, 'media-title'],
];

/** Values mpv's `audio-device` property can hold instead of a sink description. */
const DEVICE_ALIASES = new Set(['auto', 'pipewire', 'pulse', 'alsa']);

/** How often to refresh PipeWire's live graph rate while a track is active. */
const GRAPH_RATE_PROBE_INTERVAL_MS = 5_000;

const POSITION_EMIT_INTERVAL_MS = 1_000;
/** A track this close to its end has finished: Play starts it over rather than at its last moment. */
const FINISHED_WITHIN_MS = 100;
const MAX_RESPAWN_ATTEMPTS = 5;
export async function createPcZone(
  db: Db,
  cfg: Config,
  opts: PcZoneOptions = {},
): Promise<PcZone> {
  // The zone reads gains directly from track_loudness; make sure the table
  // exists even when the loudness worker has not been created yet.
  ensureLoudnessSchema(db);
  const zone = new PcZoneImpl(db, cfg, opts.log ?? ((message, err) => console.warn(message, err)));
  await zone.init();
  return zone;
}

class PcZoneImpl implements PcZone {
  readonly zone = 'pc';
  readonly socketPath: string;

  private readonly db: Db;
  private readonly cfg: Config;
  private readonly log: (message: string, err?: unknown) => void;
  private q: QueueState = createQueue();
  private status: PlayerState['status'] = 'stopped';
  /** A pause came in while a track was loading: that load finishes paused. */
  private pauseAfterLoad = false;
  private positionMs = 0;
  private volume = 100;
  private readonly listeners = new Set<(s: PlayerState) => void>();

  private mpv: ChildProcess | null = null;
  private ipc: MpvIpc | null = null;
  private mpvStderr = '';
  private closed = false;
  private started = false;
  private restoring = false;
  private respawnAttempts = 0;

  /** mpv playlist entries, index-aligned with mpv's playlist positions. */
  private window: WindowEntry[] = [];
  private currentMpvPos = -1;
  private rebuilding = false;

  private props: {
    timePos?: number;
    pause?: boolean;
    idleActive?: boolean;
    eofReached?: boolean;
    audioParams?: MpvParams;
    audioOutParams?: MpvParams;
    /** mpv's current `audio-device` option, e.g. "pipewire/alsa_output...". */
    audioDevice?: string;
    metadata?: Record<string, unknown>;
    mediaTitle?: string;
  } = {};

  /** Live PipeWire graph clock rate, refreshed asynchronously (see probeOutput). */
  private graphRate?: number;
  /** Human-readable output device, e.g. "E30 Headphones". */
  private outputDescription?: string;
  /** Node name `outputDescription` was resolved from (avoids repeated pw-dump). */
  private resolvedNodeName?: string;
  private probeTimer: NodeJS.Timeout | null = null;
  private probing = false;

  /** Serializes commands and window maintenance so races cannot interleave. */
  private ops: Promise<unknown> = Promise.resolve();

  private lastEmitAt = 0;
  private positionTimer: NodeJS.Timeout | null = null;

  constructor(
    db: Db,
    cfg: Config,
    log: (message: string, err?: unknown) => void = () => undefined,
  ) {
    this.db = db;
    this.cfg = cfg;
    this.log = log;
    this.socketPath = join(cfg.dataDir, 'mpv.sock');
  }

  async init(): Promise<void> {
    mkdirSync(this.cfg.dataDir, { recursive: true });
    await this.spawnMpv();
    // Restored from the DB (or the 100 % default); mpv always spawns at 100 %.
    await this.setMpvVolume(this.volume);
    this.started = true;
  }

  // ---------------------------------------------------------------- public API

  state(): PlayerState {
    const item = currentItem(this.q);
    const nowPlaying = this.buildNowPlaying(item?.track);
    return {
      zone: this.zone,
      status: this.status,
      queue: [...this.q.items],
      index: this.q.index,
      positionMs: Math.max(0, Math.round(this.positionMs)),
      volume: this.volume,
      shuffle: this.q.shuffle,
      repeat: this.q.repeat,
      signalPath: this.buildSignalPath(item?.track),
      ...(nowPlaying ? { nowPlaying } : {}),
      updatedAt: Date.now(),
    };
  }

  onChange(cb: (s: PlayerState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  mpvPid(): number | undefined {
    return this.mpv?.pid;
  }

  loadRun(items: QueueItem[], opts: { positionMs: number; paused: boolean }): Promise<PlayerState> {
    return this.serialize(async () => {
      const playable = this.playable(items);
      // A run is played in the order given: mpv's own shuffle and repeat stay off (the driver orders the queue).
      this.q = queuePlay({ ...createQueue(), repeat: 'off', shuffle: false }, playable, 0);
      if (playable.length === 0) {
        await this.stopPlayback();
        this.emitChange();
        return this.state();
      }
      await this.startPlayback({ positionMs: Math.max(0, Math.round(opts.positionMs)), paused: opts.paused });
      return this.state();
    });
  }

  setUpcoming(items: QueueItem[]): Promise<PlayerState> {
    return this.serialize(async () => {
      if (this.q.index < 0) return this.state();
      const head = this.q.items.slice(0, this.q.index + 1);
      const all = [...head, ...this.playable(items)];
      this.q = { ...this.q, items: all, shuffle: false, repeat: 'off' };
      if (this.status === 'playing' || this.status === 'paused') await this.syncWindow();
      this.emitChange();
      return this.state();
    });
  }

  command(cmd: RunCommand): Promise<PlayerState> {
    // Queued behind the load it would come too late: the load would report 'playing' first, and the speaker guard
    // takes that for a new start and pauses whatever the tab has moved on to.
    if (cmd.type === 'pause' && this.status === 'loading') this.pauseAfterLoad = true;
    return this.serialize(async () => {
      await this.applyCommand(cmd);
      return this.state();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // Clean shutdown (SIGTERM) writes the latest position immediately.
    this.closed = true;
    if (this.positionTimer) {
      clearTimeout(this.positionTimer);
      this.positionTimer = null;
    }
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
    const ipc = this.ipc;
    this.ipc = null;
    ipc?.close();

    const child = this.mpv;
    this.mpv = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
      await Promise.race([exited, sleep(2_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
        await Promise.race([exited, sleep(1_000)]);
      }
    }
    try {
      if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    } catch {
      // best effort
    }
  }

  // ------------------------------------------------------------ mpv lifecycle

  private async spawnMpv(): Promise<void> {
    if (this.closed) throw new Error('zone is closed');
    try {
      if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    } catch {
      // best effort
    }
    const args = [
      '--idle=yes',
      '--no-video',
      '--no-terminal',
      `--input-ipc-server=${this.socketPath}`,
      `--audio-device=${this.cfg.audioDevice}`,
      '--gapless-audio=weak',
      '--replaygain=no',
      '--volume=100',
      '--audio-display=no',
    ];
    // The null audio output is used by tests/smoke; it needs --ao=null to exist.
    if (this.cfg.audioDevice === 'null') args.push('--ao=null');

    const child = spawn('mpv', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.mpv = child;
    this.mpvStderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      this.mpvStderr = (this.mpvStderr + chunk.toString()).slice(-2_000);
    });
    child.on('error', (err) => {
      this.mpvStderr = `${this.mpvStderr}\nspawn error: ${err.message}`;
    });
    child.on('exit', (code, signal) => {
      void this.onMpvExit(child, code, signal);
    });

    this.props = {};
    this.window = [];
    this.currentMpvPos = -1;

    let ipc: MpvIpc;
    try {
      ipc = await MpvIpc.connect(this.socketPath, { timeoutMs: 10_000 });
    } catch (err) {
      // Never leave an orphaned mpv around if IPC never came up.
      if (this.mpv === child) this.mpv = null;
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      const detail = this.mpvStderr.trim();
      throw new Error(
        `mpv failed to start: ${(err as Error).message}${detail ? ` (${detail})` : ''}`,
      );
    }
    if (this.closed) {
      ipc.close();
      return;
    }
    this.ipc = ipc;
    ipc.onEvent((msg) => this.onMpvMessage(msg));
    for (const [id, name] of OBSERVED_PROPERTIES) {
      if (name === 'audio-device') {
        // Optional: older mpv builds may not expose it. Reporting degrades to
        // the configured device label rather than failing to start playback.
        await ipc.observe(id, name).catch(() => undefined);
      } else {
        await ipc.observe(id, name);
      }
    }
    this.scheduleOutputProbe(750);
  }

  private async onMpvExit(
    child: ChildProcess,
    _code: number | null,
    _signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (this.closed) return;
    if (this.mpv !== child) return;
    this.mpv = null;
    if (!this.started) return; // createPcZone() failed/never completed; don't respawn
    this.ipc?.close();
    this.ipc = null;
    this.window = [];
    this.currentMpvPos = -1;
    this.rebuilding = false;
    if (this.restoring) return; // the respawn loop owns recovery

    const wasPaused = this.status === 'paused';
    const wasActive =
      this.status === 'playing' || this.status === 'paused' || this.status === 'loading';
    const savedPosition = this.positionMs;
    if (wasActive && this.q.index >= 0) {
      this.status = 'loading';
      this.emitChange();
    }
    await this.respawn(wasPaused, savedPosition, wasActive);
  }

  /** `wasActive` false: nothing was playing, so the new mpv just waits; the queue stays for Play. */
  private async respawn(wasPaused: boolean, savedPosition: number, wasActive: boolean): Promise<void> {
    this.restoring = true;
    try {
      await sleep(200);
      if (this.closed) return;
      await this.spawnMpv();
      this.respawnAttempts = 0;
      await this.setMpvVolume(this.volume);
      if (wasActive && this.q.index >= 0) {
        await this.startPlayback({ positionMs: savedPosition, paused: wasPaused });
      } else {
        this.status = 'stopped';
        this.emitChange();
      }
    } catch (err) {
      this.respawnAttempts += 1;
      if (this.closed) return;
      if (this.respawnAttempts < MAX_RESPAWN_ATTEMPTS) {
        this.restoring = false;
        await this.respawn(wasPaused, savedPosition, wasActive);
        return;
      }
      this.status = 'stopped';
      this.positionMs = 0;
      this.emitChange();
      this.lastError = err as Error;
    } finally {
      this.restoring = false;
    }
  }

  private lastError: Error | undefined;

  // -------------------------------------------------------------- mpv events

  private onMpvMessage(msg: MpvMessage): void {
    if (msg.event === 'end-file') {
      this.props.eofReached = msg.reason === 'eof';
      return;
    }
    if (msg.event !== 'property-change') return;

    switch (msg.name) {
      case 'time-pos': {
        const t = typeof msg.data === 'number' ? msg.data : undefined;
        this.props.timePos = t;
        if (t !== undefined) this.positionMs = this.positionFromMpv(t);
        // Self-heal: time moving while we think we're stopped means a stale idle won.
        if (t !== undefined && this.status === 'stopped' && !this.rebuilding && this.window.length > 0 && this.q.index >= 0) {
          this.status = this.props.pause ? 'paused' : 'playing';
          this.emitChange();
        }
        this.schedulePositionEmit();
        break;
      }
      case 'pause': {
        this.props.pause = Boolean(msg.data);
        this.onPauseChanged();
        break;
      }
      case 'playlist-pos': {
        const pos = typeof msg.data === 'number' ? msg.data : undefined;
        this.onPlaylistPos(pos);
        break;
      }
      case 'idle-active': {
        this.props.idleActive = Boolean(msg.data);
        if (msg.data === true) this.onIdle();
        break;
      }
      case 'eof-reached': {
        this.props.eofReached = typeof msg.data === 'boolean' ? msg.data : undefined;
        break;
      }
      case 'audio-params': {
        this.props.audioParams = (msg.data as MpvParams | undefined) ?? undefined;
        // A new track may switch the PipeWire graph rate; re-read it shortly.
        this.scheduleOutputProbe(500);
        this.emitChange();
        break;
      }
      case 'audio-out-params': {
        this.props.audioOutParams = (msg.data as MpvParams | undefined) ?? undefined;
        this.scheduleOutputProbe(1_000);
        this.emitChange();
        break;
      }
      case 'audio-device': {
        const device = typeof msg.data === 'string' ? msg.data : undefined;
        if (device && device !== this.props.audioDevice) {
          this.props.audioDevice = device;
          this.scheduleOutputProbe(0);
        }
        break;
      }
      case 'metadata': {
        this.props.metadata = isStringRecord(msg.data) ? msg.data : undefined;
        this.emitChange();
        break;
      }
      case 'media-title': {
        const title = typeof msg.data === 'string' ? msg.data : undefined;
        if (title !== this.props.mediaTitle) {
          this.props.mediaTitle = title;
          this.emitChange();
        }
        break;
      }
      default:
        break;
    }
  }

  private onPauseChanged(): void {
    if (this.rebuilding || this.closed) return;
    const pause = this.props.pause === true;
    if (this.q.index < 0 || this.status === 'loading' || this.status === 'stopped') return;
    const next = pause ? 'paused' : 'playing';
    if (this.status !== next) {
      this.status = next;
      this.emitChange();
    }
  }

  private onPlaylistPos(pos: number | undefined): void {
    if (this.rebuilding || this.closed) {
      if (typeof pos === 'number' && pos >= 0) this.currentMpvPos = pos;
      return;
    }
    if (pos === undefined || pos < 0) {
      if (this.props.idleActive) this.onIdle();
      return;
    }
    const entry = this.window[pos];
    if (!entry) return;
    const queueIndex = this.findQueueIndex(entry.queueId);
    if (queueIndex < 0) return;

    const changed = pos !== this.currentMpvPos || queueIndex !== this.q.index;
    const previousIndex = this.q.index;
    this.currentMpvPos = pos;
    if (queueIndex !== this.q.index) {
      this.q = queueJump(this.q, queueIndex);
    }
    if (changed && queueIndex !== previousIndex) {
      // mpv advanced from a local track into a preloaded live radio entry;
      // that transition is a real play too.
      const playing = currentItem(this.q);
      if (playing && isRadioTrack(playing.track)) {
        void markStationPlayed(this.db, this.cfg, playing.track.id).catch(() => undefined);
      }
    }
    if (changed) {
      // time-pos for the new file arrives right after this; don't report stale
      // position from the previous track.
      this.positionMs = 0;
      if (this.status !== 'loading') {
        this.status = this.props.pause ? 'paused' : 'playing';
      }
      this.emitChange();
      this.scheduleSync();
    }
  }

  private onIdle(): void {
    // A freshly spawned mpv reports idle before we restore playback; don't let
    // that reset the position/status the respawn is about to restore.
    if (this.rebuilding || this.restoring || this.closed) return;
    // The idle event from 'stop'/'playlist-clear' during a track switch can arrive
    // after startPlayback has already loaded the new file. Confirm with mpv first.
    if (this.window.length > 0 && this.ipc) {
      const ipc = this.ipc;
      void ipc
        .command(['get_property', 'idle-active'])
        .then((res) => {
          if (res.data === true && !this.rebuilding && !this.restoring && !this.closed) this.applyIdle();
        })
        .catch(() => undefined);
      return;
    }
    this.applyIdle();
  }

  private applyIdle(): void {
    this.currentMpvPos = -1;
    this.window = [];
    this.props.timePos = undefined;
    if (this.q.items.length === 0) {
      this.positionMs = 0;
    } else {
      const item = currentItem(this.q);
      this.positionMs = item?.track.durationMs ?? this.positionMs;
    }
    if (this.status !== 'stopped') {
      this.status = 'stopped';
      this.emitChange();
    }
  }

  private findQueueIndex(queueId: string): number {
    return indexOfQueueId(this.q, queueId);
  }

  private positionFromMpv(timePosSec: number): number {
    const item = currentItem(this.q);
    if (!item) return 0;
    const offsetMs = item.track.cue?.startMs ?? 0;
    const durationMs = item.track.durationMs;
    const position = Math.max(0, Math.round(timePosSec * 1_000 - offsetMs));
    // Live radio has duration 0 and keeps counting up; don't clamp it to zero.
    return durationMs > 0 ? Math.min(durationMs, position) : position;
  }

  // ------------------------------------------------------------- queue -> mpv

  /**
   * Per-file loadfile options. `startMs` is a position inside the logical track
   * (e.g. restoring after a respawn); for cue tracks it is offset by the cue start.
   * Using the start option is more reliable than an immediate seek command, which
   * mpv can ignore while the file is still being opened.
   */
  private fileOptions(track: Track, startMs = 0): string | undefined {
    if (isRadioTrack(track)) return undefined; // a live stream has no start/end or gain
    // ReplayGain-style leveling is applied per file: mpv's af volume filter is
    // reset for each playlist entry, and upcoming entries are loaded with their
    // own gain below. Peak-limited, so this cannot clip.
    return buildFileOptions({ cue: track.cue, startMs, gainDb: this.gainFor(track) });
  }

  /** Applied loudness gain for a local track, 0 when disabled or unmeasured. */
  private gainFor(track: Track): number {
    if (track.source !== 'local') return 0;
    try {
      return gainInfoForTrack(this.db, track.id, this.cfg.normalize ?? 'album')?.gainDb ?? 0;
    } catch {
      return 0;
    }
  }

  private async appendEntry(
    item: QueueItem,
    flag: 'replace' | 'append-play',
    startMs = 0,
  ): Promise<void> {
    const ipc = this.ipc;
    if (!ipc) throw new Error('mpv is not running');
    let path = trackPath(item.track);
    if (isRadioTrack(item.track)) {
      // The queued URL may be a .pls/.m3u wrapper; resolve it before handing it
      // to mpv (mpv cannot play every playlist flavour remote servers use).
      // A stored station whose address fails the policy throws StationUrlBlockedError (kept, not played).
      const resolved = await resolveRadioStreamUrlForTrack(this.db, this.cfg, item.track.id).catch(
        (err: unknown) => {
          if (err instanceof StationUrlBlockedError) throw err;
          return undefined;
        },
      );
      if (resolved) path = resolved;
      else if (path) await assertStationUrl(path);
    }
    if (!path) throw new Error(`track ${item.track.id} has no local file or stream URL`);
    const args: MpvArg[] = ['loadfile', path, flag];
    const options = this.fileOptions(item.track, startMs);
    if (options) args.push(-1, options);
    await ipc.command(args, 15_000);
    this.window.push({ queueId: item.queueId, track: item.track });
  }

  /** Load the current track and the next two, starting playback at `positionMs`. */
  private async startPlayback(opts: { positionMs?: number; paused?: boolean } = {}): Promise<void> {
    const item = currentItem(this.q);
    this.rebuilding = true;
    this.status = 'loading';
    const startPosition = Math.max(0, opts.positionMs ?? 0);
    this.positionMs = startPosition;
    this.emitChange();
    try {
      const ipc = this.ipc;
      if (!ipc) throw new Error('mpv is not running');
      await ipc.command(['stop']).catch(() => undefined);
      await ipc.command(['playlist-clear']).catch(() => undefined);
      this.window = [];
      this.currentMpvPos = -1;
      if (!item || !trackPath(item.track)) {
        this.status = 'stopped';
        this.rebuilding = false;
        this.emitChange(); // clients were told 'loading'
        return;
      }
      // Before the file, or its first moments sound until the pause lands.
      if (opts.paused) {
        this.props.pause = true;
        await ipc.command(['set_property', 'pause', true]).catch(() => undefined);
      }
      // Start position is passed as a per-file option (an immediate seek command can
      // be ignored while mpv is still opening the file).
      await this.appendEntry(item, 'replace', startPosition);
      this.currentMpvPos = 0;
      if (isRadioTrack(item.track)) {
        // A live stream never ends; there is nothing to preload gaplessly.
        // Count the play only once mpv accepted the stream.
        void markStationPlayed(this.db, this.cfg, item.track.id).catch(() => undefined);
      } else {
        for (const upcoming of upcomingEntries(this.q, 2)) {
          await this.appendEntry(upcoming, 'append-play');
        }
      }
      const paused = opts.paused === true || this.pauseAfterLoad;
      if (!opts.paused) {
        // mpv keeps its pause flag across loadfile: after any pause the new song would sit silent at 0:00
        // while rune showed it playing.
        this.props.pause = paused;
        await ipc.command(['set_property', 'pause', paused]).catch(() => undefined);
      }
      this.status = paused ? 'paused' : 'playing';
    } finally {
      this.rebuilding = false;
      this.pauseAfterLoad = false;
    }
    this.emitChange();
  }

  /**
   * Keep exactly the next two queue entries after the current one loaded in mpv.
   * Only touches the tail of mpv's playlist so the playing entry is never
   * interrupted.
   */
  private async syncWindow(): Promise<void> {
    const ipc = this.ipc;
    if (!ipc || this.closed || this.rebuilding) return;
    if (this.currentMpvPos < 0 || this.q.index < 0) return;
    // The mpv playlist holds exactly the playing live stream for radio.
    const current = currentItem(this.q);
    if (current && isRadioTrack(current.track)) return;

    const desired = upcomingEntries(this.q, 2).map((e) => e.queueId);
    const existing = this.window.slice(this.currentMpvPos + 1).map((e) => e.queueId);

    let common = 0;
    while (common < existing.length && common < desired.length && existing[common] === desired[common]) {
      common += 1;
    }

    const keepLength = this.currentMpvPos + 1 + common;
    for (let i = this.window.length - 1; i >= keepLength; i--) {
      // Re-check the current position: playback may have advanced while we waited.
      if (i <= this.currentMpvPos) break;
      await ipc.command(['playlist-remove', i]).catch(() => undefined);
      this.window.pop();
    }
    // Recompute the items to append; entries are QueueItems rebuilt from queue state.
    const allUpcoming = upcomingEntries(this.q, 2);
    for (let i = common; i < allUpcoming.length; i++) {
      const item = allUpcoming[i];
      if (!item) break;
      await this.appendEntry(item, 'append-play');
    }
  }

  private scheduleSync(): void {
    this.serialize(() => this.syncWindow()).catch(() => undefined);
  }

  private async seekTo(positionMs: number): Promise<void> {
    const ipc = this.ipc;
    const item = currentItem(this.q);
    if (!ipc || !item) return;
    const offsetSec = (item.track.cue?.startMs ?? 0) / 1_000;
    const seconds = offsetSec + Math.max(0, positionMs) / 1_000;
    await ipc.command(['seek', seconds, 'absolute']).catch(() => undefined);
  }

  private async setMpvVolume(volume: number): Promise<void> {
    await this.ipc?.command(['set_property', 'volume', volume]).catch(() => undefined);
  }

  private async stopPlayback(): Promise<void> {
    const ipc = this.ipc;
    if (ipc) {
      await ipc.command(['stop']).catch(() => undefined);
      await ipc.command(['playlist-clear']).catch(() => undefined);
    }
    this.window = [];
    this.currentMpvPos = -1;
    this.props.timePos = undefined;
    this.status = 'stopped';
    this.positionMs = 0;
  }

  // --------------------------------------------------------------- commands

  private applyCommand(cmd: RunCommand): Promise<void> {
    switch (cmd.type) {
      case 'pause':
        return this.cmdPause();
      case 'resume':
        return this.cmdResume();
      case 'seek':
        return this.cmdSeek(cmd.positionMs);
      case 'clear':
        return this.cmdClear();
      case 'volume':
        return this.cmdVolume(cmd.volume);
      default: {
        const exhaustive: never = cmd;
        throw new Error(`unknown run command ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private async cmdPause(): Promise<void> {
    if (this.status !== 'playing') return;
    this.props.pause = true;
    this.status = 'paused';
    await this.ipc?.command(['set_property', 'pause', true]).catch(() => undefined);
    this.emitChange();
  }

  private async cmdResume(): Promise<void> {
    if (this.status === 'paused') {
      // mpv holds nothing (it was restarted): load the current track at the saved position instead.
      if (this.window.length === 0) {
        await this.startPlayback({ positionMs: this.resumePosition() });
        return;
      }
      this.props.pause = false;
      this.status = 'playing';
      await this.ipc?.command(['set_property', 'pause', false]).catch(() => undefined);
      this.emitChange();
      return;
    }
    if (this.status === 'stopped' && this.q.index >= 0) {
      await this.startPlayback({ positionMs: this.resumePosition() });
    }
  }

  /** Where Play picks the current track up. */
  private resumePosition(): number {
    const duration = currentItem(this.q)?.track.durationMs ?? 0;
    return duration > 0 && this.positionMs >= duration - FINISHED_WITHIN_MS ? 0 : this.positionMs;
  }

  private async cmdSeek(positionMs: number): Promise<void> {
    const item = currentItem(this.q);
    // Live radio (duration 0) is not seekable; drop the command silently.
    if (item && isRadioTrack(item.track)) return;
    const duration = item?.track.durationMs ?? 0;
    const pos = Math.min(duration, Math.max(0, Math.round(positionMs)));
    this.positionMs = pos;
    if (this.status === 'playing' || this.status === 'paused' || this.status === 'loading') {
      await this.seekTo(pos);
    }
    this.emitChange();
  }

  /** Empty the queue and stop playback; shuffle/repeat settings are kept. */
  private async cmdClear(): Promise<void> {
    this.q = queueClear(this.q);
    await this.stopPlayback();
    this.emitChange();
  }

  private async cmdVolume(volume: number): Promise<void> {
    const v = Math.round(Math.min(100, Math.max(0, volume)) * 2) / 2; // 0.5 % resolution
    this.volume = v;
    await this.setMpvVolume(v);
    this.emitChange();
  }

  private playable(items: QueueItem[]): QueueItem[] {
    return items.filter((it) => trackPath(it.track) !== undefined);
  }

  // ---------------------------------------------------------------- helpers

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.ops.then(fn, fn);
    this.ops = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private emitChange(): void {
    if (this.closed) return;
    this.lastEmitAt = Date.now();
    // Persist queue/transport changes after a short pause; while only the
    // position moves, write at the slower position cadence.
    if (this.positionTimer) {
      clearTimeout(this.positionTimer);
      this.positionTimer = null;
    }
    const snapshot = this.state();
    for (const cb of this.listeners) {
      try {
        cb(snapshot);
      } catch {
        // a bad listener must not break playback
      }
    }
  }

  /** Position updates are throttled to at most one state event per second. */
  private schedulePositionEmit(): void {
    if (this.closed) return;
    const elapsed = Date.now() - this.lastEmitAt;
    if (elapsed >= POSITION_EMIT_INTERVAL_MS) {
      this.emitChange();
      return;
    }
    if (this.positionTimer) return;
    this.positionTimer = setTimeout(() => {
      this.positionTimer = null;
      this.emitChange();
    }, POSITION_EMIT_INTERVAL_MS - elapsed);
    this.positionTimer.unref?.();
  }

  private buildSignalPath(track?: Track): string[] | undefined {
    if (!track) return undefined;
    const parts = [formatLabel(track), 'mpv'];
    const out = this.props.audioOutParams;
    const input = this.props.audioParams;
    const outRate = typeof out?.samplerate === 'number' ? out.samplerate : undefined;
    if (outRate !== undefined) {
      parts.push(`${this.outputDeviceLabel()} ${rateLabel(outRate)}`);
    }
    if (isRadioTrack(track)) {
      parts.push('live stream');
      return parts;
    }
    const active = this.status === 'playing' || this.status === 'paused' || this.status === 'loading';
    if (active && this.graphRate !== undefined) {
      parts.push(`PipeWire graph ${rateLabel(this.graphRate)}`);
    }
    if (active && out && input) {
      const inRate = typeof input.samplerate === 'number' ? input.samplerate : undefined;
      if (inRate !== undefined && outRate !== undefined && inRate !== outRate) {
        parts.push(`resampled to ${rateLabel(outRate)}`);
      } else if (
        this.graphRate !== undefined &&
        outRate !== undefined &&
        this.graphRate !== outRate
      ) {
        // mpv negotiated the stream at its native rate, but the PipeWire graph
        // clock is different: PipeWire is resampling, which mpv cannot see.
        parts.push(`resampled to ${rateLabel(this.graphRate)}`);
      } else if (input.format && out.format && input.format !== out.format) {
        parts.push(`converted to ${out.format}`);
      } else if (this.pipewireOutput() && this.graphRate === undefined) {
        // Don't claim bit-perfect before the graph rate probe has answered.
        parts.push('PipeWire rate unknown');
      } else {
        // The signal path is no longer bit-perfect once the leveling filter runs.
        parts.push(levelingLabel(this.gainFor(track), this.volume));
      }
    }
    return parts;
  }

  private buildNowPlaying(track?: Track): PlayerState['nowPlaying'] | undefined {
    if (!track || !isRadioTrack(track)) return undefined;
    return nowPlayingFromMetadata(
      this.props.metadata,
      this.props.mediaTitle,
      track.title,
      trackPath(track),
    );
  }

  private outputDeviceLabel(): string {
    const device = this.cfg.audioDevice;
    if (device === 'null') return 'null output';
    if (this.outputDescription) return this.outputDescription;
    if (device === 'auto' || device === 'pipewire' || device === 'pulse') return 'PipeWire';
    if (device.startsWith('pipewire/')) return 'PipeWire';
    if (device.startsWith('pulse/')) return 'PulseAudio';
    if (device.startsWith('alsa/')) return `ALSA ${device.slice('alsa/'.length)}`;
    return device;
  }

  // ---------------------------------------------- PipeWire output diagnostics

  private pipewireOutput(): boolean {
    const device = this.cfg.audioDevice;
    return (
      device === 'auto' ||
      device === 'pipewire' ||
      device === 'pulse' ||
      device.startsWith('pipewire/') ||
      device.startsWith('pulse/')
    );
  }

  private isActive(): boolean {
    return this.status === 'playing' || this.status === 'paused' || this.status === 'loading';
  }

  /**
   * Refreshes the real output device name and PipeWire's live graph rate. Both
   * need out-of-process queries (mpv IPC for the sink, `pw-top` for the graph
   * clock), so results are cached and refreshed on a slow timer instead of on
   * every state() call.
   */
  private scheduleOutputProbe(delayMs: number): void {
    if (this.closed || !this.pipewireOutput()) return;
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      void this.probeOutput();
    }, Math.max(0, delayMs));
    this.probeTimer.unref?.();
  }

  private async probeOutput(): Promise<void> {
    if (this.closed || this.probing || !this.pipewireOutput()) return;
    this.probing = true;
    const previousDevice = this.outputDescription;
    const previousRate = this.graphRate;
    try {
      const ipc = this.ipc;
      if (ipc) {
        const res = await ipc.command(['get_property', 'audio-device']).catch(() => undefined);
        const device = typeof res?.data === 'string' ? res.data : undefined;
        if (device) this.props.audioDevice = device;
        const description = await this.resolveOutputDescription(device);
        if (description) this.outputDescription = description;
      }
      const rate = await queryPipeWireGraphRate();
      if (rate !== undefined) this.graphRate = rate;
    } finally {
      this.probing = false;
    }
    if (
      !this.closed &&
      (previousDevice !== this.outputDescription || previousRate !== this.graphRate)
    ) {
      this.emitChange();
    }
    if (!this.closed && this.isActive()) {
      this.scheduleOutputProbe(GRAPH_RATE_PROBE_INTERVAL_MS);
    }
  }

  private async resolveOutputDescription(mpvDevice?: string): Promise<string | undefined> {
    const device = mpvDevice?.trim();
    if (device && !DEVICE_ALIASES.has(device)) {
      if (device.startsWith('pipewire/') || device.startsWith('pulse/')) {
        return this.describeNode(device.slice(device.indexOf('/') + 1));
      }
      // Some mpv builds report the PipeWire node description directly.
      return device;
    }
    const configured = this.cfg.audioDevice;
    if (configured.startsWith('pipewire/') || configured.startsWith('pulse/')) {
      return this.describeNode(configured.slice(configured.indexOf('/') + 1));
    }
    // "pipewire"/"pulse"/"auto": ask WirePlumber what the default sink is.
    return this.describeNode('@DEFAULT_AUDIO_SINK@');
  }

  /** Resolve a PipeWire node name (or @DEFAULT_AUDIO_SINK@) to its description. */
  private async describeNode(node: string): Promise<string | undefined> {
    if (node === this.resolvedNodeName && this.outputDescription) return this.outputDescription;
    const description = await queryPipeWireNodeDescription(node);
    if (description) {
      // The default sink can change while playing; don't cache that lookup.
      if (!node.startsWith('@')) this.resolvedNodeName = node;
      return description;
    }
    return this.outputDescription;
  }
}

/**
 * Upcoming QueueItems from pure queue state (wraps / repeats per repeat mode).
 * A live radio entry ends the window: it is appended so playback can advance
 * into it, but nothing after it is preloaded (no gapless pairing around a live
 * stream, and no extra station connections).
 */
function upcomingEntries(q: QueueState, count: number): QueueItem[] {
  const out: QueueItem[] = [];
  for (const entry of queueUpcoming(q, count)) {
    out.push(entry.item);
    if (isRadioTrack(entry.item.track)) break;
  }
  return out;
}

/** Radio tracks are the only ones whose runtime source is 'radio'. */
export function isRadioTrack(track: Track): boolean {
  return (track as { source?: unknown }).source === 'radio';
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatLabel(track: Track): string {
  if (track.format === 'flac') {
    const parts: string[] = [];
    if (track.bitDepth) parts.push(String(track.bitDepth));
    if (track.sampleRate) parts.push(rateShort(track.sampleRate));
    return parts.length === 0 ? 'FLAC' : `FLAC ${parts.join('/')}`;
  }
  if (track.format === 'mp3') {
    return track.bitrateKbps ? `MP3 ${track.bitrateKbps}` : 'MP3';
  }
  if (track.format === 'other') return 'Audio';
  if (track.sampleRate) return `Audio ${rateShort(track.sampleRate)}`;
  return 'Audio';
}

function rateShort(sampleRate: number): string {
  if (sampleRate % 1000 === 0) return String(sampleRate / 1000);
  return String(Number((sampleRate / 1000).toFixed(1)));
}

function rateLabel(sampleRate: number): string {
  return `${rateShort(sampleRate)} kHz`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run a command and resolve its stdout; never rejects (diagnostics are best-effort). */
function runCommand(
  file: string,
  args: string[],
  timeoutMs: number,
  maxBuffer = 1 << 20,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer }, (err, stdout) => {
      resolve(err ? undefined : stdout);
    });
  });
}

interface PipeWireDumpObject {
  info?: { props?: Record<string, unknown> };
}

/**
 * Node description for a node name, numeric id, or `@DEFAULT_AUDIO_SINK@`.
 * `wpctl inspect` only accepts ids (not node names), so names go through pw-dump.
 */
async function queryPipeWireNodeDescription(target: string): Promise<string | undefined> {
  if (target.startsWith('@') || /^\d+$/.test(target)) {
    const stdout = await runCommand('wpctl', ['inspect', target], 2_000);
    if (!stdout) return undefined;
    const description = /node\.description = "(.*)"/.exec(stdout);
    if (description?.[1]) return description[1];
    const name = /node\.name = "(.*)"/.exec(stdout);
    return name?.[1];
  }
  const stdout = await runCommand('pw-dump', [], 3_000, 8 << 20);
  if (!stdout) return undefined;
  try {
    const objects = JSON.parse(stdout) as PipeWireDumpObject[];
    for (const object of objects) {
      const props = object.info?.props;
      if (props?.['node.name'] === target) {
        const description = props['node.description'];
        return typeof description === 'string' ? description : target;
      }
    }
  } catch {
    // malformed pw-dump output: fall back to the configured label
  }
  return undefined;
}

/**
 * PipeWire's live graph clock rate. `pw-metadata -n settings` only reports the
 * configured default (`clock.rate`), which does not follow allowed-rates
 * switching on PipeWire 1.6; `pw-top` prints the driver's actual rate.
 */
async function queryPipeWireGraphRate(): Promise<number | undefined> {
  const stdout = await runCommand('pw-top', ['-b', '-n', '2'], 3_000);
  if (!stdout) return undefined;
  for (const line of stdout.split('\n')) {
    // Driver rows carry a non-zero quantum: S ID QUANT RATE ...
    const m = /^R\s+\d+\s+(\d+)\s+(\d+)\s/.exec(line);
    if (m && Number(m[1]) > 0) {
      const rate = Number(m[2]);
      if (rate > 0) return rate;
    }
  }
  return undefined;
}
