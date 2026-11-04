import type { Track } from '@liner/shared';
import { describe, expect, it, vi } from 'vitest';
import type { PlayItem } from '../lib/types';
import type { Engine } from './engine';
import { HybridEngine } from './hybrid';
import { LocalBackend } from './local';

class Fake implements Engine {
  calls: string[] = [];
  pos: number | null = 0;
  ended: () => void = () => {};
  error: (m: string) => void = () => {};
  sync: (p: number, playing: boolean) => void = () => {};
  constructor(public name: string) {}
  load(t: Track, s: number, a: boolean) { this.calls.push(`load:${t.id}@${s}:${a}`); }
  setUpcoming(tracks: Track[]) { this.calls.push(`upcoming:${tracks.map((t) => t.id).join(',')}`); }
  play() { this.calls.push('play'); }
  pause() { this.calls.push('pause'); }
  seek(ms: number) { this.calls.push(`seek:${ms}`); }
  setVolume(v: number) { this.calls.push(`vol:${v}`); }
  position() { return this.pos; }
  stop() { this.calls.push('stop'); }
  onEnded(fn: () => void) { this.ended = fn; }
  onError(fn: (m: string) => void) { this.error = fn; }
  onSync(fn: (p: number, playing: boolean) => void) { this.sync = fn; }
}

const track = (id: string, source: 'local' | 'spotify', durationMs = 200_000): Track => ({
  id, albumId: source === 'spotify' ? 'sp:alb' : 'la:alb', source, title: id, artists: [{ id: 'ar:1', name: 'A' }], disc: 1, number: 1, durationMs,
});
const item = (t: Track): PlayItem => ({ track: t, album: { id: t.albumId, title: 'Alb' } });

describe('HybridEngine', () => {
  it('routes by track source and silences the other engine on a switch', () => {
    const local = new Fake('local'), sp = new Fake('spotify');
    const h = new HybridEngine(local, sp);
    h.load(track('l:1', 'local'), 0, true);
    expect(local.calls).toContain('load:l:1@0:true');
    expect(h.current).toBe('local');
    h.load(track('sp:9', 'spotify'), 1500, true);
    expect(local.calls.at(-1)).toBe('stop');
    expect(sp.calls).toContain('load:sp:9@1500:true');
    expect(h.current).toBe('spotify');
    h.load(track('l:2', 'local'), 0, true);
    expect(sp.calls.at(-1)).toBe('stop');
    expect(local.calls.at(-1)).toBe('load:l:2@0:true');
  });

  it('does not stop anything when staying on the same engine', () => {
    const local = new Fake('local'), sp = new Fake('spotify');
    const h = new HybridEngine(local, sp);
    h.load(track('sp:1', 'spotify'), 0, true);
    h.load(track('sp:2', 'spotify'), 0, true);
    expect(sp.calls.filter((c) => c === 'stop')).toHaveLength(0);
    expect(local.calls).toHaveLength(0);
  });

  it('delegates transport + position to the active engine and volume to both', () => {
    const local = new Fake('local'), sp = new Fake('spotify');
    const h = new HybridEngine(local, sp);
    h.setVolume(40);
    h.load(track('sp:1', 'spotify'), 0, true);
    expect(sp.calls).toContain('vol:40'); // new engine gets the current volume before loading
    sp.pos = 12_345;
    expect(h.position()).toBe(12_345);
    h.pause(); h.play(); h.seek(900);
    expect(sp.calls.slice(-3)).toEqual(['pause', 'play', 'seek:900']);
    expect(local.calls.filter((c) => /pause|play|seek/.test(c))).toHaveLength(0);
    h.setVolume(10);
    expect(local.calls).toContain('vol:10');
    expect(sp.calls).toContain('vol:10');
  });

  it('only forwards ended / error / sync from the active engine', () => {
    const local = new Fake('local'), sp = new Fake('spotify');
    const h = new HybridEngine(local, sp);
    const ended = vi.fn(), err = vi.fn(), sync = vi.fn();
    h.onEnded(ended); h.onError(err); h.onSync(sync);
    h.load(track('l:1', 'local'), 0, true);
    sp.ended(); sp.error('x'); sp.sync(1, true);
    expect(ended).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    local.ended(); local.error('boom'); local.sync(5, true);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledWith('boom');
    expect(sync).toHaveBeenCalledWith(5, true);
  });

  it('has no position and ignores transport once stopped', () => {
    const local = new Fake('local'), sp = new Fake('spotify');
    const h = new HybridEngine(local, sp);
    h.load(track('l:1', 'local'), 0, true);
    h.stop();
    expect(h.position()).toBeNull();
    h.play();
    expect(local.calls.filter((c) => c === 'play')).toHaveLength(0);
  });
});

