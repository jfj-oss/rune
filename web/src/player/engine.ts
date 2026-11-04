import type { Track } from '@liner/shared';
import { isLiveTrack } from '../lib/listenTypes';
import { detectIOS } from '../lib/volume';

/** What actually makes sound (or pretends to) for a local (browser/mock) zone. */
export interface Engine {
  /** `upcoming`: the songs after this one in play order (engines that can load ahead use it). */
  load(track: Track, startMs: number, autoplay: boolean, upcoming?: Track[]): void;
  /** The queue changed without a track change: keep/drop the look-ahead buffer in sync. */
  setUpcoming?(upcoming: Track[]): void;
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

const ON_IOS = typeof navigator !== 'undefined' && detectIOS(navigator.userAgent, navigator.maxTouchPoints) !== null;

function streamSrc(track: Track, fmt: { fmt: string; kbps: number }, tMs?: number): string {
  if (isLiveTrack(track)) return `/api/radio/${encodeURIComponent(track.id)}/stream`;
  // iOS needs a ranged file, so it waits for the cache instead of taking a live stream.
  const base = `/api/stream/${encodeURIComponent(track.id)}?fmt=${fmt.fmt}&kbps=${fmt.kbps}${ON_IOS ? '&wait=1' : ''}`;
  // Live transcoded streams have no length and cannot be range-seeked, so seeking
  // reloads with t=<ms> and the server slices from there.
  return tMs && tMs > 0 ? `${base}&t=${Math.round(tMs)}` : base;
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
  private loadedTrack: Track | null = null;
  /** Track id currently buffered in `spareEl`, if any. */
  private preloadedId: string | null = null;
  private preloadedTrack: Track | null = null;
  /** Invalidates metadata handlers left over from a previous load/seek. */
  private loadGen = 0;
  private playing = false;
  /** Time offset already encoded in the active live stream's `?t=` (0 = from start). */
  private liveBaseMs = 0;
  /** Per element: t= could be needed if the server has no cache (cue track or AAC). */
  private readonly wantsLiveFlags = new WeakMap<HTMLAudioElement, boolean>();
  /** Per element: the current src really is a live ffmpeg stream (from X-Rune-Live). */
  private readonly liveFlags = new WeakMap<HTMLAudioElement, boolean>();

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
    if (ON_IOS && typeof document !== 'undefined') this.unlockOnFirstTap();
  }

