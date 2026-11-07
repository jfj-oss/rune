import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from './engine';
import { LocalBackend } from './local';
import { mkItem, mkTrack } from './testkit';

class FakeAudio {
  static all: FakeAudio[] = [];
  currentTime = 0; volume = 1; preload = ''; src = ''; playCalls = 0; paused = true;
  constructor() { FakeAudio.all.push(this); }
  play() { this.playCalls++; this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; } load() {} removeAttribute() { this.src = ''; }
  addEventListener() {}
}
beforeEach(() => {
  FakeAudio.all = [];
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: {} })));
});
afterEach(() => vi.unstubAllGlobals());

describe('browser zone', () => {
  it('B1 Previous on a local song in the browser restarts it, the audio too', async () => {
    const eng = new AudioEngine();
    const b = new LocalBackend('browser', eng);
    const t = mkItem(mkTrack('l:1', 'local'));
    await b.send({ type: 'play', trackIds: [], startIndex: 0 }, [t]);
    const el = FakeAudio.all.find((a) => a.src.includes('l%3A1'))!;
    el.currentTime = 90;              // 1:30 in
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 90_000);
    await b.send({ type: 'prev' });   // over 3 s in: "restart"
    vi.useRealTimers();
    expect(b.state.positionMs).toBe(0);
    expect(el.currentTime).toBe(0);
    expect(el.paused).toBe(false);
    b.dispose();
  });

  it('KNOWN BUG B2 two tabs on the browser zone: two engines, nothing tells them about each other (each plays)', async () => {
    const mk = () => new LocalBackend('browser', new AudioEngine());
    const a = mk(), c = mk();
    await a.send({ type: 'play', trackIds: [], startIndex: 0 }, [mkItem(mkTrack('l:1', 'local'))]);
    await c.send({ type: 'play', trackIds: [], startIndex: 0 }, [mkItem(mkTrack('l:2', 'local'))]);
    expect(FakeAudio.all.filter((e) => !e.paused)).toHaveLength(2);
    a.dispose(); c.dispose();
  });
});
