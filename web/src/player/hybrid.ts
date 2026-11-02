import type { Track } from '@liner/shared';
import type { Engine } from './engine';

/**
 * The browser zone's engine: local files play through the <audio> engine, Spotify tracks through the
 * Web Playback SDK engine. LocalBackend keeps ONE queue spanning both; on every track change this
 * engine switches to the right backend and silences the other one.
 */
export class HybridEngine implements Engine {
  private active: Engine | null = null;
  private volume = 70;
  private endedFn: () => void = () => {};
  private errorFn: (m: string) => void = () => {};
  private syncFn: (pos: number, playing: boolean) => void = () => {};

  constructor(private local: Engine, private spotify: Engine) {
    // Only the engine that is currently active may speak.
    local.onEnded(() => { if (this.active === local) this.endedFn(); });
    spotify.onEnded(() => { if (this.active === spotify) this.endedFn(); });
    local.onError((m) => { if (this.active === local) this.errorFn(m); });
    spotify.onError((m) => { if (this.active === spotify) this.errorFn(m); });
    local.onSync?.((p, pl) => { if (this.active === local) this.syncFn(p, pl); });
    spotify.onSync?.((p, pl) => { if (this.active === spotify) this.syncFn(p, pl); });
  }

  /** Which engine a track belongs to. */
  engineFor(track: Track): Engine {
    return track.source === 'spotify' ? this.spotify : this.local;
  }
  get current(): 'local' | 'spotify' | null {
    return this.active === this.local ? 'local' : this.active === this.spotify ? 'spotify' : null;
  }

  load(track: Track, startMs: number, autoplay: boolean, upcoming: Track[] = []) {
    const target = this.engineFor(track);
    if (this.active && this.active !== target) this.active.stop();
    this.active = target;
    target.setVolume(this.volume);
    // look-ahead only covers the run of songs the same engine will play next
    const run: Track[] = [];
    for (const t of upcoming) { if (this.engineFor(t) !== target) break; run.push(t); }
    target.load(track, startMs, autoplay, run);
  }
  play() { this.active?.play(); }
  pause() { this.active?.pause(); }
  seek(ms: number) { this.active?.seek(ms); }
  setVolume(v: number) {
    this.volume = v;
    this.local.setVolume(v);
    this.spotify.setVolume(v);
  }
  position() { return this.active ? this.active.position() : null; }
  stop() {
    this.local.stop();
    this.spotify.stop();
    this.active = null;
  }
  onEnded(fn: () => void) { this.endedFn = fn; }
  onError(fn: (m: string) => void) { this.errorFn = fn; }
  onSync(fn: (pos: number, playing: boolean) => void) { this.syncFn = fn; }
}
