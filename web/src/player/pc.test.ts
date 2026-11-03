import type { PlayerState } from '@liner/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtCommand, PlayItem } from '../lib/types';
import { isMixedQueue, modeFor, PcBackend } from './pc';
import { FakeZone, mkItem, mkTrack } from './testkit';
import { emptyState, type Backend } from './types';

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A server-queue backend over a FakeZone (what RemoteBackend is in production). */
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

function make(withDevice = true) {
  const zones = { pc: new FakeZone('pc'), 'spotify:dev': new FakeZone('spotify:dev') };
  const remotes: Record<string, FakeRemote> = {};
  const notice = vi.fn();
  const pc = new PcBackend({
    remote: (z) => (remotes[z] = new FakeRemote(z, zones[z as keyof typeof zones])),
    transport: (z) => zones[z as keyof typeof zones],
    notice,
  }, withDevice ? { id: 'dev', name: 'HORSE' } : null);
  const states: PlayerState[] = [];
  pc.subscribe((s) => states.push(s));
  return { pc, zones, remotes, notice, states };
}
const L = (n: number) => mkItem(mkTrack(`l:${n}`, 'local'));
const S = (n: number) => mkItem(mkTrack(`sp:${n}`, 'spotify'));
const play = (items: PlayItem[], startIndex = 0, extra: object = {}): ExtCommand => ({ type: 'play', trackIds: items.map((i) => i.track.id), startIndex, ...extra });

let live: PcBackend | null = null;
afterEach(() => { live?.dispose(); live = null; });

describe('modeFor / isMixedQueue', () => {
  it('classifies lists', () => {
    expect(modeFor([L(1), L(2)])).toBe('pc');
    expect(modeFor([S(1)])).toBe('spotify');
    expect(modeFor([L(1), S(1)])).toBe('mixed');
    expect(isMixedQueue([{ queueId: 'a', ...L(1) }, { queueId: 'b', ...S(1) }])).toBe(true);
    expect(isMixedQueue([{ queueId: 'a', ...L(1) }])).toBe(false);
  });
});

