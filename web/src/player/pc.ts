import type { PlayerState } from '@liner/shared';
import type { ExtCommand, PlayItem } from '../lib/types';
import { HybridEngine } from './hybrid';
import { LocalBackend } from './local';
import { matchBackendModes, PLAIN_MODES } from './modes';
import { soloistStreamsToPhone } from './routing';
import { emptyState, livePosition, type Backend, type PlayModes } from './types';
import { ZoneEngine, type ZoneTransport } from './zoneEngine';

/** The player on the PC that takes the pc zone's Spotify songs: Soloist (zone 'soloist') or the Spotify app's Connect zone. */
export interface PcDevice {
  /** Server zone id: 'soloist', or 'spotify:<device id>' for the Spotify app on the PC. */
  zone: string;
  name: string;
}

export const SOLOIST_ZONE = 'soloist';

/** What PcBackend needs from the outside world (swapped for fakes in tests). */
export interface PcDeps {
  remote(zone: string): Backend;
  transport(zone: string): ZoneTransport;
  /** Soloist's sound goes to the PC speakers (a phone that was listening loses the stream: one device, one place). */
  soloistToPc?(): Promise<unknown>;
  notice?(msg: string): void;
  now?(): number;
}

/**
 * How long a lower volume from outside must stand before it counts as the user's. The voice assistant ducks a zone for
 * up to 15 s with a plain volume command and restores that zone only, so a level copied meanwhile would stick for good.
 */
const DUCK_MS = 20_000;

/**
 * pc queue mode:
 * - `pc`      only local files: the server's own mpv queue (gapless, keeps going with no tab open)
 * - `spotify` only Spotify tracks: Soloist's rune-kept queue, or the Spotify app's own queue on the PC (tab-independent)
 * - `mixed`   both in one queue: the queue lives in this tab and each track is loaded into mpv or the
 *             Spotify player one at a time, switching on track change (needs a rune tab open)
 */
export type PcMode = 'pc' | 'spotify' | 'mixed';

const sources = (items: PlayItem[]) => ({
  local: items.some((i) => i.track.source !== 'spotify'),
  spotify: items.some((i) => i.track.source === 'spotify'),
});
export const modeFor = (items: PlayItem[]): PcMode => {
  const s = sources(items);
  return s.local && s.spotify ? 'mixed' : s.spotify ? 'spotify' : 'pc';
};

/** Is this queue a mix of local and Spotify tracks? */
export function isMixedQueue(queue: PlayerState['queue']): boolean {
  return queue.some((q) => q.track.source === 'spotify') && queue.some((q) => q.track.source !== 'spotify');
}

/** The "Linux PC speakers" zone: mpv, plus (through Soloist, or the Spotify app on the PC) Spotify tracks in the same queue. */
export class PcBackend implements Backend {
  readonly zone = 'pc';
  private pc: Backend;
  private sp: Backend | null = null;
  private mixed: LocalBackend | null = null;
  private device: PcDevice | null = null;
  private mode: PcMode = 'pc';
  private subs = new Set<(s: PlayerState) => void>();
  private offs: (() => void)[] = [];
  private cache: { src: PlayerState; out: PlayerState } | null = null;
  /** The level the user chose (null until a zone reported one) and since when the zone has sat below it. */
  private level: number | null = null;
  private lowSince: number | null = null;
  /** Soloist's sound goes to the phone stream (by its last state), not to these speakers. */
  private onPhone = false;

  constructor(private deps: PcDeps, device?: PcDevice | null) {
    this.pc = deps.remote('pc');
    if (this.pc.ready !== false) this.level = this.pc.state.volume;
    this.offs.push(this.pc.subscribe((s) => this.onChild('pc', s)));
    this.setDevice(device ?? null);
  }

  get currentMode(): PcMode { return this.mode; }
  get hasSpotify(): boolean { return !!this.device; }
  /** Soloist plays this zone's Spotify songs (no app, no Web API). */
  get usesSoloist(): boolean { return this.device?.zone === SOLOIST_ZONE; }

  /** The PC's Spotify player appeared / went away / changed (Soloist came up, the app quit, …). */
  setDevice(device: PcDevice | null) {
    if (device?.zone === this.device?.zone) { this.device = device; return; }
    if (this.mode !== 'pc') this.switchTo('pc');
    this.sp?.dispose();
    this.sp = null;
    if (this.mixed && this.mode !== 'mixed') { this.mixed.dispose(); this.mixed = null; }
    this.device = device;
    if (device) {
      const sp = this.deps.remote(device.zone);
      this.sp = sp;
      this.offs.push(sp.subscribe((s) => this.onChild('spotify', s)));
    }
  }

  get state(): PlayerState {
    const src = this.child(this.mode)?.state ?? emptyState('pc');
    if (this.cache?.src === src) return this.cache.out;
    const out = src.zone === 'pc' ? src : { ...src, zone: 'pc' };
    this.cache = { src, out };
    return out;
  }

