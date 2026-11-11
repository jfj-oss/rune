// The client half of "Spotify on the Linux PC speakers": start the app, wait for its
// Connect device, then play exactly as if it had been there. Fetch is faked (no real
// Spotify API is ever called), playback zones are the server's RemoteBackend over that
// fake fetch, and time is fake.
import type { PlayerState, QueueItem, Track } from '@liner/shared';
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

const queueItem = (id: string): QueueItem => ({
  queueId: `q:${id}`,
  track: { id, albumId: 'sp:alb', source: 'spotify', title: id, artists: [], disc: 1, number: 1, durationMs: 1000 } as Track,
  album: { id: 'sp:alb', title: 'Album' },
});

/** How the fake Spotify device is set (repeat "all" = Spotify's "context"). */
interface DeviceModes { shuffle: boolean; repeat: PlayerState['repeat'] }

class FakeWebSocket {
  /** The socket the store opened last: a test pushes server events through it. */
  static last: FakeWebSocket | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeWebSocket.last = this; }
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
  /** Every /zones read. */
  zoneReads: () => number;
  playerPosts: () => PlayerPost[];
  /** POST /api/soloist/output bodies, in order. */
  soloistOutputs: () => string[];
  /** A `player` event from the server over the websocket (what the server broadcasts on every zone change). */
  pushPlayer: (state: PlayerState) => void;
}

interface SetupExtra {
  /** Extra fields of the pc zone entry (the Soloist engine, a fallback notice). */
  pc?: Record<string, unknown>;
  /** Further zones the server lists. */
  zones?: Record<string, unknown>[];
}

