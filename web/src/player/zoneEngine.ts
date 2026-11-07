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
  /** How near the end the song must be, by the clock, for the zone's report to count as "finished". */
  endSlackMs?: number;
}

const sameTrack = (a: Track, b: Track) => a.id === b.id || (!!a.spotifyUri && a.spotifyUri === b.spotifyUri);
/** Spotify reports a finished song as paused at about 0; a real pause keeps its position. */
const REWOUND_MS = 2000;

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
  /** Another client's song took the zone: this track waits, paused, until the user plays it again. */
  private displaced = false;
  /** Waiting like that, but the song's time ran out: Play moves on to the next song. */
  private spent = false;
  /** Pause or Play was pressed during the load: until the correction lands, what the zone says is out of date. */
  private correcting = false;
  /** The load this engine gave up on while its play was on the way: it gets a pause if it lands after all. */
  private lateGen: number | null = null;
  private startMs = 0;
  private loadedAt = 0;
  private lastUpdated = 0;
  private snap: { pos: number; at: number; playing: boolean } | null = null;
  /** How late a track's end may be noticed and still move on to the next song. */
  static readonly STALE_END_MS = 60_000;
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
    this.displaced = false;
    this.spent = false;
    this.correcting = false;
    this.userPaused = !autoplay;
    this.startMs = startMs;
    this.loadedAt = this.now();
    this.lastUpdated = 0;
    this.snap = null;
    this.attach(gen);
    void (async () => {
      try {
        // the zone may have a different volume than the slider (mpv vs the Spotify app): bring it in line
        if (this.serverVolume === null || Math.abs(this.serverVolume - this.volume) > 1) await this.t.send({ type: 'volume', volume: this.volume }).catch(() => undefined);
        if (gen !== this.gen) return; // stopped or replaced meanwhile: its pause must not land before this play
        let paused = this.userPaused;
        let s = await this.t.send({ type: 'play', trackIds: [track.id], startIndex: 0, positionMs: Math.max(0, Math.round(startMs)), paused });
        // Pause or Play pressed while the start was on its way: only now can it land after that start, not ahead of it.
        while (gen === this.gen && this.userPaused !== paused) {
          paused = this.userPaused;
          s = await this.t.send({ type: paused ? 'pause' : 'resume' });
        }
        if (gen === this.gen) {
          this.inFlight = false;
          this.correcting = false;
          this.onState(s, gen);
        } else if (gen === this.lateGen && (!this.track || this.displaced)) {
          // Given up on, and nothing new took over: the page says it did not start, so it must not sound now.
          void this.t.send({ type: 'pause' }).catch(() => undefined);
        }
      } catch (e) {
        if (gen === this.gen) this.errorFn(e instanceof Error && e.message ? `Could not start playback — ${e.message}` : 'Could not start playback on that device');
      } finally {
        if (gen === this.gen) {
          this.inFlight = false;
          this.correcting = false;
        }
      }
    })();
  }

  play() {
    if (!this.track) return;
    // the song was over when the tab noticed, and this engine stopped there: Play goes on with the queue
    if (this.spent) { this.spent = false; this.endedFn(); return; }
    // the zone holds someone else's song: a resume would only restart that
    if (this.displaced) { this.load(this.track, this.position() ?? 0, true); return; }
    const wasPaused = this.userPaused;
    this.userPaused = false;
    if (this.snap) this.snap = { pos: this.position() ?? this.snap.pos, at: this.now(), playing: true };
    if (this.inFlight) { this.correcting ||= wasPaused; return; }
    this.command({ type: 'resume' });
  }

  pause() {
    if (!this.track || (!this.armed && !this.inFlight)) return;
    const wasPaused = this.userPaused;
    this.userPaused = true;
    const pos = this.position();
    if (pos !== null) this.snap = { pos, at: this.now(), playing: false };
    if (this.inFlight) { this.correcting ||= !wasPaused; return; }
    this.command({ type: 'pause' });
  }

  seek(ms: number) {
    if (!this.track) return;
    this.snap = { pos: ms, at: this.now(), playing: this.snap?.playing ?? !this.userPaused };
    this.spent = false; // a place picked in the song: Play starts from there, not with the next song
    if (this.displaced) return; // not our song to seek in: play() starts from here
    this.command({ type: 'seek', positionMs: Math.round(ms) });
  }

  setVolume(v: number) {
    this.volume = v;
    // only talk to the zone while it is ours; otherwise load() applies it
    if (this.track && this.armed && this.serverVolume !== v) {
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
    this.displaced = false;
    this.spent = false;
    this.correcting = false;
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
    if (!track || gen !== this.gen || this.displaced || this.correcting) return;
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
          this.fail('The device did not start the track — is the Spotify app open on the PC?', s);
        }
        return;
      }
    }
    // The same snapshot delivered again (the tab's safety poll) says nothing new, so it must not restart the clock.
    const repeat = s.updatedAt === this.lastUpdated;
    this.lastUpdated = s.updatedAt;
    this.serverVolume = s.volume;

    const dur = track.durationMs;
    const playing = s.status === 'playing';
    // Where the song should be by now if nobody touched it: polls can be two minutes apart, and a seek back moves this
    // back too. It says the time is up, never that the song ended: a pause nobody polled looks just the same.
    const pos = this.position() ?? s.positionMs;
    const nearEnd = !this.userPaused && dur > 0 && pos >= dur - this.endSlackMs;
    // The zone has let go of our song. That is the song ending only if its time is up (mpv going idle reports the end
    // itself, also for a track of unknown length). Before that it was moved to the phone, Spotify dropped it, or another
    // client took over, and sending our next track would take the zone back from them.
    const letGo = !match || s.status === 'stopped';
    const reportedEnd = match && s.status === 'stopped' && (dur <= 0 || s.positionMs >= dur - this.endSlackMs);
    // Another song that began when ours ran out followed it; one that began later was someone's choice, even if ours was over by then.
    const snap = this.snap;
    const sinceEnd = snap?.playing ? t - (snap.at + Math.max(0, dur - snap.pos)) : null;
    const followed = s.status === 'stopped' || (sinceEnd !== null && Math.abs(s.positionMs - sinceEnd) <= this.endSlackMs);
    if (letGo && (s.elsewhere || !(nearEnd || reportedEnd) || (!match && !followed))) {
      this.armed = false;
      this.detach();
      this.displaced = true;
      this.spent = nearEnd;
      this.userPaused = true;
      this.snap = { pos, at: t, playing: false };
      this.syncFn(pos, false);
      return;
    }

    const finished =
      letGo ||
      // Spotify's way of ending. A pause keeps its position, so one from outside is never this, even in the last seconds.
      (s.status === 'paused' && s.positionMs <= REWOUND_MS && !!this.snap?.playing && nearEnd);
    if (finished) {
      this.armed = false;
      this.detach();
      // A tab that slept (a closed laptop, a background tab) finds out long after the song ended. It must not start
      // the next song on the PC out of nowhere minutes later, with nobody there: it stops instead.
      // The same goes for a song paused elsewhere that Spotify drops as stopped minutes later: nobody asked for the next one.
      const overdue = sinceEnd !== null ? sinceEnd > ZoneEngine.STALE_END_MS : s.status !== 'paused';
      this.snap = { pos: dur, at: t, playing: false };
      if (overdue) {
        this.displaced = true;
        this.spent = true;
        this.userPaused = true;
        this.syncFn(dur, false);
        return;
      }
      this.endedFn();
      return;
    }

    if (repeat && this.snap?.playing === playing) return;
    this.snap = { pos: s.positionMs, at: t, playing };
    this.syncFn(s.positionMs, playing);
  }

  /** Give up on a start. The track stays, paused, so that Play tries again. */
  private fail(msg: string, s: PlayerState) {
    this.detach();
    // A play still on its way can start any time now. One already answered may too, unless another song has the zone.
    if (this.inFlight) this.lateGen = this.gen;
    else if (s.status !== 'playing') void this.t.send({ type: 'pause' }).catch(() => undefined);
    this.gen++;
    this.inFlight = false;
    this.correcting = false;
    this.displaced = true;
    this.userPaused = true;
    this.snap = { pos: this.startMs, at: this.now(), playing: false };
    this.errorFn(msg);
  }
}
