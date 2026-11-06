import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayerState } from '@liner/shared';
import { createSpeakerGuard, type SpeakerZone } from '../src/play/oneSpeaker.js';
import type { SpotifyPlaybackState } from '../src/spotify/api.js';
import { SpotifyConnectZone, type SpotifyZoneApi } from '../src/spotify/zones.js';
import { playbackState, sampleTrack } from './spotify-helpers.js';

const st = (status: PlayerState['status']) => ({ status }) as PlayerState;
const zone = (status: PlayerState['status']) => {
  const z = { status, state: () => st(z.status), command: vi.fn(async () => { z.status = 'paused'; }) };
  return z as typeof z & SpeakerZone;
};

describe('the PC speakers play one thing at a time', () => {
  it('a song starting on mpv pauses the Spotify app', () => {
    const pc = zone('playing');
    const sp = zone('playing');
    createSpeakerGuard({ pc: () => pc, spotify: () => sp }).changed('pc', st('playing'));
    expect(sp.command).toHaveBeenCalledWith({ type: 'pause' });
    expect(pc.command).not.toHaveBeenCalled();
  });
  it('Spotify starting (autoplay, the app itself) pauses mpv', () => {
    const pc = zone('playing');
    const sp = zone('playing');
    createSpeakerGuard({ pc: () => pc, spotify: () => sp }).changed('spotify', st('playing'));
    expect(pc.command).toHaveBeenCalledWith({ type: 'pause' });
  });
  it('a player that keeps playing (next track, a poll) stops nothing', () => {
    const pc = zone('playing');
    const sp = zone('paused');
    const g = createSpeakerGuard({ pc: () => pc, spotify: () => sp });
    g.changed('pc', st('playing'));
    sp.status = 'playing';
    g.changed('pc', st('playing'));
    expect(sp.command).not.toHaveBeenCalled();
  });
  it('leaves a paused player alone, and copes with no Spotify app', () => {
    const sp = zone('paused');
    const g = createSpeakerGuard({ pc: () => undefined, spotify: () => sp });
    g.changed('spotify', st('playing'));
    g.changed('pc', st('playing'));
    expect(sp.command).not.toHaveBeenCalled();
  });
});

describe('a Spotify start seen late', () => {
  it('pauses Spotify instead when mpv started after it', () => {
    let t = 1_000;
    const pc = zone('playing');
    const sp = Object.assign(zone('paused'), { startedAt: () => 5_000 });
    const g = createSpeakerGuard({ pc: () => pc, spotify: () => sp }, { now: () => t });
    t = 8_000;
    g.changed('pc', st('playing'));
    t = 20_000;
    sp.status = 'playing';
    g.changed('spotify', st('playing'));
    expect(sp.command).toHaveBeenCalledWith({ type: 'pause' });
    expect(pc.command).not.toHaveBeenCalled();
  });
  it('pauses mpv when Spotify really started after it', () => {
    let t = 1_000;
    const pc = zone('playing');
    const sp = Object.assign(zone('paused'), { startedAt: () => 12_000 });
    const g = createSpeakerGuard({ pc: () => pc, spotify: () => sp }, { now: () => t });
    t = 8_000;
    g.changed('pc', st('playing'));
    t = 20_000;
    sp.status = 'playing';
    g.changed('spotify', st('playing'));
    expect(pc.command).toHaveBeenCalledWith({ type: 'pause' });
    expect(sp.command).not.toHaveBeenCalled();
  });
  it('mpv starting wakes the Spotify poll, unless the budget says no', () => {
    const pc = zone('playing');
    const sp = Object.assign(zone('paused'), { wake: vi.fn() });
    createSpeakerGuard({ pc: () => pc, spotify: () => sp }).changed('pc', st('playing'));
    expect(sp.wake).toHaveBeenCalledTimes(1);
    createSpeakerGuard({ pc: () => pc, spotify: () => sp }, { canWake: () => false }).changed('pc', st('playing'));
    expect(sp.wake).toHaveBeenCalledTimes(1);
  });
  it('a track change on mpv wakes nothing', () => {
    const pc = zone('playing');
    const sp = Object.assign(zone('paused'), { wake: vi.fn() });
    const g = createSpeakerGuard({ pc: () => pc, spotify: () => sp });
    g.changed('pc', st('playing'));
    g.changed('pc', st('playing'));
    expect(sp.wake).toHaveBeenCalledTimes(1);
  });
});

