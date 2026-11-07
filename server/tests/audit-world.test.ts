// AUDIT: full stack on a virtual clock. Real SpotifyConnectZone + real ZoneEngine + HybridEngine + LocalBackend + PlayCounter.
// Only Spotify itself is simulated (no network). The World follows the behaviour rune's own comments record:
// a finished single-URI song = paused + rewound; ~10 min later the player is dropped (204).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerState } from '@liner/shared';
import type { SpotifyBudgetLevel, SpotifyPlaybackState, SpotifyPlayBody, SpotifyQueue, SpotifyTrack, SpotifyDevice } from '../src/spotify/api.js';
import { SpotifyConnectZone, type SpotifyZoneApi } from '../src/spotify/zones.js';
import { PlayCounter, type RecordedPlay } from '../src/history/plays.js';
import { ZoneEngine, type ZoneTransport } from '../../web/src/player/zoneEngine.js';
import { HybridEngine } from '../../web/src/player/hybrid.js';
import { LocalBackend } from '../../web/src/player/local.js';
import { FakeZone, mkItem, mkTrack } from '../../web/src/player/testkit.js';

const DEV = 'horse';
const DROP_MS = 600_000;
const sp = (id: string, dur: number): SpotifyTrack => ({ id, name: id, uri: `spotify:track:${id}`, duration_ms: dur, disc_number: 1, track_number: 1, artists: [{ id: 'a', name: 'A' }], album: { id: 'alb', name: 'Alb', artists: [], images: [] } } as unknown as SpotifyTrack);

class World implements SpotifyZoneApi {
  songs = new Map<string, SpotifyTrack>();
  cur: SpotifyTrack | null = null;
  device: string | null = null;
  playing = false; basePos = 0; baseAt = 0; pausedAt: number | null = null;
  volume = 100; log: string[] = []; polls: number[] = []; t0 = Date.now();
  /** Next N reads of /me/player answer 204, as Spotify does before a dormant device is active. */
  nullReads = 0;
  at() { return ((Date.now() - this.t0) / 1000).toFixed(1).padStart(7); }
  note(s: string) { this.log.push(`${this.at()}s ${s}`); }
  private settle() {
    if (this.playing && this.cur) {
      const end = this.baseAt + (this.cur.duration_ms - this.basePos);
      if (Date.now() >= end) { this.playing = false; this.basePos = 0; this.pausedAt = end; this.note(`[spotify] ${this.cur.id} finished: paused, rewound`); }
    }
    if (!this.playing && this.pausedAt !== null && Date.now() - this.pausedAt > DROP_MS) { this.note('[spotify] player dropped'); this.cur = null; this.device = null; this.pausedAt = null; }
  }
  pos() { return this.playing ? this.basePos + Date.now() - this.baseAt : this.basePos; }
  externalPause() { this.settle(); const p = this.pos(); this.playing = false; this.basePos = p; this.pausedAt = Date.now(); this.note(`[user] paused in the Spotify app at ${(p / 1000).toFixed(0)}s`); }
  otherDevice(id: string) { this.settle(); this.basePos = this.pos(); this.baseAt = Date.now(); this.device = id; this.note(`[user] moved playback to ${id}`); }
  async devices(): Promise<SpotifyDevice[]> { return []; }
  async tracks(ids: string[]) { return ids.map((i) => this.songs.get(i)!).filter(Boolean); }
  async track(id: string) { return this.songs.get(id)!; }
  async currentPlayback(): Promise<SpotifyPlaybackState | null> {
    this.polls.push(Date.now() - this.t0);
    this.settle();
    if (this.nullReads > 0) { this.nullReads--; this.note('[spotify] GET /me/player -> 204'); return undefined as unknown as null; }
    if (!this.cur || !this.device) return null;
    return { device: { id: this.device, is_active: true, is_private_session: false, is_restricted: false, name: 'x', type: 'Computer', volume_percent: this.volume }, repeat_state: 'off', shuffle_state: false, timestamp: Date.now(), progress_ms: Math.round(this.pos()), is_playing: this.playing, item: this.cur } as SpotifyPlaybackState;
  }
  async queue(): Promise<SpotifyQueue> { return { currently_playing: null, queue: [] }; }
  async play(body: SpotifyPlayBody, device?: string) {
    this.settle();
    if (body.uris?.length) { const id = body.uris[body.offset?.position ?? 0]!.split(':').pop()!; this.cur = this.songs.get(id)!; this.basePos = body.position_ms ?? 0; this.note(`[rune] PUT play ${id} on ${device}`); }
    else { this.note('[rune] PUT play (resume)'); }
    this.device = device ?? this.device; this.baseAt = Date.now(); this.playing = true; this.pausedAt = null;
  }
  async pause() { this.settle(); this.basePos = this.pos(); this.playing = false; this.pausedAt = Date.now(); this.note('[rune] PUT pause'); }
  async next() {} async previous() {} async seek() {} async setShuffle() {} async setRepeat() {} async enqueue() {}
  async setVolume(v: number) { this.volume = v; this.note(`[rune] PUT volume ${v}`); }
}

