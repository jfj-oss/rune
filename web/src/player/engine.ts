import type { Track } from '@liner/shared';

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

export class AudioEngine implements Engine {
  private el = new Audio();
  private endedFn: () => void = () => {};
  private errorFn: (m: string) => void = () => {};
  private fmt = pickFormat();
  private loadedId: string | null = null;

  constructor() {
    this.el.preload = 'auto';
    this.el.addEventListener('ended', () => this.endedFn());
    this.el.addEventListener('error', () => this.errorFn('Could not play this track in the browser'));
  }
  load(track: Track, startMs: number, autoplay: boolean) {
    if (track.source === 'spotify') {
      this.el.pause();
      this.errorFn('Spotify tracks play on a Spotify device — pick one from the zone menu');
      return;
    }
    const src = `/api/stream/${encodeURIComponent(track.id)}?fmt=${this.fmt.fmt}&kbps=${this.fmt.kbps}`;
    if (this.loadedId !== track.id) {
      this.el.src = src;
      this.loadedId = track.id;
    }
    const start = () => {
      this.el.currentTime = startMs / 1000;
      if (autoplay) void this.el.play().catch(() => this.errorFn('Tap play to start audio'));
    };
    if (startMs > 0) this.el.addEventListener('loadedmetadata', start, { once: true });
    else if (autoplay) void this.el.play().catch(() => this.errorFn('Tap play to start audio'));
  }
  play() { void this.el.play().catch(() => this.errorFn('Tap play to start audio')); }
  pause() { this.el.pause(); }
  seek(ms: number) { this.el.currentTime = ms / 1000; }
  setVolume(v: number) { this.el.volume = Math.max(0, Math.min(1, v / 100)); }
  position() { return Number.isFinite(this.el.currentTime) ? this.el.currentTime * 1000 : null; }
  stop() { this.el.pause(); this.el.removeAttribute('src'); this.loadedId = null; this.el.load(); }
  onEnded(fn: () => void) { this.endedFn = fn; }
  onError(fn: (m: string) => void) { this.errorFn = fn; }
}
