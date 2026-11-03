import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueItem } from '@liner/shared';
import type { SpotifyDevice, SpotifyTrack } from '../src/spotify/api.js';
import {
  LibrespotZone,
  type LibrespotFetch,
  type LibrespotSocket,
  type LibrespotSocketFactory,
} from '../src/spotify/librespot.js';
import { createSpotifyZones, SpotifyConnectZone, type SpotifyZoneApi } from '../src/spotify/zones.js';

// Everything here is an in-process fake: the tests never touch the real
// go-librespot at 127.0.0.1:3678 (which would play audio) or the Spotify API.

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

class FakeHttp {
  calls: RecordedCall[] = [];
  fetch: LibrespotFetch = async (url, init) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, path, body });
    if (method === 'GET' && path === '/player/volume') return jsonResponse(200, { value: 50, max: 100 });
    return jsonResponse(200, {});
  };

  callsOf(method: string, path: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method && c.path === path);
  }

  playUris(): string[] {
    return this.callsOf('POST', '/player/play').map((c) => (c.body as { uri: string }).uri);
  }
}

class FakeSocket implements LibrespotSocket {
  private openCb: (() => void) | undefined;
  private messageCb: ((data: string) => void) | undefined;
  private closeCb: (() => void) | undefined;
  private errorCb: ((err: unknown) => void) | undefined;

  constructor(readonly url: string) {}

