import type { PlayerCommand, PlayerState, Track } from '@liner/shared';
import type { Engine } from './engine';

/** How an engine talks to one server zone (the pc's mpv, or a Spotify Connect device). */
export interface ZoneTransport {
  send(cmd: PlayerCommand): Promise<PlayerState>;
  get(): Promise<PlayerState>;
  /** Pushed state changes (websocket `player` events for this zone). */
  subscribe(fn: (s: PlayerState) => void): () => void;
  /** Is the push channel connected right now? Absent = no push channel, so poll at `pollMs`. */
  connected?(): boolean;
}

export interface ZoneEngineOptions {
  now?: () => number;
  /** Poll interval while a track is loaded and the push channel is down. */
  pollMs?: number;
  /** Safety poll interval while the push channel is up (the websocket is the fast path). */
  safetyPollMs?: number;
  /** Give up waiting for the zone to start the track after this long. */
  startTimeoutMs?: number;
  /** Paused this close to the end (after playing up to there) counts as "finished". */
  endSlackMs?: number;
}

const sameTrack = (a: Track, b: Track) => a.id === b.id || (!!a.spotifyUri && a.spotifyUri === b.spotifyUri);

/**
 * An Engine whose "speaker" is a server zone: one track at a time is loaded into the zone, and the
 * zone's state (pushed over the websocket and polled) tells us position, play/pause and — importantly —
 * when the track ended, because the server zone only ever holds that single track. The client queue
 * (LocalBackend) decides what comes next. Used twice by the pc zone's hybrid mode: once for mpv, once
 * for the Spotify app on the PC.
 */
export class ZoneEngine implements Engine {
  private track: Track | null = null;
  private gen = 0;
  private armed = false;
  /** A play is on its way to the zone: it will start even though `armed` is still false. */
  private inFlight = false;
  private userPaused = false;
  private maxPlayed = 0;
  private loadedAt = 0;
  private lastUpdated = 0;
  private snap: { pos: number; at: number; playing: boolean } | null = null;
  private off: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPollAt = 0;
  private volume = 100;
  private serverVolume: number | null = null;
  private endedFn: () => void = () => {};
  private errorFn: (m: string) => void = () => {};
  private syncFn: (pos: number, playing: boolean) => void = () => {};
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly safetyPollMs: number;
  private readonly startTimeoutMs: number;
  private readonly endSlackMs: number;

  constructor(private t: ZoneTransport, opts: ZoneEngineOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.pollMs = opts.pollMs ?? 2000;
    this.safetyPollMs = opts.safetyPollMs ?? 15_000;
    this.startTimeoutMs = opts.startTimeoutMs ?? 12_000;
    this.endSlackMs = opts.endSlackMs ?? 5000;
  }

  // ----- Engine -----

  load(track: Track, startMs: number, autoplay: boolean) {
    this.detach();
    const gen = ++this.gen;
    this.track = track;
    this.armed = false;
    this.inFlight = true;
    this.userPaused = !autoplay;
    this.maxPlayed = startMs;
    this.loadedAt = this.now();
    this.lastUpdated = 0;
    this.snap = null;
    this.attach(gen);
    void (async () => {
      try {
        // the zone may have a different volume than the slider (mpv vs the Spotify app): bring it in line
        if (this.serverVolume === null || Math.abs(this.serverVolume - this.volume) > 1) await this.t.send({ type: 'volume', volume: this.volume }).catch(() => undefined);
        if (gen !== this.gen) return; // stopped or replaced meanwhile: its pause must not land before this play
        const s = await this.t.send({ type: 'play', trackIds: [track.id], startIndex: 0, positionMs: Math.max(0, Math.round(startMs)), paused: !autoplay });
        this.onState(s, gen);
      } catch (e) {
        if (gen === this.gen) this.errorFn(e instanceof Error && e.message ? `Could not start playback — ${e.message}` : 'Could not start playback on that device');
      } finally {
        if (gen === this.gen) this.inFlight = false;
      }
    })();
  }

  play() {
    if (!this.track) return;
    this.userPaused = false;
    if (this.snap) this.snap = { pos: this.position() ?? this.snap.pos, at: this.now(), playing: true };
    this.command({ type: 'resume' });
  }

