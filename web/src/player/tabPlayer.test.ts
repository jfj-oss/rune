// The browser zone's tab: it follows the server's state with its engine and reports what the engine did.
// A fake engine, a fake server state and a fake channel; nothing real.
import type { PlayerCommand, PlayerState, QueueItem, TabReport } from '@liner/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Engine } from './engine';
import { startsSoundHere } from './browser';
import type { TabChannel } from './oneTab';
import { TabPlayer } from './tabPlayer';
import { mkTrack } from './testkit';
import { emptyState } from './types';

class FakeEngine implements Engine {
  calls: string[] = [];
  pos: number | null = 0;
  endedFn: () => void = () => {};
  errorFn: (m: string) => void = () => {};
  syncFn: (p: number, playing: boolean) => void = () => {};
  load(t: { id: string }, s: number, a: boolean, up: { id: string }[] = []) { this.calls.push(`load:${t.id}@${s}:${a}${up.length ? `+${up.map((u) => u.id).join(',')}` : ''}`); }
  setUpcoming(up: { id: string }[]) { this.calls.push(`upcoming:${up.map((u) => u.id).join(',')}`); }
  play() { this.calls.push('play'); }
  pause() { this.calls.push('pause'); }
  seek(ms: number) { this.calls.push(`seek:${ms}`); }
  setVolume(v: number) { this.calls.push(`vol:${v}`); }
  position() { return this.pos; }
  stop() { this.calls.push('stop'); }
  onEnded(fn: () => void) { this.endedFn = fn; }
  onError(fn: (m: string) => void) { this.errorFn = fn; }
  onSync(fn: (p: number, playing: boolean) => void) { this.syncFn = fn; }
}