  subscribe(fn: (s: PlayerState) => void) {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }

  async refresh() {
    await this.pc.refresh();
    if (this.sp) await this.sp.refresh().catch(() => undefined);
    if (this.mode === 'mixed') return;
    // pick up what is already playing (started from the Spotify app, another rune tab, ...)
    const pcOn = this.pc.state.queue.length > 0 && this.pc.state.status !== 'stopped';
    const spOn = !!this.sp && this.sp.state.status !== 'stopped';
    const spPlaying = this.sp?.state.status === 'playing' && this.pc.state.status !== 'playing';
    const pcPlaying = this.pc.state.status === 'playing' && this.sp?.state.status !== 'playing';
    // Whatever sounds wins; otherwise stay put: a paused Spotify song must not lose to mpv's old queue, or a handoff
    // would move the wrong song.
    const stay = this.mode === 'pc' ? pcOn : spOn;
    const want: PcMode = spPlaying ? 'spotify' : pcPlaying ? 'pc' : stay ? this.mode : pcOn ? 'pc' : spOn ? 'spotify' : this.mode;
    if (want !== this.mode) this.follow(want);
    this.emit();
  }

  dispose() {
    for (const off of this.offs) off();
    this.offs = [];
    this.pc.dispose();
    this.sp?.dispose();
    this.mixed?.dispose();
    this.subs.clear();
  }

  /** The level to carry over to another player: a duck on this one must not travel with it. */
  userVolume(): number {
    const v = this.state.volume;
    if (this.level === null) return v;
    if (this.lowSince !== null && (this.deps.now ?? Date.now)() - this.lowSince >= DUCK_MS) {
      this.lowSince = null;
      if (v > 0) this.level = v;
    }
    return this.level;
  }

  private noteVolume(v: number) {
    if (v <= 0) return; // not a level anyone chose: a Spotify zone that has not reported yet
    if (this.level === null || v >= this.level) {
      this.level = v;
      this.lowSince = null;
    } else this.lowSince ??= (this.deps.now ?? Date.now)();
  }

  async send(cmd: ExtCommand, items: PlayItem[] = []): Promise<void> {
    if (cmd.type === 'play') return this.start(cmd, items);
    if (cmd.type === 'enqueue') return this.enqueue(cmd, items);
    if (cmd.type === 'volume') {
      this.level = cmd.volume;
      this.lowSince = null;
    }
    const c = this.child(this.mode);
    if (!c) return;
    // Play pressed for a Spotify song on the PC speakers: the sound must be there (a phone may have taken the stream).
    if (cmd.type === 'resume' && this.state.queue[this.state.index]?.track.source === 'spotify') await this.soloistToPc();
    return c.send(cmd, items);
  }

  /** Before a Spotify song sounds through Soloist for this zone: its output is the PC speakers. Failing is not fatal. */
  private async soloistToPc(): Promise<void> {
    if (!this.usesSoloist || !this.deps.soloistToPc) return;
    await this.deps.soloistToPc().catch(() => undefined);
  }

  /**
   * Make what sounds match rune's repeat/shuffle. The Spotify app is a player of its own: when it holds the queue it
   * must follow rune's setting ("off" included), and when rune drives it a song at a time (a mixed queue) it must
   * neither repeat nor reorder what it is sent.
   */
  async matchModes(want: PlayModes): Promise<void> {
    if (this.mode === 'mixed') {
      if (this.sp) await matchBackendModes(this.sp, PLAIN_MODES);
      if (this.mixed) await matchBackendModes(this.mixed, want);
      return;
    }
    const c = this.child(this.mode);
    if (c) await matchBackendModes(c, want);
  }

  // ----- starting / queueing -----

  private async start(cmd: Extract<ExtCommand, { type: 'play' }>, items: PlayItem[]) {
    const target = modeFor(items);
    if (target !== 'pc' && !this.device) throw new Error('rune starts Spotify on the PC for this');
    const want: PlayModes = { shuffle: this.state.shuffle, repeat: this.state.repeat };
    const volume = this.userVolume();
    const moved = target !== this.mode;
    if (target !== 'pc') await this.soloistToPc();
    await this.switchTo(target);
    const c = this.ensure(target)!;
    // A mixed queue sends one song at a time: clear the app's own repeat/shuffle before its first song starts.
    if (target === 'mixed' && this.sp) await matchBackendModes(this.sp, PLAIN_MODES);
    await c.send(cmd, items);
    await this.matchModes(want);
    if (moved && target !== 'mixed' && c.state.volume !== volume && volume > 0) await c.send({ type: 'volume', volume }).catch(() => undefined);
  }

