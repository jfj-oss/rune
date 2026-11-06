import type { PlayerState } from '@liner/shared';
import { describe, expect, it, vi } from 'vitest';
import { HybridEngine } from './hybrid';
import { FakeZone, mkTrack } from './testkit';
import { ZoneEngine } from './zoneEngine';

const flush = () => new Promise((r) => setTimeout(r, 0));
function setup(opts = {}) {
  const zone = new FakeZone('spotify:dev');
  let now = 10_000;
  const eng = new ZoneEngine(zone, { now: () => now, pollMs: 60_000, startTimeoutMs: 5000, ...opts });
  const ended = vi.fn(), err = vi.fn(), sync = vi.fn();
  eng.onEnded(ended); eng.onError(err); eng.onSync(sync);
  return { zone, eng, ended, err, sync, tick: (ms: number) => { now += ms; } };
}

describe('ZoneEngine', () => {
  it('loads a single track into the zone and starts reporting once the zone confirms it', async () => {
    const { zone, eng, sync, ended } = setup();
    eng.load(mkTrack('sp:1', 'spotify'), 5000, true);
    await flush();
    expect(zone.log).toContain('play:sp:1@5000');
    zone.progress(6000);
    expect(sync).toHaveBeenLastCalledWith(6000, true);
    expect(ended).not.toHaveBeenCalled();
    expect(eng.position()).toBe(6000);
  });

  it('interpolates the position while playing and freezes it on pause', async () => {
    const { zone, eng, tick } = setup();
    eng.load(mkTrack('sp:1', 'spotify'), 0, true);
    await flush();
    zone.progress(1000);
    tick(1500);
    expect(eng.position()).toBe(2500);
    zone.progress(2500); // the zone's own report agrees
    eng.pause();
    await flush();
    expect(zone.log.at(-1)).toBe('pause');
    tick(4000);
    expect(eng.position()).toBe(2500);
  });

  it('starts paused when autoplay is off', async () => {
    const { zone, eng } = setup();
    eng.load(mkTrack('sp:1', 'spotify'), 42_000, false);
    await flush();
    expect(zone.log).toContain('play:sp:1@42000:paused');
  });

  it('detects the end when the zone reports stopped (mpv)', async () => {
    const { zone, eng, ended } = setup();
    eng.load(mkTrack('l:1', 'local'), 0, true);
    await flush();
    zone.progress(190_000);
    zone.finish();
    expect(ended).toHaveBeenCalledTimes(1);
    zone.finish();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('detects the end when Spotify pauses and rewinds after playing to the end', async () => {
    const { zone, eng, ended } = setup();
    eng.load(mkTrack('sp:1', 'spotify', 200_000), 0, true);
    await flush();
    zone.progress(198_000);
    zone.finishPaused();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('does not call a user pause (or an external one mid-track) the end', async () => {
    const { zone, eng, ended, sync } = setup();
    eng.load(mkTrack('sp:1', 'spotify', 200_000), 0, true);
    await flush();
    zone.progress(60_000);
    zone.externalPause();
    expect(ended).not.toHaveBeenCalled();
    expect(sync).toHaveBeenLastCalledWith(60_000, false);
    zone.progress(199_000);
    eng.pause();
    await flush();
    expect(ended).not.toHaveBeenCalled();
  });

  it('ends when the zone moved on to a different track as ours finished', async () => {
    const { zone, eng, ended } = setup();
    eng.load(mkTrack('sp:1', 'spotify'), 0, true);
    await flush();
    zone.progress(197_000);
    await zone.send({ type: 'play', trackIds: ['sp:other'] });
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('counts time played since the last report: a slow poll may only see the next song', async () => {
    const { zone, eng, ended, tick } = setup();
    eng.load(mkTrack('sp:1', 'spotify'), 0, true);
    await flush();
    zone.progress(170_000);
    tick(31_500); // Spotify's next poll comes just after the song ended
    await zone.send({ type: 'play', trackIds: ['sp:other'] });
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('another client’s song mid-track is not our end: it detaches, shows paused and sends nothing', async () => {
    const { zone, eng, ended, sync } = setup();
    eng.load(mkTrack('sp:1', 'spotify'), 0, true);
    await flush();
    zone.progress(60_000);
    await zone.send({ type: 'play', trackIds: ['sp:other'] });
    const sent = zone.log.length;

    expect(ended).not.toHaveBeenCalled();
    expect(sync).toHaveBeenLastCalledWith(60_000, false);
    expect(eng.position()).toBe(60_000);

    zone.progress(90_000); // their song goes on: no longer ours to follow
    eng.seek(70_000); // and not ours to touch
    eng.stop();
    await flush();
    expect(ended).not.toHaveBeenCalled();
    expect(zone.log.length).toBe(sent);
  });

  it('play after being displaced loads our track again where it stopped', async () => {
    const { zone, eng } = setup();
    eng.load(mkTrack('sp:1', 'spotify'), 0, true);
    await flush();
    zone.progress(60_000);
    await zone.send({ type: 'play', trackIds: ['sp:other'] });

    eng.play();
    await flush();
    expect(zone.log.at(-1)).toBe('play:sp:1@60000');
    expect(zone.log).not.toContain('resume');
  });

  it('a user pause near the end is not an end when another song takes the zone', async () => {
    const { zone, eng, ended } = setup();
    eng.load(mkTrack('sp:1', 'spotify'), 0, true);
    await flush();
    zone.progress(198_000);
    eng.pause();
    await flush();
    await zone.send({ type: 'play', trackIds: ['sp:other'] });
    expect(ended).not.toHaveBeenCalled();
  });

  it('a command answered after being displaced raises no error', async () => {
    const { zone, eng, err, tick } = setup();
    eng.load(mkTrack('sp:1', 'spotify'), 0, true);
    await flush();
    zone.progress(60_000);
    await zone.send({ type: 'play', trackIds: ['sp:other'] });
    tick(60_000);
    eng.onState(zone.state);
    expect(err).not.toHaveBeenCalled();
  });

  it('ignores the previous track’s state until the zone shows the new one', async () => {
    const { zone, eng, ended, sync } = setup();
    zone.state = { ...zone.state, queue: [{ queueId: 'x', track: mkTrack('sp:old', 'spotify'), album: { id: 'a', title: 'A' } }], index: 0, status: 'stopped' };
    eng.load(mkTrack('sp:new', 'spotify'), 0, true);
    eng.onState(zone.state); // stale snapshot of sp:old
    expect(ended).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    await flush();
    expect(sync).toHaveBeenCalled();
  });

  it('reports an error when the device never starts the track', async () => {
    const { zone, eng, err, tick } = setup();
    zone.send = async () => zone.state; // accepts commands, plays nothing
    eng.load(mkTrack('sp:1', 'spotify'), 0, true);
    await flush();
    tick(6000);
    eng.onState(zone.state);
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0]![0]).toMatch(/Spotify app/);
  });

  it('reports an error when the command fails', async () => {
    const { zone, eng, err } = setup();
    zone.fail = true;
    eng.load(mkTrack('sp:1', 'spotify'), 0, true);
    await flush();
    expect(err).toHaveBeenCalled();
  });

  it('stop pauses the zone only if it was playing our track, and goes quiet', async () => {
    const { zone, eng, ended } = setup();
    eng.stop();
    await flush();
    expect(zone.log).toEqual([]);
    eng.load(mkTrack('sp:1', 'spotify'), 0, true);
    await flush();
    zone.progress(1000);
    eng.stop();
    await flush();
    expect(zone.log.at(-1)).toBe('pause');
    zone.finish();
    expect(ended).not.toHaveBeenCalled();
  });

  it('stop during a load sends the pause, because that load is still going to start', async () => {
    const { zone, eng } = setup();
    const send = zone.send.bind(zone);
    zone.send = (cmd) => {
      if (cmd.type !== 'play') return send(cmd);
      zone.log.push('play');
      return new Promise<PlayerState>(() => {}); // mpv still loading: no answer and no state yet
    };
    eng.load(mkTrack('l:1', 'local'), 0, true);
    await flush();
    expect(zone.log.at(-1)).toBe('play');
    eng.stop();
    await flush();
    expect(zone.log.at(-1)).toBe('pause');
  });

  it('stop while the volume is on its way drops the play instead of pausing ahead of it', async () => {
    const { zone, eng } = setup();
    let volumeDone = () => {};
    const send = zone.send.bind(zone);
    zone.send = async (cmd) => {
      if (cmd.type === 'volume') await new Promise<void>((r) => { volumeDone = r; });
      return send(cmd);
    };
    eng.load(mkTrack('l:1', 'local'), 0, true);
    await flush();
    eng.stop();
    volumeDone();
    await flush();
    expect(zone.log.filter((l) => l.startsWith('play'))).toEqual([]);
  });

  it('a track that ended by itself sends no pause when the next engine takes over', async () => {
    const { zone, eng, ended } = setup();
    eng.load(mkTrack('l:1', 'local'), 0, true);
    await flush();
    zone.progress(199_000);
    zone.finish();
    expect(ended).toHaveBeenCalledTimes(1);
    eng.stop();
    await flush();
    expect(zone.log).not.toContain('pause');
  });

  it('a load that failed leaves nothing to pause', async () => {
    const { zone, eng } = setup();
    zone.fail = true;
    eng.load(mkTrack('l:1', 'local'), 0, true);
    await flush();
    zone.fail = false;
    eng.stop();
    await flush();
    expect(zone.log).not.toContain('pause');
  });

  it('polls fast only while the socket is down, then falls back to a 15 s safety poll', async () => {
    vi.useFakeTimers();
    try {
      const zone = new FakeZone('pc');
      let connected = false;
      zone.connected = () => connected;
      let now = 1_000_000;
      const eng = new ZoneEngine(zone, { now: () => now, pollMs: 2000, safetyPollMs: 15_000 });
      const get = vi.spyOn(zone, 'get');
      eng.load(mkTrack('l:1', 'local'), 0, true);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      get.mockClear();

      const tick = async () => { now += 2000; await vi.advanceTimersByTimeAsync(2000); };

      await tick();
      await tick();
      expect(get).toHaveBeenCalledTimes(2); // disconnected: every 2 s

      connected = true;
      for (let i = 0; i < 7; i++) await tick(); // 14 s since the last poll
      expect(get).toHaveBeenCalledTimes(2);
      await tick(); // 16 s: the safety poll fires
      expect(get).toHaveBeenCalledTimes(3);

      connected = false; // the socket drops: back to the fast poll
      await tick();
      expect(get).toHaveBeenCalledTimes(4);
      eng.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a transport with no connected() as having no push channel (legacy polling)', async () => {
    vi.useFakeTimers();
    try {
      const zone = new FakeZone('pc');
      zone.connected = undefined;
      let now = 1_000_000;
      const eng = new ZoneEngine(zone, { now: () => now, pollMs: 2000 });
      const get = vi.spyOn(zone, 'get');
      eng.load(mkTrack('l:1', 'local'), 0, true);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      get.mockClear();
      now += 2000;
      await vi.advanceTimersByTimeAsync(2000);
      expect(get).toHaveBeenCalledTimes(1);
      eng.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends no volume the zone already has', async () => {
    const { zone, eng } = setup();
    eng.setVolume(35);
    eng.load(mkTrack('sp:1', 'spotify'), 0, true);
    await flush();
    const sent = zone.log.length;
    eng.setVolume(35); // HybridEngine does this before every load
    await flush();
    expect(zone.log.length).toBe(sent);
    eng.setVolume(36);
    await flush();
    expect(zone.log.at(-1)).toBe('volume:36');
  });

  it('skipping between two tracks on one engine sends one volume, at the start', async () => {
    const eng = new ZoneEngine(new FakeZone('pc'));
    const zone = (eng as unknown as { t: FakeZone }).t;
    const hybrid = new HybridEngine(eng, new ZoneEngine(new FakeZone('spotify:dev')));
    hybrid.setVolume(40);
    hybrid.load(mkTrack('l:1', 'local'), 0, true);
    await flush();
    hybrid.load(mkTrack('l:2', 'local'), 0, true);
    await flush();
    expect(zone.log.filter((l) => l.startsWith('volume'))).toEqual(['volume:40']);
    hybrid.stop();
  });

  it('brings the zone volume in line before playing, and only talks volume while loaded', async () => {
    const { zone, eng } = setup();
    eng.setVolume(35);
    expect(zone.log).toEqual([]);
    eng.load(mkTrack('sp:1', 'spotify'), 0, true);
    await flush();
    expect(zone.log.slice(0, 2)).toEqual(['volume:35', 'play:sp:1@0']);
    eng.setVolume(50);
    await flush();
    expect(zone.log.at(-1)).toBe('volume:50');
  });
});
