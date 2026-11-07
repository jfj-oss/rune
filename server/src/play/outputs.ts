// The two outputs of the server-owned pc queue (play/driver.ts). Each one plays the run it is given and reports
// facts; neither decides what plays next.
//
// MpvOutput: a run of local songs in mpv, gapless (play/zone.ts keeps the next two preloaded).
// SpotifyAppOutput: a run of Spotify songs in this PC's Spotify app, sent as one PUT play of up to 100 URIs so the app
// moves on by itself. What the app does is read from MPRIS (local D-Bus reads, no Spotify request): a track change
// to the expected next song is the app moving on; paused near 0 with the time up is the end; paused anywhere else is
// a pause; a song rune did not start is a takeover. No MPRIS method is ever called.
import type { PlayerState, QueueItem } from '@liner/shared';
import type { MprisBus, MprisEvent, MprisProps } from '../spotify/mpris.js';
import type { SpotifyZoneApi } from '../spotify/zones.js';
import { OutputError, type Output, type OutputFact } from './driver.js';
import type { MpvRunZone } from './zone.js';

const END_SLACK_MS = 5_000;
/** How long a "paused at 0" mid-list is given to turn into the next song. */
const RECHECK_MS = 1_500;
/** How long after a stop a "Playing" for one of its songs is rune's own late start. */
const GHOST_MS = 5_000;

// ---------------------------------------------------------------- mpv

export class MpvOutput implements Output {
  readonly kind = 'mpv' as const;
  private token = 0;
  private active = false;
  private cur: string | null = null;
  private last: PlayerState['status'] = 'stopped';
  private readonly facts = new Set<(f: OutputFact) => void>();
  private readonly detailFns = new Set<() => void>();
  private lastDetails = '';

  constructor(
    private readonly zone: MpvRunZone,
    private readonly now: () => number = Date.now,
  ) {
    zone.onChange((s) => this.onState(s));
  }

  async start(run: QueueItem[], opts: { token: number; positionMs: number; volume: number }): Promise<void> {
    this.token = opts.token;
    this.active = true;
    this.cur = null;
    this.last = 'loading';
    if (Math.abs(this.zone.state().volume - opts.volume) > 0.25) await this.zone.command({ type: 'volume', volume: opts.volume });
    await this.zone.loadRun(run, { positionMs: opts.positionMs, paused: false });
  }

  update(run: QueueItem[], token: number): void {
    if (!this.active || token !== this.token) return;
    void this.zone.setUpcoming(run.slice(1)).catch(() => undefined);
  }

  async pause(): Promise<void> {
    if (this.active) await this.zone.command({ type: 'pause' });
  }

  async resume(): Promise<void> {
    if (!this.active) throw new Error('mpv holds no song');
    await this.zone.command({ type: 'resume' });
  }

  async seek(positionMs: number): Promise<void> {
    if (this.active) await this.zone.command({ type: 'seek', positionMs });
  }

  async stop(): Promise<void> {
    const wasActive = this.active;
    this.active = false;
    this.cur = null;
    const s = this.zone.state();
    if (!wasActive && s.status === 'stopped' && s.queue.length === 0) return;
    await this.zone.command({ type: 'clear' });
  }

  async setVolume(volume: number): Promise<void> {
    await this.zone.command({ type: 'volume', volume });
  }

  position(): number | null {
    if (!this.active) return null;
    const s = this.zone.state();
    return s.queue[s.index]?.queueId === this.cur ? s.positionMs : null;
  }

  onFact(fn: (f: OutputFact) => void): void {
    this.facts.add(fn);
  }

  details(): Pick<PlayerState, 'signalPath' | 'nowPlaying'> {
    const s = this.zone.state();
    return { ...(s.signalPath ? { signalPath: s.signalPath } : {}), ...(s.nowPlaying ? { nowPlaying: s.nowPlaying } : {}) };
  }

  onDetails(fn: () => void): void {
    this.detailFns.add(fn);
  }