/** Fresh store + fake fetch. `deviceAfterReads` = first poll on which the pc device exists (null = never). */
async function setup(
  deviceAfterReads: number | null,
  pcState?: Partial<PlayerState>,
  deviceModes?: DeviceModes,
  extra: SetupExtra = {},
): Promise<Harness> {
  vi.resetModules();
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:4545' });
  vi.stubGlobal('WebSocket', FakeWebSocket);

  let startCalls = 0;
  let readsAfterStart = 0;
  let zoneReads = 0;
  const playerPosts: PlayerPost[] = [];
  const soloistOutputs: string[] = [];
  // A Spotify Connect device's own state. A command changes it, as Spotify would; /me/player echoes it.
  const modes: DeviceModes = { ...(deviceModes ?? { shuffle: false, repeat: 'off' }) };

  const zones = () => {
    const ready = startCalls > 0 && deviceAfterReads !== null && readsAfterStart >= deviceAfterReads;
    return [
      { id: 'pc', name: 'Linux PC speakers', kind: 'pc', ...(ready ? { spotifyDeviceId: 'dev', spotifyDeviceName: 'MYPC' } : {}), ...(extra.pc ?? {}) },
      ...(deviceModes ? [{ id: 'spotify:dev', name: 'MYPC', kind: 'spotify' }] : []),
      ...(extra.zones ?? []),
      { id: 'browser', name: 'This computer', kind: 'browser' },
    ];
  };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url === '/api/zones') {
      zoneReads++;
      if (startCalls > 0) readsAfterStart++;
      return json(zones());
    }
    if (url === '/api/soloist/output') {
      const body = JSON.parse(String(init?.body)) as { output: string };
      soloistOutputs.push(body.output);
      return json({ output: body.output, problem: null });
    }
    if (url === '/api/spotify/status') return json({ connected: false });
    if (url === '/api/pc/spotify/start') {
      startCalls++;
      return json({ started: true, running: false });
    }
    if (url.startsWith('/api/player/')) {
      const zone = decodeURIComponent(url.slice('/api/player/'.length));
      const isDevice = zone.startsWith('spotify:');
      const body = init?.body ? (JSON.parse(String(init.body)) as ExtCommand & { trackIds?: string[]; startIndex?: number }) : null;
      if (method === 'POST' && body) {
        playerPosts.push({ zone, body });
        if (isDevice) {
          if (body.type === 'repeat') modes.repeat = body.mode;
          else if (body.type === 'shuffle') modes.shuffle = body.on;
        }
        const ids = body.trackIds ?? [];
        const queue = ids.map((id, i) => ({
          queueId: `q${i}`,
          track: { id, albumId: 'sp:alb', source: id.startsWith('sp:') ? 'spotify' : 'local', title: id, artists: [], disc: 1, number: 1, durationMs: 1000 } as Track,
          album: { id: 'sp:alb', title: 'Album' },
        }));
        return json({ ...baseState(zone), ...(isDevice ? modes : {}), status: 'playing', queue, index: body.startIndex ?? 0 });
      }
      return json({ ...baseState(zone), ...(isDevice ? modes : {}), ...(zone === 'pc' ? pcState : {}) });
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
    zoneReads: () => zoneReads,
    playerPosts: () => playerPosts,
    soloistOutputs: () => soloistOutputs,
    pushPlayer: (state) => FakeWebSocket.last?.onmessage?.({ data: JSON.stringify({ type: 'player', state, queueRev: `rev-${state.updatedAt}` }) }),
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

describe('repeat/shuffle when playback moves to a Spotify zone', () => {
  /** The pc zone is sounding a Spotify queue with repeat off (= rune's setting in the bar). */
  const pcPlaying = (extra: Partial<PlayerState> = {}): Partial<PlayerState> => ({
    status: 'playing',
    queue: [queueItem('sp:1')],
    index: 0,
    positionMs: 0,
    repeat: 'off',
    shuffle: false,
    ...extra,
  });
  const devicePosts = (h: Harness) => h.playerPosts().filter((p) => p.zone === 'spotify:dev');

  it('clears a Spotify device left repeating: a one-song queue with repeat off ends up off', async () => {
    // The device says "all" (Spotify's "context"): it would loop the single song forever.
    const h = await setup(null, pcPlaying(), { repeat: 'all', shuffle: true });

    await h.usePlayer.getState().setZone('spotify:dev');

    expect(devicePosts(h).map((p) => p.body.type)).toEqual(['play', 'repeat', 'shuffle']);
    expect(devicePosts(h)[1]!.body).toEqual({ type: 'repeat', mode: 'off' });
    expect(devicePosts(h)[2]!.body).toEqual({ type: 'shuffle', on: false });
    // The bar follows the zone that actually plays, not the zone it was handed from.
    expect(h.usePlayer.getState().zone).toBe('spotify:dev');
    expect(h.usePlayer.getState().state.repeat).toBe('off');
    expect(h.usePlayer.getState().state.shuffle).toBe(false);
  });

  it('carries rune’s own repeat and shuffle (all / on) to the Spotify device', async () => {
    const h = await setup(null, pcPlaying({ repeat: 'all', shuffle: true }), { repeat: 'off', shuffle: false });

    await h.usePlayer.getState().setZone('spotify:dev');

    expect(devicePosts(h).map((p) => p.body.type)).toEqual(['play', 'repeat', 'shuffle']);
    expect(devicePosts(h)[1]!.body).toEqual({ type: 'repeat', mode: 'all' });
    expect(devicePosts(h)[2]!.body).toEqual({ type: 'shuffle', on: true });
    expect(h.usePlayer.getState().state.repeat).toBe('all');
  });

  it('sends no repeat/shuffle request when the device already matches', async () => {
    const h = await setup(null, pcPlaying(), { repeat: 'off', shuffle: false });

    await h.usePlayer.getState().setZone('spotify:dev');

    expect(devicePosts(h).map((p) => p.body.type)).toEqual(['play']);
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

describe('Spotify on the PC speakers through Soloist', () => {
  const SOLOIST_PC = { spotifyEngine: 'soloist', spotifyZone: 'soloist' };
  const SOLOIST_ZONE = { id: 'soloist', name: 'Spotify (Soloist)', kind: 'spotify', soloist: true, output: 'pc', isActive: true };

  it('plays at once on the soloist zone: no app start, no device polling, the sound on the PC speakers', async () => {
    const h = await setup(null, undefined, undefined, { pc: SOLOIST_PC, zones: [SOLOIST_ZONE] });
    const toast = vi.spyOn(h.useUi.getState(), 'toast');
    const reads = h.zoneReads();
    await h.usePlayer.getState().playItems([item('sp:1'), item('sp:2')], 0);

    expect(h.startCalls()).toBe(0);
    expect(h.zoneReads()).toBe(reads); // not one /zones read (each is a Spotify devices call) for the play
    const plays = h.playerPosts().filter((p) => p.body.type === 'play');
    expect(plays).toHaveLength(1);
    expect(plays[0]).toMatchObject({ zone: 'soloist', body: { type: 'play', trackIds: ['sp:1', 'sp:2'], startIndex: 0 } });
    expect(h.soloistOutputs()).toEqual(['pc']);
    expect(toast.mock.calls.map((c) => c[0])).not.toContain(PC_SPOTIFY_STARTING);
    expect(h.usePlayer.getState().zone).toBe('pc');
    expect(h.usePlayer.getState().state.status).toBe('playing');
    // The Soloist zone is the pc zone's player on a desktop: one entry in the list.
    expect(h.usePlayer.getState().zones.map((z) => z.id)).toEqual(['pc', 'browser']);
  });

  it('what Soloist plays on after the list (autoplay, named by Soloist) is the pc zone\'s now playing within one server event', async () => {
    const h = await setup(null, undefined, undefined, { pc: SOLOIST_PC, zones: [SOLOIST_ZONE] });
    await h.usePlayer.getState().playItems([item('sp:1')], 0);
    expect(h.usePlayer.getState().state.queue.map((q) => q.track.id)).toEqual(['sp:1']);
    // The song ended; Spotify's autoplay went on and the server's Soloist zone adopted the new song (soloist/zone.ts).
    const adopted: QueueItem = { ...queueItem('sp:x1'), queueId: 'soloist:1:x1', track: { ...queueItem('sp:x1').track, title: "Givin' It All", artists: [{ id: 'sp:ar', name: 'Someone' }] } };
    h.pushPlayer({ ...baseState('soloist'), status: 'playing', queue: [queueItem('sp:1'), adopted], index: 1, positionMs: 1200, updatedAt: Date.now() });
    const s = h.usePlayer.getState().state;
    expect(h.usePlayer.getState().zone).toBe('pc');
    expect(s.status).toBe('playing');
    expect(s.queue[s.index]?.track.title).toBe("Givin' It All");
    expect(s.queue[s.index]?.track.artists[0]?.name).toBe('Someone');
    // Soloist stopping for good (nothing left to autoplay) shows as stopped, as before.
    h.pushPlayer({ ...baseState('soloist'), status: 'stopped', queue: [queueItem('sp:1'), adopted], index: 1, updatedAt: Date.now() + 1 });
    expect(h.usePlayer.getState().state.status).toBe('stopped');
  });

  it('a mixed queue keeps local songs on mpv and sends the Spotify song to Soloist when its turn comes', async () => {
    const h = await setup(null, undefined, undefined, { pc: SOLOIST_PC, zones: [SOLOIST_ZONE] });
    await h.usePlayer.getState().playItems([{ ...item('l:1'), track: { ...item('l:1').track, source: 'local' } }, item('sp:1')], 0);
    await new Promise((r) => setTimeout(r, 0));
    const plays = h.playerPosts().filter((p) => p.body.type === 'play');
    expect(plays.map((p) => [p.zone, p.body.trackIds])).toEqual([['pc', ['l:1']]]); // one song at a time into mpv first
    expect(h.startCalls()).toBe(0);
    expect(h.soloistOutputs()).toEqual(['pc']);
    expect(h.usePlayer.getState().state.queue.map((q) => q.track.id)).toEqual(['l:1', 'sp:1']);
  });

  it('with Soloist unavailable the app route runs as before, and the one-line reason is shown', async () => {
    vi.useFakeTimers();
    const notice = 'Soloist needs updating (its build expired) — using the Spotify app';
    const h = await setup(1, undefined, undefined, { pc: { spotifyEngine: 'app', spotifyNotice: notice }, zones: [SOLOIST_ZONE] });
    const toast = vi.spyOn(h.useUi.getState(), 'toast');
    const pending = h.usePlayer.getState().playItems([item('sp:1')], 0);
    await vi.advanceTimersByTimeAsync(PC_SPOTIFY_POLL_MS);
    await pending;
    const messages = toast.mock.calls.map((c) => c[0]);
    expect(messages[0]).toBe(notice);
    expect(messages).toContain(PC_SPOTIFY_STARTING);
    expect(h.startCalls()).toBe(1);
    expect(h.playerPosts().filter((p) => p.body.type === 'play').map((p) => p.zone)).toEqual(['spotify:dev']);
    expect(h.soloistOutputs()).toEqual([]);
    // The same reason is not repeated for every song in a row.
    const again = h.usePlayer.getState().playItems([item('sp:2')], 0);
    await vi.advanceTimersByTimeAsync(PC_SPOTIFY_POLL_MS);
    await again;
    expect(toast.mock.calls.map((c) => c[0]).filter((m) => m === notice)).toHaveLength(1);
  });
});
