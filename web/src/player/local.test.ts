import type { Track } from '@liner/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayItem } from '../lib/types';
import type { Engine } from './engine';
import { LocalBackend } from './local';
import { livePosition } from './types';

/** An <audio> stand-in whose clock the test moves by hand. */
class SlowStart implements Engine {
  private base: number | null = null;
  private at = 0;
  private running = false;
  /** The element's clock: stuck at `ms` (buffering) or running from it. */
  clock(ms: number, running: boolean) { this.base = ms; this.at = Date.now(); this.running = running; }
  load() {}
  play() {}
  pause() {}
  seek(ms: number) { this.clock(ms, this.running); }
  setVolume() {}
  position() { return this.base === null ? null : this.base + (this.running ? Date.now() - this.at : 0); }
  stop() {}
  onEnded() {}
  onError() {}
}

const track = (id: string): Track => ({ id, albumId: 'la:alb', source: 'local', title: id, artists: [{ id: 'ar:1', name: 'A' }], disc: 1, number: 1, durationMs: 200_000 });
const item = (t: Track): PlayItem => ({ track: t, album: { id: t.albumId, title: 'Alb' } });

describe('LocalBackend keeps the shown position honest', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('follows the element when the sound starts seconds after Play (a phone buffering a transcode)', async () => {
    const engine = new SlowStart();
    const b = new LocalBackend('browser', engine);
    await b.send({ type: 'play', trackIds: ['l:1'], startIndex: 0 }, [item(track('l:1'))]);
    // Five seconds pass with nothing buffered yet: the page's clock says 0:05, the element is still at 0.
    engine.clock(0, false);
    vi.advanceTimersByTime(5_000);
    expect(livePosition(b.state)).toBeLessThan(700);
    // Then the element plays normally: the page keeps pace with it, no jump.
    engine.clock(0, true);
    vi.advanceTimersByTime(3_000);
    expect(Math.abs(livePosition(b.state) - 3_000)).toBeLessThan(700);
    b.dispose();
  });

  it('leaves a position that is already right alone (no churn every tick)', async () => {
    const engine = new SlowStart();
    const b = new LocalBackend('browser', engine);
    await b.send({ type: 'play', trackIds: ['l:1'], startIndex: 0 }, [item(track('l:1'))]);
    const seen: number[] = [];
    b.subscribe((s) => seen.push(s.updatedAt));
    engine.clock(0, true);
    vi.advanceTimersByTime(4_000);
    expect(seen.length).toBe(0);
    b.dispose();
  });
});
