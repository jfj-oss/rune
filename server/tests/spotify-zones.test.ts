import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  SpotifyBudgetLevel,
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
  queueCalls = 0;
  deviceCalls = 0;
  trackCalls = 0;
  /** Delay for GET /tracks/{id}, so a test can prove 'play' does not wait for metadata. */
  trackDelayMs = 0;

  async devices(): Promise<SpotifyDevice[]> {
    this.deviceCalls++;
    return this.devicesData;
  }
  async tracks(ids: string[]): Promise<SpotifyTrack[]> {
    return ids.map((id) => this.tracksData.get(id)).filter((t): t is SpotifyTrack => !!t);
  }
  async track(id: string): Promise<SpotifyTrack> {
    this.trackCalls++;
    if (this.trackDelayMs > 0) await new Promise((r) => setTimeout(r, this.trackDelayMs));
    const track = this.tracksData.get(id);
    if (!track) throw Object.assign(new Error(`no track ${id}`), { status: 404 });
    return track;
  }
  async currentPlayback(): Promise<SpotifyPlaybackState | null> {
    this.currentPlaybackCalls++;
    return this.playback;
  }
  async queue(): Promise<SpotifyQueue> {
    this.queueCalls++;
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

  it('a fast volume drag sends only the newest level and no extra player reads', async () => {
    const api = new FakeZoneApi();
    api.playback = playbackState(sampleTrack('t1'));
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone', { now: () => 1000 });
    const reads = () => api.currentPlaybackCalls;
    const before = reads();
    await Promise.all([10, 20, 30, 40, 50].map((volume) => zone.command({ type: 'volume', volume })));
    const sent = callsOf(api, 'setVolume').map((c) => c.args[0]);
    expect(sent[0]).toBe(10);
    expect(sent.at(-1)).toBe(50);
    expect(sent.length).toBeLessThanOrEqual(2);
    expect(reads()).toBe(before);
    expect(zone.state().volume).toBe(50);
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

  it('jumps by replaying the queue from the picked song (explicit offset, safe with shuffle)', async () => {
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
      uris: ['spotify:track:t1', 'spotify:track:t2', 'spotify:track:t3'],
      offset: { position: 1 },
    });
  });

  it('shows the next song at once while Spotify still reports the old one', async () => {
    const api = new FakeZoneApi();
    api.playback = playbackState(sampleTrack('t1'));
    api.queueData = { currently_playing: sampleTrack('t1'), queue: [sampleTrack('t2', 2, 'Something'), sampleTrack('t3', 3, 'Maxwell')] };
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone');
    await zone.command({ type: 'play', trackIds: ['sp:t1'] });
    const seen: string[] = [];
    zone.onChange((st) => seen.push(st.queue[st.index]?.track.id ?? ''));

    // Spotify keeps answering with t1 for a moment after "next"
    const state = await zone.command({ type: 'next' });
    expect(state.queue[state.index]?.track.id).toBe('sp:t2');
    expect(state.positionMs).toBe(0);
    expect(seen[0]).toBe('sp:t2'); // listeners hear it before Spotify answers

    // once Spotify reports t2, the hold ends and real data flows again
    api.playback = playbackState(sampleTrack('t2', 2, 'Something'));
    api.queueData = { currently_playing: sampleTrack('t2', 2, 'Something'), queue: [sampleTrack('t3', 3, 'Maxwell')] };
    const after = await zone.command({ type: 'seek', positionMs: 5000 });
    expect(after.queue[after.index]?.track.id).toBe('sp:t2');
    zone.close();
  });

  it('rejects remove and out-of-range jump', async () => {
    const api = new FakeZoneApi();
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone');
    await expect(zone.command({ type: 'remove', queueId: 'x' })).rejects.toThrow(/no Web API/i);
    await expect(zone.command({ type: 'jump', index: 4 })).rejects.toThrow(/No queue item/);
  });

  it('polls once the playing song has finished (capped at 30 s) and stops when the last listener leaves', async () => {
    vi.useFakeTimers();
    const api = new FakeZoneApi();
    api.playback = playbackState(sampleTrack('t1')); // 259 s long, 12 s in
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone');

    const unsubscribe = zone.onChange(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(api.currentPlaybackCalls).toBe(1);

    // 246 s left would be far away; the watched playing cap is 30 s.
    await vi.advanceTimersByTimeAsync(29_999);
    expect(api.currentPlaybackCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.currentPlaybackCalls).toBe(2);

    unsubscribe();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.currentPlaybackCalls).toBe(2);
    await zone.close();
  });

  it('a song another device kept is dropped just after the claim runs out, not at the next background poll', async () => {
    vi.useFakeTimers();
    const api = new FakeZoneApi();
    api.playback = playbackState(sampleTrack('old'), { progress_ms: 10_000, device: { ...SIM_DEVICE, id: 'elsewhere' } });
    api.playback.item!.duration_ms = 300_000;
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone');
    zone.onChange(() => {});
    await vi.advanceTimersByTimeAsync(0);

    const started = zone.command({ type: 'play', trackIds: ['sp:new'] });
    await vi.advanceTimersByTimeAsync(1_100); // the settle tries
    await started;
    expect(zone.state().status).toBe('playing');

    await vi.advanceTimersByTimeAsync(3_800); // both fast follow-ups, still inside the 5 s claim
    expect(zone.state().status).toBe('playing');
    await vi.advanceTimersByTimeAsync(500);
    expect(zone.state().status).toBe('stopped');
    await zone.close();
  });

  it('a song the device ignored gives way to what it reports just after the track hold runs out', async () => {
    vi.useFakeTimers();
    const api = new FakeZoneApi();
    api.playback = playbackState(sampleTrack('old'), { progress_ms: 10_000 });
    api.playback.item!.duration_ms = 300_000;
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone');
    zone.onChange(() => {});
    await vi.advanceTimersByTimeAsync(0);

    await zone.command({ type: 'play', trackIds: ['sp:new'] });
    expect(zone.state().queue[zone.state().index]?.track.id).toBe('sp:new');

    await vi.advanceTimersByTimeAsync(3_900); // the follow-ups at 1 s and 3 s are held
    expect(zone.state().queue[zone.state().index]?.track.id).toBe('sp:new');
    await vi.advanceTimersByTimeAsync(400);
    expect(zone.state().queue[zone.state().index]?.track.id).toBe('sp:old');
    await zone.close();
  });

  it('an expired hold never turns into fast polling', async () => {
    vi.useFakeTimers();
    const api = new FakeZoneApi();
    api.playback = playbackState(sampleTrack('old'), { progress_ms: 10_000 });
    api.playback.item!.duration_ms = 300_000;
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone');
    zone.onChange(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await zone.command({ type: 'play', trackIds: ['sp:new'] });
    await vi.advanceTimersByTimeAsync(5_000);
    const reads = api.currentPlaybackCalls;
    await vi.advanceTimersByTimeAsync(29_000); // the 30 s background cap has not come round again
    expect(api.currentPlaybackCalls).toBe(reads);
    await zone.close();
  });

  it('schedules the next poll just after the track ends: 40 s left → 30 s, 8 s left → 9.5 s', async () => {
    vi.useFakeTimers();

    // 40 s left: the 30 s cap wins.
    const apiLong = new FakeZoneApi();
    apiLong.playback = playbackState(sampleTrack('t1'), { progress_ms: 20_000 });
    apiLong.playback.item!.duration_ms = 60_000;
    const longZone = new SpotifyConnectZone(apiLong, 'dev1', 'Sim Phone');
    longZone.onChange(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(apiLong.currentPlaybackCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(apiLong.currentPlaybackCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(apiLong.currentPlaybackCalls).toBe(2);
    await longZone.close();

    // 8 s left: poll 1.5 s after the song ends.
    const apiShort = new FakeZoneApi();
    apiShort.playback = playbackState(sampleTrack('t1'), { progress_ms: 52_000 });
    apiShort.playback.item!.duration_ms = 60_000;
    const shortZone = new SpotifyConnectZone(apiShort, 'dev1', 'Sim Phone');
    shortZone.onChange(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(apiShort.currentPlaybackCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(9_499);
    expect(apiShort.currentPlaybackCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(apiShort.currentPlaybackCalls).toBe(2);
    await shortZone.close();
  });

  it('polls every 20 s while paused and watched', async () => {
    vi.useFakeTimers();
    const api = new FakeZoneApi();
    api.playback = playbackState(sampleTrack('t1'), { is_playing: false });
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone');
    zone.onChange(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(api.currentPlaybackCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(19_999);
    expect(api.currentPlaybackCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.currentPlaybackCalls).toBe(2);
    await zone.close();
  });

  it('reuses the queue while the item is unchanged and re-reads it when the item changes', async () => {
    vi.useFakeTimers();
    const api = new FakeZoneApi();
    api.playback = playbackState(sampleTrack('t1'), { progress_ms: 0 });
    api.playback.item!.duration_ms = 600_000;
    api.queueData = {
      currently_playing: sampleTrack('t1'),
      queue: [sampleTrack('t2', 2, 'Something')],
    };
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone');
    zone.onChange(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(api.currentPlaybackCalls).toBe(1);
    expect(api.queueCalls).toBe(1);

    // A plain position poll (same item, 30 s later) does not re-read the queue.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.currentPlaybackCalls).toBe(2);
    expect(api.queueCalls).toBe(1);

    // The item changes: this poll reads the queue once, then reuses it again.
    api.playback = playbackState(sampleTrack('t2', 2, 'Something'), { progress_ms: 0 });
    api.playback.item!.duration_ms = 600_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.currentPlaybackCalls).toBe(3);
    expect(api.queueCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.currentPlaybackCalls).toBe(4);
    expect(api.queueCalls).toBe(2);
    await zone.close();
  });

  it('refreshes the cached queue after five minutes even when the item did not change', async () => {
    vi.useFakeTimers();
    const api = new FakeZoneApi();
    api.playback = playbackState(sampleTrack('t1'), { progress_ms: 0 });
    api.playback.item!.duration_ms = 600_000;
    api.queueData = { currently_playing: sampleTrack('t1'), queue: [] };
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone');
    zone.onChange(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(api.queueCalls).toBe(1);

    // 9 polls × 30 s: still the same cached queue (last read at 0 s).
    await vi.advanceTimersByTimeAsync(270_000);
    expect(api.queueCalls).toBe(1);

    // At 300 s the cached answer is stale: read it again.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.currentPlaybackCalls).toBe(11);
    expect(api.queueCalls).toBe(2);
    await zone.close();
  });

  it('picks up a track change within 2 s of the song ending', async () => {
    vi.useFakeTimers();
    const api = new FakeZoneApi();
    api.playback = playbackState(sampleTrack('t1'), { progress_ms: 9_000 });
    api.playback.item!.duration_ms = 10_000;
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone');
    zone.onChange(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(api.currentPlaybackCalls).toBe(1);

    // The song ends at 1 s and Spotify moves on to t2.
    api.playback = playbackState(sampleTrack('t2', 2, 'Something'), { progress_ms: 0 });
    // The scheduled poll is at 1 s (remaining) + 1.5 s slack = 2.5 s.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.currentPlaybackCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(api.currentPlaybackCalls).toBe(2);
    const state = zone.state();
    expect(state.queue[state.index]?.track.id).toBe('sp:t2');
    await zone.close();
  });

  it('polls slowly and skips the queue while no client is connected, then speeds up on connect', async () => {
    vi.useFakeTimers();
    const api = new FakeZoneApi();
    api.playback = playbackState(sampleTrack('t1'), { progress_ms: 0 });
    api.playback.item!.duration_ms = 600_000;
    let connected = false;
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone', {
      hasClients: () => connected,
    });
    zone.onChange(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(api.currentPlaybackCalls).toBe(1);
    expect(api.queueCalls).toBe(0); // nobody to show the queue to

    // Unwatched playing: 60 s (the track has 10 min left).
    await vi.advanceTimersByTimeAsync(59_999);
    expect(api.currentPlaybackCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.currentPlaybackCalls).toBe(2);
    expect(api.queueCalls).toBe(0);

    // A client connects: poll at once and read the queue; 30 s while playing.
    connected = true;
    zone.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.currentPlaybackCalls).toBe(3);
    expect(api.queueCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.currentPlaybackCalls).toBe(4);

    // Idle and unwatched: 300 s.
    api.playback = playbackState(sampleTrack('t1', 1, 'Come Together'), { is_playing: false });
    connected = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.currentPlaybackCalls).toBe(5);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(api.currentPlaybackCalls).toBe(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.currentPlaybackCalls).toBe(6);
    expect(api.queueCalls).toBe(1);
    await zone.close();
  });

  it('does not poll Spotify while the quota circuit breaker is open, then resumes', async () => {
    vi.useFakeTimers();
    const api = new FakeZoneApi();
    api.playback = playbackState(sampleTrack('t1'));
    const unblockAt = Date.now() + 5000;
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone', {
      blockedUntil: () => unblockAt,
    });
    zone.onChange(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(api.currentPlaybackCalls).toBe(0);

    // Parked until blockedUntil + 1 s: nothing goes out for the whole block.
    await vi.advanceTimersByTimeAsync(5999);
    expect(api.currentPlaybackCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.currentPlaybackCalls).toBe(1);

    // Back to the normal background delay (30 s cap while a long song plays).
    await vi.advanceTimersByTimeAsync(29_999);
    expect(api.currentPlaybackCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.currentPlaybackCalls).toBe(2);
    await zone.close();
  });

  it("'play' shows songs rune already has at once and only looks up the unknown ones", async () => {
    const api = new FakeZoneApi();
    api.playback = playbackState(sampleTrack('t1'));
    api.queueData = { currently_playing: sampleTrack('t1'), queue: [] };
    api.tracksData.set('t3', sampleTrack('t3', 3, 'Maxwell'));
    const known = (ids: string[]) =>
      ids.filter((id) => id !== 'sp:t3').map((id, i) => ({
        queueId: `db${i}`,
        track: { ...mapTrack(sampleTrack(id.slice(3), i + 1, `Known ${id}`)) },
        album: { id: 'sp:abbey', title: 'Abbey Road' },
      }));
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone', { knownTracks: known });
    const states: ReturnType<typeof zone.state>[] = [];
    zone.onChange((st) => states.push(st));
    await zone.command({ type: 'play', trackIds: ['sp:t1', 'sp:t2', 'sp:t3'], startIndex: 0 });
    expect(states[0]?.queue.map((q) => q.track.title)).toEqual(['Known sp:t1', 'Known sp:t2', '']);
    await vi.waitFor(() => expect(zone.state().queue[2]?.track.title).toBe('Maxwell'));
    expect(api.trackCalls).toBe(1); // only t3 was asked from Spotify
    zone.close();
  });

  it("returns from 'play' before slow metadata lookups finish and fills titles when they arrive", async () => {
    vi.useFakeTimers();
    const api = new FakeZoneApi();
    api.playback = playbackState(sampleTrack('t1'));
    api.queueData = { currently_playing: sampleTrack('t1'), queue: [] };
    api.tracksData.set('t1', sampleTrack('t1', 1, 'Come Together'));
    api.tracksData.set('t2', sampleTrack('t2', 2, 'Something'));
    api.trackDelayMs = 2000;
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone');
    const states: ReturnType<typeof zone.state>[] = [];
    zone.onChange((s) => states.push(s));

    let resolved = false;
    const started = zone
      .command({ type: 'play', trackIds: ['sp:t1', 'sp:t2'], startIndex: 0 })
      .then((s) => {
        resolved = true;
        return s;
      });

    // Well before the 2 s lookups: the command has returned and listeners saw the song.
    await vi.advanceTimersByTimeAsync(100);
    expect(resolved).toBe(true);
    expect(states[0]?.queue[states[0].index ?? 0]?.track.id).toBe('sp:t1');
    expect(states[0]?.queue[0]?.track.title).toBe(''); // placeholder, no metadata yet
    expect(zone.state().queue[1]?.track.title).toBe('');

    await vi.advanceTimersByTimeAsync(2000);
    expect(api.trackCalls).toBe(2);
    expect(zone.state().queue[0]?.track.title).toBe('Come Together');
    expect(zone.state().queue[1]?.track.title).toBe('Something');
    expect(states.some((s) => s.queue[1]?.track.title === 'Something')).toBe(true);
    await started;
    await zone.close();
  });

  it('polls ~1 s and ~3 s after a command, even when the budget is out', async () => {
    vi.useFakeTimers();
    const api = new FakeZoneApi();
    api.playback = playbackState(sampleTrack('t1'), { progress_ms: 0 });
    api.playback.item!.duration_ms = 600_000;
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone', { budgetLevel: () => 'out' });
    zone.onChange(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(api.currentPlaybackCalls).toBe(1);

    // The command itself goes through, as does its immediate refresh poll.
    await zone.command({ type: 'seek', positionMs: 1000 });
    expect(callsOf(api, 'seek')).toHaveLength(1);
    const afterCommand = api.currentPlaybackCalls;

    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.currentPlaybackCalls).toBe(afterCommand + 1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.currentPlaybackCalls).toBe(afterCommand + 2);

    // Only after the follow-ups does the 'out' delay (ten minutes) apply.
    await vi.advanceTimersByTimeAsync(599_999);
    expect(api.currentPlaybackCalls).toBe(afterCommand + 2);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.currentPlaybackCalls).toBe(afterCommand + 3);
    await zone.close();
  });

  it('polls right after the song ends whatever the budget, so a finished song does not stay on screen', async () => {
    vi.useFakeTimers();
    const api = new FakeZoneApi();
    api.playback = playbackState(sampleTrack('t1'), { progress_ms: 40_000 });
    api.playback.item!.duration_ms = 60_000;
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone', { budgetLevel: () => 'tight' });
    zone.onChange(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(api.currentPlaybackCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(25_100); // 20 s left + 5 s slack with no client watching
    expect(api.currentPlaybackCalls).toBe(2);
  });

  it('multiplies background delays by the budget level, and "out" polls every ten minutes', async () => {
    vi.useFakeTimers();
    const api = new FakeZoneApi();
    api.playback = playbackState(sampleTrack('t1'), { progress_ms: 20_000 });
    api.playback.item!.duration_ms = 600_000;
    let level: SpotifyBudgetLevel = 'normal';
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone', { budgetLevel: () => level });
    zone.onChange(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(api.currentPlaybackCalls).toBe(1);

    // Long song: the normal 30 s cap; tight doubles it.
    level = 'tight';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.currentPlaybackCalls).toBe(2);

    // low ×4 = 120 s.
    level = 'low';
    await vi.advanceTimersByTimeAsync(59_999);
    expect(api.currentPlaybackCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(60_001); // 120 s from the last poll
    expect(api.currentPlaybackCalls).toBe(3);

    // out → at most once every 10 minutes.
    level = 'out';
    await vi.advanceTimersByTimeAsync(59_999); // 120 s after the last poll
    expect(api.currentPlaybackCalls).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.currentPlaybackCalls).toBe(4);
    await vi.advanceTimersByTimeAsync(599_999);
    expect(api.currentPlaybackCalls).toBe(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.currentPlaybackCalls).toBe(5);
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

  it('with shuffle on, lists upcoming songs in the order Spotify will play them', () => {
    const started = ['t1', 't2', 't3', 't4', 't5'].map((id, i) => ({
      queueId: `q${i}`,
      track: mapTrack(sampleTrack(id, i + 1, `Song ${id}`)),
      album: { id: 'sp:abbey', title: 'Abbey Road' },
    }));
    const state = mapPlaybackState(
      'spotify:dev1',
      { ...playbackState(sampleTrack('t2', 2, 'Song t2')), shuffle_state: true },
      { currently_playing: sampleTrack('t2', 2, 'Song t2'), queue: [sampleTrack('t5', 5, 'Song t5'), sampleTrack('t1', 1, 'Song t1')] },
      started,
    );
    // played before (not coming up again) · now · Spotify's next picks · the rest in unknown order
    expect(state.queue.map((q) => q.track.id)).toEqual(['sp:t2', 'sp:t5', 'sp:t1', 'sp:t3', 'sp:t4']);
    expect(state.index).toBe(0);
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

  it('caches devices() for 5 s and invalidates it after a write', async () => {
    const api = new FakeZoneApi();
    api.devicesData = [SIM_DEVICE];
    let t = 1000;
    const shared = sharedPlaybackReads(api, () => t);

    await shared.devices();
    await shared.devices();
    expect(api.deviceCalls).toBe(1);

    t += 4_999;
    await shared.devices();
    expect(api.deviceCalls).toBe(1);

    t += 2; // 5 s old
    await shared.devices();
    expect(api.deviceCalls).toBe(2);

    await shared.pause('dev1'); // a write invalidates the device list too
    await shared.devices();
    expect(api.deviceCalls).toBe(3);
  });
});

describe('commands on one zone run in order', () => {
  /** A fake whose pause only finishes when the test says so. */
  function slowPause() {
    const api = new FakeZoneApi();
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const pause = api.pause.bind(api);
    api.pause = async (deviceId) => {
      await gate;
      await pause(deviceId);
    };
    return { api, release };
  }

  it('a play sent right after a pause waits for it, so the pause cannot land after the play', async () => {
    const { api, release } = slowPause();
    api.playback = playbackState(sampleTrack('t1'));
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone');

    const pausing = zone.command({ type: 'pause' });
    const playing = zone.command({ type: 'play', trackIds: ['sp:t1'] });
    await new Promise((r) => setTimeout(r, 5));
    expect(callsOf(api, 'play')).toHaveLength(0);

    release();
    await Promise.all([pausing, playing]);
    expect(api.calls.filter((c) => c.method === 'pause' || c.method === 'play').map((c) => c.method)).toEqual(['pause', 'play']);
    await zone.close();
  });

  it('a failed command does not stop the next one', async () => {
    const api = new FakeZoneApi();
    api.playback = playbackState(sampleTrack('t1'));
    api.pause = async () => { throw new Error('nope'); };
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone');
    const failing = zone.command({ type: 'pause' });
    const next = zone.command({ type: 'next' });
    await expect(failing).rejects.toThrow('nope');
    await next;
    expect(callsOf(api, 'next')).toHaveLength(1);
    await zone.close();
  });

  it('volume does not queue behind a command, so a drag keeps its coalescing', async () => {
    const { api, release } = slowPause();
    api.playback = playbackState(sampleTrack('t1'));
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone');
    const pausing = zone.command({ type: 'pause' });
    await zone.command({ type: 'volume', volume: 40 });
    expect(callsOf(api, 'setVolume')).toHaveLength(1);
    release();
    await pausing;
    await zone.close();
  });

  it('a hung Spotify request holds the queue only for a while', async () => {
    vi.useFakeTimers();
    const api = new FakeZoneApi();
    api.playback = playbackState(sampleTrack('t1'));
    api.pause = () => new Promise<void>(() => {}); // never answers
    const zone = new SpotifyConnectZone(api, 'dev1', 'Sim Phone');
    void zone.command({ type: 'pause' });
    const next = zone.command({ type: 'next' });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(callsOf(api, 'next')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_100);
    await next;
    expect(callsOf(api, 'next')).toHaveLength(1);
    await zone.close();
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
