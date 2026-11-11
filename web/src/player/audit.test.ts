// Audit repros. A test named KNOWN BUG still asserts the buggy behaviour (a pass means the bug is there); the rest assert the fix.
import type { PlayerState } from '@liner/shared';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { ExtCommand, PlayItem } from '../lib/types';
import { HybridEngine } from './hybrid';
import { LocalBackend } from './local';
import { PcBackend } from './pc';
import { FakeZone, mkItem, mkTrack } from './testkit';
import { emptyState, type Backend } from './types';
import { ZoneEngine, type ZoneTransport } from './zoneEngine';

const flush = () => new Promise((r) => setTimeout(r, 0));
function setup(opts = {}) {
  const zone = new FakeZone('spotify:dev');
  let now = 10_000;
  const eng = new ZoneEngine(zone, { now: () => now, pollMs: 60_000, startTimeoutMs: 5000, ...opts });
  const ended = vi.fn(), err = vi.fn(), sync = vi.fn();
  eng.onEnded(ended); eng.onError(err); eng.onSync(sync);
  return { zone, eng, ended, err, sync, tick: (ms: number) => { now += ms; } };
}

describe('Z: ZoneEngine', () => {
  it('Z1 a pause in the Spotify app, seen late by a sparse poll, is a pause: it keeps its position and no next song starts', async () => {
    const { zone, eng, ended, sync, tick } = setup();
    eng.load(mkTrack('sp:1', 'spotify'), 0, true); await flush();   // 200 s song
    zone.progress(60_000);                  // last poll: 60 s in
    tick(30_000);                           // user pauses in the Spotify app at 90 s; no poll sees it
    zone.state.positionMs = 90_000;
    tick(105_000);                          // the poll aimed at the song's end, t=195 s
    zone.externalPause();                   // Spotify honestly says: paused at 90 s, NOT rewound
    expect(zone.state.positionMs).toBe(90_000);
    expect(ended).not.toHaveBeenCalled();
    expect(sync).toHaveBeenLastCalledWith(90_000, false);
    expect(eng.position()).toBe(90_000);
  });

  it('Z2 seek forward then back: the end seen on the way does not count, so an outside pause later is only a pause', async () => {
    const { zone, eng, ended, sync, tick } = setup();
    eng.load(mkTrack('sp:1', 'spotify'), 0, true); await flush();
    zone.progress(10_000);
    eng.seek(198_000); await flush();   // peek at the end
    eng.seek(20_000); await flush();    // come back
    zone.progress(21_000);
    tick(1000);
    zone.externalPause();               // speaker guard / voice "pause" / phone: mid-song at 21 s
    expect(ended).not.toHaveBeenCalled();
    expect(sync).toHaveBeenLastCalledWith(21_000, false);
  });

  it('Z3 a pause in the last 5 s from outside the tab (voice "pause", guard) does not start the next song', async () => {
    const { zone, eng, ended, sync } = setup();
    eng.load(mkTrack('l:1', 'local'), 0, true); await flush();
    zone.progress(196_000);
    zone.externalPause();
    expect(ended).not.toHaveBeenCalled();
    expect(sync).toHaveBeenLastCalledWith(196_000, false);
  });

  it('Z3b the song ending after such a pause is still seen, once it was resumed: the pause did not stick', async () => {
    const { zone, eng, ended, tick } = setup();
    eng.load(mkTrack('sp:1', 'spotify'), 0, true); await flush();
    zone.progress(196_000);
    zone.externalPause();
    zone.progress(196_000);              // resumed from the Spotify app
    tick(5000);
    zone.finishPaused();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('Z4 Pause pressed while the play is still on its way lands right after it: the song stays silent', async () => {
    const zone = new FakeZone('spotify:dev');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: ZoneTransport = { ...zone, send: async (c) => { if (c.type === 'play') await gate; return zone.send(c); }, get: () => zone.get(), subscribe: (f) => zone.subscribe(f), connected: () => false };
    const eng = new ZoneEngine(slow, { pollMs: 60_000 });
    eng.load(mkTrack('sp:1', 'spotify'), 0, true); await flush();
    eng.pause();                         // user changes their mind
    release(); await flush(); await flush();
    expect(zone.log.filter((l) => l === 'pause')).toHaveLength(1);
    expect(zone.log.indexOf('pause')).toBeGreaterThan(zone.log.findIndex((l) => l.startsWith('play:')));
    expect(zone.state.status).toBe('paused');
  });

  it('Z4b Pause then Play during the load cancel out: one play, nothing else, and the song is followed', async () => {
    const zone = new FakeZone('spotify:dev');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: ZoneTransport = { send: async (c) => { if (c.type === 'play') await gate; return zone.send(c); }, get: () => zone.get(), subscribe: (f) => zone.subscribe(f), connected: () => false };
    const eng = new ZoneEngine(slow, { pollMs: 60_000 });
    const sync = vi.fn(); eng.onSync(sync);
    eng.load(mkTrack('sp:1', 'spotify'), 0, true); await flush();
    eng.pause();
    eng.play();
    release(); await flush(); await flush();
    expect(zone.log.filter((l) => l === 'pause' || l === 'resume')).toEqual([]);
    expect(zone.state.status).toBe('playing');
    zone.progress(5000);
    expect(sync).toHaveBeenLastCalledWith(5000, true);
  });

  it('Z4c Play pressed during a paused start resumes it once it landed', async () => {
    const zone = new FakeZone('spotify:dev');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: ZoneTransport = { send: async (c) => { if (c.type === 'play') await gate; return zone.send(c); }, get: () => zone.get(), subscribe: (f) => zone.subscribe(f), connected: () => false };
    const eng = new ZoneEngine(slow, { pollMs: 60_000 });
    eng.load(mkTrack('sp:1', 'spotify'), 42_000, false); await flush();
    eng.play();
    release(); await flush(); await flush();
    expect(zone.log.at(-1)).toBe('resume');
    expect(zone.state.status).toBe('playing');
  });

  it('Z4d Pause during the volume step goes out with the play itself', async () => {
    const zone = new FakeZone('spotify:dev');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: ZoneTransport = { send: async (c) => { if (c.type === 'volume') await gate; return zone.send(c); }, get: () => zone.get(), subscribe: (f) => zone.subscribe(f), connected: () => false };
    const eng = new ZoneEngine(slow, { pollMs: 60_000 });
    eng.setVolume(50);
    eng.load(mkTrack('sp:1', 'spotify'), 0, true); await flush();
    eng.pause();
    release(); await flush(); await flush();
    expect(zone.log).toContain('play:sp:1@0:paused');
    expect(zone.log).not.toContain('pause');
  });

  it('Z5 after the "overdue" stop, Play goes on with the queue instead of resuming a song on a dead engine', async () => {
    const { zone, eng, ended, tick } = setup();
    eng.load(mkTrack('sp:1', 'spotify'), 0, true); await flush();
    zone.progress(100_000);
    tick(400_000);                       // slept past the end
    zone.finishPaused();                 // overdue: tab stops, shows the end, paused
    expect(ended).not.toHaveBeenCalled();
    const sent = zone.log.length;
    eng.play(); await flush();           // the user presses Play on the rune page
    expect(ended).toHaveBeenCalledTimes(1);
    expect(zone.log).toHaveLength(sent); // the old song is not resumed: the queue loads the next one
  });

  it('Z5b the whole queue: Play after the overdue stop plays the next song, and that one is followed to its end', async () => {
    const zone = new FakeZone('spotify:dev');
    let now = 10_000;
    const b = new LocalBackend('pc', new ZoneEngine(zone, { now: () => now, pollMs: 60_000 }));
    await b.send({ type: 'play', trackIds: [], startIndex: 0 }, [S(1), S(2), S(3)]); await flush();
    zone.progress(100_000);
    now += 400_000;
    zone.finishPaused();
    expect(b.state).toMatchObject({ index: 0, status: 'paused' });
    await b.send({ type: 'resume' }); await flush();
    expect(b.state).toMatchObject({ index: 1, status: 'playing', positionMs: 0 });
    expect(zone.log.at(-1)).toBe('play:sp:2,sp:3@0'); // the song and the run after it: the zone plays on by itself
    zone.progress(199_000);
    zone.finishPaused(); await flush();
    expect(b.state.index).toBe(2);
    expect(zone.log.at(-1)).toBe('play:sp:3@0');
    b.dispose();
  });

  it('Z5c Play after the overdue stop on the last song ends the queue instead of showing it playing', async () => {
    const zone = new FakeZone('spotify:dev');
    let now = 10_000;
    const b = new LocalBackend('pc', new ZoneEngine(zone, { now: () => now, pollMs: 60_000 }));
    await b.send({ type: 'play', trackIds: [], startIndex: 0 }, [S(1)]); await flush();
    zone.progress(100_000);
    now += 400_000;
    zone.finishPaused();
    const sent = zone.log.length;
    await b.send({ type: 'resume' }); await flush();
    expect(b.state.status).toBe('stopped');
    expect(zone.log).toHaveLength(sent);
    b.dispose();
  });

  it('Z5d a seek after the overdue stop picks a place in that song: Play starts there', async () => {
    const { zone, eng, ended, tick } = setup();
    eng.load(mkTrack('sp:1', 'spotify'), 0, true); await flush();
    zone.progress(100_000);
    tick(400_000);
    zone.finishPaused();
    eng.seek(30_000);
    eng.play(); await flush();
    expect(ended).not.toHaveBeenCalled();
    expect(zone.log.at(-1)).toBe('play:sp:1@30000');
  });

  it('Z6 a start given up on is silenced when it lands after all, and Play tries it again', async () => {
    const zone = new FakeZone('spotify:dev');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: ZoneTransport = { send: async (c) => { if (c.type === 'play') await gate; return zone.send(c); }, get: () => zone.get(), subscribe: (f) => zone.subscribe(f), connected: () => true };
    let now = 0;
    const eng = new ZoneEngine(slow, { now: () => now, pollMs: 60_000, startTimeoutMs: 12_000 });
    const err = vi.fn(); eng.onError(err);
    eng.load(mkTrack('sp:1', 'spotify'), 0, true); await flush();
    now = 13_000;
    eng.onState({ ...emptyState('spotify:dev'), updatedAt: 5 });    // any zone event after 12 s
    expect(err).toHaveBeenCalledTimes(1);                          // page: "did not start", paused
    release(); await flush(); await flush();
    expect(zone.log.at(-1)).toBe('pause');                         // it landed late: silenced at once
    expect(zone.state.status).toBe('paused');
    eng.play(); await flush(); await flush();
    expect(zone.log.at(-1)).toBe('play:sp:1@0');
  });

  it('Z6b a new song taking over before the late start lands is not paused by it', async () => {
    const zone = new FakeZone('spotify:dev');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // the zone runs its commands in order: the second play waits for the first
    const slow: ZoneTransport = { send: async (c) => { if (c.type === 'play') await gate; return zone.send(c); }, get: () => zone.get(), subscribe: (f) => zone.subscribe(f), connected: () => true };
    let now = 0;
    const eng = new ZoneEngine(slow, { now: () => now, pollMs: 60_000, startTimeoutMs: 12_000 });
    eng.load(mkTrack('sp:1', 'spotify'), 0, true); await flush();
    now = 13_000;
    eng.onState({ ...emptyState('spotify:dev'), updatedAt: 5 });
    eng.load(mkTrack('sp:2', 'spotify'), 0, true); await flush();
    release(); await flush(); await flush();
    expect(zone.log.filter((l) => l.startsWith('play:'))).toEqual(['play:sp:1@0', 'play:sp:2@0']);
    expect(zone.log).not.toContain('pause');
    expect(zone.state.status).toBe('playing');
  });

  it('Z6c a start the zone accepted but never showed gets its pause at once', async () => {
    const { zone, eng, err, tick } = setup();
    const send = zone.send.bind(zone);
    zone.send = async (c) => { if (c.type === 'play') { zone.log.push('play'); return zone.state; } return send(c); };
    eng.load(mkTrack('sp:1', 'spotify'), 0, true); await flush();
    tick(6000);
    eng.onState(zone.state);
    expect(err).toHaveBeenCalledTimes(1);
    await flush();
    expect(zone.log.at(-1)).toBe('pause');
  });

  it('Z7 a tab that wakes within 60 s of the end leaves another client\'s new song alone', async () => {
    const { zone, eng, ended, sync, tick } = setup();
    eng.load(mkTrack('sp:1', 'spotify'), 0, true); await flush();
    zone.progress(150_000);
    tick(70_000);    // song ended 20 s ago; the phone has started something else
    zone.state = { ...zone.state, queue: [{ queueId: 'x', track: mkTrack('sp:phone', 'spotify'), album: { id: 'a', title: 'b' } }], index: 0, positionMs: 3000, status: 'playing', updatedAt: Date.now() + 1 };
    const sent = zone.log.length;
    eng.onState(zone.state);
    expect(ended).not.toHaveBeenCalled();
    expect(sync).toHaveBeenLastCalledWith(200_000, false);
    await flush();
    expect(zone.log).toHaveLength(sent);
    eng.play(); await flush();               // the user asks: then the queue goes on
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('Z7b a song that began as ours ran out followed it, however late the tab noticed within the minute', async () => {
    const { zone, eng, ended, tick } = setup();
    eng.load(mkTrack('sp:1', 'spotify'), 0, true); await flush();
    zone.progress(150_000);
    tick(70_000);    // song ended 20 s ago and Spotify's own autoplay has run for those 20 s
    zone.state = { ...zone.state, queue: [{ queueId: 'x', track: mkTrack('sp:auto', 'spotify'), album: { id: 'a', title: 'b' } }], index: 0, positionMs: 20_000, status: 'playing', updatedAt: Date.now() + 1 };
    eng.onState(zone.state);
    expect(ended).toHaveBeenCalledTimes(1);
  });
});

class FakeRemote implements Backend {
  state: PlayerState;
  sent: string[] = [];
  private subs = new Set<(s: PlayerState) => void>();
  constructor(readonly zone: string, public z: FakeZone) {
    this.state = z.state;
    z.subscribe((s) => { this.state = s; for (const f of this.subs) f(s); });
  }
  subscribe(fn: (s: PlayerState) => void) { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  async send(cmd: ExtCommand, _items?: PlayItem[]) { this.sent.push(cmd.type); if (cmd.type !== 'clear' && cmd.type !== 'move') await this.z.send(cmd); }
  async refresh() { this.state = this.z.state; }
  dispose() {}
}
function make(pre?: (z: { pc: FakeZone; sp: FakeZone }) => void) {
  const pcz = new FakeZone('pc'), spz = new FakeZone('spotify:dev');
  pre?.({ pc: pcz, sp: spz });
  const zones = { pc: pcz, 'spotify:dev': spz };
  const pc = new PcBackend({ remote: (z) => new FakeRemote(z, zones[z as keyof typeof zones]), transport: (z) => zones[z as keyof typeof zones], notice: vi.fn() }, { zone: 'spotify:dev', name: 'HORSE' });
  return { pc, pcz, spz };
}
const L = (n: number) => mkItem(mkTrack(`l:${n}`, 'local'));
const S = (n: number) => mkItem(mkTrack(`sp:${n}`, 'spotify'));
const play = (items: PlayItem[], extra: object = {}): ExtCommand => ({ type: 'play', trackIds: items.map((i) => i.track.id), startIndex: 0, ...extra });
let live: PcBackend | null = null;
afterEach(() => { live?.dispose(); live = null; });

describe('P: PcBackend', () => {
  it('KNOWN BUG (serverQueue off; closed with it on in server/tests/driver.test.ts) P1 one /zones answer without the Spotify device throws the mixed queue away and stops the music', async () => {
    const { pc, spz } = make(); live = pc;
    await pc.send(play([S(1), L(2), S(3)]), [S(1), L(2), S(3)]); await flush();
    spz.progress(5000);
    expect(pc.state.queue).toHaveLength(3);
    pc.setDevice(null); await flush();                    // one flap
    pc.setDevice({ zone: 'spotify:dev', name: 'HORSE' }); await flush(); // back a moment later
    expect(spz.log).toContain('pause');
    expect(pc.currentMode).toBe('pc');
    expect(pc.state.queue.length).toBeLessThan(3);        // queue gone
  });

  it('KNOWN BUG (serverQueue off; closed with it on in server/tests/driver.test.ts) P2 a flap in Spotify mode pauses the song on the speakers', async () => {
    const { pc, spz } = make(); live = pc;
    await pc.send(play([S(1), S(2)]), [S(1), S(2)]); await flush();
    expect(pc.currentMode).toBe('spotify');
    pc.setDevice(null); await flush();
    expect(spz.log).toContain('pause');
  });

  it('KNOWN BUG (serverQueue off; closed with it on in server/tests/driver.test.ts) P3 a tab in mixed mode never follows another client: stale now-playing, and its Play overwrites them', async () => {
    const { pc, spz } = make(); live = pc;
    await pc.send(play([S(1), L(2)]), [S(1), L(2)]); await flush();
    spz.progress(30_000);
    await spz.send({ type: 'play', trackIds: ['sp:other'], startIndex: 0 }); await flush();  // phone starts another song
    expect(pc.currentMode).toBe('mixed');
    expect(pc.state.queue[pc.state.index]?.track.id).toBe('sp:1');   // page still shows the old song
    expect(pc.state.status).toBe('paused');                          // while sp:other is playing
    expect(spz.state.status).toBe('playing');
    await pc.send({ type: 'resume' }); await flush();
    expect(spz.log.at(-1)).toContain('play:sp:1');                   // Play takes the speakers back
  });

  it('KNOWN BUG (serverQueue off; closed with it on in server/tests/driver.test.ts) P4 fresh page: a paused Spotify song loses to mpv\'s old restored queue (refresh() is never called at start)', async () => {
    const { pc, pcz, spz } = make(({ pc: p, sp }) => {
      p.state = { ...emptyState('pc'), status: 'paused', queue: [{ queueId: 'o', track: mkTrack('l:old', 'local'), album: { id: 'a', title: 'x' } }], index: 0 };
      sp.state = { ...emptyState('spotify:dev'), status: 'paused', queue: [{ queueId: 'n', track: mkTrack('sp:now', 'spotify'), album: { id: 'a', title: 'x' } }], index: 0 };
    }); live = pc;
    await flush();
    expect(pc.currentMode).toBe('pc');
    expect(pc.state.queue[0]?.track.id).toBe('l:old');
    await pc.send({ type: 'resume' }); await flush();
    expect(pcz.log).toContain('resume');    // space bar starts yesterday's mpv song
    expect(spz.log).not.toContain('resume');
  });

  it('P5 starting Spotify while the voice assistant has mpv ducked leaves the duck behind', async () => {
    const { pc, pcz, spz } = make(); live = pc;
    await pc.send(play([L(1)]), [L(1)]); await flush();
    await pcz.send({ type: 'volume', volume: 100 });
    await pcz.send({ type: 'volume', volume: 20 });   // voice: wake word heard (also on a false wake)
    await flush();
    await spz.send({ type: 'volume', volume: 100 });
    await pc.send(play([S(1)]), [S(1)]); await flush();
    expect(spz.state.volume).toBe(100);
    expect(spz.log).not.toContain('volume:20');
    await pcz.send({ type: 'volume', volume: 100 });  // voice restores the zone it ducked: pc only
    expect(spz.state.volume).toBe(100);
  });

  it('P5b the level the user chose still follows the music from mpv to Spotify', async () => {
    const { pc, spz } = make(); live = pc;
    await pc.send(play([L(1)]), [L(1)]); await flush();
    await pc.send({ type: 'volume', volume: 40 }); await flush();
    await pc.send(play([S(1)]), [S(1)]); await flush();
    expect(spz.state.volume).toBe(40);
  });

  it('P5c a lower level set from another tab counts once it has stood longer than a duck', async () => {
    let now = 1000;
    const pcz = new FakeZone('pc'), spz = new FakeZone('spotify:dev');
    const zones = { pc: pcz, 'spotify:dev': spz };
    const pc = new PcBackend({ remote: (z) => new FakeRemote(z, zones[z as keyof typeof zones]), transport: (z) => zones[z as keyof typeof zones], now: () => now }, { zone: 'spotify:dev', name: 'HORSE' }); live = pc;
    await pc.send(play([L(1)]), [L(1)]); await flush();
    await pcz.send({ type: 'volume', volume: 30 }); await flush();
    now += 21_000;
    await pc.send(play([S(1)]), [S(1)]); await flush();
    expect(spz.state.volume).toBe(30);
  });

  it('P5d a duck ending in time counts for nothing', async () => {
    let now = 1000;
    const pcz = new FakeZone('pc'), spz = new FakeZone('spotify:dev');
    const zones = { pc: pcz, 'spotify:dev': spz };
    const pc = new PcBackend({ remote: (z) => new FakeRemote(z, zones[z as keyof typeof zones]), transport: (z) => zones[z as keyof typeof zones], now: () => now }, { zone: 'spotify:dev', name: 'HORSE' }); live = pc;
    await pc.send(play([L(1)]), [L(1)]); await flush();
    await pcz.send({ type: 'volume', volume: 20 }); await flush();
    now += 10_000;
    await pcz.send({ type: 'volume', volume: 100 }); await flush();
    now += 60_000;
    await pc.send(play([S(1)]), [S(1)]); await flush();
    expect(spz.state.volume).toBe(100);
  });

  it('P5e a page opened on a quiet zone takes that level, not the placeholder of a zone that has not answered', async () => {
    const pcz = new FakeZone('pc'), spz = new FakeZone('spotify:dev');
    pcz.state = { ...pcz.state, volume: 40 };
    class Late extends FakeRemote {
      ready = false;
      constructor(zone: string, z: FakeZone) { super(zone, z); this.state = emptyState(zone); }
    }
    const zones = { pc: pcz, 'spotify:dev': spz };
    const pc = new PcBackend({ remote: (z) => (z === 'pc' ? new Late(z, pcz) : new FakeRemote(z, spz)), transport: (z) => zones[z as keyof typeof zones] }, { zone: 'spotify:dev', name: 'HORSE' }); live = pc;
    await pcz.send({ type: 'volume', volume: 40 }); await flush();   // the first answer
    expect(pc.userVolume()).toBe(40);
  });

  it('P6 a mixed queue created during a duck does not pin the queue to the ducked level', async () => {
    const { pc, pcz, spz } = make(); live = pc;
    await pcz.send({ type: 'volume', volume: 20 }); await flush();
    const ducks = pcz.log.filter((l) => l === 'volume:20').length;
    await pc.send(play([S(1), L(2)]), [S(1), L(2)]); await flush();
    expect(spz.log).not.toContain('volume:20');
    await pcz.send({ type: 'volume', volume: 100 });  // duck over
    spz.progress(199_000);
    spz.finishPaused(); await flush(); await flush();
    expect(pcz.log.at(-1)).toContain('play:l:2');     // the next song did start...
    expect(pcz.log.filter((l) => l === 'volume:20')).toHaveLength(ducks); // ...without dragging mpv back down
  });
});

describe('L: LocalBackend', () => {
  it('L1 Pause during a load holds: the page stays paused and the song stays silent', async () => {
    const zone = new FakeZone('spotify:dev');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: ZoneTransport = { send: async (c) => { if (c.type === 'play') await gate; return zone.send(c); }, get: () => zone.get(), subscribe: (f) => zone.subscribe(f), connected: () => false };
    const engine = new HybridEngine(new ZoneEngine(new FakeZone('pc'), { pollMs: 60_000 }), new ZoneEngine(slow, { pollMs: 60_000 }));
    const b = new LocalBackend('pc', engine);
    await b.send({ type: 'play', trackIds: [], startIndex: 0 }, [S(1), L(2)]); await flush();
    await b.send({ type: 'pause' });
    expect(b.state.status).toBe('paused');
    release(); await flush(); await flush();
    expect(b.state.status).toBe('paused');
    expect(zone.state.status).toBe('paused');
    b.dispose();
  });
});