function stack(level: SpotifyBudgetLevel, watched = true) {
  const w = new World();
  for (const [id, d] of [['s1', 230_000], ['s2', 180_000], ['s3', 200_000], ['s4', 210_000]] as const) w.songs.set(id, sp(id, d));
  let lvl = level;
  const zone = new SpotifyConnectZone(w, DEV, 'HORSE', { budgetLevel: () => lvl, hasClients: () => watched });
  const plays: RecordedPlay[] = [];
  const counter = new PlayCounter((p) => plays.push(p));
  let prev: PlayerState | null = null;
  zone.onChange((s) => { if (prev) counter.recordFromState(prev, s); prev = s; });
  const transport: ZoneTransport = { send: (c) => zone.command(c), get: async () => zone.state(), subscribe: (f) => zone.onChange(f), connected: () => true };
  const pcz = new FakeZone('pc');
  const items = ['s1', 's2', 's3', 's4'].map((id) => mkItem({ ...mkTrack(`sp:${id}`, 'spotify'), durationMs: w.songs.get(id)!.duration_ms }));
  const b = new LocalBackend('pc', new HybridEngine(new ZoneEngine(pcz), new ZoneEngine(transport)));
  return { w, zone, b, items, plays, pcz, setLevel: (l: SpotifyBudgetLevel) => { lvl = l; } };
}
const run = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const dump = (name: string, w: World, extra = '') => console.log(`\n=== ${name}\n${w.log.join('\n')}${extra ? `\n${extra}` : ''}`);
const nowPlaying = (b: LocalBackend) => `page: ${b.state.queue[b.state.index]?.track.id} ${b.state.status}`;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
afterEach(() => { vi.useRealTimers(); });

