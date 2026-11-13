// A rune tab opened on the PC itself, where Soloist plays the pc zone's Spotify songs.
//
// The live bug: such a tab sat on its own browser zone and played a playlist through the Web Playback SDK, a second
// Spotify Connect device on the same speakers. Soloist mirrored it, the server's Soloist zone played its older queue
// into the tab's session, and the song shown and the song heard differed. On that PC the page has ONE player, the pc
// zone: no browser zone, and the SDK is never even registered.
//
// The SDK here is a fake (window.Spotify.Player) and fetch is faked: no request ever reaches Spotify.
import type { PlayerState, Track } from '@liner/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayItem } from '../lib/types';
import { pageIsOnThePc } from '../player/routing';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const item = (id: string): PlayItem => ({
  track: { id, albumId: 'sp:alb', source: 'spotify', title: id, artists: [], disc: 1, number: 1, durationMs: 1000, spotifyUri: `spotify:track:${id.slice(3)}` } as Track,
  album: { id: 'sp:alb', title: 'Album' },
});

const baseState = (zone: string): PlayerState => ({ zone, status: 'stopped', queue: [], index: -1, positionMs: 0, volume: 70, shuffle: false, repeat: 'off', updatedAt: 1_000 });
const json = (data: unknown): Response => ({ ok: true, status: 200, statusText: 'OK', json: async () => data }) as unknown as Response;

class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  close(): void { this.onclose?.(); }
  send(): void {}
}

