// Spotify on a phone, with no Spotify app: Soloist on the PC plays the song and the phone hears it over the HLS
// stream (/api/soloist/stream/live.m3u8, server/src/soloist/audio.ts). This is the browser zone's Spotify half on a
// handheld, where the Web Playback SDK cannot run: a ZoneEngine on the soloist zone (one song and its run at a time,
// like the pc zone's mixed mode drives mpv and Soloist) plus the one <audio> element that plays the stream.
//
// The element follows the zone's state: a new HLS program (`rev` bumps on play, skip and seek) reloads it, pause and
// resume pause and resume it, and a song that is not ours (the PC took Soloist back, a Spotify app) silences it.
// iOS lets an element start only from a tap, so the first tap anywhere unlocks it (play + pause, silent), and a load
// unlocks it again inside the tap that caused it.
import type { PlayerCommand, PlayerState, Track } from '@liner/shared';
import type { ZoneInfo } from '../lib/types';
import type { Engine } from './engine';
import { SOLOIST_ZONE } from './pc';
import { soloistStreamsToPhone } from './routing';
import { ZoneEngine, type ZoneEngineOptions, type ZoneTransport } from './zoneEngine';

export { SOLOIST_ZONE };

/** The Soloist zone's live stream, played by this phone (native HLS: it keeps going on the lock screen). */
export const PHONE_STREAM_URL = '/api/soloist/stream/live.m3u8';

/** The signal path shown on the phone while a Spotify song plays this way. */
export const PHONE_SOLOIST_PATH = ['Spotify', 'Soloist on the PC', 'AAC stream to this phone'];

export interface PhoneSoloistRoute {
  /** Soloist is running, connected and signed in: Spotify songs play on this phone through it. */
  available: boolean;
  /** Why they go to the Spotify app instead, in pcRoute's words ("… — using the Spotify app"); null when Soloist is fine
   *  or not part of this rune at all (then the app route is the only one, as before, and nothing needs saying). */
  notice: string | null;
}

/**
 * Can a phone play Spotify songs "on this phone" through Soloist right now? From GET /zones: the pc zone names Soloist
 * as its Spotify engine while it can play (server soloist/pcRoute.ts), or the Soloist zone says so itself (a server
 * without a pc zone). Pure: the store and the pages ask this with the same list.
 */
export function phoneSoloistRoute(zones: ZoneInfo[]): PhoneSoloistRoute {
  const pc = zones.find((z) => z.kind === 'pc');
  const sz = zones.find((z) => z.soloist);
  const available = pc?.spotifyZone === SOLOIST_ZONE || (sz ? sz.available ?? !sz.problem : false);
  if (available) return { available: true, notice: null };
  const notice = sz?.notice ?? pc?.spotifyNotice ?? (sz?.problem ? `${sz.problem} — using the Spotify app` : null);
  return { available: false, notice };
}

/** The part of an <audio> element the stream needs (a fake in tests). */
export interface StreamElement {
  src: string;
  readonly paused: boolean;
  play(): Promise<void> | void;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, fn: () => void): void;
}

export interface PhoneSoloistDeps {
  /** The one stream element of the session (iOS unlocks an element on a tap and keeps it unlocked). */
  element(): StreamElement;
  /** POST /api/soloist/output phone: Soloist's sound goes to the stream (and leaves the PC speakers). */
  toPhone(): Promise<{ problem?: string | null }>;
  notice?(message: string): void;
  /** Delays before the player reloads after an error / a stall (the program it played ended: a skip or a seek). */
  retryMs?: { error: number; stalled: number };
  now?(): number;
  log?(message: string, data?: Record<string, unknown>): void;
}

export class PhoneSoloistEngine implements Engine {
  private readonly zone: ZoneEngine;
  private readonly t: ZoneTransport;
  private track: Track | null = null;
  private run: Track[] = [];
  private gen = 0;
  private lastRev: number | undefined;
  private last: PlayerState | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;

  constructor(transport: ZoneTransport, private readonly deps: PhoneSoloistDeps, opts: ZoneEngineOptions = {}) {
    this.now = deps.now ?? Date.now;
    this.t = transport;
    // Every state the zone engine sees, this sees too — after it, so a song the zone moved on to is ours already
    // (a command's answer reaches the zone engine in a microtask; the tap waits a turn).
    const tap = (s: PlayerState) => this.onZoneState(s);
    const tapped: ZoneTransport = {
      send: async (cmd) => { const s = await transport.send(cmd); setTimeout(() => tap(s), 0); return s; },
      get: async () => { const s = await transport.get(); setTimeout(() => tap(s), 0); return s; },
      subscribe: (fn) => transport.subscribe((s) => { fn(s); tap(s); }),
      ...(transport.connected ? { connected: () => transport.connected!() } : {}),
    };
    // Soloist keeps its own level (the PC's), and the stream carries it: the slider follows and only a move sends one.
    this.zone = new ZoneEngine(tapped, { pushVolumeOnLoad: false, ...opts });
    const el = deps.element();
    el.addEventListener('error', () => this.retry(deps.retryMs?.error ?? 400));
    el.addEventListener('stalled', () => this.retry(deps.retryMs?.stalled ?? 800));
    el.addEventListener('ended', () => this.retry(deps.retryMs?.error ?? 400));
  }

  // ----- Engine -----

