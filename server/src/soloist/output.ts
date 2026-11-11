// The server-owned pc queue's Spotify output through Soloist (play/driver.ts picks an output per song; this one plays
// the Spotify runs when Soloist can), and the switch that puts Soloist before the Spotify desktop app.
//
// SoloistRunOutput drives the SoloistZone the way MpvOutput drives mpv's run zone: it hands the zone the run, reports what
// the zone's states say happened (started, ended, paused, resumed, failed) under the driver's own queue ids, and never
// decides what plays next. Everything goes over Soloist's local WebSocket: no app launch, no device polling, not one
// Web API request.
import type { PlayerState, QueueItem } from '@liner/shared';
import { OutputError, type Output, type OutputFact } from '../play/driver.js';
import type { SoloistZone } from './zone.js';
import type { PcSpotifyEngine } from './pcRoute.js';

export interface SoloistRunOutputDeps {
  zone: SoloistZone;
  /** Put Soloist's sound on the PC speakers (a phone that was listening loses the stream: one device, one place). */
  ensureOutput(): Promise<void>;
  /** Does Soloist's sound go to the phone stream right now? Names the phone when it takes the run over. */
  streamsToPhone?(): boolean;
  now?(): number;
  log?(obj: unknown, msg: string): void;
}

export class SoloistRunOutput implements Output {
  readonly kind = 'spotify' as const;
  private token = 0;
  private active = false;
  private run: QueueItem[] = [];
  /** The driver's queue id of the song the zone holds now. */
  private cur: string | null = null;
  private last: PlayerState['status'] = 'stopped';
  /** The play is on its way: the zone's states until it lands still describe what it held before. */
  private starting = false;
  private readonly facts = new Set<(f: OutputFact) => void>();
  private readonly detailFns = new Set<() => void>();
  private lastDetails = '';
  private readonly now: () => number;

  constructor(private readonly deps: SoloistRunOutputDeps) {
    this.now = deps.now ?? Date.now;
    deps.zone.onChange((s) => this.onState(s));
  }

  async start(run: QueueItem[], opts: { token: number; positionMs: number; volume: number }): Promise<void> {
    this.token = opts.token;
    this.active = true;
    this.starting = true;
    this.run = run;
    this.cur = null;
    this.last = 'loading';
    try {
      await this.deps.ensureOutput().catch((err) => this.deps.log?.({ err }, 'soloist output: could not switch the sound to the PC speakers'));
      const zone = this.deps.zone;
      if (Math.abs(zone.state().volume - opts.volume) > 0.25) await zone.command({ type: 'volume', volume: opts.volume }).catch(() => undefined);
      try {
        await zone.command({ type: 'play', trackIds: run.map((q) => q.track.id), startIndex: 0, positionMs: opts.positionMs });
      } catch (err) {
        this.active = false;
        throw new OutputError('spotify-unavailable', err instanceof Error ? err.message : 'Soloist did not start the song.');
      }
    } finally {
      this.starting = false;
    }
    // The zone answered with the song playing (or paused): report it now, in case its state came while the play was in flight.
    if (this.active) this.onState(this.deps.zone.state());
  }

  update(run: QueueItem[], token: number): void {
    if (!this.active || token !== this.token) return;
    this.run = run;
    void this.deps.zone.setUpcoming(run.slice(1)).catch(() => undefined);
  }

  async pause(): Promise<void> {
    if (this.active) await this.deps.zone.command({ type: 'pause' });
  }

  async resume(): Promise<void> {
    if (!this.active) throw new Error('Soloist holds no song');
    await this.deps.zone.command({ type: 'resume' });
  }

  async seek(positionMs: number): Promise<void> {
    if (this.active) await this.deps.zone.command({ type: 'seek', positionMs });
  }

  async stop(): Promise<void> {
    const wasActive = this.active;
    this.active = false;
    this.cur = null;
    this.run = [];
    const s = this.deps.zone.state();
    if (!wasActive && s.status === 'stopped' && s.queue.length === 0) return;
    await this.deps.zone.command({ type: 'clear' });
  }

  async setVolume(volume: number): Promise<void> {
    await this.deps.zone.command({ type: 'volume', volume });
  }

