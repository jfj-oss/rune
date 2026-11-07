// Phase 3: the server-owned pc queue (config spotify.serverQueue). The driver with a fake mpv and the simulated
// Spotify account + desktop app (MPRIS) from support/spotify-world.ts. No sound, no D-Bus, no network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerCommand, PlayerState, QueueItem } from '@liner/shared';
import { placeholderItem, QUEUE_KEY, QueueDriver, type DriverStore, type MirrorZone } from '../src/play/driver.js';
import { MpvOutput, SpotifyAppOutput } from '../src/play/outputs.js';
import type { RecordedPlay } from '../src/history/plays.js';
import { SESSION_KEY } from '../src/play/zone.js';
import { DEV, World, sp } from './support/spotify-world.js';
import { FakeRunMpv } from './support/fake-run-mpv.js';

const SONGS: [string, number][] = [['s1', 200_000], ['s2', 180_000], ['s3', 150_000], ['s4', 210_000], ['other', 240_000]];
let qn = 0;
const local = (n: number, dur = 120_000): QueueItem => ({
  queueId: `q${++qn}`,
  track: { id: `l:${n}`, albumId: 'la:1', source: 'local', title: `Local ${n}`, artists: [], disc: 1, number: n, durationMs: dur, path: `/music/${n}.flac` } as QueueItem['track'],
  album: { id: 'la:1', title: 'Album' },
});
const spot = (id: string): QueueItem => ({
  queueId: `q${++qn}`,
  track: { id: `sp:${id}`, albumId: 'sp:alb', source: 'spotify', title: id, artists: [], disc: 1, number: 1, durationMs: SONGS.find((s) => s[0] === id)?.[1] ?? 0, spotifyUri: `spotify:track:${id}` },
  album: { id: 'sp:alb', title: 'Alb' },
});

class MemStore implements DriverStore {
  rows = new Map<string, string>();
  read(k: string) { return this.rows.get(k); }
  write(k: string, v: string) { this.rows.set(k, v); }
}

/** The app's Connect zone as the page sees it while the queue is parked: what the app's MPRIS says. */
function mirrorOf(w: World): MirrorZone {
  return {
    state(): PlayerState {
      const p = w.mprisProps();
      const id = p?.trackId ?? null;
      return {
        zone: `spotify:${DEV}`, status: p?.status === 'Playing' ? 'playing' : p?.trackId ? 'paused' : 'stopped',
        queue: id ? [spot(id.slice(3))] : [], index: id ? 0 : -1, positionMs: p?.positionMs ?? 0, volume: w.volume,
        shuffle: false, repeat: 'off', updatedAt: Date.now(),
      };
    },
    async command(cmd: PlayerCommand) {
      if (cmd.type === 'pause') await w.pause();
      else if (cmd.type === 'resume') await w.play({}, DEV);
      return this.state();
    },
  };
}

