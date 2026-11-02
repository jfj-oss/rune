// PC playback zone: one long-lived mpv process driven over its JSON IPC socket.
//
// The queue lives here (see ./queue.ts); mpv's playlist only ever holds the current
// track plus the next two, loaded with `loadfile <path> append-play` so transitions
// are gapless. Cue-sheet tracks pass per-file `start=`/`end=` options.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { PlayerCommand, PlayerState, QueueItem, Track } from '@liner/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { PlaybackZone } from '../modules.js';
import { MpvIpc, type MpvArg, type MpvMessage } from './mpv-ipc.js';
import {
  createQueue,
  currentItem,
  enqueue as queueEnqueue,
  indexOfQueueId,
  jump as queueJump,
  next as queueNext,
  play as queuePlay,
  prev as queuePrev,
  remove as queueRemove,
  setRepeat as queueSetRepeat,
  setShuffle as queueSetShuffle,
  upcoming as queueUpcoming,
  type QueueState,
} from './queue.js';
import { loadQueueItems, trackPath } from './rows.js';

/** Extra diagnostics exposed for the smoke script (not part of PlaybackZone). */
export interface PcZone extends PlaybackZone {
  readonly socketPath: string;
  /** PID of the current mpv process, if running. */
  mpvPid(): number | undefined;
}

export type CreatePcZone = (db: Db, cfg: Config) => Promise<PcZone>;

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
];

const POSITION_EMIT_INTERVAL_MS = 1_000;
const MAX_RESPAWN_ATTEMPTS = 5;

export async function createPcZone(db: Db, cfg: Config): Promise<PcZone> {
  const zone = new PcZoneImpl(db, cfg);
  await zone.init();
  return zone;
}

class PcZoneImpl implements PcZone {
  readonly zone = 'pc';
  readonly socketPath: string;

