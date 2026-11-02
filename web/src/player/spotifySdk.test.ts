import type { Track } from '@liner/shared';
import { describe, expect, it, vi } from 'vitest';
import { SpotifySdkEngine } from './spotifySdk';

vi.mock('../clientLog', () => ({ clientLog: () => undefined }));

const track = (id: string): Track => ({ id: `sp:${id}`, albumId: 'sp:alb', source: 'spotify', title: id, artists: [{ id: 'ar:1', name: 'A' }], disc: 1, number: 1, durationMs: 200_000 });
const sdkTrack = (id: string) => ({ id, uri: `spotify:track:${id}` });
const state = (cur: string, prev: string[], next: string[], position = 0, paused = false) => ({
  paused, position, duration: 200_000,
  track_window: { current_track: sdkTrack(cur), previous_tracks: prev.map(sdkTrack), next_tracks: next.map(sdkTrack) },
});

/** An engine that already sent [a, b, c] to Spotify and is playing `a`. */
function playing() {
  const e = new SpotifySdkEngine('test');
  const player = { nextTrack: vi.fn(async () => undefined), resume: vi.fn(async () => undefined), pause: vi.fn(async () => undefined) };
  const x = e as unknown as Record<string, unknown>;
  x.player = player;
  x.window = ['a', 'b', 'c'];
  x.cur = { track: track('a'), startMs: 0 };
  x.pos = { ms: 1000, at: Date.now(), playing: true };
  const onState = (s: unknown) => (e as unknown as { onState(s: unknown): void }).onState(s);
  return { e, player, onState };
}

describe('SpotifySdkEngine look-ahead', () => {
  it('Next uses Spotify’s preloaded next song instead of a new play request', () => {
    const { e, player, onState } = playing();
    onState(state('a', [], ['b', 'c'], 1000));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    e.load(track('b'), 0, true, [track('c')]);
    expect(player.nextTrack).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('reports the end once when Spotify moves on by itself, then follows without a request', () => {
    const { e, player, onState } = playing();
    const ended = vi.fn();
    e.onEnded(ended);
    onState(state('a', [], ['b', 'c'], 199_000));
    onState(state('b', ['a'], ['c'], 300));
    onState(state('b', ['a'], ['c'], 900)); // a second event for the same move
    expect(ended).toHaveBeenCalledTimes(1);
    e.load(track('b'), 0, true, [track('c')]); // the queue advances to b
    expect(player.nextTrack).not.toHaveBeenCalled();
    expect(e.position()).toBeGreaterThanOrEqual(300);
  });

  it('Previous right after Next is a real load, not a follow of the song being left', () => {
    const { e, player, onState } = playing();
    onState(state('a', [], ['b', 'c'], 5000));
    const ensure = vi.spyOn(e as unknown as { ensureReady(): Promise<string> }, 'ensureReady').mockResolvedValue('dev');
    e.load(track('b'), 0, true, [track('c')]); // Next: skip
    expect(player.nextTrack).toHaveBeenCalledTimes(1);
    e.load(track('a'), 0, true, [track('b'), track('c')]); // Previous before Spotify reported b
    expect(ensure).toHaveBeenCalledTimes(1); // a normal play request
  });

  it('a song outside the sent list, or a restart of the same song, is a normal load', () => {
    const { e, player, onState } = playing();
    onState(state('a', [], ['b', 'c'], 5000));
    const ensure = vi.spyOn(e as unknown as { ensureReady(): Promise<string> }, 'ensureReady').mockResolvedValue('dev');
    e.load(track('a'), 0, true, [track('b')]); // Previous after 3 s restarts a
    e.load(track('z'), 0, true);
    expect(player.nextTrack).not.toHaveBeenCalled();
    expect(ensure).toHaveBeenCalledTimes(2);
  });
});