  close(): void {
    this.facts.clear();
    this.detailFns.clear();
  }

  private fact(f: OutputFact): void {
    for (const fn of this.facts) fn(f);
  }

  private onState(s: PlayerState): void {
    if (!this.active) return;
    const at = this.now();
    const token = this.token;
    const item = s.queue[s.index];
    const qid = item?.queueId ?? null;
    if (s.status === 'loading') {
      this.last = 'loading';
      return;
    }
    if (s.status === 'stopped') {
      if (this.last !== 'stopped') {
        const dur = item?.track.durationMs ?? 0;
        const atEnd = !!item && (dur <= 0 || s.positionMs >= dur - 2_000);
        if (this.cur && atEnd) this.fact({ type: 'ended', token, queueId: this.cur, at, last: true });
        else this.fact({ type: 'failed', token, queueId: this.cur ?? qid, reason: 'output-failed', message: 'mpv could not play this song.', at });
        this.active = false;
      }
      this.last = 'stopped';
      return;
    }
    if (qid && qid !== this.cur) {
      if (this.cur) this.fact({ type: 'ended', token, queueId: this.cur, at, last: false });
      this.cur = qid;
      this.last = s.status;
      this.fact({ type: 'started', token, queueId: qid, positionMs: s.positionMs, at });
      if (s.status === 'paused') this.fact({ type: 'paused', token, queueId: qid, positionMs: s.positionMs, at });
      return;
    }
    if (qid && s.status !== this.last) {
      if (s.status === 'paused' && this.last === 'playing') this.fact({ type: 'paused', token, queueId: qid, positionMs: s.positionMs, at });
      if (s.status === 'playing' && this.last === 'paused') this.fact({ type: 'resumed', token, queueId: qid, positionMs: s.positionMs, at });
    }
    this.last = s.status;
    const details = JSON.stringify([s.signalPath, s.nowPlaying]);
    if (details !== this.lastDetails) {
      this.lastDetails = details;
      for (const fn of this.detailFns) fn();
    }
  }
}

// ---------------------------------------------------------------- Spotify app

export type SpotifyControl = Pick<SpotifyZoneApi, 'play' | 'pause' | 'seek' | 'setVolume' | 'setShuffle' | 'setRepeat'>;

export interface SpotifyAppDeps {
  bus: MprisBus;
  api: SpotifyControl;
  /** The app's Connect device id as last seen in the device list (cached; it survives app restarts). */
  deviceId(): string | null;
  /** One device-list read, for when none is cached. */
  findDevice?(): Promise<string | null>;
  /** Launch the app (pcSpotify.start); only called when its MPRIS name has no owner. */
  startApp?(): Promise<unknown>;
  now?(): number;
  log?(obj: unknown, msg: string): void;
  /** How long to wait for the app to come up (default 30 s). */
  appWaitMs?: number;
  /** How long a start may go unconfirmed by MPRIS before it failed (default 8 s). */
  confirmMs?: number;
  /** Signals come in bursts: read once they settle (default 150 ms). */
  settleMs?: number;
  /** How long before a song's end the app is told about a changed next song (default 1 s). */
  leadMs?: number;
}

/** Spotify reports a finished list as paused and rewound to about 0. */
const REWOUND_MS = 2_000;

interface SentRun {
  token: number;
  items: QueueItem[];
  /** Index in `items` of the song the app plays now. */
  cur: number;
  confirmed: boolean;
  /** The run ran out (or was handed off): the driver decides what comes next. */
  done: boolean;
}

