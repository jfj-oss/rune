import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '@liner/shared';
import { AudioEngine, streamUrl } from './engine';
import { mkTrack } from './testkit';

/** Minimal <audio> double: records src assignments, play calls and events. */
class FakeAudio {
  static instances: FakeAudio[] = [];
  currentTime = 0;
  volume = 1;
  preload = '';
  playCalls = 0;
  loadCalls = 0;
  readonly srcLog: string[] = [];
  private srcValue = '';
  private readonly listeners = new Map<string, (() => void)[]>();

  constructor() {
    FakeAudio.instances.push(this);
  }

  get src(): string {
    return this.srcValue;
  }
  set src(value: string) {
    if (value !== this.srcValue) this.srcLog.push(value);
    this.srcValue = value;
  }

  play(): Promise<void> {
    this.playCalls += 1;
    return Promise.resolve();
  }
  paused = true;
  pauseCalls = 0;
  pause(): void {
    this.pauseCalls += 1;
  }
  load(): void {
    this.loadCalls += 1;
  }
  removeAttribute(name: string): void {
    if (name === 'src') this.srcValue = '';
  }
  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  dispatch(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
}

const local = (id: string): Track => mkTrack(id, 'local');
const streamSrc = (id: string) =>
  `/api/stream/${encodeURIComponent(id)}?fmt=orig&kbps=256`;
const elementFor = (id: string) => FakeAudio.instances.find((el) => el.src === streamSrc(id));

beforeEach(() => {
  FakeAudio.instances = [];
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { headers: { 'X-Rune-Gain-Db': '0' } })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AudioEngine look-ahead', () => {
  it('preloads the next local track and swaps to it on ended without a new src', () => {
    const engine = new AudioEngine();
    const a = local('l:A');
    const b = local('l:B');
    const ended = vi.fn(() => engine.load(b, 0, true, []));
    engine.onEnded(ended);

    engine.load(a, 0, true, [b]);

    const aEl = elementFor(a.id)!;
    const bEl = elementFor(b.id)!;
    expect(aEl).toBeDefined();
    expect(bEl).toBeDefined();
    // The preload uses the same URL the active element would use, and is not played yet.
    expect(bEl.srcLog).toEqual([streamSrc(b.id)]);
    expect(bEl.playCalls).toBe(0);
    expect(aEl.srcLog).toEqual([streamSrc(a.id)]);

    aEl.dispatch('ended');

    expect(ended).toHaveBeenCalledTimes(1);
    // B now plays from the element that was preloaded: no new src assignment.
    expect(bEl.playCalls).toBe(1);
    expect(bEl.srcLog).toEqual([streamSrc(b.id)]);
    // The finished track's file is released.
    expect(aEl.src).toBe('');
  });

  it('Next to a non-preloaded track works as before and releases the stale preload', () => {
    const engine = new AudioEngine();
    const a = local('l:A');
    const b = local('l:B');
    const c = local('l:C');

    engine.load(a, 0, true, [b]);
    const active = elementFor(a.id)!;
    const preloaded = elementFor(b.id)!;
    expect(preloaded.src).toBe(streamSrc(b.id));

    engine.load(c, 0, true, []);

    expect(elementFor(c.id)).toBe(active);
    expect(active.srcLog).toEqual([streamSrc(a.id), streamSrc(c.id)]);
    expect(active.playCalls).toBe(2);
    // The preloaded B file is no longer needed.
    expect(preloaded.src).toBe('');
  });

  it('never preloads for repeat-one (no upcoming tracks)', () => {
    const engine = new AudioEngine();
    const a = local('l:A');

    engine.load(a, 0, true, []);

    expect(FakeAudio.instances).toHaveLength(2);
    expect(elementFor(a.id)).toBeDefined();
    const spare = FakeAudio.instances.find((el) => el !== elementFor(a.id))!;
    expect(spare.src).toBe('');
    expect(spare.loadCalls).toBe(0);
  });

  it('does not preload a Spotify track that follows', () => {
    const engine = new AudioEngine();
    engine.load(local('l:A'), 0, true, [mkTrack('sp:B', 'spotify')]);

    const spare = FakeAudio.instances.find((el) => el !== elementFor('l:A'))!;
    expect(spare.src).toBe('');
  });

  it('releases or replaces the preload when the queue changes', () => {
    const engine = new AudioEngine();
    const b = local('l:B');
    const c = local('l:C');
    engine.load(local('l:A'), 0, true, [b]);
    const preloaded = elementFor(b.id)!;

    engine.setUpcoming([c]);
    expect(preloaded.src).toBe(streamSrc(c.id)); // same element now buffers C
    expect(elementFor(b.id)).toBeUndefined();

    engine.setUpcoming([]);
    expect(preloaded.src).toBe('');
  });

  it('ignores metadata from a load that has already been superseded', () => {
    const engine = new AudioEngine();
    engine.load(local('l:A'), 5000, true, []);
    const active = elementFor('l:A')!;
    expect(active.playCalls).toBe(0); // waiting for A's metadata to seek

    engine.load(local('l:C'), 0, true, []);
    const plays = active.playCalls;
    active.currentTime = 0;

    // A's late loadedmetadata must not seek/start C at 5 s.
    active.dispatch('loadedmetadata');
    expect(active.playCalls).toBe(plays);
    expect(active.currentTime).toBe(0);
  });

  it('applies the volume to both elements', () => {
    const engine = new AudioEngine();
    engine.setVolume(35);
    expect(FakeAudio.instances.map((el) => el.volume)).toEqual([0.35, 0.35]);
  });
});

