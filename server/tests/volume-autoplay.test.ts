// Regression tests for the playback bugs behind "the native volume slider does nothing": the level reaches whatever
// sounds on the PC in every output state, Spotify's autoplay after the end of rune's list is not a takeover, and a
// seek Soloist refuses (seek_to_restricted) neither fails nor breaks the queue. Stub outputs, no sound, no network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerCommand, PlayerState, QueueItem } from '@liner/shared';
import { QueueDriver, type MirrorZone, type Output, type OutputFact, type OutputKind } from '../src/play/driver.js';

let qn = 0;
const song = (id: string, source: 'local' | 'spotify', dur = 100_000): QueueItem => ({
  queueId: `q${++qn}`,
  track: { id, albumId: 'al:1', source, title: id, artists: [], disc: 1, number: 1, durationMs: dur, ...(source === 'local' ? { path: `/m/${id}.flac` } : { spotifyUri: `spotify:track:${id}` }) } as QueueItem['track'],
  album: { id: 'al:1', title: 'Album' },
});

class Stub implements Output {
  volumes: number[] = [];
  facts: ((f: OutputFact) => void)[] = [];
  token = 0;
  run: QueueItem[] = [];
  startVolume: number | null = null;
  stopped = 0;
  seekError: Error | null = null;
  pos: number | null = null;
  constructor(readonly kind: OutputKind) {}
  async start(run: QueueItem[], o: { token: number; positionMs: number; volume: number }) {
    this.token = o.token; this.run = run; this.startVolume = o.volume;
    queueMicrotask(() => this.emit({ type: 'started', token: o.token, queueId: run[0]!.queueId, positionMs: o.positionMs, at: Date.now() }));
  }
  update() {}
  async pause() {}
  async resume() {}
  async seek() { if (this.seekError) throw this.seekError; }
  async stop() { this.stopped++; }
  async setVolume(v: number) { this.volumes.push(v); }
  position() { return this.pos; }
  onFact(fn: (f: OutputFact) => void) { this.facts.push(fn); }
  close() {}
  emit(f: OutputFact) { for (const fn of this.facts) fn(f); }
  endLast() { this.emit({ type: 'ended', token: this.token, queueId: this.run[0]!.queueId, at: Date.now(), last: true }); }
}

function rig(opts: { mirror?: MirrorZone } = {}) {
  const mpv = new Stub('mpv');
  const spotify = new Stub('spotify');
  const catalog = new Map<string, QueueItem>();
  const driver = new QueueDriver({
    load: (ids) => ids.flatMap((id) => (catalog.has(id) ? [{ ...catalog.get(id)!, queueId: `q${++qn}` }] : [])),
    outputs: { mpv, spotify },
    ...(opts.mirror ? { mirror: () => opts.mirror } : {}),
  });
  const items = (...l: QueueItem[]) => { for (const i of l) catalog.set(i.track.id, i); return l.map((i) => i.track.id); };
  const play = (ids: string[]) => driver.command({ type: 'play', trackIds: ids, startIndex: 0 });
  return { mpv, spotify, driver, items, play };
}
const settle = () => vi.advanceTimersByTimeAsync(50);

