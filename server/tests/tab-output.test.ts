// A browser tab that goes quiet (a locked phone) must never pause or fail the zone on its own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueItem } from '@liner/shared';
import type { OutputFact } from '../src/play/driver.js';
import { TabOutput } from '../src/play/tabOutput.js';

const item = (n: number): QueueItem => ({ queueId: `q${n}`, track: { id: `l:${n}`, albumId: 'a', source: 'local', title: `T${n}`, artists: [], disc: 1, number: n, durationMs: 200_000 } as QueueItem['track'], album: { id: 'a', title: 'A' } });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
afterEach(() => { vi.useRealTimers(); });

async function rig() {
  const out = new TabOutput();
  const facts: OutputFact[] = [];
  out.onFact((f) => facts.push(f));
  await out.start([item(1), item(2)], { token: 1, positionMs: 0, volume: 100 });
  out.report({ token: 1, queueId: 'q1', type: 'started', positionMs: 0, visible: true });
  return { out, facts };
}

describe('a tab that goes silent while playing', () => {
  it('is not paused for 2 minutes, its position is unknown meanwhile, and it resumes reporting cleanly', async () => {
    const { out, facts } = await rig();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(out.position()).toBeGreaterThan(9_000);
    out.report({ token: 1, queueId: 'q1', type: 'position', positionMs: 10_000, visible: false });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(facts.map((f) => f.type)).toEqual(['started']); // nothing paused, nothing failed
    expect(out.position()).toBeNull(); // stale: the driver counts by its clock
    expect(out.details().tab?.run).toEqual(['q1', 'q2']); // the instruction is untouched
    // back after an unlock: it moved on to the next song while quiet and says so
    out.report({ token: 1, queueId: 'q1', type: 'ended', visible: true });
    out.report({ token: 1, queueId: 'q2', type: 'started', positionMs: 3_000, visible: true });
    expect(facts.map((f) => f.type)).toEqual(['started', 'ended', 'started']);
    expect(out.position()).toBeGreaterThanOrEqual(3_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(facts.map((f) => f.type)).toEqual(['started', 'ended', 'started']);
  });

  it('is released (failed) only after 30 minutes without a word', async () => {
    const { out, facts } = await rig();
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(facts.map((f) => f.type)).toEqual(['started']);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(facts.map((f) => f.type)).toEqual(['started', 'failed']);
    out.close();
  });

  it('"nobody answered the start" applies to a visible page only', async () => {
    const hidden = new TabOutput();
    const f1: OutputFact[] = [];
    hidden.onFact((f) => f1.push(f));
    hidden.report({ token: 0, queueId: 'x', type: 'position', positionMs: 0, visible: false }); // the page last said it is hidden
    await hidden.start([item(1)], { token: 1, positionMs: 0, volume: 100 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f1).toEqual([]);
    hidden.close();

    const shown = new TabOutput();
    const f2: OutputFact[] = [];
    shown.onFact((f) => f2.push(f));
    await shown.start([item(1)], { token: 1, positionMs: 0, volume: 100 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f2.map((f) => f.type)).toEqual(['failed']);
  });
});