  onOpen(cb: () => void): void {
    this.openCb = cb;
  }
  onMessage(cb: (data: string) => void): void {
    this.messageCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  onError(cb: (err: unknown) => void): void {
    this.errorCb = cb;
  }
  close(): void {
    this.closeCb?.();
  }

  open(): void {
    this.openCb?.();
  }
  emit(type: string, data: Record<string, unknown> = {}): void {
    this.messageCb?.(JSON.stringify({ type, data }));
  }
  /** Simulate the daemon going away. */
  drop(): void {
    this.closeCb?.();
  }
  fail(err: unknown = new Error('boom')): void {
    this.errorCb?.(err);
  }
}

class FakeSockets {
  list: FakeSocket[] = [];
  factory: LibrespotSocketFactory = (url) => {
    const socket = new FakeSocket(url);
    this.list.push(socket);
    return socket;
  };
  get last(): FakeSocket {
    return this.list[this.list.length - 1]!;
  }
}

function makeZone(opts: {
  knownTracks?: (ids: string[]) => QueueItem[];
  now?: () => number;
  socket?: LibrespotSocketFactory;
} = {}) {
  const http = new FakeHttp();
  const sockets = new FakeSockets();
  let t = 1_000;
  const zone = new LibrespotZone('dev1', 'HORSE', {
    baseUrl: 'http://librespot.test',
    fetch: http.fetch,
    socket: opts.socket ?? sockets.factory,
    knownTracks: opts.knownTracks,
    now: opts.now ?? (() => t),
    reconnectBaseMs: 500,
    reconnectMaxMs: 30_000,
  });
  return { zone, http, sockets, advance: (ms: number) => (t += ms) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('LibrespotZone playback', () => {
  it('plays the first track of a list one uri at a time', async () => {
    const { zone, http } = makeZone();
    const state = await zone.command({
      type: 'play',
      trackIds: ['sp:t1', 'sp:t2', 'sp:t3'],
      startIndex: 0,
    });

    expect(http.playUris()).toEqual(['spotify:track:t1']);
    expect(state.zone).toBe('spotify:dev1');
    expect(state.status).toBe('playing');
    expect(state.index).toBe(0);
    expect(state.queue.map((q) => q.track.id)).toEqual(['sp:t1', 'sp:t2', 'sp:t3']);
    expect(state.queue[0]?.track.spotifyUri).toBe('spotify:track:t1');
    await zone.close();
  });

  it('starts at startIndex and passes position and paused through', async () => {
    const { zone, http } = makeZone();
    const state = await zone.command({
      type: 'play',
      trackIds: ['sp:t1', 'sp:t2'],
      startIndex: 1,
      positionMs: 12_345,
      paused: true,
    });
    expect(http.callsOf('POST', '/player/play')[0]?.body).toEqual({
      uri: 'spotify:track:t2',
      paused: true,
      position: 12_345,
    });
    expect(state.index).toBe(1);
    expect(state.status).toBe('paused');
    expect(state.positionMs).toBe(12_345);
    await zone.close();
  });

  it('rejects local track ids with the Connect zone error and no request', async () => {
    const { zone, http } = makeZone();
    await expect(zone.command({ type: 'play', trackIds: ['l:abc'] })).rejects.toThrow(
      /only Spotify tracks/,
    );
    expect(http.calls).toHaveLength(0);
    await zone.close();
  });

  it('fills the queue from knownTracks and the websocket metadata', async () => {
    const known = (ids: string[]): QueueItem[] =>
      ids.slice(0, 1).map((id) => ({
        queueId: 'db',
        track: {
          id,
          albumId: 'sp:abbey',
          source: 'spotify',
          title: 'Come Together',
          artists: [{ id: 'ar:sp:1', name: 'The Beatles' }],
          disc: 1,
          number: 1,
          durationMs: 259_000,
          spotifyUri: 'spotify:track:t1',
        },
        album: { id: 'sp:abbey', title: 'Abbey Road' },
      }));
    const { zone, sockets } = makeZone({ knownTracks: known });
    await zone.command({ type: 'play', trackIds: ['sp:t1', 'sp:t2'] });
    expect(zone.state().queue[0]?.track.title).toBe('Come Together');
    expect(zone.state().queue[1]?.track.title).toBe('');

    sockets.last.emit('metadata', {
      uri: 'spotify:track:t2',
      name: 'Something',
      artist_names: ['The Beatles'],
      album_name: 'Abbey Road',
      album_cover_url: 'http://img.test/abbey.jpg',
      duration: 182_000,
      position: 0,
    });
    const second = zone.state().queue[1]!;
    expect(second.track.title).toBe('Something');
    expect(second.track.artists).toEqual([{ id: 'ar:sp:name:The Beatles', name: 'The Beatles' }]);
    expect(second.track.durationMs).toBe(182_000);
    expect(second.album.title).toBe('Abbey Road');
    expect(second.album.coverUrl).toBe('http://img.test/abbey.jpg');
    await zone.close();
  });

  it('advances when the websocket says the current track finished', async () => {
    const { zone, http, sockets } = makeZone();
    await zone.command({ type: 'play', trackIds: ['sp:t1', 'sp:t2'] });
    sockets.last.emit('playing', { uri: 'spotify:track:t1', resume: false });
    sockets.last.emit('metadata', { uri: 'spotify:track:t1', position: 0, duration: 1_000 });
    sockets.last.emit('not_playing', { uri: 'spotify:track:t1' });

    await vi.waitFor(() => expect(http.playUris()).toEqual(['spotify:track:t1', 'spotify:track:t2']));
    expect(zone.state().index).toBe(1);
    expect(zone.state().status).toBe('playing');
    await zone.close();
  });

  it('does not advance on not_playing for a different track', async () => {
    const { zone, http, sockets } = makeZone();
    await zone.command({ type: 'play', trackIds: ['sp:t1', 'sp:t2'] });
    sockets.last.emit('not_playing', { uri: 'spotify:track:other' });
    await Promise.resolve();
    expect(http.playUris()).toEqual(['spotify:track:t1']);
    await zone.close();
  });

  it('handles the not_playing + stopped pair as one track end', async () => {
    const { zone, http, sockets } = makeZone();
    await zone.command({ type: 'play', trackIds: ['sp:t1', 'sp:t2'] });
    sockets.last.emit('not_playing', { uri: 'spotify:track:t1' });
    sockets.last.emit('stopped', {});

    await vi.waitFor(() => expect(http.playUris()).toEqual(['spotify:track:t1', 'spotify:track:t2']));
    // A second advance would have skipped t2 or stopped the queue.
    expect(zone.state().index).toBe(1);
    expect(zone.state().status).toBe('playing');
    await zone.close();
  });

  it('repeats the current track with repeat one', async () => {
    const { zone, http, sockets } = makeZone();
    await zone.command({ type: 'play', trackIds: ['sp:t1', 'sp:t2'] });
    await zone.command({ type: 'repeat', mode: 'one' });
    sockets.last.emit('not_playing', { uri: 'spotify:track:t1' });

    await vi.waitFor(() => expect(http.playUris()).toEqual(['spotify:track:t1', 'spotify:track:t1']));
    expect(zone.state().index).toBe(0);
    expect(zone.state().repeat).toBe('one');
    await zone.close();
  });

  it('wraps to the first track with repeat all', async () => {
    const { zone, http, sockets } = makeZone();
    await zone.command({ type: 'play', trackIds: ['sp:t1', 'sp:t2'], startIndex: 1 });
    await zone.command({ type: 'repeat', mode: 'all' });
    sockets.last.emit('not_playing', { uri: 'spotify:track:t2' });

    await vi.waitFor(() => expect(http.playUris()).toEqual(['spotify:track:t2', 'spotify:track:t1']));
    expect(zone.state().index).toBe(0);
    await zone.close();
  });

  it('stops at the end with repeat off', async () => {
    const { zone, http, sockets } = makeZone();
    await zone.command({ type: 'play', trackIds: ['sp:t1', 'sp:t2'], startIndex: 1 });
    sockets.last.emit('not_playing', { uri: 'spotify:track:t2' });

    await vi.waitFor(() => expect(zone.state().status).toBe('stopped'));
    expect(http.playUris()).toEqual(['spotify:track:t2']);
    expect(zone.state().index).toBe(1);
    await zone.close();
  });

  it('jump replays the picked entry', async () => {
    const { zone, http } = makeZone();
    await zone.command({ type: 'play', trackIds: ['sp:t1', 'sp:t2', 'sp:t3'] });
    const state = await zone.command({ type: 'jump', index: 2 });
    expect(http.playUris()).toEqual(['spotify:track:t1', 'spotify:track:t3']);
    expect(state.index).toBe(2);
    expect(state.positionMs).toBe(0);
    await zone.close();
  });

  it('gives every queue entry a unique id, also across enqueues of the same song', async () => {
    const { zone } = makeZone();
    await zone.command({ type: 'play', trackIds: ['sp:t1', 'sp:t2'] });
    await zone.command({ type: 'enqueue', trackIds: ['sp:t1'] });
    const ids = zone.state().queue.map((q) => q.queueId);
    expect(new Set(ids).size).toBe(ids.length);
    await zone.close();
  });

  it('a lone stopped or inactive (playback moved to another device) never starts the next song', async () => {
    let t = 10_000;
    const { zone, http, sockets } = makeZone({ now: () => t });
    await zone.command({ type: 'play', trackIds: ['sp:t1', 'sp:t2'] });
    t += 5_000; // past the post-play suppress window
    sockets.last.emit('stopped', {});
    await new Promise((r) => setTimeout(r, 0));
    expect(http.playUris()).toEqual(['spotify:track:t1']);
    expect(zone.state().status).toBe('stopped');
    sockets.last.emit('inactive', {});
    await new Promise((r) => setTimeout(r, 0));
    expect(http.playUris()).toEqual(['spotify:track:t1']);
    await zone.close();
  });

  it('skips a song go-librespot cannot play', async () => {
    const { zone, http, sockets } = makeZone();
    await zone.command({ type: 'play', trackIds: ['sp:t1', 'sp:t2'] });
    sockets.last.emit('playback_error', { uri: 'spotify:track:t1', stage: 'load', kind: 'restricted', unplayable: true });
    await vi.waitFor(() => expect(http.playUris()).toEqual(['spotify:track:t1', 'spotify:track:t2']));
    await zone.close();
  });

  it('removes entries, including the playing one', async () => {
    const { zone, http } = makeZone();
    await zone.command({ type: 'play', trackIds: ['sp:t1', 'sp:t2', 'sp:t3'] });

    await zone.command({ type: 'remove', queueId: zone.state().queue.find((q) => q.track.id === 'sp:t2')!.queueId });
    expect(zone.state().queue.map((q) => q.track.id)).toEqual(['sp:t1', 'sp:t3']);
    expect(zone.state().index).toBe(0);
    expect(http.playUris()).toEqual(['spotify:track:t1']);

    // Removing the current entry moves to its successor and plays it.
    const after = await zone.command({ type: 'remove', queueId: zone.state().queue.find((q) => q.track.id === 'sp:t1')!.queueId });
    expect(after.queue.map((q) => q.track.id)).toEqual(['sp:t3']);
    expect(after.index).toBe(0);
    expect(http.playUris()).toEqual(['spotify:track:t1', 'spotify:track:t3']);
    await zone.close();
  });

  it('moves entries and keeps the playing one current', async () => {
    const { zone } = makeZone();
    await zone.command({ type: 'play', trackIds: ['sp:t1', 'sp:t2', 'sp:t3'] });
    const state = await zone.command({ type: 'move', queueId: zone.state().queue.find((q) => q.track.id === 'sp:t3')!.queueId, toIndex: 0 });
    expect(state.queue.map((q) => q.track.id)).toEqual(['sp:t3', 'sp:t1', 'sp:t2']);
    expect(state.index).toBe(1);
    expect(state.queue[state.index]?.track.id).toBe('sp:t1');
    await zone.close();
  });

  it('clears the queue and stops playback', async () => {
    const { zone, http } = makeZone();
    await zone.command({ type: 'play', trackIds: ['sp:t1', 'sp:t2'] });
    const state = await zone.command({ type: 'clear' });
    expect(state.queue).toEqual([]);
    expect(state.index).toBe(-1);
    expect(state.status).toBe('stopped');
    expect(http.callsOf('POST', '/player/stop')).toHaveLength(1);
    await zone.close();
  });

  it('maps pause, resume, seek and volume to the REST endpoints', async () => {
    const { zone, http } = makeZone();
    await zone.command({ type: 'play', trackIds: ['sp:t1'] });

    expect((await zone.command({ type: 'pause' })).status).toBe('paused');
    expect(http.callsOf('POST', '/player/pause')).toHaveLength(1);

    expect((await zone.command({ type: 'resume' })).status).toBe('playing');
    expect(http.callsOf('POST', '/player/resume')).toHaveLength(1);

    await zone.command({ type: 'seek', positionMs: 90_000 });
    expect(http.callsOf('POST', '/player/seek')[0]?.body).toEqual({ position: 90_000 });

    const spotifyVolume = await zone.command({ type: 'volume', volume: 33 });
    expect(spotifyVolume.volume).toBe(33);
    expect(http.callsOf('POST', '/player/volume')[0]?.body).toEqual({ volume: 33 });
    await zone.close();
  });

  it('scales websocket volume from go-librespot max to 0..100', async () => {
    const { zone, sockets } = makeZone();
    sockets.last.emit('volume', { value: 15, max: 50 });
    expect(zone.state().volume).toBe(30);
    await zone.close();
  });

  it('prev restarts after 3 s and otherwise goes back one entry', async () => {
    const { zone, http, sockets, advance } = makeZone();
    await zone.command({ type: 'play', trackIds: ['sp:t1', 'sp:t2'], startIndex: 1 });
    advance(4_000);
    await zone.command({ type: 'prev' });
    expect(http.callsOf('POST', '/player/seek')[0]?.body).toEqual({ position: 0 });
    expect(http.playUris()).toEqual(['spotify:track:t2']);

    sockets.last.emit('seek', { uri: 'spotify:track:t2', position: 1_000 });
    const state = await zone.command({ type: 'prev' });
    expect(state.index).toBe(0);
    expect(http.playUris()).toEqual(['spotify:track:t2', 'spotify:track:t1']);
    await zone.close();
  });

  it('lists shuffle and repeat locally without any HTTP call', async () => {
    const { zone, http } = makeZone();
    await zone.command({ type: 'play', trackIds: ['sp:t1', 'sp:t2'] });
    const calls = http.calls.length;
    const shuffled = await zone.command({ type: 'shuffle', on: true });
    expect(shuffled.shuffle).toBe(true);
    const repeated = await zone.command({ type: 'repeat', mode: 'all' });
    expect(repeated.repeat).toBe('all');
    expect(http.calls.length).toBe(calls);
    await zone.close();
  });

  it('enqueues at the end and starts playback when the queue was empty', async () => {
    const { zone, http } = makeZone();
    const state = await zone.command({ type: 'enqueue', trackIds: ['sp:t1'], next: false });
    expect(state.queue.map((q) => q.track.id)).toEqual(['sp:t1']);
    expect(state.status).toBe('playing');
    expect(http.playUris()).toEqual(['spotify:track:t1']);

    await zone.command({ type: 'enqueue', trackIds: ['sp:t2'], next: false });
    expect(zone.state().queue.map((q) => q.track.id)).toEqual(['sp:t1', 'sp:t2']);
    expect(http.playUris()).toEqual(['spotify:track:t1']);
    await zone.close();
  });
});

describe('LibrespotZone websocket', () => {
  it('reconnects with exponential backoff after the socket drops', async () => {
    vi.useFakeTimers();
    const { zone, sockets } = makeZone();
    expect(sockets.list).toHaveLength(1);

    sockets.last.drop();
    await vi.advanceTimersByTimeAsync(499);
    expect(sockets.list).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets.list).toHaveLength(2);

    sockets.last.drop();
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets.list).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets.list).toHaveLength(3);

    await zone.close();
  });

  it('stops reconnecting after close', async () => {
    vi.useFakeTimers();
    const { zone, sockets } = makeZone();
    sockets.last.drop();
    await zone.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets.list).toHaveLength(1);
  });

