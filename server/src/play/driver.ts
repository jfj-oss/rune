// Phase 3 of the server-queue plan: the pc zone's queue lives here, on the server, behind config
// spotify.serverQueue (off by default). This driver is the only code that decides what plays next. It sends a run of
// songs to one output at a time: local songs to mpv (gapless within the run), Spotify songs to this PC's Spotify app
// as one PUT play of up to 100 URIs, so the app moves on by itself. Outputs report facts only (started, ended, paused,
// resumed, failed, taken over) and the driver keeps the queue, the cursor (by queueId) and a revision number.
//
// What it never does: start sound at boot (a restored queue waits, paused), or skip a Spotify song to a local one
// while Spotify's rate limit is up (it pauses with a reason instead).
import type { PlayerCommand, PlayerHold, PlayerState, QueueItem, Track } from '@liner/shared';
import type { PlaybackZone } from '../modules.js';
import type { Db } from '../db/index.js';
import { playThreshold, type RecordedPlay } from '../history/plays.js';
import * as Q from './queue.js';
import { isRadioTrack, parseSavedSession, SESSION_KEY, type SavedSession } from './zone.js';

export type OutputKind = 'mpv' | 'spotify';

/** What an output saw happen. `token` names the run it belongs to: facts about an older run are ignored. */
export type OutputFact =
  | { type: 'started'; token: number; queueId: string; positionMs: number; at: number; durationMs?: number }
  /** The song played to its end (or to about 1 s before it, when the driver's next song took over). `last`: the
   *  output has nothing after it, so the driver must decide what comes next. */
  | { type: 'ended'; token: number; queueId: string; at: number; last: boolean }
  | { type: 'paused'; token: number; queueId: string; positionMs: number; at: number }
  | { type: 'resumed'; token: number; queueId: string; positionMs: number; at: number }
  | { type: 'failed'; token: number; queueId: string | null; reason: PlayerHold['reason']; message: string; at: number }
  /** Something rune did not start began to play in this output. `at` is when its signal arrived. */
  | { type: 'takeover'; at: number; trackId: string | null };

export interface Output {
  readonly kind: OutputKind;
  /** Play `run` from its first song at `positionMs`. Resolves once the output accepted it (the start is a fact). */
  start(run: QueueItem[], opts: { token: number; positionMs: number; volume: number }): Promise<void>;
  /** The run from the song now playing on changed (a queue edit): current song first. */
  update(run: QueueItem[], token: number): void;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  /** Silence it and forget the run (nothing is sent when it is already silent). */
  stop(): Promise<void>;
  setVolume(volume: number): Promise<void>;
  /** Live position of the song it plays, when it knows one. */
  position(): number | null;
  onFact(fn: (fact: OutputFact) => void): void;
  /** Extra details for the page (mpv's signal path, a radio stream's title). */
  details?(): Pick<PlayerState, 'signalPath' | 'nowPlaying'>;
  onDetails?(fn: () => void): void;
  close(): void;
}

/** A start an output refused, with the reason the page shows. */
export class OutputError extends Error {
  constructor(
    readonly reason: PlayerHold['reason'],
    message: string,
    readonly until?: number,
  ) {
    super(message);
    this.name = 'OutputError';
  }
}

/** The Spotify app's own Connect zone: shown (and commanded) while another player has taken over. */
export interface MirrorZone {
  state(): PlayerState;
  command(cmd: PlayerCommand): Promise<PlayerState>;
}

export interface DriverStore {
  read(key: string): string | undefined;
  write(key: string, value: string): void;
}

export interface DriverDeps {
  /** Queue items for ids, in order; unknown Spotify ids come back as placeholders, unknown local ids are dropped. */
  load(ids: string[]): QueueItem[];
  outputs: { mpv: Output; spotify?: Output };
  store?: DriverStore;
  /** Spotify's rate limit: while this is in the future no Spotify song is started. */
  rateLimitedUntil?(): number | null;
  mirror?(): MirrorZone | undefined;
  /** Fill in placeholders (titles, covers) in the background; optional. */
  describe?(items: QueueItem[]): Promise<QueueItem[]>;
  now?(): number;
  log?(obj: unknown, msg: string): void;
  onPlay?(play: RecordedPlay): void;
}

