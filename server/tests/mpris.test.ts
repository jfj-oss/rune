// Phase 2: this PC's Spotify app read over MPRIS. Everything here is fake: no D-Bus, no Spotify, no sound.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueueItem } from '@liner/shared';
import type { WatchChild } from '../src/play/spotifyWatch.js';
import type { StreamSample } from '../src/play/playbackLog.js';
import type { SpotifyPlaybackState } from '../src/spotify/api.js';
import { createMprisBus, MprisPlaybackSource, parseGetAll, type MprisBus, type MprisEvent, type MprisProps } from '../src/spotify/mpris.js';
import { mapPlaybackState, sharedPlaybackReads, SpotifyConnectZone, type SpotifyZoneApi } from '../src/spotify/zones.js';
import { buildApp } from '../src/api/server.js';
import { openDb } from '../src/db/index.js';
import { playbackState, sampleTrack, TEST_CONFIG } from './spotify-helpers.js';

process.env.LOG_LEVEL = 'silent';

// Shaped like the real `busctl --json=short call … GetAll` answer from the Spotify flatpak (titles made up).
const GETALL = (over: { status?: string; id?: string; position?: number; length?: number; volume?: number } = {}) =>
  JSON.stringify({
    type: 'a{sv}',
    data: [{
      PlaybackStatus: { type: 's', data: over.status ?? 'Playing' },
      LoopStatus: { type: 's', data: 'None' },
      Rate: { type: 'd', data: 1 },
      Shuffle: { type: 'b', data: false },
      Metadata: { type: 'a{sv}', data: {
        'mpris:trackid': { type: 's', data: over.id ?? '/com/spotify/track/4GZspqJhj1V8OAEXx3lFDr' },
        'mpris:length': { type: 't', data: over.length ?? 90_000_000 },
        'mpris:artUrl': { type: 's', data: 'https://i.scdn.co/image/cover' },
        'xesam:album': { type: 's', data: 'An Album' },
        'xesam:artist': { type: 'as', data: ['An Artist'] },
        'xesam:title': { type: 's', data: 'A Title' },
      } },
      Volume: { type: 'd', data: over.volume ?? 1 },
      Position: { type: 'x', data: over.position ?? 3_065_000 },
      CanControl: { type: 'b', data: true },
    }],
  });

describe('reading GetAll', () => {
  it('takes the status, the song, its length, the position, the volume, shuffle and loop', () => {
    expect(parseGetAll(GETALL())).toEqual({
      status: 'Playing', trackId: 'sp:4GZspqJhj1V8OAEXx3lFDr', lengthMs: 90_000, positionMs: 3065, volume: 1, shuffle: false, loop: 'None',
      title: 'A Title', artists: ['An Artist'], album: 'An Album', artUrl: 'https://i.scdn.co/image/cover',
    });
  });
  it('an ad or no song has no id; garbage is no answer', () => {
    expect(parseGetAll(GETALL({ id: '/com/spotify/ad/xyz' }))?.trackId).toBeNull();
    expect(parseGetAll(GETALL({ id: '/org/mpris/MediaPlayer2/TrackList/NoTrack' }))?.trackId).toBeNull();
    expect(parseGetAll('not json')).toBeNull();
    expect(parseGetAll(null)).toBeNull();
    expect(parseGetAll('{"type":"a{sv}","data":[{}]}')).toBeNull();
  });
});

class FakeChild implements WatchChild {
  lines: ((l: string) => void)[] = [];
  exits: (() => void)[] = [];
  killed = false;
  onLine(fn: (l: string) => void) { this.lines.push(fn); }
  onExit(fn: () => void) { this.exits.push(fn); }
  kill() { this.killed = true; }
  say(l: string) { for (const f of this.lines) f(l); }
  die() { for (const f of this.exits) f(); }
}