  it('seeds the volume from GET /player/volume when the socket opens', async () => {
    const { zone, http, sockets } = makeZone();
    sockets.last.open();
    await vi.waitFor(() => expect(zone.state().volume).toBe(50));
    expect(http.callsOf('GET', '/player/volume')).toHaveLength(1);
    await zone.close();
  });
});

class StubSpotifyApi implements SpotifyZoneApi {
  devicesData: SpotifyDevice[] = [];
  deviceCalls = 0;
  currentPlaybackCalls = 0;
  queueCalls = 0;

  async devices(): Promise<SpotifyDevice[]> {
    this.deviceCalls += 1;
    return this.devicesData;
  }
  async tracks() {
    return [];
  }
  async track(_id: string): Promise<SpotifyTrack> {
    throw new Error('not used');
  }
  async currentPlayback() {
    this.currentPlaybackCalls += 1;
    return null;
  }
  async queue() {
    this.queueCalls += 1;
    return { currently_playing: null, queue: [] };
  }
  async play(): Promise<void> {}
  async pause(): Promise<void> {}
  async next(): Promise<void> {}
  async previous(): Promise<void> {}
  async seek(): Promise<void> {}
  async setVolume(): Promise<void> {}
  async setShuffle(): Promise<void> {}
  async setRepeat(): Promise<void> {}
  async enqueue(): Promise<void> {}
}