const item = (n: number): QueueItem => ({ queueId: `q${n}`, track: mkTrack(`l:${n}`, 'local'), album: { id: 'a', title: 'A' } });
const state = (patch: Partial<PlayerState> = {}): PlayerState => ({
  ...emptyState('browser:me'), queue: [1, 2, 3].map(item), index: 0, status: 'loading', positionMs: 0, updatedAt: Date.now(),
  tab: { token: 1, loadV: 1, seekV: 0, run: ['q1', 'q2', 'q3'] }, ...patch,
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const live: TabPlayer[] = [];
afterEach(() => { for (const p of live.splice(0)) p.dispose(); vi.useRealTimers(); });

function rig(opts: { channel?: TabChannel | null } = {}) {
  const engine = new FakeEngine();
  const reports: TabReport[] = [];
  const setVolume = vi.fn();
  const notice = vi.fn();
  const player = new TabPlayer('browser:me', engine, { report: async (r) => { reports.push(r); }, setVolume, notice, channel: opts.channel ?? null });
  live.push(player);
  return { engine, reports, player, setVolume, notice };
}

describe('TabPlayer: the engine follows the server', () => {
  it('does nothing until this tab sounds the zone', () => {
    const { engine, player } = rig();
    player.apply(state({ status: 'paused', tab: undefined }));
    expect(engine.calls).toEqual([]);
  });

  it('loads the current song at the start instruction, with the run after it, and says it started', async () => {
    const { engine, reports, player } = rig();
    player.apply(state());
    player.claim();
    expect(engine.calls).toEqual(['vol:100', 'load:l:1@0:true+l:2,l:3']);
    await flush();
    expect(reports).toEqual([{ type: 'started', queueId: 'q1', positionMs: 0, token: 1 }]);
  });

  it('a loading state whose instruction has not changed yet starts nothing (the new instruction follows)', () => {
    const { engine, player } = rig();
    player.claim();
    player.apply(state());
    engine.calls.length = 0;
    player.apply(state({ index: 1, status: 'loading' })); // cursor moved, still the old loadV
    expect(engine.calls).toEqual([]);
    player.apply(state({ index: 1, status: 'loading', tab: { token: 1, loadV: 2, seekV: 0, run: ['q2', 'q3'] } }));
    expect(engine.calls).toEqual(['load:l:2@0:true+l:3']);
  });

  it('pause and play follow the server status, seek follows seekV, a queue edit refreshes the look-ahead', () => {
    const { engine, player } = rig();
    player.claim();
    player.apply(state());
    player.apply(state({ status: 'playing' }));
    engine.calls.length = 0;
    player.apply(state({ status: 'paused', positionMs: 5000 }));
    player.apply(state({ status: 'playing', positionMs: 5000 }));
    expect(engine.calls).toEqual(['pause', 'play']);
    engine.calls.length = 0;
    player.apply(state({ status: 'playing', positionMs: 40_000, tab: { token: 1, loadV: 1, seekV: 1, run: ['q1', 'q2', 'q3'] } }));
    expect(engine.calls).toEqual(['seek:40000']);
    engine.calls.length = 0;
    player.apply(state({ status: 'playing', tab: { token: 1, loadV: 1, seekV: 1, run: ['q1', 'q3'] } }));
    expect(engine.calls).toEqual(['upcoming:l:3']);
  });

  it('a stopped queue silences the engine', () => {
    const { engine, player } = rig();
    player.claim();
    player.apply(state());
    engine.calls.length = 0;
    player.apply(state({ status: 'stopped', queue: [], index: -1, tab: undefined }));
    expect(engine.calls).toEqual(['stop']);
  });

  it('the volume is the server\'s', () => {
    const { engine, player } = rig();
    player.claim();
    player.apply(state({ volume: 40 }));
    expect(engine.calls[0]).toBe('vol:40');
  });
});

describe('TabPlayer: song ends', () => {
  it('goes on down the run at once, saying ended then started; the last song of the run leaves the next step to the server', async () => {
    const { engine, reports, player } = rig();
    player.claim();
    player.apply(state({ status: 'playing' }));
    await flush();
    reports.length = 0; engine.calls.length = 0;
    engine.endedFn();
    expect(engine.calls).toEqual(['load:l:2@0:true+l:3']);
    await flush();
    expect(reports.map((r) => `${r.type}:${r.queueId}`)).toEqual(['ended:q1', 'started:q2']);
    // the server catches up: the cursor is on q2 now, same instruction: nothing is loaded again
    engine.calls.length = 0;
    player.apply(state({ status: 'playing', index: 1 }));
    expect(engine.calls).toEqual([]);
    engine.endedFn();
    engine.endedFn(); // q3 was the last: a second end with nothing loaded is ignored
    await flush();
    expect(reports.map((r) => `${r.type}:${r.queueId}`)).toEqual(['ended:q1', 'started:q2', 'ended:q2', 'started:q3', 'ended:q3']);
    engine.calls.length = 0;
    player.apply(state({ status: 'loading', index: 0, tab: { token: 2, loadV: 2, seekV: 0, run: ['q1'] } })); // repeat one / a new run
    expect(engine.calls).toEqual(['load:l:1@0:true']);
  });

  it('an engine error is reported as a failure and shown', async () => {
    const { engine, reports, player, notice } = rig();
    player.claim();
    player.apply(state({ status: 'playing' }));
    await flush();
    reports.length = 0;
    engine.errorFn('Tap play to start audio');
    await flush();
    expect(notice).toHaveBeenCalledWith('Tap play to start audio');
    expect(reports).toEqual([{ type: 'failed', queueId: 'q1', message: 'Tap play to start audio', token: 1 }]);
  });

  it('a player that paused on its own (Spotify changed from another app) says so, but not right after it was told to load', async () => {
    vi.useFakeTimers();
    const { engine, reports, player } = rig();
    player.claim();
    player.apply(state({ status: 'playing' }));
    engine.syncFn(0, false);                // still starting
    await vi.advanceTimersByTimeAsync(0);
    expect(reports.filter((r) => r.type === 'paused')).toEqual([]);
    await vi.advanceTimersByTimeAsync(3000);
    engine.syncFn(12_000, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(reports.filter((r) => r.type === 'paused')).toEqual([{ type: 'paused', queueId: 'q1', positionMs: 12_000, token: 1 }]);
  });

  it('tells the server where it is every few seconds while it sounds', async () => {
    vi.useFakeTimers();
    const { engine, reports, player } = rig();
    player.claim();
    player.apply(state({ status: 'playing' }));
    engine.pos = 9_000;
    await vi.advanceTimersByTimeAsync(8_100);
    expect(reports.at(-1)).toEqual({ type: 'position', queueId: 'q1', positionMs: 9000, token: 1 });
  });
});

describe('TabPlayer: which tab sounds', () => {
  function channel() {
    let letGo = () => {}, asked = () => false, answer = false;
    const ch: TabChannel = {
      claimed: vi.fn(), onClaimedElsewhere: (fn) => { letGo = fn; }, anyoneSounding: async () => answer, onAsked: (fn) => { asked = fn; }, close: () => {},
    };
    return { ch, other: () => letGo(), asked: () => asked(), setAnswer: (v: boolean) => { answer = v; } };
  }

  it('claims on start, lets go (and falls silent) when another tab claims', () => {
    const c = channel();
    const { engine, player } = rig({ channel: c.ch });
    player.apply(state());
    player.claim();
    expect(c.ch.claimed).toHaveBeenCalledTimes(1);
    expect(c.asked()).toBe(true);
    engine.calls.length = 0;
    c.other();
    expect(player.isHosting).toBe(false);
    expect(engine.calls).toEqual(['stop']);
    player.apply(state({ status: 'playing' }));
    expect(engine.calls).toEqual(['stop']); // not hosting: nothing more
  });

  it('a page that opens while the zone plays takes it over unless another tab sounds it', async () => {
    const taken = channel();
    const a = rig({ channel: taken.ch });
    a.player.apply(state({ status: 'playing' }));
    await flush();
    expect(a.player.isHosting).toBe(true);
    expect(a.engine.calls).toContain('load:l:1@0:true+l:2,l:3');

    const busy = channel();
    busy.setAnswer(true);
    const b = rig({ channel: busy.ch });
    b.player.apply(state({ status: 'playing' }));
    await flush();
    expect(b.player.isHosting).toBe(false);
    expect(b.engine.calls).toEqual([]);
  });
});

describe('which commands make this tab the one that sounds', () => {
  const s = state({ status: 'playing' });
  it('play, resume, next, prev, jump do; transport edits and volume do not', () => {
    for (const cmd of [{ type: 'play', trackIds: ['l:1'] }, { type: 'resume' }, { type: 'next' }, { type: 'prev' }, { type: 'jump', index: 1 }] satisfies PlayerCommand[]) expect(startsSoundHere(cmd, s)).toBe(true);
    for (const cmd of [{ type: 'pause' }, { type: 'seek', positionMs: 1 }, { type: 'volume', volume: 5 }, { type: 'remove', queueId: 'q1' }, { type: 'shuffle', on: true }, { type: 'clear' }] satisfies PlayerCommand[]) expect(startsSoundHere(cmd, s)).toBe(false);
  });
  it('adding to a playing queue leaves the sound where it is; into an empty or stopped one it starts it here', () => {
    expect(startsSoundHere({ type: 'enqueue', trackIds: ['l:9'] }, s)).toBe(false);
    expect(startsSoundHere({ type: 'enqueue', trackIds: ['l:9'] }, state({ status: 'stopped' }))).toBe(true);
    expect(startsSoundHere({ type: 'enqueue', trackIds: ['l:9'] }, emptyState('browser:me'))).toBe(true);
  });
});