  load(track: Track, startMs: number, autoplay: boolean, upcoming: Track[] = []) {
    const gen = ++this.gen;
    this.track = track;
    this.run = [track, ...upcoming];
    // `lastRev` stays: a song the zone went on to by itself keeps the program, and the element must not restart.
    this.unlock();
    const toPhone = async () => {
      try {
        const r = await this.deps.toPhone();
        if (r.problem) this.deps.notice?.(r.problem);
      } catch {
        this.deps.notice?.('Could not switch Soloist to this phone — is the server reachable?');
      }
    };
    if (this.last && soloistStreamsToPhone(this.last)) {
      // The stream is here already: the song at once (a song the zone moved on to is adopted while that is fresh).
      void toPhone();
      this.zone.load(track, startMs, autoplay, upcoming);
      return;
    }
    void (async () => {
      // The output first, so the play's new program starts the encoder at once; then the song.
      await toPhone();
      if (gen !== this.gen) return;
      this.zone.load(track, startMs, autoplay, upcoming);
    })();
  }

  play() {
    this.zone.play();
    const el = this.deps.element();
    if (el.src && el.paused) void this.playElement(el);
  }

  pause() {
    this.deps.element().pause();
    const mine = !!this.last && this.ours(this.last);
    this.zone.pause();
    if (!mine) this.hush();
  }

  seek(ms: number) { this.zone.seek(ms); }
  setVolume(v: number) { this.zone.setVolume(v); }
  position() { return this.zone.position(); }

  stop() {
    this.gen++;
    const mine = !!this.last && this.ours(this.last);
    this.track = null;
    this.run = [];
    this.lastRev = undefined;
    this.silence();
    this.zone.stop(); // pauses Soloist when our song is on it
    if (!mine) this.hush();
  }

  onEnded(fn: () => void) { this.zone.onEnded(fn); }
  onError(fn: (m: string) => void) { this.zone.onError(fn); }
  onSync(fn: (pos: number, playing: boolean) => void) { this.zone.onSync(fn); }
  onVolume(fn: (volume: number) => void) { this.zone.onVolume(fn); }

  // ----- the stream element -----

  /** Inside a tap: a silent play + pause unlocks the element for the plays that come after the server answers. */
  private unlock() {
    const el = this.deps.element();
    if (el.src) return; // already sounding (or unlocked and loaded): nothing to do
    try {
      const p = el.play();
      el.pause();
      void (p as Promise<void> | undefined)?.catch?.(() => undefined);
    } catch { /* not inside a gesture: the first tap anywhere unlocked it (store/player.ts) */ }
  }

  private playElement(el: StreamElement): Promise<void> | void {
    try {
      const p = el.play();
      return (p as Promise<void> | undefined)?.catch?.((err: unknown) => this.deps.log?.('phone stream: play refused', { err: String(err) }));
    } catch (err) {
      this.deps.log?.('phone stream: play refused', { err: String(err) });
      return undefined;
    }
  }

  /** Join the current program (a new one after a play, skip or seek; the same one again after a stall). */
  private reload() {
    const el = this.deps.element();
    el.src = `${PHONE_STREAM_URL}?t=${this.now()}`;
    el.load();
    void this.playElement(el);
  }

  private retry(ms: number) {
    if (!this.track) return;
    const s = this.last;
    if (!s || !(s.status === 'playing' || s.status === 'loading') || !this.ours(s)) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; if (this.track) this.reload(); }, ms);
  }

  private silence() {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    const el = this.deps.element();
    if (!el.src) return;
    el.pause();
    el.removeAttribute('src');
    el.load();
  }

  /**
   * Soloist went on by itself after our last song (Spotify's autoplay) and the stream still comes here: a stop or pause
   * of this zone must silence that too. Not when the PC took Soloist back (its sound is on the speakers then).
   */
  private hush() {
    const s = this.last;
    if (!s || !soloistStreamsToPhone(s) || !(s.status === 'playing' || s.status === 'loading')) return;
    const cmd: PlayerCommand = { type: 'pause' };
    void this.t.send(cmd).catch(() => undefined);
  }

  /** Is the zone's current song ours (the loaded one, or one of the run it plays on to)? */
  private ours(s: PlayerState): boolean {
    const cur = s.queue[s.index];
    if (!cur) return false;
    const same = (a: Track, b: Track) => a.id === b.id || (!!a.spotifyUri && a.spotifyUri === b.spotifyUri);
    return (!!this.track && same(cur.track, this.track)) || this.run.some((x) => same(x, cur.track));
  }

  private onZoneState(s: PlayerState) {
    this.last = s;
    if (!this.track) return;
    const el = this.deps.element();
    if (!this.ours(s) || s.status === 'stopped') {
      // Not our song (nothing yet, the PC took Soloist back, a Spotify app) or nothing at all: not ours to hear.
      this.silence();
      return;
    }
    if (s.rev !== undefined && s.rev !== this.lastRev) {
      this.lastRev = s.rev;
      // A new program (our play, a skip, a seek): join it. A paused one is joined when it plays.
      if (s.status === 'playing' || s.status === 'loading') { this.reload(); return; }
      this.silence();
      return;
    }
    if (s.status === 'paused') { if (!el.paused) el.pause(); return; }
    if (s.status === 'playing' && el.paused) {
      if (el.src) void this.playElement(el);
      else this.reload();
    }
  }
}
