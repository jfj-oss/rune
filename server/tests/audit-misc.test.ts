import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerState } from '@liner/shared';
import { createSpeakerGuard, type SpeakerZone } from '../src/play/oneSpeaker.js';
import { SpotifyConnectZone, SpotifyZones, type SpotifyZoneApi } from '../src/spotify/zones.js';
import { MprisPlaybackSource } from '../src/spotify/mpris.js';
import { DEV, World, sp } from './support/spotify-world.js';
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

  it('X2 the server sends Spotify at most 100 URIs, from the starting song on, whichever zone kind asked', async () => {
    const sent: { uris?: string[]; offset?: { position: number } }[] = [];
    const { api, calls } = fakeApi({ play: async (b: { uris?: string[]; offset?: { position: number } }) => { sent.push(b); calls.push(`play(${b.uris?.length ?? 'resume'} uris)`); } } as never);
    const z = new SpotifyConnectZone(api, 'd', 'HORSE');
    const p = z.command({ type: 'play', trackIds: Array.from({ length: 700 }, (_, i) => `sp:t${i}`), startIndex: 250 });
    await vi.advanceTimersByTimeAsync(5000); await p;
    expect(calls[0]).toBe('play(100 uris)');
    expect(sent[0]!.uris![0]).toBe('spotify:track:t250');
    expect(sent[0]!.offset).toEqual({ position: 0 });
    expect(z.state().queue[z.state().index]!.track.id).toBe('sp:t250');
    const short = z.command({ type: 'play', trackIds: ['sp:a', 'sp:b', 'sp:c'], startIndex: 2 });
    await vi.advanceTimersByTimeAsync(5000); await short;
    expect(sent[1]!.uris).toHaveLength(3);
    expect(sent[1]!.offset).toEqual({ position: 2 });
    await z.close();
  });

  it('X3 while the breaker is up nothing re-reads Spotify, and a song past its time is shown paused at its end', async () => {
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
    const seen: string[] = [];
    z.onChange((s) => seen.push(`${s.status}@${s.positionMs}`));
    await vi.advanceTimersByTimeAsync(190_000);          // the song has 195 s left
    expect(z.state().status).toBe('playing');
    await vi.advanceTimersByTimeAsync(2 * 3600_000);     // two hours later
    expect(reads).toBe(r);                              // still not one read
    expect(z.state().status).toBe('paused');
    expect(z.state().positionMs).toBe(200000);
    expect(seen).toEqual(['paused@200000']);
    await z.close();
  });

  it('KNOWN BUG X4 (MPRIS reads off) guard: resuming in the Spotify app AFTER mpv started loses; the newest action gets paused', async () => {
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

  it('X4 guard with MPRIS: resuming in the Spotify app after mpv started wins, and mpv is the one paused', async () => {
    const w = new World({ mpris: true });
    w.songs.set('s1', sp('s1', 300_000));
    const source = new MprisPlaybackSource(w.mpris!, { deviceId: () => DEV });
    const zones = new SpotifyZones(w, { mpris: source });
    const zone = zones.ensureZone(DEV, 'HORSE');
    const pc = { status: 'stopped' as PlayerState['status'], state() { return { status: this.status, queue: [], index: -1 } as unknown as PlayerState; }, command: vi.fn(async () => { pc.status = 'paused'; }) };
    // No wake when mpv starts (budget out): only the app's own signal can date the resume.
    const g = createSpeakerGuard({ pc: () => pc as unknown as SpeakerZone, spotify: () => zone }, { canWake: () => false });
    zone.onChange((s) => g.changed('spotify', s));
    await w.play({ uris: ['spotify:track:s1'] }, DEV);   // the song plays in the app...
    await vi.advanceTimersByTimeAsync(120_000);
    w.externalPause();                                    // ...and is paused at 2:00
    await vi.advanceTimersByTimeAsync(5_000);
    expect(zone.state().status).toBe('paused');
    pc.status = 'playing';
    g.changed('pc', { status: 'playing' } as PlayerState); // mpv started
    await vi.advanceTimersByTimeAsync(5_000);
    w.externalResume();                                   // seconds later the user resumes the app at 2:00
    await vi.advanceTimersByTimeAsync(2_000);
    expect(zone.state().status).toBe('playing');
    expect(pc.command).toHaveBeenCalledWith({ type: 'pause' });
    expect(w.log.some((l) => l.includes('PUT pause'))).toBe(false);
    await zones.close(); source.close(); w.dispose();
  });

  it('X4b guard with MPRIS: a Spotify song still playing from before mpv started is the one paused', async () => {
    const w = new World({ mpris: true });
    w.songs.set('s1', sp('s1', 300_000));
    const source = new MprisPlaybackSource(w.mpris!, { deviceId: () => DEV });
    const zones = new SpotifyZones(w, { mpris: source });
    const zone = zones.ensureZone(DEV, 'HORSE');
    const pc = { status: 'stopped' as PlayerState['status'], state() { return { status: this.status, queue: [], index: -1 } as unknown as PlayerState; }, command: vi.fn(async () => undefined) };
    const g = createSpeakerGuard({ pc: () => pc as unknown as SpeakerZone, spotify: () => zone });
    zone.onChange((s) => g.changed('spotify', s));
    await vi.advanceTimersByTimeAsync(1_000);
    await w.play({ uris: ['spotify:track:s1'] }, DEV);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(zone.state().status).toBe('playing');
    pc.status = 'playing';
    g.changed('pc', { status: 'playing' } as PlayerState);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pc.command).not.toHaveBeenCalled();
    expect(w.log.some((l) => l.includes('PUT pause'))).toBe(true);
    await zones.close(); source.close(); w.dispose();
  });
});
