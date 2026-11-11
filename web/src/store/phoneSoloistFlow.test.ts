// A phone's Spotify songs play "on this phone" through Soloist on the PC, by default: the store over a fake fetch and
// a fake websocket, with an iPhone's user agent. No Spotify API, no Connect device, no real audio element.
import type { PlayerState, QueueItem, Track } from '@liner/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtCommand, PlayItem } from '../lib/types';
import { PcBackend } from '../player/pc';

/** The last store made: its zone engines keep timers (polls) that would otherwise reach the next test's fetch. */
let lastStore: { getState(): { command(cmd: ExtCommand): Promise<void> } } | null = null;
afterEach(async () => {
  await lastStore?.getState().command({ type: 'clear' }).catch(() => undefined);
  lastStore = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const track = (id: string, source: 'spotify' | 'local' = 'spotify'): Track =>
  ({ id, albumId: source === 'spotify' ? 'sp:alb' : 'la:alb', source, title: id, artists: [{ id: 'ar:1', name: 'A' }], disc: 1, number: 1, durationMs: 200_000, ...(source === 'spotify' ? { spotifyUri: `spotify:track:${id.slice(3)}` } : {}) }) as Track;
const item = (id: string, source: 'spotify' | 'local' = 'spotify'): PlayItem => ({ track: track(id, source), album: { id: 'sp:alb', title: 'Album' } });
const queueItem = (id: string): QueueItem => ({ queueId: `q:${id}`, ...item(id) });

const baseState = (zone: string): PlayerState => ({ zone, status: 'stopped', queue: [], index: -1, positionMs: 0, volume: 70, shuffle: false, repeat: 'off', updatedAt: 1_000 });
const json = (data: unknown): Response => ({ ok: true, status: 200, statusText: 'OK', json: async () => data }) as unknown as Response;

class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  constructor(readonly url: string) { FakeWebSocket.last = this; }
  send() {}
  close(): void { this.onclose?.(); }
}

/** The one stream element the phone plays the HLS stream in. */
class FakeAudio {
  static made: FakeAudio[] = [];
  src = '';
  paused = true;
  preload = '';
  loads = 0;
  constructor() { FakeAudio.made.push(this); }
  addEventListener() {}
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  load() { this.loads++; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
}

interface PlayerPost { zone: string; body: ExtCommand & { trackIds?: string[]; startIndex?: number; positionMs?: number } }

interface Setup {
  /** The pc zone's extra fields (the engine Soloist or the app, the fallback notice). */
  pc?: Record<string, unknown>;
  /** The Soloist zone entry as the server lists it. */
  soloist?: Record<string, unknown> | null;
  /** What the soloist zone is doing when the page loads (the PC playing a Spotify song through it). */
  soloistState?: Partial<PlayerState>;
  pcState?: Partial<PlayerState>;
}

async function setup(o: Setup = {}) {
  vi.resetModules();
  FakeAudio.made = [];
  const location = { protocol: 'https:', host: 'rune.example', href: 'https://rune.example/', search: '' };
  vi.stubGlobal('location', location);
  // A phone: narrow screen (the browser zone is the default there), iPhone user agent, a secure page.
  vi.stubGlobal('window', { location, matchMedia: () => ({ matches: true }), isSecureContext: true });
  vi.stubGlobal('navigator', { userAgent: IPHONE_UA, maxTouchPoints: 5 });
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('Audio', FakeAudio);
  const posts: PlayerPost[] = [];
  const outputs: string[] = [];
  /** The soloist zone's state, kept like the server would (a play replaces its queue). */
  let soloist: PlayerState = { ...baseState('soloist'), signalPath: ['Spotify', 'Soloist on the PC', 'PipeWire'], rev: 1, ...(o.soloistState ?? {}) };
  let rev = 1;
  const zones = () => [
    { id: 'pc', name: 'Linux PC speakers', kind: 'pc', ...(o.pc ?? { spotifyEngine: 'soloist', spotifyZone: 'soloist' }) },
    ...(o.soloist === null ? [] : [o.soloist ?? { id: 'soloist', name: 'Spotify (Soloist)', kind: 'spotify', soloist: true, output: 'pc', available: true, isActive: true }]),
    { id: 'spotify:iphone', name: 'iPhone', kind: 'spotify', deviceType: 'Smartphone' },
  ];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/zones')) return json(zones());
    if (url === '/api/soloist/output') {
      const body = JSON.parse(String(init?.body)) as { output: 'pc' | 'phone' };
      outputs.push(body.output);
      soloist = { ...soloist, signalPath: ['Spotify', 'Soloist on the PC', body.output === 'phone' ? 'AAC stream to the phone' : 'PipeWire'], updatedAt: Date.now() };
      return json({ output: body.output, problem: null });
    }
    if (url === '/api/spotify/status') return json({ connected: true, user: { name: 'u', product: 'premium' } });
    if (url.startsWith('/api/player/')) {
      const zone = decodeURIComponent(url.slice('/api/player/'.length));
      const body = init?.body ? (JSON.parse(String(init.body)) as PlayerPost['body']) : null;
      if (method === 'POST' && body) {
        posts.push({ zone, body });
        if (zone === 'soloist') {
          if (body.type === 'play') {
            rev++;
            soloist = { ...soloist, rev, status: body.paused ? 'paused' : 'playing', queue: (body.trackIds ?? []).map(queueItem), index: body.startIndex ?? 0, positionMs: body.positionMs ?? 0, updatedAt: Date.now() };
          } else if (body.type === 'pause') soloist = { ...soloist, status: 'paused', updatedAt: Date.now() };
          else if (body.type === 'resume') soloist = { ...soloist, status: 'playing', updatedAt: Date.now() };
          return json(soloist);
        }
        const ids = body.trackIds ?? [];
        return json({ ...baseState(zone), status: 'playing', queue: ids.map(queueItem), index: body.startIndex ?? 0 });
      }
      if (zone === 'soloist') return json(soloist);
      return json({ ...baseState(zone), ...(zone === 'pc' ? o.pcState : {}) });
    }
    if (url.startsWith('/api/twins/') || url.includes('twins')) return json({});
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  const [{ usePlayer }, { useUi }, { useSpotify }] = await Promise.all([import('./player'), import('./ui'), import('./spotify')]);
  await usePlayer.getState().init();
  lastStore = usePlayer;
  const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
  return {
    usePlayer, useUi, useSpotify, posts, outputs, flush,
    plays: () => posts.filter((p) => p.body.type === 'play'),
    stream: () => FakeAudio.made.find((a) => a.src.includes('/api/soloist/stream/')),
    pushPlayer: (state: PlayerState) => FakeWebSocket.last?.onmessage?.({ data: JSON.stringify({ type: 'player', state, queueRev: `rev-${state.updatedAt}` }) }),
  };
}

describe('Spotify on this phone, through Soloist (the default)', () => {
  it('a Spotify song on the phone’s own zone: output to the phone, then the song on the soloist zone; the stream plays here; no Connect device, no sheet', async () => {
    const h = await setup();
    expect(h.usePlayer.getState().zone).toBe('browser'); // a phone starts on its own zone
    // The Soloist entry is folded away: the phone's zone is how it hears Spotify.
    expect(h.usePlayer.getState().zones.map((z) => z.id)).toEqual(['pc', 'spotify:iphone', 'browser']);
    await h.usePlayer.getState().playItems([item('sp:1'), item('sp:2')], 0);
    await h.flush();
    expect(h.useSpotify.getState().chooser).toBeNull();
    expect(h.outputs).toEqual(['phone']);
    expect(h.plays()).toEqual([{ zone: 'soloist', body: expect.objectContaining({ type: 'play', trackIds: ['sp:1', 'sp:2'], startIndex: 0 }) }]);
    expect(h.posts.some((p) => p.zone.startsWith('spotify:'))).toBe(false);
    expect(h.usePlayer.getState().zone).toBe('browser');
    expect(h.usePlayer.getState().state.status).toBe('playing');
    expect(h.usePlayer.getState().state.queue.map((q) => q.track.id)).toEqual(['sp:1', 'sp:2']);
    const el = h.stream();
    expect(el?.paused).toBe(false);
    expect(el?.src).toMatch(/\/api\/soloist\/stream\/live\.m3u8\?t=/);
  });

  it('local files keep playing in the phone’s own player: nothing goes to Soloist', async () => {
    const h = await setup();
    await h.usePlayer.getState().playItems([item('l:1', 'local')], 0);
    await h.flush();
    expect(h.outputs).toEqual([]);
    expect(h.posts).toEqual([]);
    expect(h.usePlayer.getState().state.status).toBe('playing');
    expect(h.stream()).toBeUndefined();
  });

  it('a mixed queue: the local file here first, the Spotify song is sent to Soloist only when its turn comes', async () => {
    const h = await setup();
    await h.usePlayer.getState().playItems([item('l:1', 'local'), item('sp:1')], 0);
    await h.flush();
    expect(h.usePlayer.getState().state.queue.map((q) => q.track.id)).toEqual(['l:1', 'sp:1']);
    expect(h.posts).toEqual([]);
    await h.usePlayer.getState().command({ type: 'next' });
    await h.flush();
    expect(h.outputs).toEqual(['phone']);
    expect(h.plays()).toEqual([{ zone: 'soloist', body: expect.objectContaining({ trackIds: ['sp:1'] }) }]);
    expect(h.usePlayer.getState().state.index).toBe(1);
  });

  it('Soloist down: the Spotify app route stands in, with the one-line reason, and the sheet opens', async () => {
    const notice = 'Soloist is not signed in to Spotify (pair it once with soloist --pair) — using the Spotify app';
    const h = await setup({
      pc: { spotifyEngine: 'app', spotifyNotice: notice },
      soloist: { id: 'soloist', name: 'Spotify (Soloist)', kind: 'spotify', soloist: true, output: 'pc', available: false, problem: 'Soloist is not signed in to Spotify', notice },
    });
    const toast = vi.spyOn(h.useUi.getState(), 'toast');
    await h.usePlayer.getState().playItems([item('sp:1')], 0);
    await h.flush();
    expect(toast.mock.calls.map((c) => c[0])).toContain(notice);
    expect(h.useSpotify.getState().chooser?.need).toBe('spotify');
    expect(h.outputs).toEqual([]);
    expect(h.posts).toEqual([]);
    // The sheet lists the phone's Spotify app and the PC, not the phone's own zone.
    const { playableZones } = await import('../player/routing');
    expect(playableZones(h.usePlayer.getState().zones, 'spotify', { sdk: false, soloist: false }).map((o) => o.zone.id)).toEqual(['soloist', 'spotify:iphone', 'pc']);
  });

  it('no Soloist in this rune at all: the app route as before, and nothing to explain', async () => {
    const h = await setup({ pc: {}, soloist: null });
    const toast = vi.spyOn(h.useUi.getState(), 'toast');
    await h.usePlayer.getState().playItems([item('sp:1')], 0);
    await h.flush();
    expect(h.useSpotify.getState().chooser?.need).toBe('spotify');
    expect(toast.mock.calls.map((c) => c[0]).filter((m) => /Soloist/.test(m))).toEqual([]);
  });

  it('PC → phone: the PC plays a Spotify song through Soloist; picking "This iPhone" carries it over, and the sound moves to the phone', async () => {
    const soloistPlaying: Partial<PlayerState> = { status: 'playing', queue: [queueItem('sp:7'), queueItem('sp:8')], index: 0, positionMs: 30_000, updatedAt: Date.now() };
    const h = await setup({ soloistState: soloistPlaying });
    await h.usePlayer.getState().setZone('pc', { handoff: false });
    expect(h.usePlayer.getState().state.queue.map((q) => q.track.id)).toEqual(['sp:7', 'sp:8']); // the pc zone shows Soloist's song
    await h.usePlayer.getState().setZone('browser');
    await h.flush();
    expect(h.usePlayer.getState().zone).toBe('browser');
    const types = h.posts.map((p) => `${p.zone}:${p.body.type}`);
    expect(types[0]).toBe('soloist:pause'); // the PC's playback stops first
    expect(h.outputs).toEqual(['phone']);
    const play = h.plays().at(-1)!;
    expect(play.zone).toBe('soloist');
    expect(play.body.trackIds).toEqual(['sp:7', 'sp:8']);
    expect(play.body.positionMs).toBeGreaterThanOrEqual(29_000);
    expect(h.usePlayer.getState().state.status).toBe('playing');
    expect(h.stream()?.paused).toBe(false);
  });
});

describe('the PC’s page when a phone takes Soloist', () => {
  it('says so once and does not pretend the speakers sound; the signal path ends at the phone', () => {
    const notice = vi.fn();
    const states: Record<string, PlayerState> = { pc: baseState('pc'), soloist: baseState('soloist') };
    const subs: Record<string, Set<(s: PlayerState) => void>> = { pc: new Set(), soloist: new Set() };
    const remote = (zone: string) => ({
      zone,
      get state() { return states[zone]!; },
      subscribe(fn: (s: PlayerState) => void) { subs[zone]!.add(fn); return () => { subs[zone]!.delete(fn); }; },
      async send() {},
      async refresh() {},
      dispose() {},
    });
    const pc = new PcBackend({ remote, transport: () => { throw new Error('unused'); }, notice }, { zone: 'soloist', name: 'Soloist' });
    const push = (zone: string, s: PlayerState) => { states[zone] = s; for (const f of subs[zone]!) f(s); };
    // The PC was playing a Spotify song through Soloist on its speakers.
    push('soloist', { ...baseState('soloist'), status: 'playing', queue: [queueItem('sp:1')], index: 0, signalPath: ['Spotify', 'Soloist on the PC', 'PipeWire'], updatedAt: 2 });
    expect(pc.currentMode).toBe('spotify');
    // The phone took it: Soloist plays the phone's song, streamed to the phone.
    const phones = { ...baseState('soloist'), status: 'playing' as const, queue: [queueItem('sp:9')], index: 0, signalPath: ['Spotify', 'Soloist on the PC', 'AAC stream to the phone'], updatedAt: 3 };
    push('soloist', phones);
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith(PcBackend.MOVED_TO_PHONE);
    expect(pc.state.signalPath?.at(-1)).toMatch(/to the phone/);
    push('soloist', { ...phones, positionMs: 5000, updatedAt: 4 });
    expect(notice).toHaveBeenCalledTimes(1); // once
    // The PC page sitting on mpv does not jump to a Soloist that sounds on the phone.
    pc.dispose();
    const pc2 = new PcBackend({ remote, transport: () => { throw new Error('unused'); }, notice }, { zone: 'soloist', name: 'Soloist' });
    push('soloist', { ...phones, updatedAt: 5 });
    expect(pc2.currentMode).toBe('pc');
    pc2.dispose();
  });
});