describe('go-librespot detection', () => {
  const statusOk = async () => jsonResponse(200, { device_id: 'dev1', device_name: 'HORSE' });

  it('uses a LibrespotZone for the device go-librespot reports', async () => {
    const api = new StubSpotifyApi();
    api.devicesData = [
      { id: 'dev1', name: 'HORSE' } as SpotifyDevice,
      { id: 'dev2', name: 'Kitchen' } as SpotifyDevice,
    ];
    const sockets = new FakeSockets();
    const zones = createSpotifyZones(api, {
      librespotUrl: 'http://librespot.test',
      librespotFetch: statusOk,
      librespotSocket: sockets.factory,
      now: () => 1_000,
    });

    const list = await zones.listZones();
    expect(list).toEqual([
      { id: 'spotify:dev1', name: 'HORSE', kind: 'spotify' },
      { id: 'spotify:dev2', name: 'Kitchen', kind: 'spotify' },
    ]);
    expect(zones.get('spotify:dev1')).toBeInstanceOf(LibrespotZone);
    expect(zones.get('spotify:dev2')).toBeInstanceOf(SpotifyConnectZone);
    // No zone polled the Spotify Web API: the local zone has no api at all.
    expect(api.currentPlaybackCalls).toBe(0);
    expect(api.queueCalls).toBe(0);
    await zones.close();
  });

  it('falls back to a SpotifyConnectZone when /status fails', async () => {
    const api = new StubSpotifyApi();
    api.devicesData = [{ id: 'dev1', name: 'HORSE' } as SpotifyDevice];
    const zones = createSpotifyZones(api, {
      librespotUrl: 'http://librespot.test',
      librespotFetch: async () => {
        throw new Error('ECONNREFUSED');
      },
      now: () => 1_000,
    });

    await zones.listZones();
    expect(zones.get('spotify:dev1')).toBeInstanceOf(SpotifyConnectZone);
    await zones.close();
  });

  it('does not use the local zone when librespotUrl is empty', async () => {
    const api = new StubSpotifyApi();
    api.devicesData = [{ id: 'dev1', name: 'HORSE' } as SpotifyDevice];
    const zones = createSpotifyZones(api, { librespotUrl: '' });
    await zones.listZones();
    expect(zones.get('spotify:dev1')).toBeInstanceOf(SpotifyConnectZone);
    await zones.close();
  });

  it('caches the /status lookup for a minute', async () => {
    const api = new StubSpotifyApi();
    api.devicesData = [{ id: 'dev1', name: 'HORSE' } as SpotifyDevice];
    let t = 1_000;
    let statusCalls = 0;
    const sockets = new FakeSockets();
    const zones = createSpotifyZones(api, {
      librespotUrl: 'http://librespot.test',
      librespotFetch: async (url) => {
        statusCalls += 1;
        return statusOk();
      },
      librespotSocket: sockets.factory,
      now: () => t,
    });

    await zones.listZones();
    await zones.listZones();
    expect(statusCalls).toBe(1);

    t += 60_001;
    await zones.listZones();
    expect(statusCalls).toBe(2);
    await zones.close();
  });

  it('replaces a Connect zone with the local one when go-librespot appears', async () => {
    const api = new StubSpotifyApi();
    api.devicesData = [{ id: 'dev1', name: 'HORSE' } as SpotifyDevice];
    const sockets = new FakeSockets();
    let up = false;
    let t = 1_000;
    const zones = createSpotifyZones(api, {
      librespotUrl: 'http://librespot.test',
      librespotFetch: async () => (up ? statusOk() : jsonResponse(204, {})),
      librespotSocket: sockets.factory,
      now: () => t,
    });

    await zones.listZones();
    expect(zones.get('spotify:dev1')).toBeInstanceOf(SpotifyConnectZone);

    up = true;
    await zones.listZones(); // the 60 s cache has not expired: still the Connect zone
    expect(zones.get('spotify:dev1')).toBeInstanceOf(SpotifyConnectZone);

    t += 60_001;
    await zones.listZones();
    expect(zones.get('spotify:dev1')).toBeInstanceOf(LibrespotZone);
    await zones.close();
  });
});
