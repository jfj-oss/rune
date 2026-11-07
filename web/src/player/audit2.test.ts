import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from './engine';
import { LocalBackend } from './local';
import { createTabChannel } from './oneTab';
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

  it('B2 two tabs on the browser zone: Play in one pauses the other, and back again', async () => {
    const name = `rune-test-${Math.random()}`;
    const mk = () => new LocalBackend('browser', new AudioEngine(), undefined, undefined, undefined, createTabChannel(name));
    const a = mk(), c = mk();
    await a.send({ type: 'play', trackIds: [], startIndex: 0 }, [mkItem(mkTrack('l:1', 'local'))]);
    await vi.waitFor(() => expect(FakeAudio.all.filter((e) => !e.paused)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 5));      // a later click: the newer start wins
    await c.send({ type: 'play', trackIds: [], startIndex: 0 }, [mkItem(mkTrack('l:2', 'local'))]);
    await vi.waitFor(() => expect(a.state.status).toBe('paused'));
    expect(c.state.status).toBe('playing');
    const sounding = FakeAudio.all.filter((e) => !e.paused);
    expect(sounding).toHaveLength(1);
    expect(sounding[0]!.src).toContain('l%3A2');
    await new Promise((r) => setTimeout(r, 5));
    await a.send({ type: 'resume' });
    await vi.waitFor(() => expect(c.state.status).toBe('paused'));
    expect(a.state.status).toBe('playing');
    a.dispose(); c.dispose();
  });

  it('B2 two tabs pressing Play in the same instant: exactly one keeps playing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1_800_000_000_000);
    const name = `rune-test-${Math.random()}`;
    const mk = () => new LocalBackend('browser', new AudioEngine(), undefined, undefined, undefined, createTabChannel(name));
    const a = mk(), c = mk();
    await a.send({ type: 'play', trackIds: [], startIndex: 0 }, [mkItem(mkTrack('l:1', 'local'))]);
    await c.send({ type: 'play', trackIds: [], startIndex: 0 }, [mkItem(mkTrack('l:2', 'local'))]);
    await vi.waitFor(() => expect([a.state.status, c.state.status].sort()).toEqual(['paused', 'playing']));
    vi.useRealTimers();
    a.dispose(); c.dispose();
  });

  it('B2 a tab is not paused by its own start, nor by another browser zone channel', async () => {
    const a = new LocalBackend('browser', new AudioEngine(), undefined, undefined, undefined, createTabChannel(`rune-test-${Math.random()}`));
    const other = new LocalBackend('browser', new AudioEngine(), undefined, undefined, undefined, createTabChannel(`rune-test-${Math.random()}`));
    await a.send({ type: 'play', trackIds: [], startIndex: 0 }, [mkItem(mkTrack('l:1', 'local'))]);
    await other.send({ type: 'play', trackIds: [], startIndex: 0 }, [mkItem(mkTrack('l:2', 'local'))]);
    await new Promise((r) => setTimeout(r, 50));
    expect(a.state.status).toBe('playing');
    expect(other.state.status).toBe('playing');
    a.dispose(); other.dispose();
  });
});