describe('PcBackend', () => {
  it('keeps a local-only queue on the server’s own pc queue (no tab needed)', async () => {
    const { pc, remotes, zones } = make();
    live = pc;
    const items = [L(1), L(2)];
    await pc.send(play(items), items);
    expect(pc.currentMode).toBe('pc');
    expect(remotes['pc']!.sent).toEqual(['play:l:1,l:2']);
    expect(zones['pc'].state.queue).toHaveLength(2);
    expect(pc.state.zone).toBe('pc');
  });

  it('plays a Spotify-only queue through the Spotify app on the PC, reporting the pc zone', async () => {
    const { pc, remotes, states } = make();
    live = pc;
    const items = [S(1), S(2)];
    await pc.send(play(items), items);
    expect(pc.currentMode).toBe('spotify');
    expect(remotes['spotify:dev']!.sent).toEqual(['play:sp:1,sp:2']);
    expect(pc.state.zone).toBe('pc');
    expect(pc.state.status).toBe('playing');
    expect(states.at(-1)!.zone).toBe('pc');
  });

  it('refuses Spotify when the Spotify app is not on the PC', async () => {
    const { pc } = make(false);
    live = pc;
    await expect(pc.send(play([S(1)]), [S(1)])).rejects.toThrow(/rune starts Spotify on the PC/);
  });

  it('mixed queue: one queue, local → mpv, Spotify → the app, switching on track end', async () => {
    const { pc, zones } = make();
    live = pc;
    const items = [L(1), S(1), L(2)];
    await pc.send(play(items), items);
    await flush();
    expect(pc.currentMode).toBe('mixed');
    expect(pc.state.queue.map((q) => q.track.id)).toEqual(['l:1', 'sp:1', 'l:2']);
    expect(zones['pc'].log).toContain('play:l:1@0');
    expect(zones['spotify:dev'].log.some((l) => l.startsWith('play'))).toBe(false);

    // mpv finishes track 1 -> the Spotify app takes over
    zones['pc'].progress(199_000);
    zones['pc'].finish();
    await flush();
    expect(pc.state.index).toBe(1);
    expect(zones['spotify:dev'].log).toContain('play:sp:1@0');

    // Spotify finishes (pause + rewind) -> back to mpv for track 3, Spotify silenced
    zones['spotify:dev'].progress(198_000);
    zones['spotify:dev'].finishPaused();
    await flush();
    expect(pc.state.index).toBe(2);
    expect(zones['pc'].log.filter((l) => l.startsWith('play'))).toEqual(['play:l:1@0', 'play:l:2@0']);
    expect(pc.state.status).toBe('playing');

    // last track ends -> stopped
    zones['pc'].finish();
    await flush();
    expect(pc.state.status).toBe('stopped');
  });

  it('switching engines pauses the one that was playing', async () => {
    const { pc, zones } = make();
    live = pc;
    const items = [S(1), L(1)];
    await pc.send(play(items), items);
    await flush();
    zones['spotify:dev'].progress(5000);
    await pc.send({ type: 'next' });
    await flush();
    expect(zones['spotify:dev'].log.at(-1)).toBe('pause');
    expect(zones['pc'].log).toContain('play:l:1@0');
  });

  it('transport commands reach the engine of the current track', async () => {
    const { pc, zones } = make();
    live = pc;
    const items = [L(1), S(1)];
    await pc.send(play(items, 1), items);
    await flush();
    zones['spotify:dev'].progress(1000);
    await pc.send({ type: 'seek', positionMs: 90_000 });
    await pc.send({ type: 'pause' });
    await flush();
    expect(zones['spotify:dev'].log).toEqual(expect.arrayContaining(['seek:90000', 'pause']));
    expect(zones['pc'].log.filter((l) => l.startsWith('seek'))).toEqual([]);
  });

  it('transfers a mixed queue in at the right track and position (zone handoff)', async () => {
    const { pc, zones } = make();
    live = pc;
    const items = [L(1), S(1), L(2)];
    await pc.send(play(items, 1, { positionMs: 74_000, paused: false }), items);
    await flush();
    expect(zones['spotify:dev'].log).toContain('play:sp:1@74000');
    expect(pc.state.index).toBe(1);
  });

  it('transfers paused', async () => {
    const { pc, zones } = make();
    live = pc;
    const items = [S(1), S(2)];
    await pc.send(play(items, 1, { positionMs: 30_000, paused: true }), items);
    expect(pc.state.status).toBe('paused');
    expect(zones['spotify:dev'].state.positionMs).toBe(30_000);
  });

  it('adding a Spotify track to a playing local queue turns it into a mixed queue, keeping position', async () => {
    const { pc, zones, notice } = make();
    live = pc;
    const items = [L(1), L(2)];
    await pc.send(play(items, 1), items);
    zones['pc'].progress(40_000);
    await pc.send({ type: 'enqueue', trackIds: ['sp:9'] }, [S(9)]);
    await flush();
    expect(pc.currentMode).toBe('mixed');
    expect(pc.state.queue.map((q) => q.track.id)).toEqual(['l:1', 'l:2', 'sp:9']);
    expect(pc.state.index).toBe(1);
    const at = Number(/^play:l:2@(\d+)/.exec(zones['pc'].log.at(-1) ?? '')?.[1]);
    expect(Math.abs(at - 40_000)).toBeLessThan(500);
    expect(notice).toHaveBeenCalledWith(expect.stringMatching(/rune tab open/));
  });

  it('queueing same-kind tracks stays on the server queue', async () => {
    const { pc, remotes } = make();
    live = pc;
    await pc.send(play([L(1)]), [L(1)]);
    await pc.send({ type: 'enqueue', trackIds: ['l:2'] }, [L(2)]);
    expect(remotes['pc']!.sent).toEqual(['play:l:1', 'enqueue']);
    expect(pc.currentMode).toBe('pc');
  });

  it('going back to a local-only queue silences the Spotify app and the mixed queue', async () => {
    const { pc, zones } = make();
    live = pc;
    const mixed = [S(1), L(1)];
    await pc.send(play(mixed), mixed);
    await flush();
    zones['spotify:dev'].progress(3000);
    await pc.send(play([L(5)]), [L(5)]);
    await flush();
    expect(pc.currentMode).toBe('pc');
    expect(zones['spotify:dev'].log.at(-1)).toBe('pause');
    expect(zones['pc'].state.queue.map((q) => q.track.id)).toEqual(['l:5']);
    expect(pc.state.queue.map((q) => q.track.id)).toEqual(['l:5']);
  });

  it('adopts what the Spotify app on the PC is already playing on refresh', async () => {
    const { pc, zones } = make();
    live = pc;
    await zones['spotify:dev'].send({ type: 'play', trackIds: ['sp:77'] });
    await pc.refresh();
    expect(pc.currentMode).toBe('spotify');
    expect(pc.state.queue[0]?.track.id).toBe('sp:77');
    expect(pc.state.zone).toBe('pc');
  });

  it('losing the Spotify app falls back to the plain pc zone', async () => {
    const { pc } = make();
    live = pc;
    pc.setDevice(null);
    expect(pc.hasSpotify).toBe(false);
    await expect(pc.send(play([S(1)]), [S(1)])).rejects.toThrow();
    pc.setDevice({ id: 'dev', name: 'HORSE' });
    expect(pc.hasSpotify).toBe(true);
  });
});
