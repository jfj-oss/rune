import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerState } from '@liner/shared';
import { createSpeakerGuard, type SpeakerZone } from '../src/play/oneSpeaker.js';
import { SpotifyConnectZone, type SpotifyZoneApi } from '../src/spotify/zones.js';
import { playbackState, sampleTrack } from './spotify-helpers.js';

function fakeApi(over: Partial<SpotifyZoneApi> = {}) {
  const calls: string[] = [];
  const api = {
    devices: async () => [], tracks: async () => [], track: async (id: string) => sampleTrack(id) as never,
    currentPlayback: async () => null, queue: async () => ({ currently_playing: null, queue: [] }),
    play: async (b: { uris?: string[] }) => { calls.push(`play(${b.uris?.length ?? 'resume'} uris)`); },
    pause: async () => { calls.push('pause'); }, next: async () => {}, previous: async () => {}, seek: async () => {},
    setVolume: async () => {}, setShuffle: async () => {}, setRepeat: async () => {}, enqueue: async () => {}, ...over,
  } as unknown as SpotifyZoneApi;
  return { api, calls };
}

describe('misc', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  it('KNOWN BUG X1 a paused start on Spotify really starts the song, then pauses: an audible blip (mpv had this fixed)', async () => {
    const { api, calls } = fakeApi();
    const z = new SpotifyConnectZone(api, 'd', 'HORSE');
    const p = z.command({ type: 'play', trackIds: ['sp:a'], startIndex: 0, paused: true });
    await vi.advanceTimersByTimeAsync(5000); await p;
    expect(calls).toEqual(['play(1 uris)', 'pause']);
    await z.close();
  });

  it('KNOWN BUG X2 the server passes any number of URIs to Spotify; only kind=spotify zones are windowed, and the PC zone is kind=pc', async () => {
    const { api, calls } = fakeApi();
    const z = new SpotifyConnectZone(api, 'd', 'HORSE');
    const p = z.command({ type: 'play', trackIds: Array.from({ length: 700 }, (_, i) => `sp:t${i}`), startIndex: 0 });
    await vi.advanceTimersByTimeAsync(5000); await p;
    expect(calls[0]).toBe('play(700 uris)');
    await z.close();
  });

  it('KNOWN BUG X3 Spotify stuck on "playing" while the breaker is up: nothing re-reads it', async () => {
    let reads = 0;
    const blocked = Date.now() + 9 * 3600_000;
    const { api } = fakeApi({ currentPlayback: async () => { reads++; return { device: { id: 'd', volume_percent: 50 }, repeat_state: 'off', shuffle_state: false, is_playing: true, progress_ms: 5000, item: { id: 'a', uri: 'spotify:track:a', name: 'a', duration_ms: 200000, artists: [], album: { id: 'b', name: 'b', images: [], artists: [] } } } as never; } });
    let on = false;
    const z = new SpotifyConnectZone(api, 'd', 'HORSE', { blockedUntil: () => (on ? blocked : null) });
    z.onChange(() => undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(z.state().status).toBe('playing');
    on = true;
    const r = reads;
    await vi.advanceTimersByTimeAsync(2 * 3600_000);    // two hours later
    expect(reads).toBe(r);
    expect(z.state().status).toBe('playing');           // every client still shows it as playing
    await z.close();
  });

  it('KNOWN BUG X4 guard: resuming in the Spotify app AFTER mpv started loses; the newest action gets paused', async () => {
    const pc = { status: 'playing' as PlayerState['status'], state() { return { status: this.status } as PlayerState; }, command: vi.fn(async () => undefined) };
    const sp = { status: 'paused' as PlayerState['status'], state() { return { status: this.status } as PlayerState; }, command: vi.fn(async () => undefined),
      startedAt: () => Date.now() - 120_000 /* position 120 s: "began" 2 min ago by the guard's arithmetic */ };
    const g = createSpeakerGuard({ pc: () => pc as unknown as SpeakerZone, spotify: () => sp as unknown as SpeakerZone }, { canWake: () => false });
    g.changed('pc', { status: 'playing' } as PlayerState);   // mpv started
    vi.advanceTimersByTime(60_000);                          // a minute later the user resumes the Spotify app at 2:00
    sp.status = 'playing';
    g.changed('spotify', { status: 'playing' } as PlayerState);
    expect(sp.command).toHaveBeenCalledWith({ type: 'pause' });
    expect(pc.command).not.toHaveBeenCalled();
  });
});
