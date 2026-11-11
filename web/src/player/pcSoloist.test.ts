// The pc zone with Spotify Soloist as its Spotify player: the server names the zone that plays Spotify songs
// (ZoneInfo.spotifyZone), the page routes them there (no app start, no polling), folds the duplicate zone away and
// puts Soloist's sound on the PC speakers before a song sounds.
import type { PlayerState, Track } from '@liner/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtCommand, PlayItem, ZoneInfo } from '../lib/types';
import { PcBackend } from './pc';
import { needsPcSpotify, pcSpotifyFallbackNotice, pcSpotifyZone, PC_SPOTIFY_POLL_MS, startPcSpotifyAndWait } from './pcStart';
import { followPcSpeakers, pcHasSpotify, withoutPcDevice } from './routing';
import { FakeZone, mkItem, mkTrack } from './testkit';
import { emptyState, type Backend } from './types';

const flush = () => new Promise((r) => setTimeout(r, 0));

class FakeRemote implements Backend {
  state: PlayerState;
  sent: string[] = [];
  private subs = new Set<(s: PlayerState) => void>();
  constructor(readonly zone: string, public z: FakeZone) {
    this.state = emptyState(zone);
    z.subscribe((s) => { this.state = s; for (const f of this.subs) f(s); });
  }
  subscribe(fn: (s: PlayerState) => void) { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  async send(cmd: ExtCommand, _items?: PlayItem[]) { this.sent.push(cmd.type === 'play' ? `play:${cmd.trackIds.join(',')}` : cmd.type); if (cmd.type !== 'clear' && cmd.type !== 'move') await this.z.send(cmd); }
  async refresh() { this.state = this.z.state; }
  dispose() {}
}

function make() {
  const zones = { pc: new FakeZone('pc'), soloist: new FakeZone('soloist') };
  const remotes: Record<string, FakeRemote> = {};
  const toPc: string[] = [];
  const pc = new PcBackend({
    remote: (z) => (remotes[z] = new FakeRemote(z, zones[z as keyof typeof zones])),
    transport: (z) => zones[z as keyof typeof zones],
    soloistToPc: async () => { toPc.push(`at:${[...zones.pc.log, ...zones.soloist.log].length}`); },
    notice: vi.fn(),
  }, { zone: 'soloist', name: 'Soloist' });
  return { pc, zones, remotes, toPc };
}
const L = (n: number) => mkItem(mkTrack(`l:${n}`, 'local'));
const S = (n: number) => mkItem(mkTrack(`sp:${n}`, 'spotify'));
const play = (items: PlayItem[], startIndex = 0): ExtCommand => ({ type: 'play', trackIds: items.map((i) => i.track.id), startIndex });

let live: PcBackend | null = null;
afterEach(() => { live?.dispose(); live = null; vi.useRealTimers(); });

const item = (id: string, source: 'local' | 'spotify'): PlayItem => ({
  track: { id, albumId: 'alb', source, title: id, artists: [], disc: 1, number: 1, durationMs: 1000 } as Track,
  album: { id: 'alb', title: 'Album' },
});
const PC_SOLOIST: ZoneInfo = { id: 'pc', name: 'Linux PC speakers', kind: 'pc', spotifyEngine: 'soloist', spotifyZone: 'soloist', spotifyDeviceId: 'horse1', spotifyDeviceName: 'HORSE' };
const PC_APP: ZoneInfo = { id: 'pc', name: 'Linux PC speakers', kind: 'pc', spotifyEngine: 'app', spotifyZone: 'spotify:horse1', spotifyDeviceId: 'horse1', spotifyDeviceName: 'HORSE', spotifyNotice: 'Soloist needs updating (its build expired) — using the Spotify app' };
const PC_NONE: ZoneInfo = { id: 'pc', name: 'Linux PC speakers', kind: 'pc', spotifyEngine: 'app', spotifyNotice: 'Soloist is not signed in to Spotify (pair it once with soloist --pair) — using the Spotify app' };
const SOLOIST: ZoneInfo = { id: 'soloist', name: 'Spotify (Soloist)', kind: 'spotify', soloist: true, output: 'pc' };

describe('which player takes the pc zone’s Spotify songs', () => {
  it('Soloist when the server says so: nothing to start, and the fallback notice is empty', () => {
    expect(pcSpotifyZone(PC_SOLOIST)).toBe('soloist');
    expect(pcHasSpotify(PC_SOLOIST)).toBe(true);
    expect(needsPcSpotify(PC_SOLOIST, [item('sp:1', 'spotify')])).toBe(false);
    expect(pcSpotifyFallbackNotice(PC_SOLOIST, [item('sp:1', 'spotify')])).toBeNull();
  });
  it('the app, with the reason, when Soloist cannot play; the app still has to be started when it is not running', () => {
    expect(pcSpotifyZone(PC_APP)).toBe('spotify:horse1');
    expect(needsPcSpotify(PC_APP, [item('sp:1', 'spotify')])).toBe(false);
    expect(pcSpotifyFallbackNotice(PC_APP, [item('sp:1', 'spotify')])).toMatch(/needs updating/);
    expect(pcSpotifyZone(PC_NONE)).toBeNull();
    expect(needsPcSpotify(PC_NONE, [item('sp:1', 'spotify')])).toBe(true);
    expect(pcSpotifyFallbackNotice(PC_NONE, [item('sp:1', 'spotify')])).toMatch(/not signed in/);
    // Local songs never need a Spotify player, and never show the notice.
    expect(needsPcSpotify(PC_NONE, [item('l:1', 'local')])).toBe(false);
    expect(pcSpotifyFallbackNotice(PC_NONE, [item('l:1', 'local')])).toBeNull();
  });
  it('an older server that only names the app device still routes to it', () => {
    const old: ZoneInfo = { id: 'pc', name: 'PC', kind: 'pc', spotifyDeviceId: 'dev' };
    expect(pcSpotifyZone(old)).toBe('spotify:dev');
    expect(needsPcSpotify(old, [item('sp:1', 'spotify')])).toBe(false);
  });
  it('the start-and-wait is satisfied by whichever player appears', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const pending = startPcSpotifyAndWait({ start: async () => undefined, readZones: async () => [++reads < 2 ? PC_NONE : PC_SOLOIST], toast: () => undefined });
    await vi.advanceTimersByTimeAsync(PC_SPOTIFY_POLL_MS * 2);
    expect(await pending).toMatchObject({ spotifyZone: 'soloist' });
  });
});