function rig(opts: { store?: MemStore; appOpen?: boolean; limit?: () => number | null; device?: () => string | null } = {}) {
  const w = new World({ mpris: true, uriLists: true });
  for (const [id, d] of SONGS) w.songs.set(id, sp(id, d));
  w.appOpen = opts.appOpen ?? true;
  const mpv = new FakeRunMpv();
  const store = opts.store ?? new MemStore();
  const catalog = new Map<string, QueueItem>();
  const plays: RecordedPlay[] = [];
  const startApp = vi.fn(async () => { setTimeout(() => w.openApp(), 3000); });
  const spotify = new SpotifyAppOutput({ bus: w.mpris!, api: w, deviceId: opts.device ?? (() => DEV), startApp, confirmMs: 8000 });
  const ended = vi.fn();
  const driver = new QueueDriver({
    load: (ids) => ids.flatMap((id) => {
      const known = catalog.get(id);
      if (known) return [{ ...known, queueId: `q${++qn}` }];
      return id.startsWith('sp:') ? [placeholderItem(id, `q${++qn}`)] : [];
    }),
    outputs: { mpv: new MpvOutput(mpv), spotify },
    store,
    rateLimitedUntil: opts.limit,
    mirror: () => mirrorOf(w),
    onPlay: (p) => plays.push(p),
  });
  driver.onQueueEnded(ended);
  const items = (...list: QueueItem[]) => { for (const i of list) catalog.set(i.track.id, i); return list.map((i) => i.track.id); };
  const play = (ids: string[], extra: Partial<Extract<PlayerCommand, { type: 'play' }>> = {}) => driver.command({ type: 'play', trackIds: ids, startIndex: 0, ...extra });
  const now = () => { const s = driver.state(); return `${s.queue[s.index]?.track.id ?? '-'} ${s.status}`; };
  const puts = () => w.requests.get('PUT play') ?? 0;
  const done = async () => { await driver.close(); spotify.close(); mpv.dispose(); w.dispose(); };
  return { w, mpv, driver, store, plays, startApp, ended, items, play, now, puts, done };
}
const run = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => { qn = 0; vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
afterEach(() => { vi.useRealTimers(); });

describe('server queue: a mixed queue plays with no tab open', () => {
  it('local, Spotify, Spotify, local: one PUT play for the Spotify run, the app moves on by itself, mpv takes over after', async () => {
    const r = rig();
    const ids = r.items(local(1), spot('s1'), spot('s2'), local(2));
    await r.play(ids);
    expect(r.now()).toBe('l:1 playing');
    expect(r.mpv.log[0]).toBe('load l:1');
    await run(121_000);
    expect(r.now()).toBe('sp:s1 playing');
    expect(r.mpv.sounding).toBe(false);
    expect(r.puts()).toBe(1);
    await run(200_000);
    expect(r.now()).toBe('sp:s2 playing');
    expect(r.puts()).toBe(1);                         // the app moved on by itself
    await run(181_000);
    expect(r.now()).toBe('l:2 playing');
    expect(r.w.playing).toBe(false);
    expect(r.mpv.log.filter((l) => l.startsWith('load'))).toEqual(['load l:1', 'load l:2']);
    await run(121_000);
    expect(r.now()).toBe('l:2 stopped');
    expect(r.ended).toHaveBeenCalledTimes(1);         // the explicit queue-ended event, once
    expect(r.w.requests.get('GET /me/player') ?? 0).toBe(0);
    // history: once per play, from the end events
    expect(r.plays.map((p) => `${p.trackId} ${p.completed}`)).toEqual(['l:1 true', 'sp:s1 true', 'sp:s2 true', 'l:2 true']);
    expect(r.plays.every((p) => p.zone === 'pc')).toBe(true);
    await r.done();
  });

  it('a run of local songs stays one gapless mpv run', async () => {
    const r = rig();
    await r.play(r.items(local(1), local(2), local(3)));
    expect(r.mpv.log[0]).toBe('load l:1,l:2,l:3');
    await run(250_000);
    expect(r.now()).toBe('l:3 playing');
    expect(r.mpv.log.filter((l) => l.startsWith('load'))).toHaveLength(1);
    await r.done();
  });

  it('W1 budget out does not matter: song ends are MPRIS facts and nothing reads /me/player', async () => {
    const r = rig();
    await r.play(r.items(spot('s1'), spot('s2'), spot('s3')));
    await run(531_000);
    expect(r.now()).toBe('sp:s3 stopped');
    expect(r.w.requests.get('GET /me/player') ?? 0).toBe(0);
    expect(r.puts()).toBe(1);
    expect(r.plays).toHaveLength(3);
    await r.done();
  });

  it('rate limit up with the next song Spotify: it pauses with a reason instead of skipping to a local song', async () => {
    let until: number | null = null;
    const r = rig({ limit: () => until });
    await r.play(r.items(local(1), spot('s1'), local(2)));
    until = Date.now() + 3600_000;
    await run(121_000);
    const s = r.driver.state();
    expect(r.now()).toBe('sp:s1 paused');
    expect(s.hold?.reason).toBe('rate-limited');
    expect(s.hold?.until).toBe(until);
    expect(r.puts()).toBe(0);
    expect(r.mpv.log.filter((l) => l.startsWith('load'))).toEqual(['load l:1']);   // l:2 was not started instead
    // Play while it is still up keeps waiting; once it lifted, the song plays.
    await r.driver.command({ type: 'resume' });
    expect(r.driver.state().hold?.reason).toBe('rate-limited');
    until = null;
    await r.driver.command({ type: 'resume' });
    await run(1000);
    expect(r.now()).toBe('sp:s1 playing');
    expect(r.driver.state().hold).toBeUndefined();
    await r.done();
  });
});

describe('server queue: X1 and P1-P4 on the pc zone', () => {
  it('X1 a paused start of a Spotify song sends nothing; Play sends one PUT play at the position', async () => {
    const r = rig();
    await r.play(r.items(spot('s1'), spot('s2')), { paused: true, positionMs: 30_000 });
    await run(5000);
    expect(r.now()).toBe('sp:s1 paused');
    expect(r.puts()).toBe(0);
    expect(r.w.requests.get('PUT pause') ?? 0).toBe(0);
    expect(r.w.playing).toBe(false);
    await r.driver.command({ type: 'resume' });
    await run(1000);
    expect(r.now()).toBe('sp:s1 playing');
    expect(r.puts()).toBe(1);
    expect(r.w.pos()).toBeGreaterThanOrEqual(30_000);
    await r.done();
  });

  it('P1 the app missing from one device list changes nothing: the mixed queue stays and nothing is paused', async () => {
    let device: string | null = DEV;
    const r = rig({ device: () => device });
    await r.play(r.items(spot('s1'), local(2), spot('s3')));
    await run(5000);
    device = null;                    // one /zones answer without HORSE
    await run(3000);
    device = DEV;
    await run(5000);
    expect(r.driver.state().queue).toHaveLength(3);
    expect(r.now()).toBe('sp:s1 playing');
    expect(r.w.requests.get('PUT pause') ?? 0).toBe(0);
    await run(200_000);
    expect(r.now()).toBe('l:2 playing');
    await r.done();
  });

  it('P2 the same flap with a Spotify-only queue: still playing, nothing paused', async () => {
    let device: string | null = DEV;
    const r = rig({ device: () => device });
    await r.play(r.items(spot('s1'), spot('s2')));
    await run(5000);
    device = null;
    await run(2000);
    device = DEV;
    await run(2000);
    expect(r.now()).toBe('sp:s1 playing');
    expect(r.w.requests.get('PUT pause') ?? 0).toBe(0);
    expect(r.w.playing).toBe(true);
    await r.done();
  });

  it('P3 another client starts a song in the app: the zone follows it, and Play does not take the speakers back', async () => {
    const r = rig();
    await r.play(r.items(spot('s1'), local(2)));
    await run(30_000);
    await r.w.play({ uris: ['spotify:track:other'] }, DEV);   // the phone picks a song on HORSE
    await run(2000);
    const s = r.driver.state();
    expect(s.hold?.reason).toBe('takeover');
    expect(s.queue[s.index]?.track.id).toBe('sp:other');      // the page shows what plays
    expect(s.status).toBe('playing');
    const mine = () => r.w.log.filter((l) => l.includes('PUT play s1')).length;
    const before = mine();
    await r.driver.command({ type: 'resume' });
    await run(1000);
    expect(mine()).toBe(before);                              // no PUT play of rune's song
    expect(r.w.cur?.id).toBe('other');
    // Pause on the page pauses the app's song; playing from rune brings rune's queue back.
    await r.driver.command({ type: 'pause' });
    await run(1000);
    expect(r.w.playing).toBe(false);
    await r.play(r.items(local(5)));
    await run(500);
    expect(r.now()).toBe('l:5 playing');
    expect(r.driver.state().hold).toBeUndefined();
    await r.done();
  });

  it('P3b the app starting a song while mpv plays: mpv stops, the queue is parked', async () => {
    const r = rig();
    await r.play(r.items(local(1), local(2)));
    await run(10_000);
    await r.w.play({ uris: ['spotify:track:other'] }, DEV);
    await run(2000);
    expect(r.mpv.sounding).toBe(false);
    expect(r.driver.state().hold?.reason).toBe('takeover');
    expect(r.driver.state().queue[0]?.track.id).toBe('sp:other');
    await r.done();
  });

  it('P4 boot: the saved queue comes back paused and silent; Play starts its Spotify song, not mpv', async () => {
    const store = new MemStore();
    store.write(QUEUE_KEY, JSON.stringify({ v: 1, queue: [{ queueId: 'a', trackId: 'sp:s1' }, { queueId: 'b', trackId: 'l:2' }], index: 0, positionMs: 42_000, shuffle: false, repeat: 'off', order: [0, 1], volume: 60 }));
    const r4 = rigWithCatalog(store, [local(2)]);
    await run(10_000);
    expect(r4.now()).toBe('sp:s1 paused');
    expect(r4.driver.state().positionMs).toBe(42_000);
    expect(r4.driver.state().volume).toBe(60);
    expect(r4.puts()).toBe(0);
    expect(r4.mpv.log).toEqual([]);
    await r4.driver.command({ type: 'resume' });
    await run(1000);
    expect(r4.now()).toBe('sp:s1 playing');
    expect(r4.mpv.log.filter((l) => l.startsWith('load') || l === 'resume')).toEqual([]);
    expect(r4.w.pos()).toBeGreaterThanOrEqual(42_000);
    await r4.done();
  });

  it('the saved mpv session moves to player.queue.pc once; the old row stays as it was', async () => {
    const store = new MemStore();
    const old = JSON.stringify({ v: 1, queue: [{ queueId: 'x', trackId: 'l:7' }], index: 0, positionMs: 1000, shuffle: false, repeat: 'off', order: [0], volume: 80 });
    store.write(SESSION_KEY, old);
    const r = rigWithCatalog(store, [local(7)]);
    expect(r.now()).toBe('l:7 paused');
    expect(store.read(QUEUE_KEY)).toContain('l:7');
    expect(store.read(SESSION_KEY)).toBe(old);
    await r.done();
  });
});

/** A rig whose loader knows `known` before the driver restores. */
function rigWithCatalog(store: MemStore, known: QueueItem[]) {
  const w = new World({ mpris: true, uriLists: true });
  for (const [id, d] of SONGS) w.songs.set(id, sp(id, d));
  const mpv = new FakeRunMpv();
  const catalog = new Map(known.map((k) => [k.track.id, k]));
  const spotify = new SpotifyAppOutput({ bus: w.mpris!, api: w, deviceId: () => DEV });
  const driver = new QueueDriver({
    load: (ids) => ids.flatMap((id) => (catalog.get(id) ? [{ ...catalog.get(id)!, queueId: `q${++qn}` }] : id.startsWith('sp:') ? [{ ...spot(id.slice(3)), queueId: `q${++qn}` }] : [])),
    outputs: { mpv: new MpvOutput(mpv), spotify },
    store,
    mirror: () => mirrorOf(w),
  });
  const now = () => { const s = driver.state(); return `${s.queue[s.index]?.track.id ?? '-'} ${s.status}`; };
  return { w, mpv, driver, now, puts: () => w.requests.get('PUT play') ?? 0, done: async () => { await driver.close(); spotify.close(); mpv.dispose(); w.dispose(); } };
}

describe('server queue: what MPRIS says', () => {
  it('a pause in the app mid-song is a pause: no next song, and Play goes on from there', async () => {
    const r = rig();
    await r.play(r.items(spot('s1'), spot('s2')));
    await run(60_000);
    r.w.externalPause();
    await run(300_000);
    expect(r.now()).toBe('sp:s1 paused');
    expect(r.puts()).toBe(1);
    expect(r.driver.state().positionMs).toBeGreaterThanOrEqual(59_000);
    r.w.externalResume();
    await run(1000);
    expect(r.now()).toBe('sp:s1 playing');
    await run(141_000);
    expect(r.now()).toBe('sp:s2 playing');
    expect(r.puts()).toBe(1);
    await r.done();
  });

  it('a pause in the app 3 s before the end is still a pause, not the end', async () => {
    const r = rig();
    await r.play(r.items(spot('s1'), local(2)));
    await run(197_000);
    r.w.externalPause();
    await run(60_000);
    expect(r.now()).toBe('sp:s1 paused');
    expect(r.mpv.log).toEqual([]);
    await r.done();
  });

  it('playback moved to the phone mid-song: no next song, no music pulled back', async () => {
    const r = rig();
    await r.play(r.items(spot('s1'), local(2)));
    await run(60_000);
    r.w.otherDevice('phone');
    await run(400_000);
    expect(r.now()).toBe('sp:s1 paused');
    expect(r.mpv.log).toEqual([]);
    expect(r.w.device).toBe('phone');
    await r.done();
  });

  it('the app closed mid-song: paused with a reason, the queue does not move on', async () => {
    const r = rig();
    await r.play(r.items(spot('s1'), local(2)));
    await run(60_000);
    r.w.closeApp();
    await run(5000);
    expect(r.now()).toBe('sp:s1 paused');
    expect(r.driver.state().hold?.reason).toBe('spotify-unavailable');
    expect(r.mpv.log).toEqual([]);
    await r.done();
  });

  it('the app is started on demand: the driver waits for its MPRIS name, then plays to the cached device', async () => {
    const r = rig({ appOpen: false });
    const p = r.play(r.items(spot('s1')));
    await run(5000);
    await p;
    expect(r.startApp).toHaveBeenCalledTimes(1);
    await run(1000);
    expect(r.now()).toBe('sp:s1 playing');
    expect(r.puts()).toBe(1);
    await r.done();
  });

  it('an app that never comes up: paused with a reason, nothing else started', async () => {
    const r = rig({ appOpen: false });
    r.startApp.mockImplementation(async () => undefined);
    const p = r.play(r.items(spot('s1'), local(2)));
    await run(31_000);
    await p;
    expect(r.now()).toBe('sp:s1 paused');
    expect(r.driver.state().hold?.reason).toBe('spotify-unavailable');
    expect(r.mpv.log).toEqual([]);
    await r.done();
  });
});

describe('server queue: edits', () => {
  it('an edit that changes the next Spotify song is sent about 1 s before the end, in one PUT play', async () => {
    const r = rig();
    await r.play(r.items(spot('s1'), spot('s2'), spot('s3')));
    await run(10_000);
    const s3 = r.driver.state().queue[2]!;
    await r.driver.command({ type: 'move', queueId: s3.queueId, toIndex: 1 });   // s3 next now
    await run(30_000);
    expect(r.puts()).toBe(1);                         // nothing sent mid-song
    await run(160_000);                               // s1 ends at 200 s
    expect(r.puts()).toBe(2);
    expect(r.now()).toBe('sp:s3 playing');
    expect(r.w.context).toEqual(['s3', 's2']);
    await run(151_000);
    expect(r.now()).toBe('sp:s2 playing');
    expect(r.puts()).toBe(2);
    await r.done();
  });

  it('a local song put next during a Spotify run: mpv takes over about 1 s before the end and the app is paused', async () => {
    const r = rig();
    await r.play(r.items(spot('s1'), spot('s2')));
    await run(10_000);
    r.items(local(9));
    await r.driver.command({ type: 'enqueue', trackIds: ['l:9'], next: true });
    await run(190_000);
    expect(r.now()).toBe('l:9 playing');
    expect(r.w.playing).toBe(false);
    expect(r.mpv.log).toContain('load l:9');
    await run(121_000);
    expect(r.now()).toBe('sp:s2 playing');
    await r.done();
  });

  it('a local edit during a mpv run goes to mpv at once (gapless preload), with no restart', async () => {
    const r = rig();
    await r.play(r.items(local(1), local(2)));
    r.items(local(3));
    await r.driver.command({ type: 'enqueue', trackIds: ['l:3'], next: true });
    expect(r.mpv.log).toContain('upcoming l:3,l:2');
    await run(121_000);
    expect(r.now()).toBe('l:3 playing');
    expect(r.mpv.log.filter((l) => l.startsWith('load'))).toHaveLength(1);
    await r.done();
  });

  it('every edit and move bumps the revision', async () => {
    const r = rig();
    await r.play(r.items(local(1), local(2), local(3)));
    const a = r.driver.state().rev!;
    await r.driver.command({ type: 'remove', queueId: r.driver.state().queue[2]!.queueId });
    const b = r.driver.state().rev!;
    await run(121_000);
    const c = r.driver.state().rev!;
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(r.driver.state().output).toBe('mpv');
    await r.done();
  });
});

describe('server queue: volume and ducks', () => {
  it('a duck travels with the music and its restore reaches whichever player sounds; the saved level is the user\'s', async () => {
    const store = new MemStore();
    const r = rig({ store });
    await r.play(r.items(local(1), spot('s1')));
    await r.driver.command({ type: 'volume', volume: 80 });
    await r.driver.command({ type: 'volume', volume: 20 });           // voice: wake word
    await run(10_000);
    expect(r.mpv.volume).toBe(20);
    await run(111_000);                                                // the switch to Spotify happens during the duck
    expect(r.now()).toBe('sp:s1 playing');
    expect(r.w.volume).toBe(20);
    await r.driver.command({ type: 'volume', volume: 80 });           // voice restores the pc zone
    expect(r.w.volume).toBe(80);
    await r.driver.command({ type: 'volume', volume: 20 });
    await run(2000);
    await r.driver.close();
    expect(JSON.parse(store.read(QUEUE_KEY)!).volume).toBe(80);
    await r.done();
  });
});

describe('server queue: transport', () => {
  it('Next on a Spotify song is one PUT play of the run from the next song; the skipped play is not completed', async () => {
    const r = rig();
    await r.play(r.items(spot('s1'), spot('s2'), spot('s3')));
    await run(60_000);
    await r.driver.command({ type: 'next' });
    await run(1000);
    expect(r.now()).toBe('sp:s2 playing');
    expect(r.puts()).toBe(2);
    expect(r.w.context).toEqual(['s2', 's3']);
    expect(r.plays.map((p) => `${p.trackId} ${p.completed}`)).toEqual(['sp:s1 false']);
    await r.done();
  });

  it('Next from a local song to a Spotify one: mpv is silenced first, then the app plays', async () => {
    const r = rig();
    await r.play(r.items(local(1), spot('s1')));
    await run(5000);
    await r.driver.command({ type: 'next' });
    await run(1000);
    expect(r.mpv.sounding).toBe(false);
    expect(r.mpv.log).toContain('clear');
    expect(r.now()).toBe('sp:s1 playing');
    await r.driver.command({ type: 'prev' });            // under 3 s in: back to the local song
    await run(500);
    expect(r.now()).toBe('l:1 playing');
    expect(r.w.playing).toBe(false);
    await r.done();
  });

  it('Pause pressed while a Spotify start is on its way holds: the song ends up paused', async () => {
    const r = rig();
    const p = r.play(r.items(spot('s1')));
    const q = r.driver.command({ type: 'pause' });
    await p; await q;
    await run(2000);
    expect(r.now()).toBe('sp:s1 paused');
    expect(r.w.playing).toBe(false);
    await r.done();
  });

  it('a seek on a Spotify song moves its end: the next song still follows at the right time', async () => {
    const r = rig();
    await r.play(r.items(spot('s1'), local(2)));
    await run(10_000);
    await r.driver.command({ type: 'seek', positionMs: 150_000 });
    await run(48_000);
    expect(r.now()).toBe('sp:s1 playing');
    await run(4_000);
    expect(r.now()).toBe('l:2 playing');
    await r.done();
  });

  it('repeat one replays the song; repeat all wraps from the last song to the first', async () => {
    const r = rig();
    await r.play(r.items(local(1), local(2)));
    await r.driver.command({ type: 'repeat', mode: 'one' });
    await run(121_000);
    expect(r.now()).toBe('l:1 playing');
    await r.driver.command({ type: 'repeat', mode: 'all' });
    await r.driver.command({ type: 'next' });
    await run(121_000);
    expect(r.now()).toBe('l:1 playing');
    expect(r.ended).not.toHaveBeenCalled();
    await r.done();
  });

  it('the last start wins, by when the signal arrived: the app after rune parks the queue', async () => {
    const r = rig();
    await r.play(r.items(local(1)));
    await run(1000);
    await r.w.play({ uris: ['spotify:track:other'] }, DEV);
    await run(2000);
    expect(r.mpv.sounding).toBe(false);
    expect(r.driver.state().hold?.reason).toBe('takeover');
    await r.done();
  });

  it('the last start wins: an app start signalled just before rune\'s own start is the one paused', async () => {
    const r = rig();
    await r.w.play({ uris: ['spotify:track:other'] }, DEV);
    await run(450);                                  // its signal has arrived; the read waits for the burst to settle
    await r.play(r.items(local(1)));                 // rune starts mpv in that moment
    await run(2000);
    expect(r.now()).toBe('l:1 playing');
    expect(r.driver.state().hold).toBeUndefined();
    expect(r.w.playing).toBe(false);                 // the older start, the app's, was paused
    await r.done();
  });

  it('Clear stops whichever player sounds and empties the queue', async () => {
    const r = rig();
    await r.play(r.items(spot('s1'), local(2)));
    await run(5000);
    await r.driver.command({ type: 'clear' });
    await run(1000);
    expect(r.driver.state().queue).toEqual([]);
    expect(r.driver.state().status).toBe('stopped');
    expect(r.w.playing).toBe(false);
    expect(r.ended).not.toHaveBeenCalled();
    await r.done();
  });
});

describe('server queue: the Spotify output on its own', () => {
  function scripted() {
    let props: import('../src/spotify/mpris.js').MprisProps | null = null;
    const fns = new Set<(ev: import('../src/spotify/mpris.js').MprisEvent) => void>();
    const bus = { read: async () => props, streams: async () => [], onEvent: (f: (ev: import('../src/spotify/mpris.js').MprisEvent) => void) => { fns.add(f); }, close: () => undefined };
    const calls: string[] = [];
    const api = { play: async (b: { uris?: string[] }) => { calls.push(`play ${b.uris?.length ?? 'resume'}`); }, pause: async () => { calls.push('pause'); }, seek: async () => {}, setVolume: async () => {}, setShuffle: async () => {}, setRepeat: async () => {} };
    const out = new SpotifyAppOutput({ bus, api, deviceId: () => DEV });
    const facts: string[] = [];
    out.onFact((f) => facts.push(f.type === 'takeover' ? `takeover ${f.trackId}` : f.type === 'ended' ? `ended ${f.queueId}${f.last ? ' last' : ''}` : `${f.type} ${'queueId' in f ? f.queueId : ''}`));
    const set = (status: string, id: string, pos: number) => {
      props = { status, trackId: id, lengthMs: 200_000, positionMs: pos, volume: 1, shuffle: false, loop: 'None', title: null, artists: [], album: null, artUrl: null };
      for (const f of fns) f({ ev: 'signal', status });
    };
    return { out, facts, calls, set, setProps: (p: typeof props) => { props = p; } };
  }
  const a = (): QueueItem => ({ ...spot('s1'), queueId: 'A' });
  const b = (): QueueItem => ({ ...spot('s2'), queueId: 'B' });

  it('"paused at 0" for a moment between two songs of the list is not the end', async () => {
    const t = scripted();
    t.setProps({ status: 'Paused', trackId: null, lengthMs: 0, positionMs: 0, volume: 1, shuffle: false, loop: 'None', title: null, artists: [], album: null, artUrl: null });
    await t.out.start([a(), b()], { token: 1, positionMs: 0, volume: 100 });
    t.set('Playing', 'sp:s1', 0);
    await run(500);
    expect(t.facts).toEqual(['started A']);
    await run(199_000);
    t.set('Paused', 'sp:s1', 0);
    await run(600);
    t.set('Playing', 'sp:s2', 0);
    await run(2000);
    expect(t.facts).toEqual(['started A', 'ended A', 'started B']);
    expect(t.calls).toEqual(['play 2']);
    t.out.close();
  });

  it('"paused at 0" that stays is the end, also mid-list', async () => {
    const t = scripted();
    t.setProps({ status: 'Paused', trackId: null, lengthMs: 0, positionMs: 0, volume: 1, shuffle: false, loop: 'None', title: null, artists: [], album: null, artUrl: null });
    await t.out.start([a(), b()], { token: 1, positionMs: 0, volume: 100 });
    t.set('Playing', 'sp:s1', 0);
    await run(200_000);
    t.set('Paused', 'sp:s1', 0);
    await run(3000);
    expect(t.facts).toEqual(['started A', 'ended A last']);
    t.out.close();
  });

  it('a song rune did not start, while nothing of rune\'s plays there, is a takeover', async () => {
    const t = scripted();
    t.set('Playing', 'sp:zzz', 0);
    await run(500);
    expect(t.facts).toEqual(['takeover sp:zzz']);
    t.out.close();
  });
});

describe('server queue: a long pause', () => {
  it('Spotify dropped the paused player: Play sends the song again from where it was', async () => {
    const r = rig();
    await r.play(r.items(spot('s1'), spot('s2')));
    await run(60_000);
    await r.driver.command({ type: 'pause' });
    await run(700_000);                            // past Spotify's ~10 min: the Connect player is dropped
    r.w.settle();
    expect(r.w.cur).toBeNull();
    await r.driver.command({ type: 'resume' });
    await run(6000);
    expect(r.now()).toBe('sp:s1 playing');
    expect(r.w.cur?.id).toBe('s1');
    expect(r.w.pos()).toBeGreaterThanOrEqual(59_000);
    expect(r.w.context).toEqual(['s1', 's2']);
    await r.done();
  });
});

describe('server queue: Play then Pause at once', () => {
  it('a pause right after a resume stays a pause: the song is not sent again', async () => {
    const r = rig();
    await r.play(r.items(spot('s1')));
    await run(30_000);
    await r.driver.command({ type: 'pause' });
    await run(5000);
    await r.driver.command({ type: 'resume' });
    await r.driver.command({ type: 'pause' });
    await run(10_000);
    expect(r.now()).toBe('sp:s1 paused');
    expect(r.w.playing).toBe(false);
    expect(r.puts()).toBe(2);                  // the start, and the resume (PUT play {})
    await r.done();
  });
});
