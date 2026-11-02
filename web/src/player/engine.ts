import type { Track } from '@liner/shared';
import { isLiveTrack } from '../lib/listenTypes';

/** What actually makes sound (or pretends to) for a local (browser/mock) zone. */
export interface Engine {
  /** `upcoming`: the songs after this one in play order (engines that can load ahead use it). */
  load(track: Track, startMs: number, autoplay: boolean, upcoming?: Track[]): void;
  play(): void;
  pause(): void;
  seek(ms: number): void;
  setVolume(v: number): void;
  /** Real position in ms, or null if the engine does not know (mock). */
  position(): number | null;
  stop(): void;
  onEnded(fn: () => void): void;
  onError(fn: (msg: string) => void): void;
  /** Engines that learn about playback from elsewhere (the Spotify SDK) report position/play state here. */
  onSync?(fn: (positionMs: number, playing: boolean) => void): void;
}

export class MockEngine implements Engine {
  load() {}
  play() {}
  pause() {}
  seek() {}
  setVolume() {}
  position() { return null; }
  stop() {}
  onEnded() {}
  onError() {}
}

/** Lossless by default: the server sends the original file (cue tracks as a cached FLAC
 *  slice), always with byte ranges so Safari can play and seek. 'aac' = data saver. */
function pickFormat(): { fmt: string; kbps: number } {
  try {
    if (localStorage.getItem('rune.dataSaver') === '1') return { fmt: 'aac', kbps: 256 };
  } catch {
    /* storage blocked */
  }
  return { fmt: 'orig', kbps: 256 };
}