describe('the MPRIS bus', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('listens with gdbus monitor, reads with GetAll only (never starting or controlling the app), and follows the owner', async () => {
    const kids: FakeChild[] = [];
    const spawned: string[] = [];
    const asked: string[] = [];
    const bus = createMprisBus({
      spawn: (c, a) => { spawned.push(`${c} ${a.join(' ')}`); const k = new FakeChild(); kids.push(k); return k; },
      probe: async (c, a) => { asked.push(`${c} ${a.join(' ')}`); return c === 'busctl' ? GETALL() : '[]'; },
    });
    const events: MprisEvent[] = [];
    bus.onEvent((e) => events.push(e));
    expect(spawned).toEqual(['gdbus monitor --session --dest org.mpris.MediaPlayer2.spotify --object-path /org/mpris/MediaPlayer2']);
    expect((await bus.read())?.trackId).toBe('sp:4GZspqJhj1V8OAEXx3lFDr');
    expect(asked).toEqual(['busctl --user --json=short --auto-start=no call org.mpris.MediaPlayer2.spotify /org/mpris/MediaPlayer2 org.freedesktop.DBus.Properties GetAll s org.mpris.MediaPlayer2.Player']);
    kids[0]!.say("/org/mpris/MediaPlayer2: org.freedesktop.DBus.Properties.PropertiesChanged ('org.mpris.MediaPlayer2.Player', {'PlaybackStatus': <'Paused'>}, @as [])");
    expect(events).toEqual([{ ev: 'signal', status: 'Paused' }]);
    kids[0]!.say('The name org.mpris.MediaPlayer2.spotify does not have an owner');
    expect(await bus.read()).toBeNull();
    expect(asked).toHaveLength(1);                          // no owner: not even asked
    kids[0]!.say('The name org.mpris.MediaPlayer2.spotify is owned by :1.300');
    expect(await bus.read()).not.toBeNull();
    expect(await bus.streams()).toEqual([]);
    // Every command run was a read: no MPRIS method (Play, Pause, OpenUri, Seek, Set…) ever.
    for (const a of asked) expect(a).toMatch(/GetAll|pactl --format=json list/);
    kids[0]!.die();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(kids).toHaveLength(2);                           // a monitor that died is started again
    bus.close();
    expect(kids[1]!.killed).toBe(true);
  });
});

// ---------- the read source ----------

class FakeBus implements MprisBus {
  props: MprisProps | null = { status: 'Playing', trackId: 'sp:t1', lengthMs: 200_000, positionMs: 5000, volume: 0.5, shuffle: false, loop: 'None', title: 'MPRIS title', artists: ['MPRIS artist'], album: 'MPRIS album', artUrl: 'https://i.scdn.co/image/x' };
  sound: boolean | null = true;
  reads = 0;
  private fns: ((e: MprisEvent) => void)[] = [];
  closed = false;
  async read() { this.reads++; return this.props ? { ...this.props } : null; }
  async streams(): Promise<StreamSample[] | null> {
    if (this.sound === null) return null;
    return [{ sink: 's', muted: false, volume: 100, corked: !this.sound, sinkMuted: false, sinkVolume: 40 }];
  }
  onEvent(fn: (e: MprisEvent) => void) { this.fns.push(fn); }
  emit(e: MprisEvent) { for (const f of this.fns) f(e); }
  close() { this.closed = true; }
}

function countingApi() {
  const api = {
    reads: 0,
    fail: false,
    answer: playbackState({ ...sampleTrack('t1'), duration_ms: 200_000 }) as SpotifyPlaybackState | null,
    devices: async () => [], tracks: async () => [], track: async (id: string) => sampleTrack(id),
    currentPlayback: async () => {
      api.reads++;
      if (api.fail) throw Object.assign(new Error('rate limited'), { status: 429 });
      return api.answer;
    },
    queue: async () => ({ currently_playing: null, queue: [] }),
    play: async () => {}, pause: async () => {}, next: async () => {}, previous: async () => {}, seek: async () => {},
    setVolume: async () => {}, setShuffle: async () => {}, setRepeat: async () => {}, enqueue: async () => {},
  };
  if (api.answer?.device) api.answer.device = { ...api.answer.device, id: 'horse' };
  return api;
}

function setup(opts: { known?: (ids: string[]) => QueueItem[]; level?: () => 'normal' | 'out' } = {}) {
  const bus = new FakeBus();
  const api = countingApi();
  const source = new MprisPlaybackSource(bus, { deviceId: () => 'horse', knownTracks: opts.known, budgetLevel: opts.level });
  const wake = vi.fn();
  source.setWake(wake);
  const reads = sharedPlaybackReads(api as unknown as SpotifyZoneApi, Date.now, undefined, source);
  const read = () => reads.currentPlayback('horse');
  return { bus, api, source, reads, read, wake };
}

