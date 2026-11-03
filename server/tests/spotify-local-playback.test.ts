import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  SpotifyDevice,
  SpotifyPlayBody,
  SpotifyPlaybackState,
  SpotifyQueue,
  SpotifyTrack,
} from '../src/spotify/api.js';
import {
  LocalPlaybackSource,
  parseLocalPlaybackReport,
  sharedPlaybackReads,
  type LocalPlaybackReport,
  type SpotifyZoneApi,
} from '../src/spotify/zones.js';
import { SIM_DEVICE, playbackState, sampleTrack } from './spotify-helpers.js';

/** Counts every network call; a synthetic answer must leave all counters at zero. */
class FakeApi implements SpotifyZoneApi {
  playback: SpotifyPlaybackState | null = playbackState(sampleTrack('t9', 9, 'Real API'));
  devicesData: SpotifyDevice[] = [SIM_DEVICE];
  calls: string[] = [];
  currentPlaybackCalls = 0;
  deviceCalls = 0;

  async devices(): Promise<SpotifyDevice[]> {
    this.deviceCalls++;
    return this.devicesData;
  }
  async tracks(ids: string[]): Promise<SpotifyTrack[]> {
    return ids.map((id) => sampleTrack(id));
  }
  async track(id: string): Promise<SpotifyTrack> {
    return sampleTrack(id);
  }
  async currentPlayback(): Promise<SpotifyPlaybackState | null> {
    this.currentPlaybackCalls++;
    return this.playback;
  }
  async queue(): Promise<SpotifyQueue> {
    return { currently_playing: null, queue: [] };
  }
  async play(_body: SpotifyPlayBody, deviceId?: string): Promise<void> {
    this.calls.push(`play:${deviceId ?? ''}`);
  }
  async pause(deviceId?: string): Promise<void> {
    this.calls.push(`pause:${deviceId ?? ''}`);
  }
  async next(deviceId?: string): Promise<void> {
    this.calls.push(`next:${deviceId ?? ''}`);
  }
  async previous(deviceId?: string): Promise<void> {
    this.calls.push(`previous:${deviceId ?? ''}`);
  }
  async seek(_ms: number, deviceId?: string): Promise<void> {
    this.calls.push(`seek:${deviceId ?? ''}`);
  }
  async setVolume(_v: number, deviceId?: string): Promise<void> {
    this.calls.push(`setVolume:${deviceId ?? ''}`);
  }
  async setShuffle(_on: boolean, deviceId?: string): Promise<void> {
    this.calls.push(`setShuffle:${deviceId ?? ''}`);
  }
  async setRepeat(_mode: 'off' | 'track' | 'context', deviceId?: string): Promise<void> {
    this.calls.push(`setRepeat:${deviceId ?? ''}`);
  }
  async enqueue(_uri: string, deviceId?: string): Promise<void> {
    this.calls.push(`enqueue:${deviceId ?? ''}`);
  }
}