function streamSrc(track: Track, fmt: { fmt: string; kbps: number }): string {
  if (isLiveTrack(track)) return `/api/radio/${encodeURIComponent(track.id)}/stream`;
  return `/api/stream/${encodeURIComponent(track.id)}?fmt=${fmt.fmt}&kbps=${fmt.kbps}`;
}

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as typeof window & { webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export class AudioEngine implements Engine {
  /** The element that is making (or about to make) sound. */
  private el = new Audio();
  /** Preloads the next local track so a track change does not rebuffer. */
  private spareEl = new Audio();
  private endedFn: () => void = () => {};
  private errorFn: (m: string) => void = () => {};
  private fmt = pickFormat();
  private loadedId: string | null = null;
  /** Track id currently buffered in `spareEl`, if any. */
  private preloadedId: string | null = null;

  // Loudness levelling: the server sends X-Rune-Gain-Db on local streams; apply it
  // with a GainNode. One graph (and one MediaElementSource, which browsers only
  // allow once per element) per element; swapping elements swaps the nodes too.
  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private spareGainNode: GainNode | null = null;
  /** Per-element request tokens, so a stale HEAD response cannot change another track's gain. */
  private readonly gainTokens = new WeakMap<HTMLAudioElement, number>();

  constructor() {
    this.armElement(this.el);
    this.armElement(this.spareEl);
  }

  private armElement(el: HTMLAudioElement) {
    el.preload = 'auto';
    // Ignore events from the element that is not active (it may be the spare being released).
    el.addEventListener('ended', () => { if (el === this.el) this.endedFn(); });
    el.addEventListener('error', () => {
      if (el === this.el) this.errorFn('Could not play this track in the browser');
    });
  }

  private gainNodeFor(el: HTMLAudioElement): GainNode | null {
    return el === this.el ? this.gainNode : this.spareGainNode;
  }

  private ensureGainGraph(el: HTMLAudioElement): GainNode | null {
    const existing = this.gainNodeFor(el);
    if (existing) return existing;
    const Ctor = audioContextCtor();
    if (!Ctor) return null;
    try {
      if (!this.ctx) this.ctx = new Ctor();
      const source = this.ctx.createMediaElementSource(el);
      const gain = this.ctx.createGain();
      source.connect(gain);
      gain.connect(this.ctx.destination);
      if (el === this.el) this.gainNode = gain;
      else this.spareGainNode = gain;
      return gain;
    } catch {
      return null;
    }
  }

  private applyGainDb(el: HTMLAudioElement, db: number | null) {
    const node = this.gainNodeFor(el);
    if (db === null || !Number.isFinite(db) || db === 0) {
      if (node) node.gain.value = 1;
      return;
    }
    const g = this.ensureGainGraph(el);
    if (!g) return;
    // keep extreme tags sane; gain is a linear multiplier
    g.gain.value = Math.min(4, Math.max(0.05, Math.pow(10, db / 20)));
    if (el === this.el && this.ctx?.state === 'suspended') {
      void this.ctx.resume().catch(() => undefined);
    }
  }

  private bumpGainToken(el: HTMLAudioElement): number {
    const token = (this.gainTokens.get(el) ?? 0) + 1;
    this.gainTokens.set(el, token);
    return token;
  }

  /** HEAD the stream and read the level hint (the GET itself never alters audio). */
  private readGain(src: string, el: HTMLAudioElement) {
    const token = this.bumpGainToken(el);
    void fetch(src, { method: 'HEAD' })
      .then((res) => {
        if (this.gainTokens.get(el) !== token) return;
        const raw = res.headers.get('X-Rune-Gain-Db');
        const db = raw === null ? null : Number(raw);
        this.applyGainDb(el, Number.isFinite(db) ? db : null);
      })
      .catch(() => {
        if (this.gainTokens.get(el) === token) this.applyGainDb(el, null);
      });
  }

  private resumeContext() {
    if (this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  }

  /** Stop the spare element and free the file it was buffering. */
  private releasePreload() {
    this.bumpGainToken(this.spareEl);
    this.preloadedId = null;
    this.spareEl.pause();
    this.spareEl.removeAttribute('src');
    this.spareEl.load();
    this.applyGainDb(this.spareEl, null);
  }

  /** Buffer `track` in the spare element (only local, finite files can be preloaded). */
  private setPreload(track: Track | undefined) {
    const desired = track && track.source === 'local' && !isLiveTrack(track) ? track : undefined;
    if ((desired?.id ?? null) === this.preloadedId) return;
    this.releasePreload();
    if (!desired) return;
    // The same URL the active element uses, so the swap needs no new load.
    const src = streamSrc(desired, this.fmt);
    this.preloadedId = desired.id;
    this.bumpGainToken(this.spareEl);
    this.spareEl.src = src;
    this.spareEl.load();
    this.readGain(src, this.spareEl);
  }

  /** Promote the preloaded element to active; the old active element becomes the spare. */
  private swapToPreloaded() {
    const oldEl = this.el;
    this.el = this.spareEl;
    this.spareEl = oldEl;
    const oldGain = this.gainNode;
    this.gainNode = this.spareGainNode;
    this.spareGainNode = oldGain;
    this.loadedId = this.preloadedId;
    this.preloadedId = null;

    // The previous track is done (ended or skipped): release its file.
    this.bumpGainToken(oldEl);
    oldEl.pause();
    oldEl.removeAttribute('src');
    oldEl.load();
    this.applyGainDb(oldEl, null);
  }

  load(track: Track, startMs: number, autoplay: boolean, upcoming: Track[] = []) {
    if (track.source === 'spotify') {
      this.el.pause();
      this.releasePreload();
      this.errorFn('Spotify tracks play on a Spotify device — pick one from the zone menu');
      return;
    }
    // A queue advance (ended / Next) to the preloaded track: swap and play without a new load.
    const swap = startMs === 0 && this.preloadedId === track.id;
    if (swap) this.swapToPreloaded();
    else {
      const src = streamSrc(track, this.fmt);
      if (this.loadedId !== track.id) {
        this.bumpGainToken(this.el);
        this.applyGainDb(this.el, null);
        this.el.src = src;
        this.loadedId = track.id;
        // Radio is live: no seek, and loudness normalisation does not apply.
        if (!isLiveTrack(track)) this.readGain(src, this.el);
      }
    }
    this.resumeContext();
    const start = () => {
      if (!isLiveTrack(track)) this.el.currentTime = startMs / 1000;
      if (autoplay) void this.el.play().catch(() => this.errorFn('Tap play to start audio'));
    };
    if (!isLiveTrack(track) && startMs > 0) {
      this.el.addEventListener('loadedmetadata', start, { once: true });
    } else if (autoplay) {
      // A swapped-in preload is already at its start: play it without rebuffering.
      if (swap) this.el.currentTime = 0;
      void this.el.play().catch(() => this.errorFn('Tap play to start audio'));
    }
    // Keep one song buffered ahead; release it when the queue now points elsewhere.
    this.setPreload(upcoming[0]);
  }

  play() {
    this.resumeContext();
    void this.el.play().catch(() => this.errorFn('Tap play to start audio'));
  }
  pause() { this.el.pause(); }
  seek(ms: number) { this.el.currentTime = ms / 1000; }
  setVolume(v: number) {
    const volume = Math.max(0, Math.min(1, v / 100));
    this.el.volume = volume;
    this.spareEl.volume = volume;
  }
  position() { return Number.isFinite(this.el.currentTime) ? this.el.currentTime * 1000 : null; }
  stop() {
    this.bumpGainToken(this.el);
    this.el.pause();
    this.el.removeAttribute('src');
    this.loadedId = null;
    this.el.load();
    this.releasePreload();
  }
  onEnded(fn: () => void) { this.endedFn = fn; }
  onError(fn: (m: string) => void) { this.errorFn = fn; }
}