  pause() {
    if (!this.track || !this.armed) return;
    this.userPaused = true;
    const pos = this.position();
    if (pos !== null) this.snap = { pos, at: this.now(), playing: false };
    this.command({ type: 'pause' });
  }

  seek(ms: number) {
    if (!this.track) return;
    this.snap = { pos: ms, at: this.now(), playing: this.snap?.playing ?? !this.userPaused };
    this.maxPlayed = Math.max(this.maxPlayed, ms);
    this.command({ type: 'seek', positionMs: Math.round(ms) });
  }

  setVolume(v: number) {
    this.volume = v;
    // only talk to the zone while it is ours; otherwise load() applies it
    if (this.track && this.armed) {
      this.serverVolume = v;
      void this.t.send({ type: 'volume', volume: v }).catch(() => undefined);
    }
  }

  position(): number | null {
    const s = this.snap;
    if (!s) return null;
    const dur = this.track?.durationMs ?? Infinity;
    return Math.max(0, Math.min(dur, s.playing ? s.pos + (this.now() - s.at) : s.pos));
  }

  stop() {
    const was = this.track;
    // A load still on its way will start after this: without a pause mpv would come up under the next song. A track
    // that ended by itself is neither armed nor in flight, so nothing is sent.
    const sounding = this.armed || this.inFlight;
    this.detach();
    this.gen++;
    this.track = null;
    this.armed = false;
    this.inFlight = false;
    this.snap = null;
    if (was && sounding) void this.t.send({ type: 'pause' }).catch(() => undefined);
  }

  onEnded(fn: () => void) { this.endedFn = fn; }
  onError(fn: (m: string) => void) { this.errorFn = fn; }
  onSync(fn: (pos: number, playing: boolean) => void) { this.syncFn = fn; }

  // ----- internals -----

  private command(cmd: PlayerCommand) {
    const gen = this.gen;
    void this.t.send(cmd).then((s) => this.onState(s, gen)).catch(() => undefined);
  }

  private attach(gen: number) {
    this.off = this.t.subscribe((s) => this.onState(s, gen));
    // The websocket is the fast path: poll at `pollMs` only while it is disconnected, and otherwise
    // just often enough to recover from a socket that is up but silent.
    this.lastPollAt = this.now();
    this.timer = setInterval(() => {
      const connected = this.t.connected?.() ?? false;
      const now = this.now();
      if (connected && now - this.lastPollAt < this.safetyPollMs) return;
      this.lastPollAt = now;
      void this.t.get().then((s) => this.onState(s, gen)).catch(() => undefined);
    }, this.pollMs);
  }
  private detach() {
    this.off?.();
    this.off = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Feed a zone state in (websocket, poll, or a command's response). Exposed for tests. */
  onState(s: PlayerState, gen = this.gen) {
    const track = this.track;
    if (!track || gen !== this.gen) return;
    if (s.updatedAt < this.lastUpdated && this.armed) return; // older than something already applied
    const cur = s.queue[s.index];
    const match = !!cur && sameTrack(cur.track, track);
    const t = this.now();

    if (!this.armed) {
      if (match && (s.status === 'playing' || s.status === 'paused')) {
        this.armed = true;
        this.serverVolume = s.volume;
      } else {
        if (t - this.loadedAt > this.startTimeoutMs) {
          this.fail('The device did not start the track — is the Spotify app open on the PC?');
        }
        return;
      }
    }
    this.lastUpdated = s.updatedAt;
    this.serverVolume = s.volume;

    const dur = track.durationMs;
    const playing = s.status === 'playing';
    if (match && playing) this.maxPlayed = Math.max(this.maxPlayed, s.positionMs);

    const finished =
      !match ||
      s.status === 'stopped' ||
      (s.status === 'paused' && !this.userPaused && dur > 0 && this.maxPlayed >= dur - this.endSlackMs);
    if (finished) {
      this.armed = false;
      this.detach();
      this.snap = { pos: dur, at: t, playing: false };
      this.endedFn();
      return;
    }

    this.snap = { pos: s.positionMs, at: t, playing };
    this.syncFn(s.positionMs, playing);
  }

  private fail(msg: string) {
    this.detach();
    this.track = null;
    this.gen++;
    this.errorFn(msg);
  }
}
