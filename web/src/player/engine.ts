import type { Track } from '@liner/shared';
import { isLiveTrack } from '../lib/listenTypes';

/** What actually makes sound (or pretends to) for a local (browser/mock) zone. */
export interface Engine {
  load(track: Track, startMs: number, autoplay: boolean): void;
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
  private el = new Audio();
  private endedFn: () => void = () => {};
  private errorFn: (m: string) => void = () => {};
  private fmt = pickFormat();
  private loadedId: string | null = null;

  // Loudness levelling: the server sends X-Rune-Gain-Db on local streams; apply it
  // with a GainNode. The graph is built lazily and only when a header is present.
  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private gainToken = 0;

  constructor() {
    this.el.preload = 'auto';
    this.el.addEventListener('ended', () => this.endedFn());
    this.el.addEventListener('error', () => this.errorFn('Could not play this track in the browser'));
  }

  private ensureGainGraph(): GainNode | null {
    if (this.gainNode) return this.gainNode;
    const Ctor = audioContextCtor();
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
      const source = this.ctx.createMediaElementSource(this.el);
      this.gainNode = this.ctx.createGain();
      source.connect(this.gainNode);
      this.gainNode.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
      this.gainNode = null;
      return null;
    }
    return this.gainNode;
  }

  private applyGainDb(db: number | null) {
    if (db === null || !Number.isFinite(db) || db === 0) {
      if (this.gainNode) this.gainNode.gain.value = 1;
      return;
    }
    const g = this.ensureGainGraph();
    if (!g) return;
    // keep extreme tags sane; gain is a linear multiplier
    g.gain.value = Math.min(4, Math.max(0.05, Math.pow(10, db / 20)));
    if (this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  }

  /** HEAD the stream and read the level hint (the GET itself never alters audio). */
  private readGain(src: string) {
    const token = ++this.gainToken;
    void fetch(src, { method: 'HEAD' })
      .then((res) => {
        if (token !== this.gainToken) return;
        const raw = res.headers.get('X-Rune-Gain-Db');
        const db = raw === null ? null : Number(raw);
        this.applyGainDb(Number.isFinite(db) ? db : null);
      })
      .catch(() => { if (token === this.gainToken) this.applyGainDb(null); });
  }

  private resumeContext() {
    if (this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  }

  load(track: Track, startMs: number, autoplay: boolean) {
    if (track.source === 'spotify') {
      this.el.pause();
      this.errorFn('Spotify tracks play on a Spotify device — pick one from the zone menu');
      return;
    }
    const src = streamSrc(track, this.fmt);
    const changed = this.loadedId !== track.id;
    if (changed) {
      this.gainToken++;
      this.applyGainDb(null);
      this.el.src = src;
      this.loadedId = track.id;
      // Radio is live: no seek, and loudness normalisation does not apply.
      if (!isLiveTrack(track)) this.readGain(src);
    }
    this.resumeContext();
    const start = () => {
      if (!isLiveTrack(track)) this.el.currentTime = startMs / 1000;
      if (autoplay) void this.el.play().catch(() => this.errorFn('Tap play to start audio'));
    };
    if (!isLiveTrack(track) && startMs > 0) this.el.addEventListener('loadedmetadata', start, { once: true });
    else if (autoplay) void this.el.play().catch(() => this.errorFn('Tap play to start audio'));
  }

  play() {
    this.resumeContext();
    void this.el.play().catch(() => this.errorFn('Tap play to start audio'));
  }
  pause() { this.el.pause(); }
  seek(ms: number) { this.el.currentTime = ms / 1000; }
  setVolume(v: number) { this.el.volume = Math.max(0, Math.min(1, v / 100)); }
  position() { return Number.isFinite(this.el.currentTime) ? this.el.currentTime * 1000 : null; }
  stop() {
    this.gainToken++;
    this.el.pause();
    this.el.removeAttribute('src');
    this.loadedId = null;
    this.el.load();
  }
  onEnded(fn: () => void) { this.endedFn = fn; }
  onError(fn: (m: string) => void) { this.errorFn = fn; }
}
