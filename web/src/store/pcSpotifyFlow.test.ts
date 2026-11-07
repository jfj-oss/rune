// The client half of "Spotify on the Linux PC speakers": start the app, wait for its
// Connect device, then play exactly as if it had been there. Fetch is faked (no real
// Spotify API is ever called), playback zones are the server's RemoteBackend over that
// fake fetch, and time is fake.
import type { PlayerState, Track } from '@liner/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtCommand, PlayItem } from '../lib/types';
import { PC_SPOTIFY_FAILED, PC_SPOTIFY_MAX_READS, PC_SPOTIFY_POLL_MS, PC_SPOTIFY_STARTING } from '../player/pcStart';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const item = (id: string): PlayItem => ({
  track: { id, albumId: 'sp:alb', source: 'spotify', title: id, artists: [], disc: 1, number: 1, durationMs: 1000 } as Track,
  album: { id: 'sp:alb', title: 'Album' },
});

const baseState = (zone: string): PlayerState => ({
  zone,
  status: 'stopped',
  queue: [],
  index: -1,
  positionMs: 0,
  volume: 70,
  shuffle: false,
  repeat: 'off',
  updatedAt: 1_000,
});

const json = (data: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: async () => data }) as unknown as Response;

class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  close(): void {
    this.onclose?.();
  }
}

interface PlayerPost {
  zone: string;
  body: ExtCommand & { trackIds?: string[]; startIndex?: number };
}

interface Harness {
  usePlayer: typeof import('./player').usePlayer;
  useUi: typeof import('./ui').useUi;
  startCalls: () => number;
  /** /zones reads made after the start request (the poll budget). */
  readsAfterStart: () => number;
  playerPosts: () => PlayerPost[];
}

/** Fresh store + fake fetch. `deviceAfterReads` = first poll on which the pc device exists (null = never). */
async function setup(deviceAfterReads: number | null, pcState?: Partial<PlayerState>): Promise<Harness> {
  vi.resetModules();
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:4545' });
  vi.stubGlobal('WebSocket', FakeWebSocket);

  let startCalls = 0;
  let readsAfterStart = 0;
  const playerPosts: PlayerPost[] = [];

  const zones = () => {
    const ready = startCalls > 0 && deviceAfterReads !== null && readsAfterStart >= deviceAfterReads;
    return [
      { id: 'pc', name: 'Linux PC speakers', kind: 'pc', ...(ready ? { spotifyDeviceId: 'dev', spotifyDeviceName: 'HORSE' } : {}) },
      { id: 'browser', name: 'This computer', kind: 'browser' },
    ];
  };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url === '/api/zones') {
      if (startCalls > 0) readsAfterStart++;
      return json(zones());
    }
    if (url === '/api/spotify/status') return json({ connected: false });
    if (url === '/api/pc/spotify/start') {
      startCalls++;
      return json({ started: true, running: false });
    }
    if (url.startsWith('/api/player/')) {
      const zone = decodeURIComponent(url.slice('/api/player/'.length));
      const body = init?.body ? (JSON.parse(String(init.body)) as ExtCommand & { trackIds?: string[]; startIndex?: number }) : null;
      if (method === 'POST' && body) {
        playerPosts.push({ zone, body });
        const ids = body.trackIds ?? [];
        const queue = ids.map((id, i) => ({
          queueId: `q${i}`,
          track: { id, albumId: 'sp:alb', source: id.startsWith('sp:') ? 'spotify' : 'local', title: id, artists: [], disc: 1, number: 1, durationMs: 1000 } as Track,
          album: { id: 'sp:alb', title: 'Album' },
        }));
        return json({ ...baseState(zone), status: 'playing', queue, index: body.startIndex ?? 0 });
      }
      return json({ ...baseState(zone), ...(zone === 'pc' ? pcState : {}) });
    }
    if (url.startsWith('/api/spotify/')) return json({ connected: false });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);

  const [{ usePlayer }, { useUi }] = await Promise.all([import('./player'), import('./ui')]);
  await usePlayer.getState().init();

  // Toast is how the flow reports progress; record every message.
  return {
    usePlayer,
    useUi,
    startCalls: () => startCalls,
    readsAfterStart: () => readsAfterStart,
    playerPosts: () => playerPosts,
  };
}

describe('moving playback to another zone', () => {
  it('pauses a zone that is still loading: its song would start under the moved one', async () => {
    vi.stubGlobal('Audio', class { addEventListener() {} play() { return Promise.resolve(); } pause() {} load() {} removeAttribute() {} });
    const loading = { track: { ...item('l:1').track, source: 'local' as const }, album: item('l:1').album, queueId: 'q0' };
    const h = await setup(null, { status: 'loading', queue: [loading], index: 0 });
    await h.usePlayer.getState().setZone('browser');
    expect(h.playerPosts().filter((p) => p.zone === 'pc').map((p) => p.body.type)).toEqual(['pause']);
    expect(h.usePlayer.getState().zone).toBe('browser');
  });
});

describe('Spotify on the PC speakers', () => {
  it('starts the app, waits for its Connect device, then plays without dropping Spotify tracks', async () => {
    vi.useFakeTimers();
    const h = await setup(2); // the device shows up on the second poll
    const toast = vi.spyOn(h.useUi.getState(), 'toast');
    const items = [item('sp:1'), item('sp:2')];

    const pending = h.usePlayer.getState().playItems(items, 0);
    await vi.advanceTimersByTimeAsync(PC_SPOTIFY_POLL_MS * 2);
    await pending;

    expect(h.startCalls()).toBe(1);
    expect(h.readsAfterStart()).toBe(2);
    expect(h.readsAfterStart()).toBeLessThanOrEqual(PC_SPOTIFY_MAX_READS);

    const plays = h.playerPosts().filter((p) => p.zone === 'spotify:dev');
    expect(plays).toHaveLength(1);
    expect(plays[0]!.body).toMatchObject({ type: 'play', trackIds: ['sp:1', 'sp:2'], startIndex: 0 });

    const messages = toast.mock.calls.map((c) => c[0]);
    expect(messages).toContain(PC_SPOTIFY_STARTING);
    expect(messages.some((m) => m.includes('skipped') || m.includes("can't play"))).toBe(false);
    expect(h.usePlayer.getState().zones.find((z) => z.id === 'pc')?.spotifyDeviceId).toBe('dev');
    expect(h.usePlayer.getState().state.status).toBe('playing');
  });

  it('keeps playback where it was and says so when the app never appears', async () => {
    vi.useFakeTimers();
    const h = await setup(null); // no device, ever
    const toast = vi.spyOn(h.useUi.getState(), 'toast');
    const before = h.usePlayer.getState();

    const pending = before.playItems([item('sp:1')], 0);
    await vi.advanceTimersByTimeAsync(PC_SPOTIFY_MAX_READS * PC_SPOTIFY_POLL_MS);
    await pending;

    expect(h.startCalls()).toBe(1);
    expect(h.readsAfterStart()).toBe(PC_SPOTIFY_MAX_READS);
    expect(h.playerPosts()).toHaveLength(0); // nothing paused, moved or dropped
    expect(toast.mock.calls.map((c) => c[0])).toContain(PC_SPOTIFY_FAILED);

    const after = h.usePlayer.getState();
    expect(after.zone).toBe('pc');
    expect(after.state.status).toBe('stopped');
    expect(after.zones.find((z) => z.id === 'pc')?.spotifyDeviceId).toBeUndefined();
  });
});