describe('the MPRIS read source', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  it('the first read asks Spotify; after that the app answers, for free', async () => {
    const { api, read, source } = setup();
    await read();
    expect(api.reads).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    const a = await read();
    await vi.advanceTimersByTimeAsync(2000);
    await read();
    expect(api.reads).toBe(1);
    expect(a).toMatchObject({ source: 'mpris', is_playing: true, progress_ms: 5000, device: { id: 'horse' } });
    expect(a?.item?.id).toBe('t1');
    expect(source.readsFree('horse')).toBe(true);
    expect(source.readsFree('phone')).toBe(false);
  });

  it('other devices still read Spotify', async () => {
    const { api, reads, read } = setup();
    await read();
    await vi.advanceTimersByTimeAsync(2000);
    await reads.currentPlayback('phone');
    await vi.advanceTimersByTimeAsync(2000);
    await reads.currentPlayback();
    expect(api.reads).toBe(3);
  });

  it('titles and covers come from rune\'s database', async () => {
    const own: QueueItem = { queueId: 'x', track: { id: 'sp:t9', albumId: 'sp:alb9', source: 'spotify', title: 'From the DB', artists: [{ id: 'ar:9', name: 'DB artist' }], disc: 1, number: 3, durationMs: 201_000, spotifyUri: 'spotify:track:t9' }, album: { id: 'sp:alb9', title: 'DB album', coverUrl: '/api/cover/sp:alb9' } };
    const { bus, api, read } = setup({ known: (ids) => (ids[0] === 'sp:t9' ? [own] : []) });
    await read();
    bus.props = { ...bus.props!, trackId: 'sp:t9' };
    await vi.advanceTimersByTimeAsync(2000);
    const a = await read();
    expect(api.reads).toBe(1);
    const state = mapPlaybackState('spotify:horse', a, undefined);
    expect(state.queue[state.index]).toMatchObject({ track: { title: 'From the DB', artists: [{ id: 'ar:9' }], durationMs: 201_000 }, album: { id: 'sp:alb9', coverUrl: '/api/cover/sp:alb9' } });
  });

  it('a song rune never stored: Spotify is asked once, then its answer is reused; at budget out MPRIS names it', async () => {
    let level: 'normal' | 'out' = 'normal';
    const { bus, api, read } = setup({ level: () => level });
    await read();
    bus.props = { ...bus.props!, trackId: 'sp:t2' };
    api.answer = { ...api.answer!, item: { ...sampleTrack('t2'), name: 'Spotify title' } };
    await vi.advanceTimersByTimeAsync(2000);
    await read();
    expect(api.reads).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    const again = await read();
    expect(api.reads).toBe(2);
    expect(again?.item?.name).toBe('Spotify title');
    level = 'out';
    bus.props = { ...bus.props!, trackId: 'sp:t3' };
    await vi.advanceTimersByTimeAsync(2000);
    const named = await read();
    expect(api.reads).toBe(2);
    expect(mapPlaybackState('spotify:horse', named, undefined).queue[0]).toMatchObject({ track: { title: 'MPRIS title', artists: [{ name: 'MPRIS artist' }] }, album: { title: 'MPRIS album', coverUrl: 'https://i.scdn.co/image/x' } });
  });

  it('while the app plays Spotify is read every ten minutes (another device may have taken over); while paused, never', async () => {
    const { bus, api, read } = setup();
    await read();
    for (let i = 0; i < 40; i++) { await vi.advanceTimersByTimeAsync(30_000); await read(); }
    expect(api.reads).toBe(3);                              // first, 600 s, 1200 s
    bus.props = { ...bus.props!, status: 'Paused' };
    for (let i = 0; i < 80; i++) { await vi.advanceTimersByTimeAsync(30_000); await read(); }
    expect(api.reads).toBe(3);
  });

  it('a command to the app waits for its signal; a command it does not signal costs one Spotify read', async () => {
    const { bus, api, reads, read } = setup();
    await read();
    await vi.advanceTimersByTimeAsync(2000);
    await reads.pause('horse');
    bus.props = { ...bus.props!, status: 'Paused' };
    setTimeout(() => bus.emit({ ev: 'signal', status: 'Paused' }), 400);
    const p = read();
    await vi.advanceTimersByTimeAsync(600);
    expect((await p)?.is_playing).toBe(false);
    expect(api.reads).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    await reads.setShuffle(true, 'horse');                  // whether the app signals shuffle is not known
    const q = read();
    await vi.advanceTimersByTimeAsync(2100);
    await q;
    expect(api.reads).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    await reads.setVolume(30, 'horse');                     // a volume change waits for nothing
    await read();
    expect(api.reads).toBe(2);
  });

  it('playback sent to another device, or Spotify naming one: Spotify is read until the app sounds here again', async () => {
    const { bus, api, reads, read, source } = setup();
    await read();
    await vi.advanceTimersByTimeAsync(2000);
    await reads.play({ uris: ['spotify:track:t1'] }, 'phone');
    api.answer = { ...api.answer!, device: { ...api.answer!.device!, id: 'phone' } };
    bus.sound = false;
    await vi.advanceTimersByTimeAsync(2000);
    await read();
    await vi.advanceTimersByTimeAsync(2000);
    await read();
    expect(api.reads).toBe(3);
    expect(source.readsFree('horse')).toBe(false);
    bus.sound = true;                                       // the user pressed play in the app
    await vi.advanceTimersByTimeAsync(2000);
    const a = await read();
    expect(api.reads).toBe(3);
    expect(a?.device?.id).toBe('horse');
  });

  it('a signal while another device plays wakes the zone only once the app sounds here', async () => {
    const { bus, api, read, wake } = setup();
    api.answer = { ...api.answer!, device: { ...api.answer!.device!, id: 'phone' } };
    await read();                                           // Spotify: the phone plays
    bus.sound = false;
    bus.emit({ ev: 'signal', status: 'Playing' });          // a mirror of the phone, or a takeover?
    await vi.advanceTimersByTimeAsync(2000);
    expect(wake).not.toHaveBeenCalled();
    bus.sound = true;
    bus.emit({ ev: 'signal', status: 'Playing' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('a state that makes no sense is asked about once', async () => {
    const { bus, api, read } = setup();
    await read();
    bus.props = { ...bus.props!, status: 'Stopped' };
    for (let i = 0; i < 3; i++) { await vi.advanceTimersByTimeAsync(2000); await read(); }
    expect(api.reads).toBe(2);
    bus.props = { ...bus.props!, status: 'Playing', positionMs: 260_000 };   // far past the end
    for (let i = 0; i < 3; i++) { await vi.advanceTimersByTimeAsync(2000); await read(); }
    expect(api.reads).toBe(3);
    bus.props = { ...bus.props!, trackId: 'sp:t1', positionMs: 1000 };
    bus.sound = false;                                      // playing, and no sound from it here
    for (let i = 0; i < 5; i++) { await vi.advanceTimersByTimeAsync(2000); await read(); }
    expect(api.reads).toBe(4);
  });

  it('the app going away wakes its zone, and Spotify is read from then on', async () => {
    const { bus, api, read, wake, source } = setup();
    await read();
    bus.props = null;
    bus.emit({ ev: 'owner', owned: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(source.readsFree('horse')).toBe(false);
    await read();
    await vi.advanceTimersByTimeAsync(2000);
    await read();
    expect(api.reads).toBe(3);
  });

  it('a Spotify read that fails (rate limit) is answered by the app', async () => {
    const { api, read } = setup();
    await read();
    api.fail = true;
    await vi.advanceTimersByTimeAsync(600_000);
    const a = await read();
    expect(api.reads).toBe(2);
    expect(a).toMatchObject({ source: 'mpris', is_playing: true });
  });

  it('shuffle, repeat and volume: Spotify\'s word until the app reports a change of its own', async () => {
    const { bus, api, read } = setup();
    api.answer = { ...api.answer!, shuffle_state: true, repeat_state: 'context', device: { ...api.answer!.device!, volume_percent: 64 } };
    await read();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await read()).toMatchObject({ shuffle_state: true, repeat_state: 'context', device: { volume_percent: 64 } });
    bus.props = { ...bus.props!, volume: 0.2, loop: 'Track' };
    await vi.advanceTimersByTimeAsync(2000);
    expect(await read()).toMatchObject({ shuffle_state: true, repeat_state: 'track', device: { volume_percent: 20 } });
  });

  it('when the app was seen to start playing is part of the answer (the speaker guard dates a resume by it)', async () => {
    const { bus, read } = setup();
    bus.props = { ...bus.props!, status: 'Paused' };
    await read();
    bus.props = { ...bus.props!, status: 'Playing', positionMs: 120_000 };
    const at = Date.now();
    bus.emit({ ev: 'signal', status: 'Playing' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(((await read()) as { playingSince?: number }).playingSince).toBe(at);
  });
});

describe('the Connect zone', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  it('reads Spotify\'s queue only for a zone a tab shows', async () => {
    for (const shown of [false, true]) {
      const api = countingApi();
      const queue = vi.spyOn(api, 'queue');
      const zone = new SpotifyConnectZone(api as unknown as SpotifyZoneApi, 'horse', 'HORSE', { shown: () => shown });
      zone.onChange(() => undefined);
      await vi.advanceTimersByTimeAsync(100);
      expect(zone.state().status).toBe('playing');
      expect(queue.mock.calls.length > 0).toBe(shown);
      await zone.close();
    }
  });
});

describe('the config switch', () => {
  it('MPRIS reads are on by default where the server asks for them, and spotify.mprisReads: false turns them off', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rune-mpris-switch-'));
    try {
      for (const mprisReads of [undefined, false]) {
        const db = openDb(':memory:');
        const bus = new FakeBus();
        const onEvent = vi.spyOn(bus, 'onEvent');
        const built = await buildApp(db, { ...TEST_CONFIG, dataDir: join(root, 'data'), spotify: mprisReads === undefined ? {} : { mprisReads } }, {
          pcZone: false, scanOnStart: false, spotifySyncOnStart: false, webDist: join(root, 'no-web-dist'),
          spotifyOptions: { fetch: async () => { throw new Error('no network in tests'); }, endpoints: { api: 'http://api.test/v1', accounts: 'http://accounts.test' } },
          mpris: { bus },
        });
        expect(onEvent).toHaveBeenCalledTimes(mprisReads === false ? 0 : 1);
        await built.close();
        expect(bus.closed).toBe(mprisReads !== false);
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