describe('one queue across both engines (LocalBackend + HybridEngine)', () => {
  const L1 = track('l:1', 'local'), S1 = track('sp:1', 'spotify'), L2 = track('l:2', 'local');
  const setup = () => {
    const local = new Fake('local'), sp = new Fake('spotify');
    const b = new LocalBackend('browser', new HybridEngine(local, sp));
    return { local, sp, b };
  };

  it('starts at full volume, so a reload never drops the level', () => {
    expect(setup().b.state.volume).toBe(100);
  });

  it('advances local -> spotify -> local when each track ends', async () => {
    const { local, sp, b } = setup();
    await b.send({ type: 'play', trackIds: [], startIndex: 0 }, [item(L1), item(S1), item(L2)]);
    expect(local.calls).toContain('load:l:1@0:true');
    local.ended();
    expect(b.state.index).toBe(1);
    expect(sp.calls).toContain('load:sp:1@0:true');
    expect(local.calls.at(-1)).toBe('stop');
    sp.ended();
    expect(b.state.index).toBe(2);
    expect(local.calls.at(-1)).toBe('load:l:2@0:true');
    expect(sp.calls.at(-1)).toBe('stop');
    local.ended();
    expect(b.state.status).toBe('stopped');
    b.dispose();
  });

  it('manual next / jump switch engines too, and pause only touches the active one', async () => {
    const { local, sp, b } = setup();
    await b.send({ type: 'play', trackIds: [], startIndex: 0 }, [item(L1), item(S1), item(L2)]);
    await b.send({ type: 'next' });
    expect(sp.calls).toContain('load:sp:1@0:true');
    await b.send({ type: 'pause' });
    expect(sp.calls.at(-1)).toBe('pause');
    expect(local.calls.filter((c) => c === 'pause')).toHaveLength(0);
    await b.send({ type: 'jump', index: 0 });
    expect(local.calls.at(-1)).toBe('load:l:1@0:true');
    b.dispose();
  });

  it('refreshes the look-ahead when the queue is edited without changing track', async () => {
    const L3 = track('l:3', 'local'), L4 = track('l:4', 'local');
    const local = new Fake('local'), sp = new Fake('spotify');
    const b = new LocalBackend('browser', new HybridEngine(local, sp));

    await b.send({ type: 'play', trackIds: [], startIndex: 0 }, [item(L1), item(L2), item(L3)]);

    await b.send({ type: 'enqueue', trackIds: [], next: true }, [item(L4)]);
    expect(local.calls.at(-1)).toBe('upcoming:l:4,l:2,l:3');

    await b.send({ type: 'repeat', mode: 'one' });
    expect(local.calls.at(-1)).toBe('upcoming:');

    await b.send({ type: 'repeat', mode: 'off' });
    expect(local.calls.at(-1)).toBe('upcoming:l:4,l:2,l:3');
    b.dispose();
  });

  it('adopts position / play state reported by the Spotify engine (e.g. paused from the phone)', async () => {
    const { sp, b } = setup();
    await b.send({ type: 'play', trackIds: [], startIndex: 1 }, [item(L1), item(S1)]);
    expect(b.state.status).toBe('playing');
    sp.sync(42_000, false);
    expect(b.state.status).toBe('paused');
    expect(b.state.positionMs).toBe(42_000);
    sp.sync(43_000, true);
    expect(b.state.status).toBe('playing');
    b.dispose();
  });

  it('does not resurrect a stopped queue from a late sync', async () => {
    const { local, sp, b } = setup();
    await b.send({ type: 'play', trackIds: [], startIndex: 1 }, [item(L1), item(S1)]);
    sp.ended();
    local.ended();
    expect(b.state.status).toBe('stopped');
    sp.sync(0, true);
    expect(b.state.status).toBe('stopped');
    b.dispose();
  });
});

describe('HybridEngine look-ahead', () => {
  it('passes only the run of following songs the same engine plays', () => {
    const local = new Fake('local'), sp = new Fake('spotify');
    const seen: string[][] = [];
    sp.load = (_t: Track, _s: number, _a: boolean, up: Track[] = []) => { seen.push(up.map((x) => x.id)); };
    const h = new HybridEngine(local, sp);
    h.load(track('sp:1', 'spotify'), 0, true, [track('sp:2', 'spotify'), track('sp:3', 'spotify'), track('l:4', 'local'), track('sp:5', 'spotify')]);
    expect(seen[0]).toEqual(['sp:2', 'sp:3']);
  });
});