/** A desktop browser in which the Web Playback SDK would run, a saved zone choice, and the server's zone list. */
async function setup(opts: { playsForBrowser: boolean; savedZone?: string; narrowWindow?: boolean }) {
  vi.resetModules();
  const sdkPlayers: { name: string }[] = [];
  const spotifyRequests: string[] = [];
  const playerPosts: { zone: string; type: string; trackIds?: string[] }[] = [];

  /** The fake Web Playback SDK: registering it is what makes the tab a Spotify Connect device. */
  class FakePlayer {
    private listeners = new Map<string, (p: unknown) => void>();
    constructor(o: { name: string }) { sdkPlayers.push({ name: o.name }); }
    addListener(event: string, cb: (p: unknown) => void) { this.listeners.set(event, cb); return true; }
    async connect() { this.listeners.get('ready')?.({ device_id: 'tab-device' }); return true; }
    disconnect() {}
    async getCurrentState() { return null; }
    async pause() {}
    async resume() {}
    async seek() {}
    async setVolume() {}
    async activateElement() {}
  }
  const store = new Map<string, string>(opts.savedZone ? [['rune.zone', JSON.stringify(opts.savedZone)]] : []);
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36', maxTouchPoints: 0, requestMediaKeySystemAccess: () => Promise.reject(new Error('not in a test')) });
  vi.stubGlobal('window', {
    isSecureContext: true,
    Spotify: { Player: FakePlayer },
    matchMedia: () => ({ matches: opts.narrowWindow === true, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal('location', { protocol: 'https:', host: 'pc.example.net:8445', pathname: '/' });
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('Audio', class { addEventListener() {} removeEventListener() {} play() { return Promise.resolve(); } pause() {} load() {} removeAttribute() {} });

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://api.spotify.com/')) { spotifyRequests.push(`${init?.method ?? 'GET'} ${url}`); return { ok: true, status: 204, statusText: 'No Content', json: async () => ({}) } as unknown as Response; }
    if (url.startsWith('/api/zones')) {
      return json([
        { id: 'pc', name: 'Linux PC speakers', kind: 'pc', spotifyEngine: 'soloist', spotifyZone: 'soloist', ...(opts.playsForBrowser ? { playsForBrowser: true } : {}) },
        { id: 'soloist', name: 'Spotify (Soloist)', kind: 'spotify', soloist: true, output: 'pc', isActive: true, available: true },
      ]);
    }
    if (url === '/api/spotify/status') return json({ connected: true, user: { name: 'u', product: 'premium' } });
    if (url === '/api/spotify/token') return json({ access_token: 'test-token', expires_at: Date.now() + 3_600_000 });
    if (url === '/api/soloist/output') return json({ output: 'pc', problem: null });
    if (url === '/api/local-twins') return json({ twins: {} });
    if (url.startsWith('/api/player/')) {
      const zone = decodeURIComponent(url.slice('/api/player/'.length));
      const body = init?.body ? (JSON.parse(String(init.body)) as { type: string; trackIds?: string[]; startIndex?: number }) : null;
      if ((init?.method ?? 'GET') === 'POST' && body) {
        playerPosts.push({ zone, type: body.type, ...(body.trackIds ? { trackIds: body.trackIds } : {}) });
        const queue = (body.trackIds ?? []).map((id, i) => ({ queueId: `q${i}`, ...item(id) }));
        return json({ ...baseState(zone), status: 'playing', queue, index: body.startIndex ?? 0 });
      }
      return json(baseState(zone));
    }
    return json({});
  }));

  const [{ usePlayer }, { useSpotify }] = await Promise.all([import('./player'), import('./spotify')]);
  await usePlayer.getState().init();
  // Let anything the Spotify store started in the background (registering the SDK player) run.
  await new Promise((r) => setTimeout(r, 20));
  return { usePlayer, useSpotify, sdkPlayers, spotifyRequests, playerPosts };
}

describe('a rune tab on the PC itself (Soloist plays there)', () => {
  it('has one player, the pc zone: a saved "this browser" choice is not used, no Spotify player is registered in the tab, and a playlist goes to Soloist only', async () => {
    const h = await setup({ playsForBrowser: true, savedZone: 'browser' });
    expect(h.usePlayer.getState().zone).toBe('pc');
    expect(h.usePlayer.getState().zones.map((z) => z.id)).toEqual(['pc']);
    expect(h.sdkPlayers).toEqual([]);
    expect(h.useSpotify.getState().sdk.phase).toBe('off');

    await h.usePlayer.getState().playItems([item('sp:tab1'), item('sp:tab2')], 0);
    await new Promise((r) => setTimeout(r, 20));
    const plays = h.playerPosts.filter((p) => p.type === 'play');
    expect(plays).toEqual([{ zone: 'soloist', type: 'play', trackIds: ['sp:tab1', 'sp:tab2'] }]);
    // The tab asked Spotify for nothing: no second device starts the song.
    expect(h.spotifyRequests).toEqual([]);
    expect(h.sdkPlayers).toEqual([]);
    expect(h.usePlayer.getState().zone).toBe('pc');
  });

  it('a narrow window on the PC is still the PC: it does not fall back to a browser player', async () => {
    const h = await setup({ playsForBrowser: true, narrowWindow: true });
    expect(h.usePlayer.getState().zone).toBe('pc');
    expect(h.sdkPlayers).toEqual([]);
  });

  it('a later zone list keeps it that way (the browser zone is not added back)', async () => {
    const h = await setup({ playsForBrowser: true });
    await h.usePlayer.getState().refreshZones();
    expect(h.usePlayer.getState().zones.map((z) => z.id)).toEqual(['pc']);
    await h.usePlayer.getState().setZone('browser');
    expect(h.usePlayer.getState().zone).toBe('pc');
  });
});

describe('a rune tab on another computer', () => {
  it('keeps its own browser zone and Web Playback SDK player (it has speakers of its own)', async () => {
    const h = await setup({ playsForBrowser: false, savedZone: 'browser' });
    expect(h.usePlayer.getState().zone).toBe('browser');
    expect(h.usePlayer.getState().zones.map((z) => z.id)).toEqual(['pc', 'browser']);
    expect(h.sdkPlayers).toHaveLength(1);
    expect(h.useSpotify.getState().sdk).toMatchObject({ phase: 'ready', deviceId: 'tab-device' });
  });
});

describe('pageIsOnThePc', () => {
  const pc = { kind: 'pc' as const, playsForBrowser: true };
  it('needs the server\'s word, and a phone or tablet is never the PC', () => {
    expect(pageIsOnThePc([pc], false)).toBe(true);
    expect(pageIsOnThePc([{ kind: 'pc' }], false)).toBe(false);
    expect(pageIsOnThePc([{ kind: 'browser' }, { kind: 'spotify' }], false)).toBe(false);
    expect(pageIsOnThePc([pc], true)).toBe(false);
  });
});