  private async enqueue(cmd: Extract<ExtCommand, { type: 'enqueue' }>, items: PlayItem[]) {
    if (!items.length) return;
    const need = modeFor(items);
    if (need !== 'pc' && !this.device) throw new Error('rune starts Spotify on the PC for this');
    if (need !== 'pc') await this.soloistToPc();
    const s = this.state;
    const live = (s.status === 'playing' || s.status === 'paused' || s.status === 'loading') && s.index >= 0 && s.queue.length > 0;
    if (!live) {
      // nothing playing: queueing is just starting
      return this.start({ type: 'play', trackIds: items.map((i) => i.track.id), startIndex: 0 }, items);
    }
    if (this.mode === 'mixed' || this.mode === need) {
      await this.child(this.mode)!.send(cmd, items);
      return;
    }
    // the queue turns mixed: move what is playing into the tab-driven hybrid queue, then add
    const queue: PlayItem[] = s.queue.map((q) => ({ track: q.track, album: q.album }));
    const modes: PlayModes = { shuffle: s.shuffle, repeat: s.repeat };
    const volume = this.userVolume();
    await this.switchTo('mixed');
    const m = this.ensure('mixed')!;
    // rune drives a mixed queue one song at a time: the app must not repeat (or shuffle) what it is sent.
    if (this.sp) await matchBackendModes(this.sp, PLAIN_MODES);
    await m.send({ type: 'play', trackIds: [], startIndex: s.index, positionMs: livePosition(s), paused: s.status === 'paused' }, queue);
    // The mixed queue is rune's own: carry the setting it had, "off" included.
    await this.matchModes(modes);
    if (volume > 0) await m.send({ type: 'volume', volume });
    await m.send(cmd, items);
    this.deps.notice?.('Mixed queue — keep a rune tab open so it can switch between local and Spotify tracks');
  }

  // ----- modes -----

  private child(mode: PcMode): Backend | null {
    return mode === 'pc' ? this.pc : mode === 'spotify' ? this.sp : this.mixed;
  }

  private ensure(mode: PcMode): Backend | null {
    if (mode === 'mixed' && !this.mixed) {
      const sp = this.device?.zone ?? null;
      if (!sp) return null;
      const engine = new HybridEngine(new ZoneEngine(this.deps.transport('pc')), new ZoneEngine(this.deps.transport(sp)));
      this.mixed = new LocalBackend('pc', engine, { volume: this.userVolume() || 100 }, this.deps.notice);
      this.offs.push(this.mixed.subscribe((s) => this.onChild('mixed', s)));
    }
    return this.child(mode);
  }

  /** Silence whatever is active and make `next` the active queue. */
  private async switchTo(next: PcMode) {
    if (next === this.mode) return;
    const old = this.mode;
    this.mode = next;
    const c = this.child(old);
    if (c) {
      if (old === 'mixed') await c.send({ type: 'clear' }).catch(() => undefined);
      else if (c.state.status === 'playing' || c.state.status === 'loading') await c.send({ type: 'pause' }).catch(() => undefined);
    }
    this.emit();
  }

  /** The page moves to the player that is sounding: its level is the one in use now. */
  private follow(mode: PcMode) {
    this.mode = mode;
    const v = this.child(mode)?.state.volume ?? 0;
    if (v > 0) {
      this.level = v;
      this.lowSince = null;
    }
  }

  /** The one line shown when a phone takes Soloist (and the Spotify song this zone was sounding) over. */
  static readonly MOVED_TO_PHONE = 'Spotify moved to the phone — it plays there through Soloist now. Press Play here to bring it back to the PC speakers.';

  /**
   * There is one Soloist: a phone starting a Spotify song takes it, and its sound, over (the newest request wins). The
   * page keeps showing what Soloist plays, with the signal path ending "to the phone", and says so once.
   */
  private notePhone(s: PlayerState) {
    const was = this.onPhone;
    this.onPhone = soloistStreamsToPhone(s);
    if (this.onPhone && !was && this.usesSoloist && this.mode !== 'pc' && (s.status === 'playing' || s.status === 'loading')) this.deps.notice?.(PcBackend.MOVED_TO_PHONE);
  }

  private onChild(from: PcMode, s: PlayerState) {
    if (from === 'spotify') this.notePhone(s);
    if (from === this.mode) this.noteVolume(s.volume);
    // The page shows whichever player is sounding: something can start the other one behind our back (the Spotify
    // app itself, another tab, the voice assistant), and the server then pauses the first (play/oneSpeaker.ts).
    // Soloist streaming to a phone is not these speakers: the page does not move to it.
    if (this.mode !== 'mixed' && from !== 'mixed') {
      const other: PcMode = this.mode === 'pc' ? 'spotify' : 'pc';
      const sounding = this.child(other)?.state.status === 'playing' && !(other === 'spotify' && this.onPhone);
      if (sounding && this.child(this.mode)?.state.status !== 'playing') {
        this.follow(other);
        this.emit();
        return;
      }
    }
    if (from === this.mode) this.emit();
  }

  private emit() {
    const s = this.state;
    for (const f of this.subs) f(s);
  }
}
