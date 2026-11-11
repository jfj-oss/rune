// AUDIT: full stack on a virtual clock. Real SpotifyConnectZone + real ZoneEngine + HybridEngine + LocalBackend + PlayCounter.
// Only Spotify itself is simulated (no network). The World follows the behaviour rune's own comments record:
// a finished single-URI song = paused + rewound; ~10 min later the player is dropped (204). With `mpris` the desktop
// app's MPRIS view of it is simulated too (phase 2), as the phase 0 session recorded it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerState } from '@liner/shared';
import type { SpotifyBudgetLevel } from '../src/spotify/api.js';
import { SpotifyConnectZone, SpotifyZones } from '../src/spotify/zones.js';
import { MprisPlaybackSource } from '../src/spotify/mpris.js';
import { PlayCounter, type RecordedPlay } from '../src/history/plays.js';
import { ZoneEngine, type ZoneTransport } from '../../web/src/player/zoneEngine.js';
import { HybridEngine } from '../../web/src/player/hybrid.js';
import { LocalBackend } from '../../web/src/player/local.js';
import { FakeZone, mkItem, mkTrack } from '../../web/src/player/testkit.js';
import { DEV, World, sp } from './support/spotify-world.js';

function stack(level: SpotifyBudgetLevel, watched = true, opts: { mpris?: boolean; blockedUntil?: () => number | null; known?: boolean; songs?: number; shown?: boolean } = {}) {
  const w = new World({ mpris: opts.mpris });
  const lengths = [230_000, 180_000, 200_000, 210_000];
  for (let i = 1; i <= (opts.songs ?? 4); i++) w.songs.set(`s${i}`, sp(`s${i}`, lengths[(i - 1) % 4]!));
  let lvl = level;
  // known: the songs are in rune's database (titles and covers without a Spotify lookup).
  const knownTracks = opts.known ? (ids: string[]) => ids.filter((id) => w.songs.has(id.slice(3))).map((id) => mkItem({ ...mkTrack(id, 'spotify'), durationMs: w.songs.get(id.slice(3))!.duration_ms })).map((p, i) => ({ ...p, queueId: `k${i}` })) : undefined;
  const zoneOpts = { budgetLevel: () => lvl, hasClients: () => watched, blockedUntil: opts.blockedUntil, knownTracks, shown: opts.shown === undefined ? undefined : () => opts.shown! };
  // With MPRIS the zone is built the way the server builds it: SpotifyZones wires the source to this device's zone.
  const source = w.mpris ? new MprisPlaybackSource(w.mpris, { deviceId: () => DEV, budgetLevel: () => lvl, knownTracks }) : undefined;
  const zones = source ? new SpotifyZones(w, { ...zoneOpts, mpris: source }) : undefined;
  const zone: SpotifyConnectZone = zones ? zones.ensureZone(DEV, 'MYPC') : new SpotifyConnectZone(w, DEV, 'MYPC', zoneOpts);
  const plays: RecordedPlay[] = [];
  const counter = new PlayCounter((p) => plays.push(p));
  let prev: PlayerState | null = null;
  zone.onChange((s) => { if (prev) counter.recordFromState(prev, s); prev = s; });
  const transport: ZoneTransport = { send: (c) => zone.command(c), get: async () => zone.state(), subscribe: (f) => zone.onChange(f), connected: () => true };
  const pcz = new FakeZone('pc');
  const items = [...w.songs.keys()].map((id) => mkItem({ ...mkTrack(`sp:${id}`, 'spotify'), durationMs: w.songs.get(id)!.duration_ms }));
  const b = new LocalBackend('pc', new HybridEngine(new ZoneEngine(pcz), new ZoneEngine(transport)));
  const dispose = async () => { b.dispose(); await zone.close(); source?.close(); w.dispose(); };
  return { w, zone, b, items, plays, pcz, source, dispose, setLevel: (l: SpotifyBudgetLevel) => { lvl = l; } };
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

  it('KNOWN BUG W1 (MPRIS reads off) budget out: a Spotify song ends and the page keeps saying playing for up to 10 minutes; queue then dies', async () => {
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

  it('W7 history at each budget: every song heard to the end is one completed play of about its length', async () => {
    for (const level of ['normal', 'tight', 'low'] as const) {
      const { w, b, items, zone, plays } = stack(level);
      await b.send({ type: 'play', trackIds: [], startIndex: 0 }, items);
      await run(830_000);
      console.log(`\n=== W7 ${level}: heard every song to the end`, plays.map((p) => `${p.trackId} played_ms=${p.playedMs} completed=${p.completed}`));
      expect(plays.map((p) => p.trackId)).toEqual(['sp:s1', 'sp:s2', 'sp:s3', 'sp:s4']);
      for (const p of plays) {
        expect(p.completed).toBe(true);
        expect(Math.abs(p.playedMs - w.songs.get(p.trackId.slice(3))!.duration_ms)).toBeLessThan(3000);
      }
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

// Phase 2: the desktop app's MPRIS is the read source for its own zone. The same stories, read from a fake MPRIS.
describe('world with MPRIS', () => {
  const reads = (w: World) => w.requests.get('GET /me/player') ?? 0;

  for (const level of ['normal', 'tight', 'low', 'out'] as const) {
    it(`W0m ${level}: songs follow each other, each seen as it ends, with no /me/player poll in between`, async () => {
      const { w, b, items, dispose } = stack(level, true, { mpris: true });
      await b.send({ type: 'play', trackIds: [], startIndex: 0 }, items);
      await run(830_000);
      dump(`W0m ${level}: plain queue over MPRIS`, w, `GET /me/player in 830 s: ${reads(w)}; requests ${JSON.stringify(Object.fromEntries(w.requests))}`);
      expect(w.log.filter((l) => l.includes('PUT play s')).length).toBe(4);
      // The one read that first confirms the device; the rest is MPRIS.
      expect(reads(w)).toBeLessThanOrEqual(2);
      await dispose();
    });
  }

  it('W1 budget out: a Spotify song ends and the next one starts at once; the queue goes on', async () => {
    const { w, b, items, dispose } = stack('out', true, { mpris: true });
    await b.send({ type: 'play', trackIds: [], startIndex: 0 }, items);
    await run(232_000);
    const during = nowPlaying(b);
    await run(620_000);
    dump('W1 out over MPRIS', w, `at 232 s (song over 2 s ago) ${during}\nat 852 s ${nowPlaying(b)}`);
    expect(during).toContain('s2 playing');
    const s2 = w.log.find((l) => l.includes('PUT play s2'))!;
    expect(Number(s2.trim().split('s ')[0])).toBeLessThan(232);
    expect(w.log.filter((l) => l.includes('PUT play s')).length).toBe(4);
    await dispose();
  });

  it('W1b breaker up: MPRIS still shows the song ending, and nothing calls Spotify to read', async () => {
    const until = Date.now() + 9 * 3600_000;
    let blocked = false;
    const { w, b, items, zone, dispose } = stack('normal', true, { mpris: true, blockedUntil: () => (blocked ? until : null) });
    await b.send({ type: 'play', trackIds: [], startIndex: 0 }, items);
    await run(20_000);
    blocked = true;
    const seen: string[] = [];
    zone.onChange((st) => seen.push(`${st.queue[st.index]?.track.id} ${st.status}@${Math.round(st.positionMs / 1000)}`));
    const before = reads(w);
    await run(212_000);                    // s1 ends at 230 s
    // The end is seen as it happens (the fake World takes the page's next play: the real one would refuse it).
    expect(seen).toContain('sp:s1 paused@0');
    expect(seen.some((x) => x.startsWith('sp:s1 paused@23'))).toBe(false);
    expect(reads(w)).toBe(before);
    await dispose();
  });

  it('W2m low: pause in the Spotify app stays a pause, seen within a second', async () => {
    const { w, b, items, zone, dispose } = stack('low', true, { mpris: true });
    await b.send({ type: 'play', trackIds: [], startIndex: 0 }, items);
    await run(130_000);
    w.externalPause();
    await run(1_000);
    expect(zone.state().status).toBe('paused');
    await run(110_000);
    expect(w.log.some((l) => l.includes('PUT play s2'))).toBe(false);
    expect(nowPlaying(b)).toContain('s1 paused');
    await dispose();
  });

  it('W3m a pause just before the end stays a pause', async () => {
    const { w, b, items, dispose } = stack('normal', true, { mpris: true });
    await b.send({ type: 'play', trackIds: [], startIndex: 0 }, items);
    await run(228_500);
    w.externalPause();
    await run(40_000);
    expect(w.log.some((l) => l.includes('PUT play s2'))).toBe(false);
    expect(nowPlaying(b)).toContain('s1 paused');
    await dispose();
  });

  it('W4m playback moved to the phone: the app goes quiet, nothing is pulled back, no next song', async () => {
    const { w, b, items, dispose } = stack('normal', true, { mpris: true });
    await b.send({ type: 'play', trackIds: [], startIndex: 0 }, items);
    await run(60_000);
    w.otherDevice('phone');
    await run(40_000);
    expect(w.device).toBe('phone');
    expect(nowPlaying(b)).toContain('s1 paused');
    await run(300_000);
    expect(w.log.filter((l) => l.includes('[rune]') && !l.includes('volume'))).toHaveLength(1);
    await dispose();
  });

  it('W4n an app that mirrors the phone (says Playing, makes no sound here): one Spotify read finds the phone', async () => {
    const { w, b, items, zone, dispose, source } = stack('normal', true, { mpris: true });
    w.mirrorsOtherDevice = true;
    await b.send({ type: 'play', trackIds: [], startIndex: 0 }, items);
    await run(60_000);
    const before = reads(w);
    w.otherDevice('phone');
    await run(40_000);
    dump('W4n mirrored phone', w, `${nowPlaying(b)}; zone ${zone.state().status} elsewhere=${zone.state().elsewhere}; reads ${reads(w) - before}; ${JSON.stringify(source!.counts)}`);
    expect(zone.state().elsewhere).toBe(true);
    expect(w.device).toBe('phone');
    expect(nowPlaying(b)).toContain('s1 paused');
    expect(w.log.filter((l) => l.includes('[rune]') && !l.includes('volume'))).toHaveLength(1);
    await run(300_000);
    expect(w.log.filter((l) => l.includes('[rune]') && !l.includes('volume'))).toHaveLength(1);
    await dispose();
  });

  it('W4o back from the phone: pressing play in the desktop app is seen at once, with no Spotify read', async () => {
    const { w, b, items, zone, dispose } = stack('normal', true, { mpris: true });
    await b.send({ type: 'play', trackIds: [], startIndex: 0 }, items);
    await run(60_000);
    w.otherDevice('phone');
    await run(40_000);
    const before = reads(w);
    w.externalResume();
    await run(3_000);
    expect(zone.state().status).toBe('playing');
    expect(zone.state().elsewhere).toBeUndefined();
    expect(reads(w) - before).toBe(0);
    await dispose();
  });

  it('W5m the app closed mid-song: Spotify is asked, the zone stops, the queue does not move on', async () => {
    const { w, b, items, zone, dispose } = stack('normal', true, { mpris: true });
    await b.send({ type: 'play', trackIds: [], startIndex: 0 }, items);
    await run(60_000);
    const before = reads(w);
    w.closeApp();
    await run(15_000);
    expect(zone.state().status).toBe('stopped');
    // One read right away, and the zone's usual confirmation of an empty answer a few seconds later.
    expect(reads(w) - before).toBeGreaterThanOrEqual(1);
    expect(reads(w) - before).toBeLessThanOrEqual(3);
    expect(w.log.some((l) => l.includes('PUT play s2'))).toBe(false);
    await dispose();
  });

  it('W6m an album playing from the app: twenty minutes cost two Spotify reads (another device may have taken over)', async () => {
    const { w, zone, dispose, source } = stack('normal', true, { mpris: true, known: true });
    w.context = ['s1', 's2', 's3', 's4', 's1', 's2', 's3', 's4'];
    zone.onChange(() => undefined);
    await w.play({ uris: ['spotify:track:s1'] }, DEV);
    w.context = ['s1', 's2', 's3', 's4', 's1', 's2', 's3', 's4'];
    await run(5_000);
    const before = reads(w);
    await run(1_300_000);
    console.log('\n=== W6m', JSON.stringify(source!.counts), 'reads at', w.polls.map((t) => Math.round(t / 1000)));
    expect(w.log.filter((l) => l.includes('next in context')).length).toBeGreaterThanOrEqual(6);
    expect(zone.state().status).toBe('playing');
    expect(reads(w) - before).toBe(2);
    await dispose();
  });

  it('W7m history at each budget: every song heard to the end is one completed play of about its length', async () => {
    for (const level of ['normal', 'low', 'out'] as const) {
      const { w, b, items, plays, dispose } = stack(level, true, { mpris: true });
      await b.send({ type: 'play', trackIds: [], startIndex: 0 }, items);
      await run(830_000);
      console.log(`\n=== W7m ${level}: heard every song to the end`, plays.map((p) => `${p.trackId} played_ms=${p.playedMs} completed=${p.completed}`));
      expect(plays.map((p) => p.trackId)).toEqual(['sp:s1', 'sp:s2', 'sp:s3', 'sp:s4']);
      for (const p of plays) {
        expect(p.completed).toBe(true);
        expect(Math.abs(p.playedMs - w.songs.get(p.trackId.slice(3))!.duration_ms)).toBeLessThan(3000);
      }
      await dispose();
    }
  });

  it('W8m a volume change costs one PUT and no reads', async () => {
    const { w, b, items, zone, dispose } = stack('normal', true, { mpris: true });
    await b.send({ type: 'play', trackIds: [], startIndex: 0 }, items);
    await run(20_000);
    const before = w.total();
    await zone.command({ type: 'volume', volume: 20 });
    await run(5_000);
    expect(w.total() - before).toBe(1);
    expect(zone.state().volume).toBe(20);
    await dispose();
  });
});

// Spotify requests over one simulated hour on this PC's Spotify app (MYPC), MPRIS reads off (before) and on (after).
// The songs are in rune's database (as songs played from rune mostly are), so no title lookups on either side.
describe('request rate', () => {
  type Story = { name: string; watched: boolean; shown: boolean; run: (s: ReturnType<typeof stack>) => Promise<void> };
  const HOUR = 3_600_000;
  const stories: Story[] = [
    {
      name: 'A rune queue on MYPC, a tab showing it: 17 songs, a 3 min pause, a seek, two volume changes',
      watched: true, shown: true,
      run: async ({ b, items }) => {
        await b.send({ type: 'play', trackIds: [], startIndex: 0 }, items);
        await run(1_000_000);
        await b.send({ type: 'pause' }); await run(180_000); await b.send({ type: 'resume' });
        await run(400_000);
        await b.send({ type: 'seek', positionMs: 60_000 });
        await run(600_000);
        await b.send({ type: 'volume', volume: 40 }); await run(10_000); await b.send({ type: 'volume', volume: 60 });
        await run(HOUR - 2_190_000);
      },
    },
    {
      name: 'B the same queue, no tab open',
      watched: false, shown: false,
      run: async ({ b, items }) => { await b.send({ type: 'play', trackIds: [], startIndex: 0 }, items); await run(HOUR); },
    },
    {
      name: 'C an album started in the Spotify app, a tab showing MYPC',
      watched: true, shown: true,
      run: async ({ w, zone }) => {
        zone.onChange(() => undefined);
        await w.play({ uris: ['spotify:track:s1'] }, DEV);
        w.context = [...w.songs.keys()];
        await run(HOUR);
      },
    },
    {
      name: 'D the app open and paused, a tab showing MYPC',
      watched: true, shown: true,
      run: async ({ w, zone }) => {
        zone.onChange(() => undefined);
        await w.play({ uris: ['spotify:track:s1'] }, DEV);
        await run(30_000);
        await w.pause();
        await run(HOUR - 30_000);
      },
    },
  ];

  it('one hour each, before and after', async () => {
    const rows: string[] = [];
    const totals = { before: 0, after: 0 };
    for (const story of stories) {
      const counts: Record<string, Record<string, number>> = {};
      for (const mpris of [false, true]) {
        vi.setSystemTime(1_800_000_000_000);
        const s = stack('normal', story.watched, { mpris, known: true, songs: 20, shown: story.shown });
        await story.run(s);
        counts[mpris ? 'after' : 'before'] = Object.fromEntries(s.w.requests);
        if (story.name.startsWith('A') || story.name.startsWith('C')) expect(s.w.log.filter((l) => l.includes('PUT play s') || l.includes('next in context')).length).toBeGreaterThanOrEqual(15);
        await s.dispose();
      }
      const sum = (c: Record<string, number>) => Object.values(c).reduce((a, n) => a + n, 0);
      const reads = (c: Record<string, number>) => (c['GET /me/player'] ?? 0) + (c['GET queue'] ?? 0);
      totals.before += sum(counts.before!);
      totals.after += sum(counts.after!);
      rows.push(`${story.name}\n  before: ${sum(counts.before!)} requests (${reads(counts.before!)} reads) ${JSON.stringify(counts.before)}\n  after:  ${sum(counts.after!)} requests (${reads(counts.after!)} reads) ${JSON.stringify(counts.after)}`);
      expect(counts.after!['GET /me/player'] ?? 0).toBeLessThan(counts.before!['GET /me/player'] ?? 0);
    }
    console.log(`\n=== Spotify requests in one simulated hour on MYPC\n${rows.join('\n')}\n  all four hours: before ${totals.before}, after ${totals.after}`);
  });
});