  position(): number | null {
    if (!this.active || !this.cur) return null;
    const s = this.deps.zone.state();
    return this.queueIdOf(s.queue[s.index]) === this.cur ? s.positionMs : null;
  }

  onFact(fn: (f: OutputFact) => void): void {
    this.facts.add(fn);
  }

  details(): Pick<PlayerState, 'signalPath' | 'nowPlaying'> {
    const s = this.deps.zone.state();
    return s.signalPath ? { signalPath: s.signalPath } : {};
  }

  onDetails(fn: () => void): void {
    this.detailFns.add(fn);
  }

  close(): void {
    this.facts.clear();
    this.detailFns.clear();
  }

  /** The zone keeps queue ids of its own: the driver hears about its songs under the ids it sent. */
  private queueIdOf(item: QueueItem | undefined): string | null {
    if (!item) return null;
    const hit = this.run.find((q) => q.track.id === item.track.id || (!!q.track.spotifyUri && q.track.spotifyUri === item.track.spotifyUri));
    return hit?.queueId ?? null;
  }

  private fact(f: OutputFact): void {
    for (const fn of this.facts) fn(f);
  }

  private onState(s: PlayerState): void {
    if (!this.active) return;
    const at = this.now();
    const token = this.token;
    const qid = this.queueIdOf(s.queue[s.index]);
    if (s.status === 'loading') {
      this.last = 'loading';
      return;
    }
    if (s.status === 'stopped') {
      if (this.starting) return; // what the zone held before our play: not a word about our song
      if (this.last !== 'stopped') {
        // Soloist went idle under a song that was sounding: the song ended (the zone's own position stops at its last
        // anchor, so the clock is no help). Stopped before anything sounded: the start failed.
        if (this.cur && this.last !== 'loading') this.fact({ type: 'ended', token, queueId: this.cur, at, last: true });
        else this.fact({ type: 'failed', token, queueId: this.cur ?? qid, reason: 'output-failed', message: 'Soloist could not play this song.', at });
        this.active = false;
      }
      this.last = 'stopped';
      return;
    }
    if (!qid) {
      // The zone follows a song rune never queued (soloist/zone.ts adopts it). Autoplay after the run's last song: that
      // song ended, and the driver decides what comes next (its next run stops Soloist; a queue that is over leaves it
      // cleared, so the server-owned queue never sounds anything it did not choose). A song a Spotify app started in
      // the middle of ours: a takeover, and the driver parks the queue.
      if (this.starting) return;
      const adopted = this.deps.zone.adopted();
      const cur = this.cur;
      if (!adopted) {
        // Not adopted, not ours: another rune client (the phone, hearing Soloist over the stream) gave Soloist its own
        // songs. There is one Soloist, and the newest request has it: this run is over, and the page says where it went.
        const theirs = s.queue[s.index];
        if (!cur || !theirs) return; // (a stopped zone was handled above)
        this.active = false;
        this.cur = null;
        this.last = 'stopped';
        const phone = this.deps.streamsToPhone?.() ?? false;
        this.fact({
          type: 'takeover',
          at,
          trackId: theirs.track.id,
          message: phone
            ? 'Spotify moved to the phone: it plays there through Soloist now. Press Play here to bring it back to the PC speakers.'
            : 'Another rune player took Soloist over: rune\'s queue waits until you play from here again.',
        });
        return;
      }
      this.active = false;
      this.cur = null;
      this.last = 'stopped';
      if (adopted.reason === 'autoplay' && cur) this.fact({ type: 'ended', token, queueId: cur, at, last: true });
      else this.fact({ type: 'takeover', at, trackId: `sp:${adopted.id}` });
      return;
    }
    if (qid !== this.cur) {
      if (this.cur) this.fact({ type: 'ended', token, queueId: this.cur, at, last: false });
      this.cur = qid;
      this.last = s.status;
      this.fact({ type: 'started', token, queueId: qid, positionMs: s.positionMs, at });
      if (s.status === 'paused') this.fact({ type: 'paused', token, queueId: qid, positionMs: s.positionMs, at });
      return;
    }
    if (s.status !== this.last) {
      if (s.status === 'paused' && this.last === 'playing') this.fact({ type: 'paused', token, queueId: qid, positionMs: s.positionMs, at });
      if (s.status === 'playing' && this.last === 'paused') this.fact({ type: 'resumed', token, queueId: qid, positionMs: s.positionMs, at });
    }
    this.last = s.status;
    const details = JSON.stringify(s.signalPath ?? null);
    if (details !== this.lastDetails) {
      this.lastDetails = details;
      for (const fn of this.detailFns) fn();
    }
  }
}