export class SpotifyAppOutput implements Output {
  readonly kind = 'spotify' as const;
  private run: SentRun | null = null;
  /** What the driver wants from the current song on (after an edit); compared with what was sent. */
  private desired: QueueItem[] | null = null;
  private playing = false;
  /** Where the current song was when last seen playing, and when. */
  private clock: { at: number; pos: number } | null = null;
  private lastStatus: string | null = null;
  private lastTrack: string | null = null;
  private lastLength = 0;
  private volume: number | null = null;
  private readonly facts = new Set<(f: OutputFact) => void>();
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private burstAt: number | null = null;
  private reading = false;
  private again = false;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  private leadTimer: ReturnType<typeof setTimeout> | null = null;
  private ownerWaiters: (() => void)[] = [];
  /** A "paused at 0" mid-list, looked at again shortly before it counts as the end. */
  private recheck: ReturnType<typeof setTimeout> | null = null;
  private rechecked: string | null = null;
  /** A start is being prepared: what the app still shows is not a takeover. */
  private starting = false;
  /** Songs of a run just stopped: their late "Playing" is rune's own start landing, not someone else's. */
  private ghost: { ids: Set<string>; until: number } | null = null;
  private closed = false;
  private readonly now: () => number;

  constructor(private readonly deps: SpotifyAppDeps) {
    this.now = deps.now ?? Date.now;
    deps.bus.onEvent((ev) => this.onEvent(ev));
  }

  // ----- Output -----

  async start(run: QueueItem[], opts: { token: number; positionMs: number; volume: number }): Promise<void> {
    this.starting = true;
    try {
      await this.startRun(run, opts);
    } finally {
      this.starting = false;
    }
  }

  private async startRun(run: QueueItem[], opts: { token: number; positionMs: number; volume: number }): Promise<void> {
    this.clearLead();
    this.clearConfirm();
    this.clearRecheck();
    this.run = null;
    this.ghost = null;
    const props = await this.ensureApp();
    const device = this.deps.deviceId() ?? (await this.deps.findDevice?.().catch(() => null)) ?? null;
    if (!device) throw new OutputError('spotify-unavailable', 'The Spotify app on the PC is not ready as a Connect device yet.');
    // rune orders the queue itself: the app's own shuffle and repeat would reorder or loop the list.
    if (props.shuffle === true) await this.deps.api.setShuffle(false, device).catch(() => undefined);
    if (props.loop && props.loop !== 'None') await this.deps.api.setRepeat('off', device).catch(() => undefined);
    const mprisVolume = props.volume === null ? null : Math.round(props.volume * 100);
    if (mprisVolume === null || Math.abs(mprisVolume - opts.volume) > 1) {
      // Before the play, or its first moments sound at the app's old level.
      await this.deps.api.setVolume(Math.round(opts.volume), device).catch(() => undefined);
    }
    this.volume = opts.volume;
    const items = run.slice(0, 100);
    this.run = { token: opts.token, items, cur: 0, confirmed: false, done: false };
    this.desired = null;
    this.playing = false;
    this.clock = null;
    const body = { uris: items.map(uriOf), offset: { position: 0 }, ...(opts.positionMs > 0 ? { position_ms: Math.round(opts.positionMs) } : {}) };
    await this.playWithRetry(body, device);
    this.armConfirm(opts.token);
  }

  update(run: QueueItem[], token: number): void {
    if (!this.run || this.run.token !== token || this.run.done) return;
    this.desired = run;
    this.scheduleLead();
  }

  async pause(): Promise<void> {
    const device = this.deps.deviceId();
    this.clearLead();
    // A resume check still waiting must not send the song again over this pause.
    this.clearConfirm();
    if (!device) return;
    await this.deps.api.pause(device);
  }

  async resume(): Promise<void> {
    const device = this.deps.deviceId();
    const run = this.run;
    if (!device || !run || run.done) throw new Error('the Spotify app holds no song of rune');
    await this.deps.api.play({}, device);
    this.armResumeCheck(run);
  }