beforeEach(() => { qn = 0; vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
afterEach(() => { vi.useRealTimers(); });

describe('volume reaches whatever sounds, in every output state', () => {
  it('playing: the output that holds the song gets it, and the state says so', async () => {
    const r = rig();
    await r.play(r.items(song('l1', 'local')));
    await settle();
    const s = await r.driver.command({ type: 'volume', volume: 40 });
    expect(r.mpv.volumes).toEqual([40]);
    expect(r.spotify.volumes).toEqual([]);
    expect(s.volume).toBe(40);
  });

  it('paused: the held output gets it', async () => {
    const r = rig();
    await r.play(r.items(song('s1', 'spotify')));
    await settle();
    await r.driver.command({ type: 'pause' });
    await r.driver.command({ type: 'volume', volume: 25 });
    expect(r.spotify.volumes).toEqual([25]);
  });

  it('no output holds a song (a paused start, the list over): every output gets it, and the next start uses it', async () => {
    const r = rig();
    await r.play(r.items(song('s1', 'spotify'), song('l1', 'local')));
    await settle();
    r.spotify.endLast(); // s1 over: l1 starts on mpv
    await settle();
    // Silence: the queue is paused with no output (a paused play sends nothing).
    await r.driver.command({ type: 'play', trackIds: ['s1'], startIndex: 0, paused: true });
    expect(r.driver.state().output).toBeNull();
    const s = await r.driver.command({ type: 'volume', volume: 33 });
    expect(r.mpv.volumes.at(-1)).toBe(33);
    expect(r.spotify.volumes.at(-1)).toBe(33);
    expect(s.volume).toBe(33);
    await r.driver.command({ type: 'resume' });
    await settle();
    expect(r.spotify.startVolume).toBe(33);
  });

  it('the next song, on the other output, starts at the level too', async () => {
    const r = rig();
    await r.play(r.items(song('s1', 'spotify'), song('l1', 'local')));
    await settle();
    await r.driver.command({ type: 'volume', volume: 55 });
    r.spotify.endLast();
    await settle();
    expect(r.mpv.startVolume).toBe(55);
  });

  it('parked: the level goes to the Spotify app (the page mirror) and to what sounds, and the state shows it', async () => {
    const sent: PlayerCommand[] = [];
    const mirror: MirrorZone = {
      state: () => ({ zone: 'spotify:x', status: 'playing', queue: [song('zzz', 'spotify')], index: 0, positionMs: 0, volume: 100, shuffle: false, repeat: 'off', updatedAt: 0 }) as PlayerState,
      command: async (c) => { sent.push(c); return mirror.state(); },
    };
    const r = rig({ mirror });
    await r.play(r.items(song('l1', 'local')));
    await settle();
    r.spotify.emit({ type: 'takeover', at: Date.now() + 10, trackId: 'sp:zzz' });
    await settle();
    expect(r.driver.state().hold?.reason).toBe('takeover');
    const s = await r.driver.command({ type: 'volume', volume: 20 });
    expect(sent).toContainEqual({ type: 'volume', volume: 20 });
    expect(r.spotify.volumes.at(-1)).toBe(20); // Soloist (via the spotify output) hears it too
    expect(r.mpv.volumes.at(-1)).toBe(20);
    expect(s.volume).toBe(20);
  });
});

describe('autoplay after the end of rune\'s list', () => {
  it('is the end of the list, not a takeover: nothing parks, the output is stopped', async () => {
    const r = rig();
    await r.play(r.items(song('s1', 'spotify')));
    await settle();
    r.spotify.endLast();
    await settle();
    expect(r.driver.state().status).toBe('stopped');
    const stops = r.spotify.stopped;
    r.spotify.emit({ type: 'takeover', at: Date.now(), trackId: 'sp:x1', autoplay: true });
    await settle();
    const s = r.driver.state();
    expect(s.hold).toBeUndefined();
    expect(s.status).toBe('stopped');
    expect(r.spotify.stopped).toBe(stops + 1);
  });

  it('a song someone else starts (not flagged autoplay) still parks the queue, and so does autoplay long after the end', async () => {
    const r = rig();
    await r.play(r.items(song('s1', 'spotify')));
    await settle();
    r.spotify.endLast();
    await settle();
    r.spotify.emit({ type: 'takeover', at: Date.now(), trackId: 'sp:y' });
    await settle();
    expect(r.driver.state().hold?.reason).toBe('takeover');

    const r2 = rig();
    await r2.play(r2.items(song('s1', 'spotify')));
    await settle();
    r2.spotify.endLast();
    await vi.advanceTimersByTimeAsync(60_000);
    r2.spotify.emit({ type: 'takeover', at: Date.now(), trackId: 'sp:y', autoplay: true });
    await settle();
    expect(r2.driver.state().hold?.reason).toBe('takeover');
  });
});

describe('a refused seek', () => {
  it('leaves the queue and the position where they were', async () => {
    const r = rig();
    await r.play(r.items(song('s1', 'spotify'), song('s2', 'spotify')));
    await settle();
    r.spotify.pos = 5_000;
    r.spotify.seekError = new Error('Spotify does not allow a seek in this song right now');
    const s = await r.driver.command({ type: 'seek', positionMs: 60_000 });
    expect(s.positionMs).toBeLessThan(10_000);
    expect(s.index).toBe(0);
    expect(s.queue).toHaveLength(2);
    expect(s.status).toBe('playing');
  });
});