// ---------------------------------------------------------------- Soloist first, the app second

export interface PcSpotifyOutputDeps {
  soloist?: { output: Output; available(): boolean; notice(): string | null };
  /** The Spotify desktop app on this PC (play/outputs.ts SpotifyAppOutput); absent when Spotify is not connected. */
  app?: Output;
  log?(obj: unknown, msg: string): void;
}

/**
 * The driver's one Spotify output: each run goes to Soloist when it can play, else to the Spotify app with the reason
 * logged (the page shows that reason from GET /zones). Neither available: the song waits with the reason.
 */
export class PcSpotifyOutput implements Output {
  readonly kind = 'spotify' as const;
  private active: Output | null = null;
  private lastNotice: string | null = null;
  private readonly facts = new Set<(f: OutputFact) => void>();
  private readonly detailFns = new Set<() => void>();

  constructor(private readonly deps: PcSpotifyOutputDeps) {
    for (const out of [deps.soloist?.output, deps.app]) {
      if (!out) continue;
      out.onFact((f) => {
        if (out === this.active || f.type === 'takeover') for (const fn of this.facts) fn(f);
      });
      out.onDetails?.(() => {
        if (out === this.active) for (const fn of this.detailFns) fn();
      });
    }
  }

  /** Which player holds the current Spotify run. */
  engine(): PcSpotifyEngine | null {
    if (!this.active) return null;
    return this.active === this.deps.soloist?.output ? 'soloist' : 'app';
  }

  async start(run: QueueItem[], opts: { token: number; positionMs: number; volume: number }): Promise<void> {
    const soloist = this.deps.soloist;
    const useSoloist = !!soloist && soloist.available();
    const pick = useSoloist ? soloist!.output : this.deps.app;
    const notice = useSoloist ? null : soloist?.notice() ?? null;
    if (!pick) {
      const why = notice?.replace(/ — using the Spotify app$/, '');
      throw new OutputError('spotify-unavailable', why ? `${why}, and Spotify is not connected: this song cannot play on the PC.` : 'Spotify is not connected: this song cannot play on the PC.');
    }
    if (notice && notice !== this.lastNotice) this.deps.log?.({ notice }, 'pc queue: Spotify songs go to the Spotify app');
    this.lastNotice = notice;
    const other = pick === this.deps.app ? soloist?.output : this.deps.app;
    if (this.active && this.active !== pick) await this.active.stop().catch(() => undefined);
    else await other?.stop().catch(() => undefined);
    this.active = pick;
    await pick.start(run, opts);
  }

  update(run: QueueItem[], token: number): void {
    this.active?.update(run, token);
  }

  async pause(): Promise<void> {
    await this.active?.pause();
  }

  async resume(): Promise<void> {
    if (!this.active) throw new Error('no Spotify player holds a song of rune');
    await this.active.resume();
  }

  async seek(positionMs: number): Promise<void> {
    await this.active?.seek(positionMs);
  }

  async stop(): Promise<void> {
    this.active = null;
    await Promise.all([this.deps.soloist?.output.stop(), this.deps.app?.stop()].map((p) => p?.catch(() => undefined)));
  }

  async setVolume(volume: number): Promise<void> {
    await this.active?.setVolume(volume);
  }

  position(): number | null {
    return this.active?.position() ?? null;
  }

  onFact(fn: (f: OutputFact) => void): void {
    this.facts.add(fn);
  }

  details(): Pick<PlayerState, 'signalPath' | 'nowPlaying'> {
    return this.active?.details?.() ?? {};
  }

  onDetails(fn: () => void): void {
    this.detailFns.add(fn);
  }

  close(): void {
    this.deps.soloist?.output.close();
    this.deps.app?.close();
    this.facts.clear();
    this.detailFns.clear();
  }
}