  /** Spotify drops a player paused for long: a resume then plays nothing. Seen so, the run is sent again from there. */
  private armResumeCheck(run: SentRun): void {
    this.clearConfirm();
    this.confirmTimer = setTimeout(() => {
      this.confirmTimer = null;
      void (async () => {
        if (this.run !== run || this.closed || this.playing) return;
        const props = await this.deps.bus.read().catch(() => null);
        if (this.run !== run || this.closed) return;
        this.observe(props, this.now());
        if (this.run !== run || this.playing) return;
        const device = this.deps.deviceId();
        if (!device) return;
        const items = run.items.slice(run.cur);
        const pos = this.clock?.pos ?? 0;
        this.deps.log?.({ trackId: items[0]?.track.id }, 'driver: the Spotify app did not resume: sending the song again');
        this.run = { token: run.token, items, cur: 0, confirmed: false, done: false };
        try {
          await this.deps.api.play({ uris: items.map(uriOf), offset: { position: 0 }, ...(pos > 0 ? { position_ms: Math.round(pos) } : {}) }, device);
          this.armConfirm(run.token);
        } catch (err) {
          this.run = null;
          this.fact({ type: 'failed', token: run.token, queueId: items[0]?.queueId ?? null, reason: (err as { status?: number }).status === 429 ? 'rate-limited' : 'output-failed', message: 'The Spotify song did not resume.', at: this.now() });
        }
      })();
    }, Math.min(this.deps.confirmMs ?? 8_000, 4_000));
    this.confirmTimer.unref?.();
  }

  async seek(positionMs: number): Promise<void> {
    const device = this.deps.deviceId();
    if (!device || !this.run) return;
    await this.deps.api.seek(Math.round(positionMs), device);
    this.clock = { at: this.now(), pos: positionMs };
    this.scheduleLead();
  }

  async stop(): Promise<void> {
    const run = this.run;
    const wasPlaying = this.playing;
    this.run = null;
    this.desired = null;
    this.clearLead();
    this.clearConfirm();
    this.clearRecheck();
    this.playing = false;
    if (run) this.ghost = { ids: new Set(run.items.map((q) => q.track.id)), until: this.now() + GHOST_MS };
    // Only an app that sounds (or may be about to, with rune's play on its way) is paused: a paused one costs nothing.
    const mayPlay = this.lastStatus === 'Playing' || (!!run && !run.done && (wasPlaying || !run.confirmed));
    if (!mayPlay) return;
    const device = this.deps.deviceId();
    if (device) await this.deps.api.pause(device);
  }

  async setVolume(volume: number): Promise<void> {
    const device = this.deps.deviceId();
    if (!device || !this.run) return;
    if (this.volume !== null && Math.abs(this.volume - volume) < 0.5) return;
    this.volume = volume;
    await this.deps.api.setVolume(Math.round(volume), device);
  }

  position(): number | null {
    if (!this.run || !this.clock) return null;
    if (!this.playing) return this.clock.pos;
    const dur = this.duration();
    const p = this.clock.pos + (this.now() - this.clock.at);
    return dur > 0 ? Math.min(dur, p) : p;
  }

  onFact(fn: (f: OutputFact) => void): void {
    this.facts.add(fn);
  }

  close(): void {
    this.closed = true;
    this.clearLead();
    this.clearConfirm();
    this.clearRecheck();
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    for (const w of this.ownerWaiters.splice(0)) w();
    this.facts.clear();
  }

  // ----- the app -----

  /** The app's MPRIS view; the app is started (and waited for) when its name has no owner. */
  private async ensureApp(): Promise<MprisProps> {
    let props = await this.deps.bus.read();
    if (props) return this.note(props);
    if (!this.deps.startApp) throw new OutputError('spotify-unavailable', 'The Spotify app is not running on the PC.');
    this.deps.log?.({}, 'driver: starting the Spotify app for a Spotify song');
    await this.deps.startApp().catch((err) => this.deps.log?.({ err }, 'driver: could not start the Spotify app'));
    const until = this.now() + (this.deps.appWaitMs ?? 30_000);
    while (!this.closed && this.now() < until) {
      await this.waitOwner(Math.min(1_000, until - this.now()));
      props = await this.deps.bus.read();
      if (props) return this.note(props);
    }
    throw new OutputError('spotify-unavailable', "The Spotify app didn't start on the PC — is it signed in?");
  }

