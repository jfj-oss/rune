import type { PlayerState } from '@liner/shared';
import type { ExtCommand, PlayItem } from '../lib/types';
import { HybridEngine } from './hybrid';
import { LocalBackend } from './local';
import { emptyState, livePosition, type Backend } from './types';
import { ZoneEngine, type ZoneTransport } from './zoneEngine';

export interface PcDevice {
  /** Spotify Connect device id of the Spotify app on the PC. */
  id: string;
  name: string;
}

/** What PcBackend needs from the outside world (swapped for fakes in tests). */
export interface PcDeps {
  remote(zone: string): Backend;
  transport(zone: string): ZoneTransport;
  notice?(msg: string): void;
}

/**
 * pc queue mode:
 * - `pc`      only local files: the server's own mpv queue (gapless, keeps going with no tab open)
 * - `spotify` only Spotify tracks: the Spotify app's own queue on the PC (also tab-independent)
 * - `mixed`   both in one queue: the queue lives in this tab and each track is loaded into mpv or the
 *             Spotify app one at a time, switching on track change (needs a rune tab open)
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

/** The "Linux PC speakers" zone: mpv, plus (when the Spotify app runs on the PC) Spotify tracks in the same queue. */
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

  constructor(private deps: PcDeps, device?: PcDevice | null) {
    this.pc = deps.remote('pc');
    this.offs.push(this.pc.subscribe((s) => this.onChild('pc', s)));
    this.setDevice(device ?? null);
  }

  get currentMode(): PcMode { return this.mode; }
  get hasSpotify(): boolean { return !!this.device; }

  /** The Spotify app on the PC appeared / went away / changed id. */
  setDevice(device: PcDevice | null) {
    if (device?.id === this.device?.id) { this.device = device; return; }
    if (this.mode !== 'pc') this.switchTo('pc');
    this.sp?.dispose();
    this.sp = null;
    if (this.mixed && this.mode !== 'mixed') { this.mixed.dispose(); this.mixed = null; }
    this.device = device;
    if (device) {
      const sp = this.deps.remote(`spotify:${device.id}`);
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
    const want: PcMode = pcOn ? 'pc' : spOn ? 'spotify' : this.mode;
    if (want !== this.mode) this.mode = want;
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

  async send(cmd: ExtCommand, items: PlayItem[] = []): Promise<void> {
    if (cmd.type === 'play') return this.start(cmd, items);
    if (cmd.type === 'enqueue') return this.enqueue(cmd, items);
    const c = this.child(this.mode);
    if (!c) return;
    return c.send(cmd, items);
  }

  // ----- starting / queueing -----

  private async start(cmd: Extract<ExtCommand, { type: 'play' }>, items: PlayItem[]) {
    const target = modeFor(items);
    if (target !== 'pc' && !this.device) throw new Error('Open the Spotify app on the PC to play Spotify through the Linux speakers');
    const volume = this.state.volume;
    await this.switchTo(target);
    const c = this.ensure(target)!;
    await c.send(cmd, items);
    if (target !== 'mixed' && c.state.volume !== volume && volume > 0) await c.send({ type: 'volume', volume }).catch(() => undefined);
  }

  private async enqueue(cmd: Extract<ExtCommand, { type: 'enqueue' }>, items: PlayItem[]) {
    if (!items.length) return;
    const need = modeFor(items);
    if (need !== 'pc' && !this.device) throw new Error('Open the Spotify app on the PC to play Spotify through the Linux speakers');
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
    const repeat = s.repeat;
    const volume = s.volume;
    await this.switchTo('mixed');
    const m = this.ensure('mixed')!;
    await m.send({ type: 'play', trackIds: [], startIndex: s.index, positionMs: livePosition(s), paused: s.status === 'paused' }, queue);
    if (repeat !== 'off') await m.send({ type: 'repeat', mode: repeat });
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
      const sp = this.device ? `spotify:${this.device.id}` : null;
      if (!sp) return null;
      const engine = new HybridEngine(new ZoneEngine(this.deps.transport('pc')), new ZoneEngine(this.deps.transport(sp)));
      this.mixed = new LocalBackend('pc', engine, { volume: this.pc.state.volume || 70 }, this.deps.notice);
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

  private onChild(from: PcMode, s: PlayerState) {
    if (from === this.mode) { this.emit(); return; }
    // something started playing behind our back (the Spotify app on the PC): follow it
    if (from === 'spotify' && this.mode === 'pc' && s.status === 'playing' && this.pc.state.status !== 'playing') {
      this.mode = 'spotify';
      this.emit();
    }
  }

  private emit() {
    const s = this.state;
    for (const f of this.subs) f(s);
  }
}