describe('the guard with a real polled Spotify zone', () => {
  afterEach(() => { vi.useRealTimers(); });

  /** A Spotify zone over a fake /me/player, wired to the guard the way server.ts does it. */
  async function rig(guardOpts = {}) {
    vi.useFakeTimers();
    let playback: SpotifyPlaybackState | null = playbackState(sampleTrack('t1'), { is_playing: false, progress_ms: 120_000 });
    const pause = vi.fn(async () => {
      if (playback) playback = { ...playback, is_playing: false };
    });
    const api = {
      currentPlayback: async () => playback,
      queue: async () => ({ currently_playing: null, queue: [] }),
      pause,
      play: async () => {
        if (playback) playback = { ...playback, is_playing: true };
      },
    } as unknown as SpotifyZoneApi;
    const sp = new SpotifyConnectZone(api, 'dev1', 'Sim Phone');
    const pc = zone('stopped');
    const guard = createSpeakerGuard({ pc: () => pc, spotify: () => sp }, guardOpts);
    sp.onChange((s) => guard.changed('spotify', s));
    await vi.advanceTimersByTimeAsync(0);
    const mpvStarts = () => { pc.status = 'playing'; guard.changed('pc', st('playing')); };
    const spotifyAppPlays = (progress: number) => { playback = { ...playback!, is_playing: true, progress_ms: progress }; };
    return { sp, pc, pause, mpvStarts, spotifyAppPlays };
  }

  it('Spotify started first and is only seen after mpv: the wake finds it and Spotify is paused', async () => {
    const { sp, pc, pause, mpvStarts, spotifyAppPlays } = await rig();
    await vi.advanceTimersByTimeAsync(10_000);
    spotifyAppPlays(5_000); // began 5 s ago, between two idle polls
    mpvStarts();
    await vi.advanceTimersByTimeAsync(100);
    expect(pause).toHaveBeenCalled();
    expect(pc.command).not.toHaveBeenCalled();
    await sp.close();
  });

  it('with the wake refused the slow poll still pauses the right one', async () => {
    const { sp, pc, pause, mpvStarts, spotifyAppPlays } = await rig({ canWake: () => false });
    await vi.advanceTimersByTimeAsync(5_000);
    mpvStarts();
    await vi.advanceTimersByTimeAsync(10_000);
    spotifyAppPlays(19_000); // as read by the idle poll at 20 s, the first to see it: Spotify began at 1 s, mpv at 5 s
    await vi.advanceTimersByTimeAsync(6_000);
    expect(pause).toHaveBeenCalled();
    expect(pc.command).not.toHaveBeenCalled();
    await sp.close();
  });

  it('a song resumed part-way in the Spotify app after mpv started still wins', async () => {
    const { sp, pc, pause, mpvStarts, spotifyAppPlays } = await rig();
    await vi.advanceTimersByTimeAsync(5_000);
    mpvStarts();
    await vi.advanceTimersByTimeAsync(5_000);
    spotifyAppPlays(125_000); // its position says "long ago", the idle poll at mpv's start says otherwise
    await vi.advanceTimersByTimeAsync(20_000);
    expect(pc.command).toHaveBeenCalledWith({ type: 'pause' });
    expect(pause).not.toHaveBeenCalled();
    await sp.close();
  });

  it('a song rune resumes part-way pauses mpv, however far in it is', async () => {
    const { sp, pc, pause, mpvStarts } = await rig({ canWake: () => false });
    await vi.advanceTimersByTimeAsync(5_000);
    mpvStarts();
    await vi.advanceTimersByTimeAsync(5_000);
    const resumed = sp.command({ type: 'resume' });
    await vi.advanceTimersByTimeAsync(2_000);
    await resumed;
    expect(pc.command).toHaveBeenCalledWith({ type: 'pause' });
    expect(pause).not.toHaveBeenCalled();
    await sp.close();
  });
});