/** Where the server-owned queue is saved. The old player.pc.session row is read once and left as it was. */
export const QUEUE_KEY = 'player.queue.pc';
const SAVE_DEBOUNCE_MS = 1_000;
const POSITION_SAVE_MS = 5_000;
/** A lower level that stands this long was the user's; a voice duck lasts at most 15 s. */
export const DUCK_MS = 20_000;
/** Spotify takes at most 100 URIs per play; mpv only preloads two, but a long run keeps transitions gapless. */
const SPOTIFY_RUN = 100;
const MPV_RUN = 500;
/** A song this near its end, by the clock, was heard to the end. */
const END_SLACK_MS = 5_000;

export const kindOf = (track: Track): OutputKind => (track.source === 'spotify' ? 'spotify' : 'mpv');

interface ActivePlay {
  queueId: string;
  trackId: string;
  albumId: string;
  durationMs: number;
  startedAt: number;
  heardMs: number;
  since: number | null;
}

export class QueueDriver implements PlaybackZone {
  readonly zone = 'pc';
  private q: Q.QueueState = Q.createQueue();
  private rev = 0;
  private status: PlayerState['status'] = 'stopped';
  private pos = 0;
  private posAt: number;
  /** Applied now (a voice duck included); `level` is the user's own choice, saved and carried to the next output. */
  private volume = 100;
  private level = 100;
  private lowSince: number | null = null;
  /** The output that holds the current song, and the run it was sent. */
  private output: OutputKind | null = null;
  private token = 0;
  private hold: PlayerHold | null = null;
  /** Another player took the speakers: the queue waits and the page shows that player. */
  private parked = false;
  private lastStartAt = Number.NEGATIVE_INFINITY;
  /** Pause was pressed while the start was on its way: the start, once it lands, is paused. */
  private pauseOnStart = false;
  private active: ActivePlay | null = null;
  private readonly listeners = new Set<(s: PlayerState) => void>();
  private readonly endedListeners = new Set<(s: PlayerState) => void>();
  private ops: Promise<unknown> = Promise.resolve();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveDueAt = 0;
  private savedKey = '';
  private closed = false;
  private readonly now: () => number;

  constructor(private readonly deps: DriverDeps) {
    this.now = deps.now ?? Date.now;
    this.posAt = this.now();
    for (const out of [deps.outputs.mpv, deps.outputs.spotify]) {
      if (!out) continue;
      out.onFact((f) => this.onFact(out.kind, f));
      out.onDetails?.(() => {
        if (this.output === out.kind) this.emit(false);
      });
    }
    this.restore();
  }

  // ---------------------------------------------------------------- public

  state(): PlayerState {
    const at = this.now();
    if (this.parked) {
      const m = this.deps.mirror?.();
      if (m) {
        const s = m.state();
        return { ...s, zone: 'pc', rev: this.rev, output: 'spotify', ...(this.hold ? { hold: this.hold } : {}), updatedAt: s.updatedAt };
      }
    }
    const details = this.output ? this.deps.outputs[this.output]?.details?.() : undefined;
    return {
      zone: 'pc',
      status: this.status,
      queue: [...this.q.items],
      index: this.q.index,
      positionMs: Math.max(0, Math.round(this.livePosition(at))),
      volume: this.volume,
      shuffle: this.q.shuffle,
      repeat: this.q.repeat,
      ...(details?.signalPath ? { signalPath: details.signalPath } : {}),
      ...(details?.nowPlaying ? { nowPlaying: details.nowPlaying } : {}),
      rev: this.rev,
      output: this.output,
      ...(this.hold ? { hold: this.hold } : {}),
      updatedAt: at,
    };
  }

