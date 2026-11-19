// Audit repros. A test named KNOWN BUG still asserts the buggy behaviour (a pass means the bug is there); the rest assert the fix.
import { describe, expect, it, vi } from 'vitest';
import { FakeZone, mkTrack } from './testkit';
import { emptyState } from './types';
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
