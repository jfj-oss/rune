import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  SpotifyDevice,
  SpotifyPlayBody,
  SpotifyPlaybackState,
  SpotifyQueue,
  SpotifyTrack,
} from '../src/spotify/api.js';
import {
  SpotifyConnectZone,
  createSpotifyZones,
  emptyPlayerState,
  mapPlaybackState,
  sharedPlaybackReads,
  type SpotifyZoneApi,
} from '../src/spotify/zones.js';
import { mapTrack } from '../src/spotify/map.js';
import { SIM_DEVICE, playbackState, sampleTrack } from './spotify-helpers.js';

class FakeZoneApi implements SpotifyZoneApi {
  devicesData: SpotifyDevice[] = [];
  playback: SpotifyPlaybackState | null = null;
  queueData: SpotifyQueue = { currently_playing: null, queue: [] };
  tracksData = new Map<string, SpotifyTrack>();
  calls: { method: string; args: unknown[] }[] = [];
  currentPlaybackCalls = 0;

  async devices(): Promise<SpotifyDevice[]> {
    return this.devicesData;
  }
  async tracks(ids: string[]): Promise<SpotifyTrack[]> {
    return ids.map((id) => this.tracksData.get(id)).filter((t): t is SpotifyTrack => !!t);
  }
  async currentPlayback(): Promise<SpotifyPlaybackState | null> {
    this.currentPlaybackCalls++;
    return this.playback;
  }
  async queue(): Promise<SpotifyQueue> {
    return this.queueData;
  }
  async play(body: SpotifyPlayBody, deviceId?: string): Promise<void> {
    this.calls.push({ method: 'play', args: [body, deviceId] });
  }
  async pause(deviceId?: string): Promise<void> {
    this.calls.push({ method: 'pause', args: [deviceId] });
  }
  async next(deviceId?: string): Promise<void> {
    this.calls.push({ method: 'next', args: [deviceId] });
  }
  async previous(deviceId?: string): Promise<void> {
    this.calls.push({ method: 'previous', args: [deviceId] });
  }
  async seek(positionMs: number, deviceId?: string): Promise<void> {
    this.calls.push({ method: 'seek', args: [positionMs, deviceId] });
  }
  async setVolume(percent: number, deviceId?: string): Promise<void> {
    this.calls.push({ method: 'setVolume', args: [percent, deviceId] });
  }
  async setShuffle(on: boolean, deviceId?: string): Promise<void> {
    this.calls.push({ method: 'setShuffle', args: [on, deviceId] });
  }
  async setRepeat(mode: 'off' | 'track' | 'context', deviceId?: string): Promise<void> {
    this.calls.push({ method: 'setRepeat', args: [mode, deviceId] });
  }
  async enqueue(uri: string, deviceId?: string): Promise<void> {
    this.calls.push({ method: 'enqueue', args: [uri, deviceId] });
  }
}