describe('one zone in the list for one set of speakers', () => {
  const list = [PC_SOLOIST, { id: 'spotify:horse1', name: 'HORSE', kind: 'spotify' } as ZoneInfo, SOLOIST, { id: 'spotify:phone', name: 'iPhone', kind: 'spotify' } as ZoneInfo];
  it('on a desktop the Soloist zone is folded into the pc zone (as the app’s device always was)', () => {
    expect(withoutPcDevice(list).map((z) => z.id)).toEqual(['pc', 'spotify:phone']);
  });
  it('on a phone the Soloist zone stays: it is how the phone hears Spotify from the PC', () => {
    expect(withoutPcDevice(list, { keepSoloist: true }).map((z) => z.id)).toEqual(['pc', 'soloist', 'spotify:phone']);
  });
  it('with the app as the engine the Soloist zone is listed (it is not what the pc zone plays with)', () => {
    expect(withoutPcDevice([PC_APP, SOLOIST, { id: 'spotify:horse1', name: 'HORSE', kind: 'spotify' }]).map((z) => z.id)).toEqual(['pc', 'soloist']);
  });
  it('a desktop page follows the PC speakers when Soloist starts for the pc zone, but a phone on the Soloist zone stays', () => {
    const idle = { zone: 'browser', status: 'stopped' };
    expect(followPcSpeakers({ zone: 'soloist', status: 'playing' }, false, idle, PC_SOLOIST)).toBe(true);
    expect(followPcSpeakers({ zone: 'soloist', status: 'playing' }, false, { zone: 'soloist', status: 'stopped' }, PC_SOLOIST)).toBe(false);
    expect(followPcSpeakers({ zone: 'soloist', status: 'playing' }, false, idle, PC_APP)).toBe(false);
  });
});