  /** A new app is not a Connect device for a few seconds: its first play may answer 404. */
  private async playWithRetry(body: Parameters<SpotifyControl['play']>[0], device: string): Promise<void> {
    const until = this.now() + (this.deps.appWaitMs ?? 30_000);
    let wait = 1_000;
    for (;;) {
      try {
        await this.deps.api.play(body, device);
        return;
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status !== 404 || this.now() + wait > until || this.closed) throw err;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(4_000, wait * 2);
      }
    }
  }

  private waitOwner(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        const i = this.ownerWaiters.indexOf(done);
        if (i >= 0) this.ownerWaiters.splice(i, 1);
        resolve();
      };
      const t = setTimeout(done, Math.max(0, ms));
      this.ownerWaiters.push(done);
    });
  }

  private note(props: MprisProps): MprisProps {
    this.lastStatus = props.status;
    this.lastTrack = props.trackId;
    if (props.lengthMs > 0) this.lastLength = props.lengthMs;
    return props;
  }

  // ----- MPRIS facts -----

  private onEvent(ev: MprisEvent): void {
    if (this.closed) return;
    if (ev.ev === 'owner' && ev.owned) for (const w of this.ownerWaiters.splice(0)) w();
    this.burstAt ??= this.now();
    if (this.settleTimer) return;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      void this.readNow();
    }, this.deps.settleMs ?? 150);
    this.settleTimer.unref?.();
  }

  /** One read at a time; signals that came during a read get one more. */
  private async readNow(): Promise<void> {
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    try {
      do {
        this.again = false;
        const at = this.burstAt ?? this.now();
        this.burstAt = null;
        const props = await this.deps.bus.read().catch(() => null);
        if (this.closed) return;
        this.observe(props, at);
      } while (this.again);
    } finally {
      this.reading = false;
    }
  }

  private fact(f: OutputFact): void {
    for (const fn of this.facts) fn(f);
  }

  private duration(): number {
    const cur = this.run?.items[this.run.cur];
    return cur?.track.durationMs || this.lastLength;
  }

  /** The time of the song now playing is up, by the clock (a pause nobody saw looks the same, so this alone is never the end). */
  private timeUp(at: number): boolean {
    const dur = this.duration();
    if (!this.clock || !this.playing || dur <= 0) return false;
    return at >= this.clock.at + (dur - this.clock.pos) - END_SLACK_MS;
  }

  private observe(props: MprisProps | null, at: number): void {
    const now = this.now();
    const prevStatus = this.lastStatus;
    const prevTrack = this.lastTrack;
    if (!props) {
      this.lastStatus = null;
      this.lastTrack = null;
      const run = this.run;
      if (run && !run.done) {
        this.run = null;
        this.clearLead();
        this.fact({ type: 'failed', token: run.token, queueId: run.items[run.cur]?.queueId ?? null, reason: 'spotify-unavailable', message: 'The Spotify app on the PC closed.', at });
      }
      return;
    }
    this.note(props);
    const pausedAtZero = props.status !== 'Playing' && props.positionMs <= REWOUND_MS;
    if (!pausedAtZero) this.clearRecheck();
    const run = this.run;
    const started = props.status === 'Playing' && (prevStatus !== 'Playing' || props.trackId !== prevTrack);
    if (!run || run.done) {
      if (!started || !props.trackId || this.starting) return;
      const ghost = this.ghost;
      if (ghost && now < ghost.until && ghost.ids.has(props.trackId)) {
        // rune's own play landing after rune moved on: silence it again.
        const device = this.deps.deviceId();
        if (device) void this.deps.api.pause(device).catch(() => undefined);
        return;
      }
      // Not rune's: a start here is a takeover (the driver decides who wins).
      this.fact({ type: 'takeover', at, trackId: props.trackId });
      return;
    }
    const token = run.token;
    const id = props.trackId;
    let idx = -1;
    if (id) {
      for (let i = run.cur; i < run.items.length && idx < 0; i++) if (run.items[i]!.track.id === id) idx = i;
      for (let i = 0; i < run.cur && idx < 0; i++) if (run.items[i]!.track.id === id) idx = i;
    }
    const cur = run.items[run.cur]!;
    if (idx === run.cur) {
      if (props.status === 'Playing') {
        this.clock = { at: now, pos: props.positionMs };
        if (!run.confirmed) {
          run.confirmed = true;
          this.clearConfirm();
          this.playing = true;
          this.fact({ type: 'started', token, queueId: cur.queueId, positionMs: props.positionMs, at, ...(props.lengthMs > 0 ? { durationMs: props.lengthMs } : {}) });
        } else if (!this.playing) {
          this.playing = true;
          this.fact({ type: 'resumed', token, queueId: cur.queueId, positionMs: props.positionMs, at });
        }
        this.scheduleLead();
        return;
      }
      // Paused (or an odd Stopped): Spotify ends a list paused and rewound, with the song's time up.
      if (run.confirmed && this.playing && props.positionMs <= REWOUND_MS && this.timeUp(now)) {
        if (run.cur < run.items.length - 1 && this.rechecked !== cur.queueId) {
          // More of the list was sent: the app may show "paused at 0" for a moment on its way to the next song.
          // Look again shortly; still there, it stopped (the driver then sends the rest).
          if (!this.recheck) {
            this.recheck = setTimeout(() => {
              this.recheck = null;
              this.rechecked = cur.queueId;
              this.burstAt ??= at;
              void this.readNow();
            }, RECHECK_MS);
            this.recheck.unref?.();
          }
          return;
        }
        this.clearRecheck();
        this.playing = false;
        run.done = true;
        this.clearLead();
        this.fact({ type: 'ended', token, queueId: cur.queueId, at, last: true });
        return;
      }
      if (this.playing) {
        this.playing = false;
        this.clearLead();
        this.clock = { at: now, pos: props.positionMs };
        this.fact({ type: 'paused', token, queueId: cur.queueId, positionMs: props.positionMs, at });
      }
      return;
    }
    if (idx > run.cur) {
      // The app moved on by itself (or its own Next): the songs in between ended.
      for (let i = run.cur; i < idx; i++) this.fact({ type: 'ended', token, queueId: run.items[i]!.queueId, at, last: false });
      return this.moveTo(run, idx, props, at, now);
    }
    if (idx >= 0) return this.moveTo(run, idx, props, at, now);
    if (!run.confirmed) return; // the start is on its way; the app still shows what it had
    if (!id) return; // an ad, or no song for a moment
    if (run.cur === run.items.length - 1 && this.timeUp(now)) {
      // Spotify's autoplay after rune's list: rune's song ended; the driver decides what comes next.
      this.playing = false;
      run.done = true;
      this.clearLead();
      this.fact({ type: 'ended', token, queueId: cur.queueId, at, last: true });
      return;
    }
    this.run = null;
    this.desired = null;
    this.clearLead();
    this.playing = props.status === 'Playing';
    this.fact({ type: 'takeover', at, trackId: id });
  }

  private moveTo(run: SentRun, idx: number, props: MprisProps, at: number, now: number): void {
    run.cur = idx;
    run.confirmed = true;
    this.clearConfirm();
    this.playing = props.status === 'Playing';
    this.clock = { at: now, pos: props.positionMs };
    const item = run.items[idx]!;
    this.fact({ type: 'started', token: run.token, queueId: item.queueId, positionMs: props.positionMs, at, ...(props.lengthMs > 0 ? { durationMs: props.lengthMs } : {}) });
    if (!this.playing) this.fact({ type: 'paused', token: run.token, queueId: item.queueId, positionMs: props.positionMs, at });
    this.scheduleLead();
  }

  private clearRecheck(): void {
    if (this.recheck) clearTimeout(this.recheck);
    this.recheck = null;
    this.rechecked = null;
  }

  private armConfirm(token: number): void {
    this.clearConfirm();
    this.confirmTimer = setTimeout(() => {
      this.confirmTimer = null;
      void (async () => {
        const run = this.run;
        if (!run || run.token !== token || run.confirmed || this.closed) return;
        const props = await this.deps.bus.read().catch(() => null);
        this.observe(props, this.now());
        const again = this.run;
        if (again && again.token === token && !again.confirmed) {
          this.run = null;
          this.fact({ type: 'failed', token, queueId: again.items[0]?.queueId ?? null, reason: 'output-failed', message: 'The Spotify app did not start the song.', at: this.now() });
        }
      })();
    }, this.deps.confirmMs ?? 8_000);
    this.confirmTimer.unref?.();
  }

  private clearConfirm(): void {
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
  }

  // ----- an edit changed the next song: tell the app just before the end -----

  /** The driver's next song, when it is not the one the app would play next; undefined when they agree. */
  private nextChanged(): { next: QueueItem[] } | undefined {
    const run = this.run;
    const desired = this.desired;
    if (!run || !desired || run.done) return undefined;
    const cur = run.items[run.cur];
    const at = desired.findIndex((q) => q.queueId === cur?.queueId);
    if (at < 0) return undefined;
    const want = desired.slice(at + 1);
    const sent = run.items.slice(run.cur + 1);
    if (want[0]?.queueId === sent[0]?.queueId) return undefined;
    return { next: want };
  }

  private scheduleLead(): void {
    this.clearLead();
    if (!this.playing || !this.clock || !this.nextChanged()) return;
    const dur = this.duration();
    if (dur <= 0) return;
    const endAt = this.clock.at + (dur - this.clock.pos);
    const lead = this.deps.leadMs ?? 1_000;
    this.leadTimer = setTimeout(() => {
      this.leadTimer = null;
      void this.handoff();
    }, Math.max(0, endAt - lead - this.now()));
    this.leadTimer.unref?.();
  }

  private clearLead(): void {
    if (this.leadTimer) clearTimeout(this.leadTimer);
    this.leadTimer = null;
  }

  /** About 1 s before the end: send the new next songs (or hand back to the driver when none of them is Spotify's). */
  private async handoff(): Promise<void> {
    const run = this.run;
    const change = this.nextChanged();
    if (!run || !change || this.closed) return;
    const props = await this.deps.bus.read().catch(() => null);
    if (this.run !== run || !props) return;
    const cur = run.items[run.cur]!;
    if (props.trackId !== cur.track.id || props.status !== 'Playing') return;
    const lead = this.deps.leadMs ?? 1_000;
    const left = this.duration() - props.positionMs;
    this.clock = { at: this.now(), pos: props.positionMs };
    if (left > lead + 500) {
      this.scheduleLead();
      return;
    }
    const at = this.now();
    if (change.next.length === 0) {
      // The next song is not the app's: the driver plays it (and pauses the app).
      run.done = true;
      this.playing = false;
      this.fact({ type: 'ended', token: run.token, queueId: cur.queueId, at, last: true });
      return;
    }
    const device = this.deps.deviceId();
    if (!device) return;
    const items = change.next.slice(0, 100);
    this.fact({ type: 'ended', token: run.token, queueId: cur.queueId, at, last: false });
    this.run = { token: run.token, items, cur: 0, confirmed: false, done: false };
    this.desired = null;
    this.playing = false;
    this.clock = null;
    try {
      await this.deps.api.play({ uris: items.map(uriOf), offset: { position: 0 } }, device);
      this.armConfirm(run.token);
    } catch (err) {
      this.deps.log?.({ err }, 'driver: could not send the changed next songs to the Spotify app');
      this.run = null;
      this.fact({ type: 'failed', token: run.token, queueId: items[0]?.queueId ?? null, reason: (err as { status?: number }).status === 429 ? 'rate-limited' : 'output-failed', message: 'The next Spotify song did not start.', at: this.now() });
    }
  }
}

function uriOf(q: QueueItem): string {
  if (q.track.spotifyUri) return q.track.spotifyUri;
  return `spotify:track:${q.track.id.startsWith('sp:') ? q.track.id.slice(3) : q.track.id}`;
}