  /**
   * iOS lets an <audio> element start only from a tap, unless a tap already called play() on that
   * element. Pressing Play now waits for the server (own-copy lookup, album tracks) before the
   * engine's play(), which iOS refused ("Tap play to start audio"). So the first tap anywhere in the
   * app calls play() + pause() on both elements in the same task: silent, and they stay unlocked.
   */
  private unlockOnFirstTap() {
    const unlock = () => {
      document.removeEventListener('touchend', unlock, true);
      document.removeEventListener('click', unlock, true);
      for (const el of [this.el, this.spareEl]) {
        if (!el.paused) continue;
        try {
          const p = el.play();
          el.pause();
          void p?.catch(() => undefined);
        } catch {
          /* not allowed here: the next tap on Play still works as before */
        }
      }
    };
    document.addEventListener('touchend', unlock, true);
    document.addEventListener('click', unlock, true);
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
    // iOS mutes Web Audio when the page is in the background or the screen locks, but the
    // <audio> element keeps running: a song routed through a MediaElementSource goes silent
    // while the clock keeps moving. iPhones/iPads therefore skip levelling and play the
    // element directly (iOS ignores element volume, so there is no other way to apply gain).
    if (ON_IOS) return null;
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

  /** HEAD the stream: read the level hint and learn whether the body is live. */
  private readGain(src: string, el: HTMLAudioElement) {
    const token = this.bumpGainToken(el);
    void fetch(src, { method: 'HEAD' })
      .then((res) => {
        if (this.gainTokens.get(el) !== token) return;
        // The server marks a live ffmpeg body with X-Rune-Live; a cached file has
        // Content-Length/Accept-Ranges instead. Absence of ranges is the fallback
        // if custom headers are not exposed.
        const wanted = this.wantsLiveFlags.get(el) ?? false;
        this.liveFlags.set(
          el,
          res.ok && (res.headers.get('X-Rune-Live') === '1' || (wanted && !res.headers.has('accept-ranges'))),
        );
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
    this.preloadedTrack = null;
    this.liveFlags.set(this.spareEl, false);
    this.wantsLiveFlags.set(this.spareEl, false);
    this.spareEl.pause();
    this.spareEl.removeAttribute('src');
    this.spareEl.load();
    this.applyGainDb(this.spareEl, null);
  }

  /** Cue tracks and AAC requests may be served as a live transcode when uncached. */
  private wantsLive(track: Track): boolean {
    return this.fmt.fmt === 'aac' || !!track.cue;
  }

  /** Buffer `track` in the spare element (only local, finite files can be preloaded). */
  private setPreload(track: Track | undefined) {
    // iOS lets an <audio> element start by itself only after a tap played that same element: a swapped-in
    // spare would be refused at the end of a song, so iPhones/iPads keep the single-element behaviour.
    const desired = track && track.source === 'local' && !isLiveTrack(track) && !ON_IOS ? track : undefined;
    if ((desired?.id ?? null) === this.preloadedId) return;
    this.releasePreload();
    if (!desired) return;
    // The same URL the active element uses, so the swap needs no new load.
    const src = streamSrc(desired, this.fmt);
    this.preloadedId = desired.id;
    this.preloadedTrack = desired;
    this.wantsLiveFlags.set(this.spareEl, this.wantsLive(desired));
    // Until the HEAD probe answers, assume the worst (live) for cue/AAC tracks.
    this.liveFlags.set(this.spareEl, this.wantsLive(desired));
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
    this.loadedTrack = this.preloadedTrack;
    this.preloadedId = null;
    this.preloadedTrack = null;
    this.liveBaseMs = 0;

    // The previous track is done (ended or skipped): release its file.
    this.bumpGainToken(oldEl);
    this.liveFlags.set(oldEl, false);
    this.wantsLiveFlags.set(oldEl, false);
    oldEl.pause();
    oldEl.removeAttribute('src');
    oldEl.load();
    this.applyGainDb(oldEl, null);
  }

  load(track: Track, startMs: number, autoplay: boolean, upcoming: Track[] = []) {
    const gen = ++this.loadGen;
    this.playing = autoplay && track.source !== 'spotify';
    if (track.source === 'spotify') {
      this.el.pause();
      this.releasePreload();
      this.errorFn('Spotify tracks play on a Spotify device — pick one from the zone menu');
      return;
    }
    // A queue advance (ended / Next) to the preloaded track: swap and play without a new load.
    const swap = startMs === 0 && this.preloadedId === track.id;
    // A cue/AAC track may be served as a live stream (no length, no byte ranges).
    // Start mid-track via ?t= instead of seeking after metadata, which would fail.
    const viaT = !isLiveTrack(track) && startMs > 0 && this.wantsLive(track);
    if (swap) this.swapToPreloaded();
    else {
      const src = streamSrc(track, this.fmt, viaT ? startMs : undefined);
      if (this.loadedId !== track.id || viaT) {
        this.bumpGainToken(this.el);
        this.applyGainDb(this.el, null);
        this.liveBaseMs = viaT ? startMs : 0;
        this.wantsLiveFlags.set(this.el, this.wantsLive(track));
        // Until the HEAD probe answers, assume a live body for cue/AAC tracks.
        this.liveFlags.set(this.el, this.wantsLive(track));
        this.el.src = src;
        this.loadedId = track.id;
        this.loadedTrack = track;
        // Radio is live: no seek, and loudness normalisation does not apply.
        if (!isLiveTrack(track)) this.readGain(src, this.el);
      } else {
        this.liveBaseMs = 0;
      }
    }
    this.resumeContext();
    // Capture the element: a later load may swap elements before metadata arrives.
    const target = this.el;
    const start = () => {
      if (gen !== this.loadGen || target !== this.el) return;
      if (!isLiveTrack(track) && !viaT) target.currentTime = startMs / 1000;
      if (autoplay) void target.play().catch(() => this.errorFn('Tap play to start audio'));
    };
    if (!isLiveTrack(track) && startMs > 0 && !viaT) {
      target.addEventListener('loadedmetadata', start, { once: true });
    } else if (autoplay) {
      // A swapped-in preload (or a live t= reload) is already at its start.
      if (swap || viaT) this.el.currentTime = 0;
      void this.el.play().catch(() => this.errorFn('Tap play to start audio'));
    }
    // Keep one song buffered ahead; release it when the queue now points elsewhere.
    this.setPreload(upcoming[0]);
  }

  setUpcoming(upcoming: Track[]) { this.setPreload(upcoming[0]); }

  play() {
    this.playing = true;
    this.resumeContext();
    void this.el.play().catch(() => this.errorFn('Tap play to start audio'));
  }
  pause() {
    this.playing = false;
    this.el.pause();
  }
  seek(ms: number) {
    const pos = Math.max(0, ms);
    // A live stream cannot be seeked in-place: reload it from the requested time.
    if (this.liveFlags.get(this.el) && this.loadedTrack) {
      this.reloadLive(pos);
      return;
    }
    this.el.currentTime = pos / 1000;
  }

  /** Restart the active live stream at `ms` using the server's ?t= slice. */
  private reloadLive(ms: number) {
    const track = this.loadedTrack;
    if (!track) return;
    this.loadGen++;
    this.liveBaseMs = ms;
    this.liveFlags.set(this.el, true);
    this.wantsLiveFlags.set(this.el, true);
    this.bumpGainToken(this.el);
    // A new src starts at 0; position() adds liveBaseMs back.
    this.el.currentTime = 0;
    const src = streamSrc(track, this.fmt, ms);
    this.el.src = src;
    this.loadedId = track.id;
    if (!isLiveTrack(track)) this.readGain(src, this.el);
    if (this.playing) void this.el.play().catch(() => this.errorFn('Tap play to start audio'));
  }

  setVolume(v: number) {
    const volume = Math.max(0, Math.min(1, v / 100));
    this.el.volume = volume;
    this.spareEl.volume = volume;
  }
  position() {
    if (!Number.isFinite(this.el.currentTime)) return null;
    // A live t= slice reports time relative to the slice; add the slice offset back.
    const base = this.liveFlags.get(this.el) ? this.liveBaseMs : 0;
    return base + this.el.currentTime * 1000;
  }
  stop() {
    this.loadGen++;
    this.playing = false;
    this.bumpGainToken(this.el);
    this.liveFlags.set(this.el, false);
    this.wantsLiveFlags.set(this.el, false);
    this.el.pause();
    this.el.removeAttribute('src');
    this.loadedId = null;
    this.loadedTrack = null;
    this.liveBaseMs = 0;
    this.el.load();
    this.releasePreload();
  }
  onEnded(fn: () => void) { this.endedFn = fn; }
  onError(fn: (m: string) => void) { this.errorFn = fn; }
}