function callsOf(api: FakeZoneApi, method: string) {
  return api.calls.filter((c) => c.method === method);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Spotify Connect zones', () => {
  it('lists Connect devices as spotify zones', async () => {
    const api = new FakeZoneApi();
    api.devicesData = [
      SIM_DEVICE,
      { ...SIM_DEVICE, id: 'dev2', name: 'Kitchen Speaker' },
      { ...SIM_DEVICE, id: null, name: 'Not addressable' },
    ];
    const zones = createSpotifyZones(api);

    const list = await zones.listZones();
    expect(list).toEqual([
      { id: 'spotify:dev1', name: 'Sim Phone', kind: 'spotify' },
      { id: 'spotify:dev2', name: 'Kitchen Speaker', kind: 'spotify' },
    ]);
    expect(zones.get('spotify:dev1')).toBeInstanceOf(SpotifyConnectZone);
    expect(zones.get('spotify:dev2')?.name).toBe('Kitchen Speaker');
  });

  it('maps play to uris + offset on the device and reflects /me/player', async () => {
    const api = new FakeZoneApi();
    api.tracksData.set('t1', sampleTrack('t1', 1, 'Come Together'));
    api.tracksData.set('t2', sampleTrack('t2', 2, 'Something'));
    api.playback = playbackState(sampleTrack('t2'));
    api.queueData = { currently_playing: sampleTrack('t2'), queue: [sampleTrack('t3', 3, 'Maxwell')] };

    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone', { now: () => 1000 });
    const state = await zone.command({ type: 'play', trackIds: ['sp:t1', 'sp:t2'], startIndex: 1 });

    const [play] = callsOf(api, 'play');
    expect(play?.args[0]).toEqual({
      uris: ['spotify:track:t1', 'spotify:track:t2'],
      offset: { position: 1 },
    });
    expect(play?.args[1]).toBe('dev1');

    expect(state.zone).toBe('spotify:dev1');
    expect(state.status).toBe('playing');
    expect(state.index).toBe(1);
    expect(state.queue.map((q) => q.track.id)).toEqual(['sp:t1', 'sp:t2', 'sp:t3']);
    expect(state.queue[0]?.album).toEqual({ id: 'sp:abbey', title: 'Abbey Road', coverUrl: 'http://img.example/abbey-640.jpg' });
    expect(state.positionMs).toBe(12_345);
    expect(state.volume).toBe(42);
    expect(state.updatedAt).toBe(1000);
  });

  it('reports nothing playing when another device is the active one', async () => {
    const api = new FakeZoneApi();
    api.playback = playbackState(sampleTrack('t1'), { device: { ...SIM_DEVICE, id: 'browser-tab', name: 'rune — This Mac' } });
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone', { now: () => 1000 });
    await (zone as unknown as { refresh(): Promise<unknown> }).refresh();
    expect(zone.state().status).toBe('stopped');
    expect(zone.state().queue).toEqual([]);
  });

  it('after play, waits for Spotify to switch to this device instead of reporting the old one', async () => {
    const api = new FakeZoneApi();
    api.playback = playbackState(sampleTrack('t1'), { device: { ...SIM_DEVICE, id: 'browser-tab' } });
    let polls = 0;
    api.currentPlayback = async () => {
      polls++;
      return polls < 3 ? playbackState(sampleTrack('t1'), { device: { ...SIM_DEVICE, id: 'browser-tab' } }) : playbackState(sampleTrack('t1'));
    };
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone', { now: () => 1000 });
    const state = await zone.command({ type: 'play', trackIds: ['sp:t1'] });
    expect(polls).toBe(3);
    expect(state.status).toBe('playing');
  });

  it('keeps a just-set volume while Spotify still reports the old one', async () => {
    const api = new FakeZoneApi();
    api.playback = playbackState(sampleTrack('t1')); // device reports 42
    let t = 1000;
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone', { now: () => t });
    const state = await zone.command({ type: 'volume', volume: 70 });
    expect(state.volume).toBe(70);
    t += 5000; // hold expired: trust Spotify again
    await (zone as unknown as { refresh(): Promise<unknown> }).refresh();
    expect(zone.state().volume).toBe(42);
  });

  it('rejects local track ids with a clear error and no call', async () => {
    const api = new FakeZoneApi();
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone');
    await expect(zone.command({ type: 'play', trackIds: ['l:abc'] })).rejects.toThrow(
      /only Spotify tracks/,
    );
    expect(api.calls).toHaveLength(0);
  });

  it('enqueues each Spotify uri by appending', async () => {
    const api = new FakeZoneApi();
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone');
    await zone.command({ type: 'enqueue', trackIds: ['sp:t1', 'sp:t2'], next: true });
    expect(callsOf(api, 'enqueue').map((c) => c.args)).toEqual([
      ['spotify:track:t1', 'dev1'],
      ['spotify:track:t2', 'dev1'],
    ]);
  });

  it('maps transport, volume, shuffle and repeat commands', async () => {
    const api = new FakeZoneApi();
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone');

    await zone.command({ type: 'pause' });
    await zone.command({ type: 'resume' });
    await zone.command({ type: 'next' });
    await zone.command({ type: 'prev' });
    await zone.command({ type: 'seek', positionMs: 90_000 });
    await zone.command({ type: 'volume', volume: 33 });
    await zone.command({ type: 'shuffle', on: true });
    await zone.command({ type: 'repeat', mode: 'all' });
    await zone.command({ type: 'repeat', mode: 'one' });
    await zone.command({ type: 'repeat', mode: 'off' });

    expect(callsOf(api, 'pause')).toEqual([{ method: 'pause', args: ['dev1'] }]);
    expect(callsOf(api, 'play').map((c) => c.args)).toEqual([[{}, 'dev1']]);
    expect(callsOf(api, 'next')[0]?.args).toEqual(['dev1']);
    expect(callsOf(api, 'previous')[0]?.args).toEqual(['dev1']);
    expect(callsOf(api, 'seek')[0]?.args).toEqual([90_000, 'dev1']);
    expect(callsOf(api, 'setVolume')[0]?.args).toEqual([33, 'dev1']);
    expect(callsOf(api, 'setShuffle')[0]?.args).toEqual([true, 'dev1']);
    expect(callsOf(api, 'setRepeat').map((c) => c.args[0])).toEqual(['context', 'track', 'off']);
  });

  it('jumps by replaying the remaining queue uris', async () => {
    const api = new FakeZoneApi();
    api.playback = playbackState(sampleTrack('t1'));
    api.queueData = {
      currently_playing: sampleTrack('t1'),
      queue: [sampleTrack('t2', 2, 'Something'), sampleTrack('t3', 3, 'Maxwell')],
    };
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone');
    await zone.command({ type: 'play', trackIds: ['sp:t1'] });

    const state = await zone.command({ type: 'jump', index: 1 });
    expect(state.queue.map((q) => q.track.id)).toEqual(['sp:t1', 'sp:t2', 'sp:t3']);
    const plays = callsOf(api, 'play');
    expect(plays.at(-1)?.args[0]).toEqual({
      uris: ['spotify:track:t2', 'spotify:track:t3'],
    });
  });

  it('rejects remove and out-of-range jump', async () => {
    const api = new FakeZoneApi();
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone');
    await expect(zone.command({ type: 'remove', queueId: 'x' })).rejects.toThrow(/no Web API/i);
    await expect(zone.command({ type: 'jump', index: 4 })).rejects.toThrow(/No queue item/);
  });

  it('polls every second while playing and stops when the last listener leaves', async () => {
    vi.useFakeTimers();
    const api = new FakeZoneApi();
    api.playback = playbackState(sampleTrack('t1'));
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone', { pollMsPlaying: 1000, pollMsIdle: 3000 });

    const unsubscribe = zone.onChange(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(api.currentPlaybackCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(api.currentPlaybackCalls).toBe(2);

    unsubscribe();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.currentPlaybackCalls).toBe(2);
    await zone.close();
  });
});