describe('PcBackend with Soloist as the Spotify player', () => {
  it('sends a Spotify-only queue to the soloist zone, with the sound put on the PC speakers first; mpv is not touched', async () => {
    const { pc, remotes, zones, toPc } = make();
    live = pc;
    expect(pc.usesSoloist).toBe(true);
    const items = [S(1), S(2)];
    await pc.send(play(items), items);
    expect(pc.currentMode).toBe('spotify');
    expect(remotes['soloist']!.sent).toEqual(['play:sp:1,sp:2']);
    expect(toPc).toEqual(['at:0']); // before anything was sent
    expect(zones.pc.log).toEqual([]);
    expect(pc.state.zone).toBe('pc'); // the page sees the pc zone, whatever plays it
    expect(pc.state.status).toBe('playing');
    // Transport controls go to Soloist; the page keeps showing the pc zone.
    await pc.send({ type: 'pause' });
    expect(zones.soloist.log.at(-1)).toBe('pause');
    expect(pc.state.status).toBe('paused');
    await pc.send({ type: 'resume' });
    expect(toPc).toHaveLength(2); // Play after a pause: the phone may have taken the stream meanwhile
    expect(pc.state.status).toBe('playing');
    await pc.send({ type: 'seek', positionMs: 5000 });
    expect(zones.soloist.log.at(-1)).toBe('seek:5000');
    await pc.send({ type: 'volume', volume: 33 });
    expect(zones.soloist.log.at(-1)).toBe('volume:33');
  });

  it('a local queue never asks Soloist for anything', async () => {
    const { pc, zones, toPc } = make();
    live = pc;
    await pc.send(play([L(1)]), [L(1)]);
    await pc.send({ type: 'resume' });
    expect(toPc).toEqual([]);
    expect(zones.soloist.log).toEqual([]);
  });

  it('mixed queue: local → mpv, Spotify → Soloist, in one queue the tab switches', async () => {
    const { pc, zones, toPc } = make();
    live = pc;
    const items = [L(1), S(1), L(2)];
    await pc.send(play(items), items);
    await flush();
    expect(pc.currentMode).toBe('mixed');
    expect(toPc).toHaveLength(1);
    expect(zones.pc.log).toContain('play:l:1@0');
    expect(zones.soloist.log.some((l) => l.startsWith('play'))).toBe(false);
    zones.pc.progress(199_000);
    zones.pc.finish();
    await flush();
    expect(pc.state.index).toBe(1);
    expect(zones.soloist.log).toContain('play:sp:1@0');
    // Soloist reports the end as stopped (idle): back to mpv.
    zones.soloist.progress(198_000);
    zones.soloist.finish();
    await flush();
    expect(pc.state.index).toBe(2);
    expect(zones.pc.log.filter((l) => l.startsWith('play'))).toEqual(['play:l:1@0', 'play:l:2@0']);
    expect(pc.state.status).toBe('playing');
  });

  it('mixed queue: Soloist going on to autoplay after the Spotify song is the song\'s end — the next local file plays', async () => {
    const { pc, zones } = make();
    live = pc;
    const items = [S(1), L(2)];
    await pc.send(play(items), items);
    await flush();
    expect(pc.currentMode).toBe('mixed');
    expect(zones.soloist.log).toContain('play:sp:1@0');
    // The Soloist zone does not go idle any more: it follows Spotify's autoplay (a new current item, playing from 0).
    zones.soloist.progress(198_000);
    zones.soloist.autoplay('sp:x1');
    await flush();
    expect(pc.state.index).toBe(1);
    expect(pc.state.queue.map((q) => q.track.id)).toEqual(['sp:1', 'l:2']); // the tab's queue is rune's, autoplay is not in it
    expect(zones.pc.log.filter((l) => l.startsWith('play'))).toEqual(['play:l:2@0']);
    expect(pc.state.status).toBe('playing');
  });

  it('queueing a Spotify song onto a local queue puts the sound on the PC speakers too', async () => {
    const { pc, toPc } = make();
    live = pc;
    await pc.send(play([L(1)]), [L(1)]);
    await pc.send({ type: 'enqueue', trackIds: ['sp:1'] }, [S(1)]);
    await flush();
    expect(pc.currentMode).toBe('mixed');
    expect(toPc).toHaveLength(1);
  });
});