describe('AudioEngine live transcode seeking', () => {
  const cue = (id: string): Track => ({
    ...local(id),
    cue: { startMs: 0, endMs: 200_000 },
  });

  it('reloads a live cue stream with t= and reports position t + currentTime', () => {
    const engine = new AudioEngine();
    const track = cue('l:cue');
    engine.load(track, 0, true, []);
    const el = elementFor(track.id)!;

    engine.seek(5000);

    const base = `/api/stream/${encodeURIComponent(track.id)}?fmt=orig&kbps=256`;
    expect(el.src).toBe(`${base}&t=5000`);
    // The new live slice starts at 0; the offset lives in liveBaseMs.
    expect(el.currentTime).toBe(0);
    expect(engine.position()).toBe(5000);
    expect(el.playCalls).toBe(2); // load + continued playback after the reload

    el.currentTime = 2.5;
    expect(engine.position()).toBe(7500); // duration still comes from track metadata
  });

  it('seeks in place when the server has a cached ranged file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, { headers: { 'X-Rune-Gain-Db': '0', 'Accept-Ranges': 'bytes' } }),
      ),
    );
    const engine = new AudioEngine();
    const track = cue('l:cued');
    engine.load(track, 0, true, []);
    await new Promise((r) => setTimeout(r, 0)); // let the HEAD probe report a cached file
    const el = elementFor(track.id)!;

    engine.seek(4000);

    expect(el.src).toBe(streamSrc(track.id)); // no t= reload
    expect(el.currentTime).toBe(4);
    expect(engine.position()).toBe(4000);
  });

  it('starts a resumed live track with t= instead of waiting for metadata', () => {
    const engine = new AudioEngine();
    const track = cue('l:resume');
    engine.load(track, 12_000, true, []);
    const el = FakeAudio.instances[0]!; // the active element (src carries t=)
    expect(el.src).toBe(`/api/stream/${encodeURIComponent(track.id)}?fmt=orig&kbps=256&t=12000`);
    expect(engine.position()).toBe(12_000);
  });
});