  private readonly db: Db;
  private readonly cfg: Config;
  private q: QueueState = createQueue();
  private status: PlayerState['status'] = 'stopped';
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
  } = {};

  /** Serializes commands and window maintenance so races cannot interleave. */
  private ops: Promise<unknown> = Promise.resolve();

  private lastEmitAt = 0;
  private positionTimer: NodeJS.Timeout | null = null;

  constructor(db: Db, cfg: Config) {
    this.db = db;
    this.cfg = cfg;
    this.socketPath = join(cfg.dataDir, 'mpv.sock');
  }

  async init(): Promise<void> {
    mkdirSync(this.cfg.dataDir, { recursive: true });
    await this.spawnMpv();
    this.started = true;
  }

  // ---------------------------------------------------------------- public API

  state(): PlayerState {
    const item = currentItem(this.q);
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

  command(cmd: PlayerCommand): Promise<PlayerState> {
    return this.serialize(async () => {
      await this.applyCommand(cmd);
      return this.state();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.positionTimer) {
      clearTimeout(this.positionTimer);
      this.positionTimer = null;
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
      await ipc.observe(id, name);
    }
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
    await this.respawn(wasPaused, savedPosition);
  }

  private async respawn(wasPaused: boolean, savedPosition: number): Promise<void> {
    this.restoring = true;
    try {
      await sleep(200);
      if (this.closed) return;
      await this.spawnMpv();
      this.respawnAttempts = 0;
      await this.setMpvVolume(this.volume);
      if (this.q.index >= 0) {
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
        await this.respawn(wasPaused, savedPosition);
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
        this.emitChange();
        break;
      }
      case 'audio-out-params': {
        this.props.audioOutParams = (msg.data as MpvParams | undefined) ?? undefined;
        this.emitChange();
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
    this.currentMpvPos = pos;
    if (queueIndex !== this.q.index) {
      this.q = queueJump(this.q, queueIndex);
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
    return Math.min(durationMs, Math.max(0, Math.round(timePosSec * 1_000 - offsetMs)));
  }

  // ------------------------------------------------------------- queue -> mpv

  /**
   * Per-file loadfile options. `startMs` is a position inside the logical track
   * (e.g. restoring after a respawn); for cue tracks it is offset by the cue start.
   * Using the start option is more reliable than an immediate seek command, which
   * mpv can ignore while the file is still being opened.
   */
  private fileOptions(track: Track, startMs = 0): string | undefined {
    const parts: string[] = [];
    if (track.cue) {
      const absoluteStart = (track.cue.startMs + Math.max(0, startMs)) / 1_000;
      parts.push(`start=${trimSeconds(absoluteStart)}`);
      parts.push(`end=${trimSeconds(track.cue.endMs / 1_000)}`);
    } else if (startMs > 0) {
      parts.push(`start=${trimSeconds(startMs / 1_000)}`);
    }
    return parts.length > 0 ? parts.join(',') : undefined;
  }

  private async appendEntry(
    item: QueueItem,
    flag: 'replace' | 'append-play',
    startMs = 0,
  ): Promise<void> {
    const ipc = this.ipc;
    if (!ipc) throw new Error('mpv is not running');
    const path = trackPath(item.track);
    if (!path) throw new Error(`track ${item.track.id} has no local file`);
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
      if (!item) {
        this.status = 'stopped';
        return;
      }
      if (!trackPath(item.track)) {
        this.status = 'stopped';
        return;
      }
      // Start position is passed as a per-file option (an immediate seek command can
      // be ignored while mpv is still opening the file).
      await this.appendEntry(item, 'replace', startPosition);
      this.currentMpvPos = 0;
      for (const upcoming of upcomingEntries(this.q, 2)) {
        await this.appendEntry(upcoming, 'append-play');
      }
      if (opts.paused) {
        this.props.pause = true;
        await ipc.command(['set_property', 'pause', true]).catch(() => undefined);
      } else {
        this.props.pause = false;
      }
      this.status = opts.paused ? 'paused' : 'playing';
    } finally {
      this.rebuilding = false;
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

  private applyCommand(cmd: PlayerCommand): Promise<void> {
    switch (cmd.type) {
      case 'play':
        return this.cmdPlay(cmd.trackIds, cmd.startIndex, cmd.positionMs, cmd.paused);
      case 'enqueue':
        return this.cmdEnqueue(cmd.trackIds, cmd.next);
      case 'pause':
        return this.cmdPause();
      case 'resume':
        return this.cmdResume();
      case 'next':
        return this.cmdNext();
      case 'prev':
        return this.cmdPrev();
      case 'seek':
        return this.cmdSeek(cmd.positionMs);
      case 'jump':
        return this.cmdJump(cmd.index);
      case 'remove':
        return this.cmdRemove(cmd.queueId);
      case 'volume':
        return this.cmdVolume(cmd.volume);
      case 'shuffle':
        return this.cmdShuffle(cmd.on);
      case 'repeat':
        return this.cmdRepeat(cmd.mode);
      default: {
        const exhaustive: never = cmd;
        throw new Error(`unknown player command ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private async cmdPlay(trackIds: string[], startIndex?: number, positionMs = 0, paused = false): Promise<void> {
    const items = this.playable(loadQueueItems(this.db, trackIds));
    if (items.length === 0) return;
    this.q = queuePlay(this.q, items, startIndex ?? 0);
    await this.startPlayback({ positionMs: Math.max(0, Math.round(positionMs)), paused });
  }

  private async cmdEnqueue(trackIds: string[], isNext?: boolean): Promise<void> {
    const items = this.playable(loadQueueItems(this.db, trackIds));
    if (items.length === 0) return;
    const wasEmpty = this.q.items.length === 0;
    this.q = queueEnqueue(this.q, items, { next: isNext });
    if (wasEmpty) {
      await this.startPlayback({ positionMs: 0 });
    } else if (this.status === 'playing' || this.status === 'paused') {
      await this.syncWindow();
      this.emitChange();
    } else {
      this.emitChange();
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
      this.props.pause = false;
      this.status = 'playing';
      await this.ipc?.command(['set_property', 'pause', false]).catch(() => undefined);
      this.emitChange();
      return;
    }
    if (this.status === 'stopped' && this.q.index >= 0) {
      const item = currentItem(this.q);
      const atEnd = item ? this.positionMs >= item.track.durationMs - 100 : true;
      await this.startPlayback({ positionMs: atEnd ? 0 : this.positionMs });
    }
  }

  private async cmdNext(): Promise<void> {
    const wasPaused = this.status === 'paused';
    const wasActive =
      this.status === 'playing' || this.status === 'paused' || this.status === 'loading';
    const result = queueNext(this.q, { auto: false });
    if (result.ended) {
      if (wasActive) await this.stopPlayback();
      this.emitChange();
      return;
    }
    this.q = result.state;
    if (wasActive) {
      await this.startPlayback({ positionMs: 0, paused: wasPaused });
    } else {
      this.positionMs = 0;
      this.emitChange();
    }
  }

  private async cmdPrev(): Promise<void> {
    const wasPaused = this.status === 'paused';
    const wasActive =
      this.status === 'playing' || this.status === 'paused' || this.status === 'loading';
    const result = queuePrev(this.q, this.positionMs);
    this.q = result.state;
    if (result.restart) {
      this.positionMs = 0;
      if (wasActive) {
        await this.seekTo(0);
        this.emitChange();
      } else {
        this.emitChange();
      }
      return;
    }
    if (wasActive) {
      await this.startPlayback({ positionMs: 0, paused: wasPaused });
    } else {
      this.positionMs = 0;
      this.emitChange();
    }
  }

  private async cmdSeek(positionMs: number): Promise<void> {
    const item = currentItem(this.q);
    const duration = item?.track.durationMs ?? 0;
    const pos = Math.min(duration, Math.max(0, Math.round(positionMs)));
    this.positionMs = pos;
    if (this.status === 'playing' || this.status === 'paused' || this.status === 'loading') {
      await this.seekTo(pos);
    }
    this.emitChange();
  }

  private async cmdJump(index: number): Promise<void> {
    if (!Number.isInteger(index) || index < 0 || index >= this.q.items.length) return;
    const wasPaused = this.status === 'paused';
    const wasActive =
      this.status === 'playing' || this.status === 'paused' || this.status === 'loading';
    this.q = queueJump(this.q, index);
    if (wasActive) {
      await this.startPlayback({ positionMs: 0, paused: wasPaused });
    } else {
      this.positionMs = 0;
      this.emitChange();
    }
  }

  private async cmdRemove(queueId: string): Promise<void> {
    const previousCurrent = currentItem(this.q)?.queueId;
    this.q = queueRemove(this.q, queueId);
    const currentAfter = currentItem(this.q)?.queueId;
    const wasPaused = this.status === 'paused';
    const wasActive =
      this.status === 'playing' || this.status === 'paused' || this.status === 'loading';

    if (this.q.items.length === 0) {
      await this.stopPlayback();
      this.emitChange();
      return;
    }
    if (currentAfter !== previousCurrent) {
      // The playing entry was removed.
      if (wasActive) {
        await this.startPlayback({ positionMs: 0, paused: wasPaused });
      } else {
        this.positionMs = 0;
        this.emitChange();
      }
      return;
    }
    if (wasActive) {
      await this.syncWindow();
      this.emitChange();
    } else {
      this.emitChange();
    }
  }

  private async cmdVolume(volume: number): Promise<void> {
    const v = Math.round(Math.min(100, Math.max(0, volume)));
    this.volume = v;
    await this.setMpvVolume(v);
    this.emitChange();
  }

  private async cmdShuffle(on: boolean): Promise<void> {
    this.q = queueSetShuffle(this.q, on);
    if (this.status === 'playing' || this.status === 'paused') {
      await this.syncWindow();
    }
    this.emitChange();
  }

  private async cmdRepeat(mode: PlayerState['repeat']): Promise<void> {
    this.q = queueSetRepeat(this.q, mode);
    if (this.status === 'playing' || this.status === 'paused') {
      await this.syncWindow();
    }
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
    if (out && typeof out.samplerate === 'number') {
      parts.push(`${this.deviceLabel()} ${rateLabel(out.samplerate)}`);
    }
    const active = this.status === 'playing' || this.status === 'paused' || this.status === 'loading';
    if (active && out && input) {
      if (
        typeof input.samplerate === 'number' &&
        typeof out.samplerate === 'number' &&
        input.samplerate !== out.samplerate
      ) {
        parts.push(`resampled to ${rateLabel(out.samplerate)}`);
      } else if (input.format && out.format && input.format !== out.format) {
        parts.push(`converted to ${out.format}`);
      } else if (this.volume !== 100) {
        parts.push(`volume ${this.volume}%`);
      } else {
        parts.push('bit-perfect');
      }
    }
    return parts;
  }

  private deviceLabel(): string {
    const device = this.cfg.audioDevice;
    if (device === 'pipewire') return 'PipeWire';
    if (device === 'null') return 'null output';
    return device;
  }
}

/** Upcoming QueueItems from pure queue state (wraps / repeats per repeat mode). */
function upcomingEntries(q: QueueState, count: number): QueueItem[] {
  return queueUpcoming(q, count).map((entry) => entry.item);
}

function trimSeconds(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
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