  onChange(cb: (s: PlayerState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** The queue ran out by itself (not a Stop or a Clear): auto-radio hangs off this. */
  onQueueEnded(cb: (s: PlayerState) => void): () => void {
    this.endedListeners.add(cb);
    return () => this.endedListeners.delete(cb);
  }

  /** Does rune drive the Spotify app now? Then its plays are counted here, not from the app's Connect zone. */
  ownsSpotifyApp(): boolean {
    return this.output === 'spotify' && !this.parked;
  }

  /** The mirrored app changed: a parked page follows it. */
  mirrorChanged(): void {
    if (this.parked) this.emit(false);
  }

  command(cmd: PlayerCommand): Promise<PlayerState> {
    return this.serialize(async () => {
      await this.apply(cmd);
      return this.state();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closeActive(false);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.persist();
    this.closed = true;
    this.listeners.clear();
    this.endedListeners.clear();
  }

  // ---------------------------------------------------------------- commands

  private async apply(cmd: PlayerCommand): Promise<void> {
    if (this.parked && cmd.type !== 'play') return this.mirrorCommand(cmd);
    switch (cmd.type) {
      case 'play': {
        const items = this.deps.load(cmd.trackIds);
        if (items.length === 0) return;
        this.unpark();
        this.closeActive(false);
        this.q = Q.play(this.q, items, cmd.startIndex ?? 0);
        this.bump();
        this.describe(items);
        await this.startCurrent(Math.max(0, Math.round(cmd.positionMs ?? 0)), cmd.paused === true);
        return;
      }
      case 'enqueue': {
        const items = this.deps.load(cmd.trackIds);
        if (items.length === 0) return;
        const wasEmpty = this.q.items.length === 0 || this.q.index < 0;
        this.q = Q.enqueue(this.q, items, { next: cmd.next });
        this.bump();
        this.describe(items);
        if (wasEmpty) await this.startCurrent(0, false);
        else this.edited();
        return;
      }
      case 'pause':
        return this.pause();
      case 'resume':
        return this.resume();
      case 'next': {
        const r = Q.next(this.q, { auto: false });
        if (r.ended) {
          if (this.status !== 'stopped') {
            this.closeActive(false);
            await this.silence();
            this.setStatus('stopped', 0);
          }
          this.emit(true);
          return;
        }
        return this.moveTo(r.state);
      }
      case 'prev': {
        const r = Q.prev(this.q, this.livePosition(this.now()));
        if (r.restart) return this.seek(0);
        return this.moveTo(r.state);
      }
      case 'seek':
        return this.seek(cmd.positionMs);
      case 'jump': {
        if (!Number.isInteger(cmd.index) || cmd.index < 0 || cmd.index >= this.q.items.length) return;
        if (cmd.index === this.q.index && this.status !== 'stopped') return this.seek(0);
        return this.moveTo(Q.jump(this.q, cmd.index));
      }
      case 'remove': {
        const before = Q.currentItem(this.q)?.queueId;
        this.q = Q.remove(this.q, cmd.queueId);
        this.bump();
        if (this.q.items.length === 0) {
          this.closeActive(false);
          await this.silence();
          this.setStatus('stopped', 0);
          this.emit(true);
          return;
        }
        if (Q.currentItem(this.q)?.queueId !== before) {
          this.closeActive(false);
          if (this.status === 'stopped') {
            this.pos = 0;
            this.emit(true);
          } else await this.startCurrent(0, this.status === 'paused');
          return;
        }
        this.edited();
        return;
      }
      case 'move': {
        const before = this.q;
        this.q = Q.move(this.q, cmd.queueId, cmd.toIndex);
        if (this.q === before) return;
        this.bump();
        this.edited();
        return;
      }
      case 'clear':
        this.closeActive(false);
        this.q = Q.clear(this.q);
        this.bump();
        await this.silence();
        this.hold = null;
        this.setStatus('stopped', 0);
        this.emit(true);
        return;
      case 'volume':
        return this.setVolume(cmd.volume);
      case 'shuffle':
        this.q = Q.setShuffle(this.q, cmd.on);
        this.bump();
        this.edited();
        return;
      case 'repeat':
        this.q = Q.setRepeat(this.q, cmd.mode);
        this.bump();
        this.edited();
        return;
      default: {
        const never: never = cmd;
        throw new Error(`unknown player command ${JSON.stringify(never)}`);
      }
    }
  }

  /** While parked the page shows the app, so every command but Play is the app's. */
  private async mirrorCommand(cmd: PlayerCommand): Promise<void> {
    const m = this.deps.mirror?.();
    if (cmd.type === 'enqueue') {
      throw new Error("The Spotify app is playing something else: play a song to bring rune's queue back");
    }
    if (cmd.type === 'volume') {
      this.noteVolume(cmd.volume);
      this.volume = cmd.volume;
    }
    if (!m) {
      // The app is gone: nothing to mirror, the queue is rune's again.
      this.unpark();
      return this.apply(cmd);
    }
    await m.command(cmd);
    this.emit(false);
  }

  private async pause(): Promise<void> {
    if (this.status !== 'playing' && this.status !== 'loading') return;
    const at = this.now();
    const pos = this.livePosition(at);
    const out = this.current();
    if (this.status === 'loading') this.pauseOnStart = true;
    this.setStatus('paused', pos);
    this.accrue(false);
    if (out) await out.pause().catch((err) => this.deps.log?.({ err }, 'driver: pause failed'));
    this.emit(true);
  }

  private async resume(): Promise<void> {
    if (this.status === 'playing' || this.status === 'loading') return;
    if (Q.currentItem(this.q) === undefined) return;
    if (this.status === 'stopped') {
      const dur = Q.currentItem(this.q)?.track.durationMs ?? 0;
      return this.startRun(dur > 0 && this.pos >= dur - 100 ? 0 : this.pos);
    }
    const out = this.current();
    if (out) {
      const pos = this.livePosition(this.now());
      try {
        this.lastStartAt = this.now();
        await out.resume();
        this.setStatus('playing', out.position() ?? pos);
        this.accrue(true);
        this.emit(true);
        return;
      } catch (err) {
        // A long-paused Spotify player may be gone: start the song again where it was.
        this.deps.log?.({ err }, 'driver: resume failed, starting the song again');
        return this.startRun(pos);
      }
    }
    return this.startRun(this.pos);
  }

  private async seek(positionMs: number): Promise<void> {
    const item = Q.currentItem(this.q);
    if (!item || isRadioTrack(item.track)) return;
    const dur = item.track.durationMs;
    const pos = Math.max(0, Math.round(dur > 0 ? Math.min(dur, positionMs) : positionMs));
    this.pos = pos;
    this.posAt = this.now();
    const out = this.current();
    if (out) await out.seek(pos).catch((err) => this.deps.log?.({ err }, 'driver: seek failed'));
    this.emit(true);
  }

  /** Next / Prev / Jump: the cursor moves; a playing or paused zone starts (or holds) the new song. */
  private async moveTo(state: Q.QueueState): Promise<void> {
    this.closeActive(false);
    this.q = state;
    this.bump();
    if (this.status === 'stopped') {
      this.pos = 0;
      this.posAt = this.now();
      this.emit(true);
      return;
    }
    await this.startCurrent(0, this.status === 'paused');
  }

  private async setVolume(volume: number): Promise<void> {
    const v = Math.round(Math.min(100, Math.max(0, volume)) * 2) / 2;
    this.noteVolume(v);
    this.volume = v;
    const out = this.current();
    if (out) await out.setVolume(v).catch((err) => this.deps.log?.({ err }, 'driver: volume failed'));
    this.emit(true);
  }

  /** A raise is the user's at once; a lower level only once it stood longer than a voice duck. */
  private noteVolume(v: number): void {
    if (v >= this.level) {
      this.level = v;
      this.lowSince = null;
    } else this.lowSince ??= this.now();
  }

  /** The level the user chose, without a duck that is passing by. */
  userVolume(): number {
    if (this.lowSince !== null && this.now() - this.lowSince >= DUCK_MS) {
      this.level = this.volume;
      this.lowSince = null;
    }
    return this.level;
  }

  // ---------------------------------------------------------------- running songs

  private current(): Output | undefined {
    return this.output ? this.deps.outputs[this.output] : undefined;
  }

  /** Make the current song the one that plays (or, paused, the one that waits: nothing is sent then). */
  private async startCurrent(positionMs: number, paused: boolean): Promise<void> {
    const item = Q.currentItem(this.q);
    if (!item) {
      await this.silence();
      this.setStatus('stopped', 0);
      this.emit(true);
      return;
    }
    if (paused) {
      // A paused start sends nothing: Spotify would sound for a moment before a pause lands (X1). Play starts it.
      await this.silence();
      this.hold = null;
      this.setStatus('paused', positionMs);
      this.openActive(item);
      this.emit(true);
      return;
    }
    await this.startRun(positionMs);
  }

  /** Send the run that starts at the current song to its output. */
  private async startRun(positionMs: number): Promise<void> {
    const item = Q.currentItem(this.q);
    if (!item) return;
    const kind = kindOf(item.track);
    const out = this.deps.outputs[kind];
    const token = ++this.token;
    const fail = (hold: PlayerHold) => {
      this.output = null;
      this.hold = hold;
      this.setStatus('paused', positionMs);
      this.emit(true);
    };
    if (!out) {
      await this.silence();
      return fail({ reason: 'spotify-unavailable', message: 'Spotify is not connected: this song cannot play on the PC.' });
    }
    if (kind === 'spotify') {
      const until = this.deps.rateLimitedUntil?.() ?? null;
      if (until !== null && until > this.now()) {
        // The user's decision: a Spotify song waits for the limit, it is not skipped for a local one.
        await this.silence();
        return fail({ reason: 'rate-limited', message: "Spotify's limit is used up: this song plays once it lifts.", until });
      }
    }
    // Only one player sounds: the other one stops first.
    const other = kind === 'mpv' ? this.deps.outputs.spotify : this.deps.outputs.mpv;
    if (this.output && this.output !== kind) await this.deps.outputs[this.output]?.stop().catch(() => undefined);
    else await other?.stop().catch(() => undefined);
    const run = this.runFrom(kind);
    this.output = kind;
    this.hold = null;
    this.lastStartAt = this.now();
    this.openActive(item);
    this.pauseOnStart = false;
    this.setStatus('loading', positionMs);
    this.emit(true);
    try {
      await out.start(run, { token, positionMs, volume: this.volume });
    } catch (err) {
      if (token !== this.token) return;
      this.deps.log?.({ err, trackId: item.track.id }, 'driver: output refused the song');
      const e = err as { status?: number; reason?: PlayerHold['reason']; until?: number; message?: string };
      if (e.status === 429) {
        const until = this.deps.rateLimitedUntil?.() ?? undefined;
        return fail({ reason: 'rate-limited', message: "Spotify's limit is used up: this song plays once it lifts.", ...(until ? { until } : {}) });
      }
      if (err instanceof OutputError) return fail({ reason: err.reason, message: err.message, ...(err.until ? { until: err.until } : {}) });
      return fail({ reason: 'output-failed', message: `The song did not start${e.message ? `: ${e.message}` : ''}` });
    }
  }

  /** The current song plus the songs after it that the same output plays, in playback order. */
  private runFrom(kind: OutputKind): QueueItem[] {
    const cur = Q.currentItem(this.q);
    if (!cur) return [];
    const out = [cur];
    if (this.q.repeat === 'one' || isRadioTrack(cur.track)) return out;
    const seen = new Set([cur.queueId]);
    const cap = kind === 'spotify' ? SPOTIFY_RUN : MPV_RUN;
    for (const e of Q.upcoming(this.q, cap)) {
      if (out.length >= cap || kindOf(e.item.track) !== kind || seen.has(e.item.queueId)) break;
      out.push(e.item);
      seen.add(e.item.queueId);
      if (isRadioTrack(e.item.track)) break;
    }
    return out;
  }

  /** A queue edit: the output that holds the run learns its new tail (the Spotify app is told just before the end). */
  private edited(): void {
    const out = this.current();
    if (out && this.status !== 'stopped') out.update(this.runFrom(out.kind), this.token);
    this.emit(true);
  }

  private async silence(): Promise<void> {
    this.token++;
    this.output = null;
    await Promise.all([this.deps.outputs.mpv.stop(), this.deps.outputs.spotify?.stop()].map((p) => p?.catch(() => undefined)));
  }

  // ---------------------------------------------------------------- facts

  private onFact(kind: OutputKind, f: OutputFact): void {
    if (this.closed) return;
    if (f.type === 'takeover') return this.onTakeover(kind, f);
    if (f.token !== this.token || this.output !== kind || this.parked) return;
    const at = this.now();
    switch (f.type) {
      case 'started': {
        const i = Q.indexOfQueueId(this.q, f.queueId);
        if (i < 0) return;
        if (i !== this.q.index) {
          // The output moved on by itself (gapless run, or the app's own next/previous).
          this.closeActive(false);
          this.q = Q.jump(this.q, i);
          this.bump();
        }
        const item = this.q.items[i]!;
        if (f.durationMs && f.durationMs > 0 && item.track.durationMs <= 0) {
          const patched = { ...item, track: { ...item.track, durationMs: f.durationMs } };
          this.q = { ...this.q, items: this.q.items.map((q, k) => (k === i ? patched : q)) };
        }
        this.hold = null;
        this.openActive(this.q.items[i]!);
        // A pause pressed while the start was on its way stays: the output is told now.
        if (this.pauseOnStart) {
          this.pauseOnStart = false;
          if (this.status === 'paused') {
            void this.current()?.pause().catch(() => undefined);
            this.emit(true);
            return;
          }
        }
        this.setStatus('playing', f.positionMs);
        this.accrue(true);
        this.emit(true);
        return;
      }
      case 'ended': {
        if (this.active?.queueId === f.queueId) this.closeActive(true);
        if (f.queueId !== Q.currentItem(this.q)?.queueId || !f.last) return;
        void this.serialize(() => this.advance());
        return;
      }
      case 'paused': {
        if (f.queueId !== Q.currentItem(this.q)?.queueId) return;
        if (this.status === 'playing' || this.status === 'loading') {
          // Paused in the app (or by a media key): a pause, never the end of the song.
          this.setStatus('paused', f.positionMs);
          this.accrue(false);
          this.emit(true);
        }
        return;
      }
      case 'resumed': {
        if (f.queueId !== Q.currentItem(this.q)?.queueId) return;
        if (this.status !== 'playing') {
          this.setStatus('playing', f.positionMs);
          this.accrue(true);
          this.emit(true);
        }
        return;
      }
      case 'failed': {
        this.closeActive(false);
        this.output = null;
        this.token++;
        this.hold = { reason: f.reason, message: f.message };
        this.setStatus('paused', this.livePosition(at));
        this.emit(true);
        return;
      }
    }
  }

  /** The output's run ran out: the next song plays, from whichever output it needs. */
  private async advance(): Promise<void> {
    const r = Q.next(this.q, { auto: true });
    if (r.ended) {
      await this.silence();
      this.setStatus('stopped', 0);
      this.emit(true);
      const s = this.state();
      for (const fn of this.endedListeners) {
        try {
          fn(s);
        } catch {
          /* a listener must not break playback */
        }
      }
      return;
    }
    this.q = r.state;
    this.bump();
    await this.startRun(0);
  }

  /** The last start wins, by when its signal arrived: rune's own start, or the one it did not make. */
  private onTakeover(kind: OutputKind, f: Extract<OutputFact, { type: 'takeover' }>): void {
    if (this.parked) {
      this.emit(false);
      return;
    }
    if (f.at < this.lastStartAt) {
      // rune started after it: whatever began before rune's start is the one that stops.
      if (this.output !== kind) void this.deps.outputs[kind]?.stop().catch(() => undefined);
      return;
    }
    this.deps.log?.({ trackId: f.trackId, output: kind }, 'driver: another player took over the PC speakers: queue parked');
    void this.serialize(async () => {
      if (this.parked) return;
      const pos = this.livePosition(this.now());
      this.closeActive(false);
      const mine = this.current();
      this.token++;
      this.output = null;
      // mpv still sounding under the new song must stop; the app that took over keeps playing.
      if (mine && mine.kind !== kind) await mine.pause().catch(() => undefined);
      this.parked = true;
      this.hold = { reason: 'takeover', message: 'Another player took over the PC speakers: rune\'s queue waits until you play from rune again.' };
      if (this.status !== 'stopped') this.setStatus('paused', pos);
      this.emit(true);
    });
  }

  private unpark(): void {
    if (!this.parked) return;
    this.parked = false;
    this.hold = null;
  }

  // ---------------------------------------------------------------- history

  private openActive(item: QueueItem): void {
    if (this.active?.queueId === item.queueId) return;
    this.closeActive(false);
    const at = this.now();
    this.active = {
      queueId: item.queueId,
      trackId: item.track.id,
      albumId: item.track.albumId,
      durationMs: item.track.durationMs,
      startedAt: at,
      heardMs: 0,
      since: null,
    };
  }

  private accrue(playing: boolean): void {
    const a = this.active;
    if (!a) return;
    const at = this.now();
    if (a.since !== null) a.heardMs += Math.max(0, at - a.since);
    a.since = playing ? at : null;
  }

  /** One history row per play, written when it ends (`completed`: it played to its end). */
  private closeActive(completed: boolean): void {
    const a = this.active;
    if (!a) return;
    this.accrue(false);
    this.active = null;
    const item = this.q.items.find((q) => q.queueId === a.queueId);
    const dur = item?.track.durationMs || a.durationMs;
    let played = Math.round(a.heardMs);
    if (dur > 0) {
      // Heard to the end within a few seconds (a handoff cuts the last one): the whole song.
      if (completed && played >= dur - END_SLACK_MS) played = dur;
      played = Math.min(dur, played);
    }
    if (played < playThreshold(dur)) return;
    if (!this.deps.onPlay) return;
    try {
      this.deps.onPlay({ trackId: a.trackId, albumId: a.albumId, zone: 'pc', startedAt: a.startedAt, playedMs: played, completed });
    } catch (err) {
      this.deps.log?.({ err }, 'driver: could not record a play');
    }
  }

  // ---------------------------------------------------------------- state helpers

  private livePosition(at: number): number {
    const out = this.status === 'playing' ? this.current()?.position() : null;
    if (out !== null && out !== undefined) return out;
    const base = this.pos + (this.status === 'playing' ? Math.max(0, at - this.posAt) : 0);
    const dur = Q.currentItem(this.q)?.track.durationMs ?? 0;
    return dur > 0 ? Math.min(dur, base) : base;
  }

  private setStatus(status: PlayerState['status'], positionMs: number): void {
    this.status = status;
    this.pos = Math.max(0, positionMs);
    this.posAt = this.now();
  }

  private bump(): void {
    this.rev++;
  }

  private emit(changed: boolean): void {
    if (this.closed) return;
    this.scheduleSave(changed);
    const s = this.state();
    for (const fn of this.listeners) {
      try {
        fn(s);
      } catch {
        /* a bad listener must not break playback */
      }
    }
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.ops.then(fn, fn);
    this.ops = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Placeholders (Spotify songs rune never stored) get their titles in the background. */
  private describe(items: QueueItem[]): void {
    const unknown = items.filter((i) => !i.track.title);
    if (!unknown.length || !this.deps.describe) return;
    void this.deps
      .describe(unknown)
      .then((found) => {
        const byQueueId = new Map(found.map((q) => [q.queueId, q]));
        let changed = false;
        const patch = (q: QueueItem) => {
          const f = byQueueId.get(q.queueId);
          if (!f || !f.track.title) return q;
          changed = true;
          return { ...q, track: { ...f.track, durationMs: f.track.durationMs || q.track.durationMs }, album: f.album };
        };
        this.q = { ...this.q, items: this.q.items.map(patch) };
        if (changed) this.emit(false);
      })
      .catch(() => undefined);
  }

  // ---------------------------------------------------------------- persistence

  private saved(): SavedSession {
    return {
      v: 1,
      queue: this.q.items.map((i) => ({ queueId: i.queueId, trackId: i.track.id })),
      index: this.q.index,
      positionMs: Math.max(0, Math.round(this.livePosition(this.now()))),
      shuffle: this.q.shuffle,
      repeat: this.q.repeat,
      order: [...this.q.order],
      volume: this.userVolume(),
    };
  }

  private saveKey(): string {
    const s = this.saved();
    return JSON.stringify([s.queue, s.index, s.shuffle, s.repeat, s.order, s.volume, this.status]);
  }

  private scheduleSave(changed: boolean): void {
    if (this.closed || !this.deps.store) return;
    const delay = changed && this.saveKey() !== this.savedKey ? SAVE_DEBOUNCE_MS : POSITION_SAVE_MS;
    const due = this.now() + delay;
    if (this.saveTimer && this.saveDueAt <= due) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveDueAt = due;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persist();
    }, delay);
    this.saveTimer.unref?.();
  }

  private persist(): void {
    const store = this.deps.store;
    if (!store || this.closed) return;
    try {
      store.write(QUEUE_KEY, JSON.stringify(this.saved()));
      this.savedKey = this.saveKey();
    } catch (err) {
      this.deps.log?.({ err }, 'driver: could not save the queue');
    }
  }

  /** The saved queue comes back paused: nothing sounds at boot. The old mpv session is read once if there is no new row. */
  private restore(): void {
    const store = this.deps.store;
    if (!store) return;
    let raw: string | undefined;
    let migrated = false;
    try {
      raw = store.read(QUEUE_KEY);
      if (raw === undefined) {
        raw = store.read(SESSION_KEY);
        migrated = raw !== undefined;
      }
    } catch (err) {
      this.deps.log?.({ err }, 'driver: could not read the saved queue');
      return;
    }
    if (raw === undefined) return;
    let session: SavedSession | undefined;
    try {
      session = parseSavedSession(JSON.parse(raw));
    } catch {
      session = undefined;
    }
    if (!session) {
      this.deps.log?.({}, 'driver: ignoring an unreadable saved queue');
      return;
    }
    const restored = restoreQueue(session, this.deps.load(session.queue.map((e) => e.trackId)));
    this.q = restored.q;
    this.volume = this.level = Math.min(100, Math.max(0, session.volume));
    this.setStatus(this.q.index >= 0 ? 'paused' : 'stopped', restored.positionMs);
    if (migrated) {
      this.deps.log?.({ entries: this.q.items.length }, 'driver: queue moved from player.pc.session to player.queue.pc (old row kept)');
      this.persist();
    } else this.savedKey = this.saveKey();
  }
}

/**
 * Line saved entries up with the items that still exist (load drops vanished local songs and keeps the order), so
 * queue ids, the current song and a shuffled order survive.
 */
export function restoreQueue(session: SavedSession, items: QueueItem[]): { q: Q.QueueState; positionMs: number } {
  const kept: number[] = [];
  let cursor = 0;
  for (let i = 0; i < session.queue.length && cursor < items.length; i++) {
    if (items[cursor]!.track.id === session.queue[i]!.trackId) {
      kept.push(i);
      cursor += 1;
    }
  }
  if (kept.length !== items.length) return { q: Q.createQueue(), positionMs: 0 };
  const oldToNew = new Map<number, number>();
  kept.forEach((oldPos, newPos) => oldToNew.set(oldPos, newPos));
  const queue = items.map((item, newPos) => ({ ...item, queueId: session.queue[kept[newPos]!]!.queueId }));
  let index = -1;
  let positionMs = 0;
  if (queue.length > 0) {
    const exact = oldToNew.get(session.index);
    if (exact !== undefined) {
      index = exact;
      positionMs = session.positionMs;
    } else {
      const after = kept.find((oldPos) => oldPos >= session.index);
      index = oldToNew.get(after ?? kept.at(-1)!) ?? -1;
    }
  }
  const cur = index >= 0 ? queue[index] : undefined;
  if (cur && cur.track.durationMs > 0) {
    positionMs = Math.min(cur.track.durationMs, Math.max(0, positionMs));
    if (positionMs >= cur.track.durationMs - 100) positionMs = 0;
  } else if (!cur) positionMs = 0;
  let order: number[];
  if (!session.shuffle) order = queue.map((_, i) => i);
  else {
    order = [];
    const seen = new Set<number>();
    for (const oldPos of session.order) {
      const n = oldToNew.get(oldPos);
      if (n !== undefined && !seen.has(n)) {
        seen.add(n);
        order.push(n);
      }
    }
    for (let i = 0; i < queue.length; i++) if (!seen.has(i)) order.push(i);
  }
  return { q: { items: queue, index, shuffle: session.shuffle, repeat: session.repeat, order }, positionMs };
}

/** app_state rows (the same key/value table the settings use). */
export function appStateStore(db: Db): DriverStore {
  db.exec('CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const get = db.prepare('SELECT value FROM app_state WHERE key = ?');
  const put = db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  return {
    read: (key) => (get.get(key) as { value: string } | undefined)?.value,
    write: (key, value) => {
      put.run(key, value);
    },
  };
}

/** A Spotify song rune never stored: its id, until a lookup (or the app's MPRIS) describes it. */
export function placeholderItem(id: string, queueId: string): QueueItem {
  const raw = id.startsWith('sp:') ? id.slice(3) : id;
  return {
    queueId,
    track: { id, albumId: 'sp:unknown', source: 'spotify', title: '', artists: [], disc: 1, number: 1, durationMs: 0, spotifyUri: `spotify:track:${raw}` },
    album: { id: 'sp:unknown', title: '' },
  };
}
