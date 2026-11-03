import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '@liner/shared';
import { AudioEngine } from './engine';
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
  pause(): void {}
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