function report(overrides: Partial<LocalPlaybackReport> = {}): LocalPlaybackReport {
  return {
    deviceId: 'dev1',
    active: true,
    playing: true,
    positionMs: 5000,
    durationMs: 200_000,
    track: {
      id: 't1',
      uri: 'spotify:track:t1',
      name: 'One',
      durationMs: 200_000,
      artists: [{ name: 'The Band', uri: 'spotify:artist:a1' }],
      album: {
        name: 'Album One',
        uri: 'spotify:album:al1',
        images: [{ url: 'http://img.example/one.jpg', width: 640, height: 640 }],
      },
    },
    shuffle: false,
    repeat: 0,
    volume: 0.42,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('sharedPlaybackReads with a local SDK report', () => {
  it('answers from the report instead of calling Spotify, and never counts a request', async () => {
    let t = 1000;
    const api = new FakeApi();
    const local = new LocalPlaybackSource(() => t);
    local.accept(report({ positionMs: 5000 }));
    const shared = sharedPlaybackReads(api, () => t, local);

    const state = await shared.currentPlayback();
    expect(api.currentPlaybackCalls).toBe(0);
    expect(state).toMatchObject({
      device: {
        id: 'dev1',
        is_active: true,
        is_private_session: false,
        is_restricted: false,
        name: '',
        type: 'Computer',
        volume_percent: 42,
      },
      is_playing: true,
      progress_ms: 5000,
      shuffle_state: false,
      repeat_state: 'off',
      timestamp: 1000,
      item: {
        id: 't1',
        uri: 'spotify:track:t1',
        name: 'One',
        duration_ms: 200_000,
        disc_number: 0,
        track_number: 0,
        artists: [{ id: 'a1', name: 'The Band' }],
        album: {
          id: 'al1',
          name: 'Album One',
          images: [{ url: 'http://img.example/one.jpg', width: 640, height: 640 }],
        },
      },
    });
  });

  it('uses the cached device name when the device list was already read', async () => {
    let t = 1000;
    const api = new FakeApi();
    api.devicesData = [{ ...SIM_DEVICE, id: 'dev1', name: 'rune — This Mac' }];
    const local = new LocalPlaybackSource(() => t);
    const shared = sharedPlaybackReads(api, () => t, local);
    await shared.devices();
    t += 1000;
    local.accept(report());

    const state = await shared.currentPlayback();
    expect(api.currentPlaybackCalls).toBe(0);
    expect(state?.device?.name).toBe('rune — This Mac');
  });

  it('extrapolates the position while playing and clamps it to the duration', async () => {
    let t = 1000;
    const api = new FakeApi();
    const local = new LocalPlaybackSource(() => t);
    local.accept(report({ positionMs: 5000, durationMs: 200_000 }));
    const shared = sharedPlaybackReads(api, () => t, local);

    t = 6000;
    expect((await shared.currentPlayback())?.progress_ms).toBe(10_000);

    local.accept(report({ positionMs: 55_000, durationMs: 60_000 }));
    t += 10_000; // would be 65 s: clamped to the duration
    expect((await shared.currentPlayback())?.progress_ms).toBe(60_000);
  });

  it('does not extrapolate while paused', async () => {
    let t = 1000;
    const api = new FakeApi();
    const local = new LocalPlaybackSource(() => t);
    local.accept(report({ playing: false, positionMs: 5000 }));
    const shared = sharedPlaybackReads(api, () => t, local);
    t += 10_000;
    const state = await shared.currentPlayback();
    expect(state?.is_playing).toBe(false);
    expect(state?.progress_ms).toBe(5000);
  });

  it('maps repeat 0/1/2 to off/context/track', async () => {
    let t = 1000;
    const api = new FakeApi();
    const local = new LocalPlaybackSource(() => t);
    const shared = sharedPlaybackReads(api, () => t, local);
    const repeatFor = async (repeat: 0 | 1 | 2) => {
      local.accept(report({ repeat }));
      return (await shared.currentPlayback())?.repeat_state;
    };
    expect(await repeatFor(0)).toBe('off');
    expect(await repeatFor(1)).toBe('context');
    expect(await repeatFor(2)).toBe('track');
    expect(api.currentPlaybackCalls).toBe(0);
  });

  it('falls back to the real API when the report is stale (20 s old)', async () => {
    let t = 1000;
    const api = new FakeApi();
    const local = new LocalPlaybackSource(() => t);
    local.accept(report());
    const shared = sharedPlaybackReads(api, () => t, local);

    t += 19_999;
    await shared.currentPlayback();
    expect(api.currentPlaybackCalls).toBe(0);

    t += 1; // exactly 20 s: stale
    const state = await shared.currentPlayback();
    expect(api.currentPlaybackCalls).toBe(1);
    expect(state?.item?.name).toBe('Real API');
  });

  it('ignores a report that predates a just-sent command, then trusts a newer report', async () => {
    let t = 1000;
    const api = new FakeApi();
    const local = new LocalPlaybackSource(() => t);
    local.accept(report());
    const shared = sharedPlaybackReads(api, () => t, local);

    // The command wins for 4 s: the report describes the state before it.
    await shared.pause('dev1');
    await shared.currentPlayback();
    expect(api.currentPlaybackCalls).toBe(1);

    // Four seconds later the hold expires and the report is used again.
    t += 4000;
    await shared.currentPlayback();
    expect(api.currentPlaybackCalls).toBe(1);

    // A report received after the command wins immediately.
    t += 1000;
    await shared.pause('dev1');
    t += 100;
    local.accept(report({ playing: false }));
    const state = await shared.currentPlayback();
    expect(api.currentPlaybackCalls).toBe(1);
    expect(state?.is_playing).toBe(false);
  });

  it('clears the report when a command targets another device', async () => {
    let t = 1000;
    const api = new FakeApi();
    const local = new LocalPlaybackSource(() => t);
    local.accept(report({ deviceId: 'dev1' }));
    const shared = sharedPlaybackReads(api, () => t, local);

    await shared.play({ uris: ['spotify:track:x'] }, 'dev2');
    await shared.currentPlayback();
    expect(api.currentPlaybackCalls).toBe(1);
  });

  it('does not clear the report for a command without a device id or for the same device', async () => {
    let t = 1000;
    const api = new FakeApi();
    const local = new LocalPlaybackSource(() => t);
    local.accept(report({ deviceId: 'dev1' }));
    const shared = sharedPlaybackReads(api, () => t, local);

    await shared.pause(); // active device: the report stays
    t += 4000; // let the command hold expire
    expect((await shared.currentPlayback())?.device?.id).toBe('dev1');

    local.accept(report({ deviceId: 'dev1' }));
    await shared.pause('dev1');
    t += 4000;
    expect((await shared.currentPlayback())?.device?.id).toBe('dev1');
    expect(api.currentPlaybackCalls).toBe(0);
  });

  it('clears the report on an active:false report for the same device', async () => {
    let t = 1000;
    const api = new FakeApi();
    const local = new LocalPlaybackSource(() => t);
    local.accept(report({ deviceId: 'dev1' }));
    local.accept(report({ deviceId: 'dev1', active: false }));
    const shared = sharedPlaybackReads(api, () => t, local);

    await shared.currentPlayback();
    expect(api.currentPlaybackCalls).toBe(1);
  });
});

describe('LocalPlaybackSource wake', () => {
  it('wakes once for a burst of changes, throttled to one per 500 ms', () => {
    vi.useFakeTimers();
    let t = 1000;
    const local = new LocalPlaybackSource(() => t);
    const wake = vi.fn();
    local.setWake(wake);

    local.accept(report());
    expect(wake).toHaveBeenCalledTimes(1); // first report wakes at once

    // Same track and flags: position changes alone do not wake.
    local.accept(report({ positionMs: 9000 }));
    expect(wake).toHaveBeenCalledTimes(1);

    // A playing change during the debounce window is coalesced.
    local.accept(report({ playing: false }));
    local.accept(report({ shuffle: true }));
    expect(wake).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(500);
    expect(wake).toHaveBeenCalledTimes(2); // one trailing wake for the whole burst
    vi.advanceTimersByTime(500); // let the trailing wake's own window close

    // A new track after the window wakes at once again.
    t += 10_000;
    local.accept(report({ track: { ...report().track!, id: 't2', uri: 'spotify:track:t2' } }));
    expect(wake).toHaveBeenCalledTimes(3);
  });

  it('does not wake for an unchanged report or an inactive one', () => {
    let t = 1000;
    const local = new LocalPlaybackSource(() => t);
    const wake = vi.fn();
    local.setWake(wake);
    local.accept(report());
    wake.mockClear();

    local.accept(report());
    local.accept(report({ active: false }));
    expect(wake).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('parseLocalPlaybackReport', () => {
  it('accepts a full active report and normalises its shape', () => {
    expect(parseLocalPlaybackReport(report())).toEqual(report());
  });

  it('accepts a minimal inactive report', () => {
    expect(parseLocalPlaybackReport({ type: 'sdk-state', deviceId: 'dev1', active: false })).toMatchObject({
      deviceId: 'dev1',
      active: false,
      track: null,
    });
  });

  it('drops malformed reports', () => {
    const bad: unknown[] = [
      null,
      'nope',
      {},
      { deviceId: 'dev1' }, // no active flag
      { deviceId: '', active: true },
      { deviceId: 'dev1', active: true }, // missing fields
      report({ volume: 1.5 }),
      report({ volume: -0.1 }),
      report({ positionMs: -1 }),
      report({ positionMs: Number.NaN }),
      report({ repeat: 3 as unknown as 0 }),
      report({ playing: 'yes' as unknown as boolean }),
      report({ track: null }),
      report({ track: { ...report().track!, id: '' } }),
      report({ track: { ...report().track!, artists: [{ name: 'x' } as unknown as { name: string; uri: string }] } }),
      report({
        track: {
          ...report().track!,
          album: {
            ...report().track!.album,
            images: [{ width: 1 } as unknown as { url: string; width: number | null; height: number | null }],
          },
        },
      }),
    ];
    for (const value of bad) expect(parseLocalPlaybackReport(value), JSON.stringify(value)).toBeNull();
  });
});