describe('mapPlaybackState', () => {
  it('returns an empty stopped state when nothing is playing', () => {
    expect(mapPlaybackState('spotify:dev1', null, undefined, [], () => 7)).toEqual({
      ...emptyPlayerState('spotify:dev1', () => 7),
    });
  });

  it('maps pause, repeat and volume from /me/player', () => {
    const state = mapPlaybackState(
      'spotify:dev1',
      playbackState(sampleTrack('t1'), {
        is_playing: false,
        repeat_state: 'context',
        shuffle_state: true,
        device: { ...SIM_DEVICE, volume_percent: 17 },
      }),
      undefined,
      [],
      () => 5,
    );
    expect(state.status).toBe('paused');
    expect(state.index).toBe(0);
    expect(state.repeat).toBe('all');
    expect(state.shuffle).toBe(true);
    expect(state.volume).toBe(17);

    const one = mapPlaybackState('z', playbackState(sampleTrack('t1'), { repeat_state: 'track' }), undefined);
    expect(one.repeat).toBe('one');
  });

  it('combines the list we started with /me/player/queue and dedupes', () => {
    const started = [
      {
        queueId: 'q1',
        track: mapTrack(sampleTrack('t1')),
        album: { id: 'sp:abbey', title: 'Abbey Road' },
      },
    ];

    const state = mapPlaybackState(
      'spotify:dev1',
      playbackState(sampleTrack('t1')),
      {
        currently_playing: sampleTrack('t1'),
        queue: [sampleTrack('t1'), sampleTrack('t2', 2, 'Something')],
      },
      started,
    );
    expect(state.queue.map((q) => q.track.id)).toEqual(['sp:t1', 'sp:t2']);
    expect(state.index).toBe(0);
    expect(state.status).toBe('playing');
  });
});

describe('sharedPlaybackReads', () => {
  it('shares /me/player between zones and drops the cache after a command', async () => {
    const api = new FakeZoneApi();
    api.playback = playbackState(sampleTrack('t1'));
    let t = 1000;
    const shared = sharedPlaybackReads(api, () => t);
    await Promise.all([shared.currentPlayback(), shared.currentPlayback(), shared.currentPlayback()]);
    expect(api.currentPlaybackCalls).toBe(1);
    await shared.pause('dev1');
    await shared.currentPlayback();
    expect(api.currentPlaybackCalls).toBe(2);
    t += 5000;
    await shared.currentPlayback();
    expect(api.currentPlaybackCalls).toBe(3);
  });
});

describe('placeholder queue entries', () => {
  it('fills a blank started entry with what /me/player says about the playing track', () => {
    const placeholder = { queueId: 'spq:0:sp:t1', track: { id: 'sp:t1', albumId: 'sp:unknown', source: 'spotify' as const, title: '', artists: [], disc: 1, number: 1, durationMs: 0 }, album: { id: 'sp:unknown', title: '' } };
    const state = mapPlaybackState('spotify:dev1', playbackState(sampleTrack('t1', 1, 'Come Together')), undefined, [placeholder]);
    expect(state.queue[0]?.track.title).toBe('Come Together');
    expect(state.queue[0]?.album.title).toBe('Abbey Road');
    expect(state.index).toBe(0);
  });
});