describe('world', () => {
  for (const level of ['normal', 'tight', 'low'] as const) {
    it(`W0 ${level}: songs follow each other`, async () => {
      const { w, b, items, zone } = stack(level);
      await b.send({ type: 'play', trackIds: [], startIndex: 0 }, items);
      await run(700_000);
      dump(`W0 ${level}: plain queue`, w, `reads of /me/player in 700 s: ${w.polls.length}`);
      expect(w.log.filter((l) => l.includes('PUT play s')).length).toBe(4);
      b.dispose(); await zone.close();
    });
  }

  it('KNOWN BUG W1 budget out: a Spotify song ends and the page keeps saying playing for up to 10 minutes; queue then dies', async () => {
    const { w, b, items, zone } = stack('out');
    await b.send({ type: 'play', trackIds: [], startIndex: 0 }, items);
    await run(232_000);
    const during = nowPlaying(b);
    await run(620_000);
    dump('W1 out', w, `at 232 s (song over 2 s ago) ${during}\nat 852 s ${nowPlaying(b)}`);
    expect(during).toContain('s1 playing');
    expect(w.log.filter((l) => l.includes('PUT play s')).length).toBe(1);
    b.dispose(); await zone.close();
  });

  it('W2 low: pause in the Spotify app, seen by the song-end poll, stays a pause', async () => {
    const { w, b, items, zone } = stack('low');
    await b.send({ type: 'play', trackIds: [], startIndex: 0 }, items);
    await run(130_000);
    w.externalPause();
    await run(110_000);
    dump('W2 low', w, nowPlaying(b));
    expect(w.log.some((l) => l.includes('PUT play s2'))).toBe(false);
    expect(nowPlaying(b)).toContain('s1 paused');
    b.dispose(); await zone.close();
  });

  it('W3 normal budget too: a pause after the last periodic poll before the end stays a pause', async () => {
    const { w, b, items, zone } = stack('normal');
    await b.send({ type: 'play', trackIds: [], startIndex: 0 }, items);
    await run(215_000);
    w.externalPause();
    await run(40_000);
    dump('W3 normal', w, nowPlaying(b));
    expect(w.log.some((l) => l.includes('PUT play s2'))).toBe(false);
    expect(nowPlaying(b)).toContain('s1 paused');
    b.dispose(); await zone.close();
  });

  it('W4 moving playback to the phone mid-song leaves it there: no next song, no music pulled back', async () => {
    const { w, b, items, zone } = stack('normal');
    await b.send({ type: 'play', trackIds: [], startIndex: 0 }, items);
    await run(60_000);
    w.otherDevice('phone');
    await run(40_000);
    dump('W4 phone takeover', w, `${nowPlaying(b)}; Spotify now on ${w.device}`);
    expect(w.device).toBe('phone');
    expect(w.cur?.id).toBe('s1');
    expect(w.log.filter((l) => l.includes('[rune]') && !l.includes('volume'))).toHaveLength(1); // only the first play
    expect(nowPlaying(b)).toContain('s1 paused');
    await run(300_000);                    // the song ends on the phone: still nothing
    expect(w.log.filter((l) => l.includes('[rune]') && !l.includes('volume'))).toHaveLength(1);
    b.dispose(); await zone.close();
  });

  it('W4b moved to the phone in the last seconds, seen after the time is up: still not the end of the song', async () => {
    const { w, b, items, zone } = stack('normal');
    await b.send({ type: 'play', trackIds: [], startIndex: 0 }, items);
    await run(226_000);
    w.otherDevice('phone');
    await run(10_000);
    expect(w.device).toBe('phone');
    expect(w.cur?.id).toBe('s1');
    expect(w.log.some((l) => l.includes('PUT play s2'))).toBe(false);
    b.dispose(); await zone.close();
  });

  it('W5 one empty /me/player answer mid-song changes nothing', async () => {
    const { w, b, items, zone } = stack('normal');
    await b.send({ type: 'play', trackIds: [], startIndex: 0 }, items);
    await run(60_000);
    w.nullReads = 1;
    await run(35_000);
    dump('W5 204 blip', w, nowPlaying(b));
    expect(w.cur?.id).toBe('s1');
    expect(w.log.some((l) => l.includes('GET /me/player -> 204'))).toBe(true);
    expect(w.log.some((l) => l.includes('PUT play s2'))).toBe(false);
    expect(nowPlaying(b)).toContain('s1 playing');
    expect(zone.state().status).toBe('playing');
    b.dispose(); await zone.close();
  });

  it('W5b a player that is really gone shows as stopped a few seconds later, and the queue does not move on', async () => {
    const { w, b, items, zone } = stack('normal');
    await b.send({ type: 'play', trackIds: [], startIndex: 0 }, items);
    await run(60_000);
    w.cur = null; w.device = null;         // Spotify lost the player mid-song: 204 from now on
    await run(40_000);
    expect(zone.state().status).toBe('stopped');
    expect(zone.state().elsewhere).toBeUndefined();
    expect(w.log.some((l) => l.includes('PUT play s2'))).toBe(false);
    expect(nowPlaying(b)).toContain('s1 paused');
    b.dispose(); await zone.close();
  });

  it('W6 dormant device: a 204 right after play does not skip the first song', async () => {
    const { w, b, items, zone } = stack('normal');
    w.nullReads = 1;
    await b.send({ type: 'play', trackIds: [], startIndex: 0 }, items);
    await run(5_000);
    dump('W6 dormant', w, nowPlaying(b));
    expect(w.log.some((l) => l.includes('GET /me/player -> 204'))).toBe(true);
    expect(w.log.some((l) => l.includes('PUT play s2'))).toBe(false);
    expect(nowPlaying(b)).toContain('s1 playing');
    b.dispose(); await zone.close();
  });

  it('KNOWN BUG W7 history at each budget', async () => {
    for (const level of ['normal', 'tight', 'low'] as const) {
      const { w, b, items, zone, plays } = stack(level);
      await b.send({ type: 'play', trackIds: [], startIndex: 0 }, items);
      await run(830_000);
      console.log(`\n=== W7 ${level}: heard every song to the end`, plays.map((p) => `${p.trackId} played_ms=${p.playedMs} completed=${p.completed}`));
      expect(plays.every((p) => !p.completed)).toBe(true);
      b.dispose(); await zone.close();
    }
  });

  it('W8 a volume change costs one PUT and no reads (a voice duck is two PUTs)', async () => {
    const { w, b, items, zone } = stack('normal');
    await b.send({ type: 'play', trackIds: [], startIndex: 0 }, items);
    await run(20_000);
    const before = w.polls.length;
    const q = vi.spyOn(w, 'queue');
    await zone.command({ type: 'volume', volume: 20 });
    await run(5_000);
    console.log(`\n=== W8 one volume change: PUT 1, GET /me/player ${w.polls.length - before}, GET queue ${q.mock.calls.length}`);
    expect(w.polls.length - before).toBe(0);
    expect(q).not.toHaveBeenCalled();
    expect(w.log.filter((l) => l.includes('PUT volume 20'))).toHaveLength(1);
    expect(zone.state().volume).toBe(20);
    b.dispose(); await zone.close();
  });
});