describe('AudioEngine on iOS (background playback)', () => {
  /** Records whether the element was routed through Web Audio. */
  function stubAudioContext() {
    const routed: unknown[] = [];
    class FakeCtx {
      state = 'running';
      destination = {};
      createMediaElementSource(el: unknown) {
        routed.push(el);
        return { connect() {} };
      }
      createGain() {
        return { gain: { value: 1 }, connect() {} };
      }
      resume() { return Promise.resolve(); }
    }
    vi.stubGlobal('window', { AudioContext: FakeCtx });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'X-Rune-Gain-Db': '-6.0' } })));
    return routed;
  }

  async function engineFor(userAgent: string) {
    vi.stubGlobal('navigator', { userAgent, maxTouchPoints: 5 });
    vi.resetModules();
    const { AudioEngine: Fresh } = await import('./engine');
    return new Fresh();
  }

  it('never routes the element through Web Audio on an iPhone (iOS mutes it when locked)', async () => {
    const routed = stubAudioContext();
    const engine = await engineFor('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15');
    engine.load(local('l:locked'), 0, true, []);
    await new Promise((r) => setTimeout(r, 0)); // the gain HEAD probe answers -6 dB
    expect(routed).toHaveLength(0);
    expect(FakeAudio.instances.some((el) => el.playCalls > 0)).toBe(true);
  });

  it('still levels loudness through Web Audio on desktop browsers', async () => {
    const routed = stubAudioContext();
    const engine = await engineFor('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36');
    engine.load(local('l:desk'), 0, true, []);
    await new Promise((r) => setTimeout(r, 0));
    expect(routed.length).toBeGreaterThan(0);
  });

  it('unlocks the audio elements on the first tap, silently (iOS refuses a play() that waits for the server)', async () => {
    stubAudioContext();
    const listeners = new Map<string, () => void>();
    vi.stubGlobal('document', {
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    });
    await engineFor('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15');
    const [a, b] = FakeAudio.instances.slice(-2);
    expect(a!.playCalls).toBe(0);
    listeners.get('touchend')!();
    expect([a!.playCalls, b!.playCalls]).toEqual([1, 1]);
    expect([a!.pauseCalls, b!.pauseCalls]).toEqual([1, 1]); // paused in the same task: no sound
    expect(listeners.size).toBe(0); // once is enough
  });
});


describe('streamUrl capability negotiation', () => {
  const track = local('l:neg');
  const base = `/api/stream/${encodeURIComponent('l:neg')}`;

  it('keeps the old URL when there is no accept list (tests, SSR, older clients)', () => {
    expect(streamUrl(track, { fmt: 'orig', kbps: 256 })).toBe(`${base}?fmt=orig&kbps=256`);
  });

  it('tells the server which source kinds this browser plays, for fmt=orig', () => {
    expect(streamUrl(track, { fmt: 'orig', kbps: 256 }, { accept: 'mp3,aac,m4a' }))
      .toBe(`${base}?fmt=orig&kbps=256&accept=mp3,aac,m4a`);
  });

  it('does not negotiate a format already picked by the user (data saver AAC)', () => {
    expect(streamUrl(track, { fmt: 'aac', kbps: 256 }, { accept: 'mp3,aac,m4a' }))
      .toBe(`${base}?fmt=aac&kbps=256`);
  });

  it('keeps wait=1 for iOS (ranged file) and seek slices with t=', () => {
    expect(streamUrl(track, { fmt: 'orig', kbps: 256 }, { accept: 'mp3,aac', ios: true }, 12_000))
      .toBe(`${base}?fmt=orig&kbps=256&accept=mp3,aac&wait=1&t=12000`);
  });

  it('leaves radio streams alone', () => {
    const radio = mkTrack('rs:station-1', 'local'); // live tracks are recognised by their rs: id
    expect(streamUrl(radio, { fmt: 'orig', kbps: 256 }, { accept: 'mp3' }))
      .toBe('/api/radio/rs%3Astation-1/stream');
  });
});
