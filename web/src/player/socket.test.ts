import { describe, expect, it, vi } from 'vitest';

const fullState = (rev: string, n: number, pos = 0) => ({ type: 'player', queueRev: rev, state: { zone: 'spotify:x', status: 'playing', index: 0, positionMs: pos, volume: 50, shuffle: false, repeat: 'off', updatedAt: 1, queue: Array.from({ length: n }, (_, i) => ({ queueId: `q${i}`, track: { id: `sp:${i}` }, album: { id: 'a', title: 'A' } })) } });
const slim = (rev: string, pos: number) => { const e = fullState(rev, 0, pos) as { state: Record<string, unknown> }; delete e.state.queue; return e; };

vi.mock('../api', () => ({ api: { playerState: vi.fn(async () => fullState('r1', 3).state) } }));

class FakeWS {
  static last: FakeWS;
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) { FakeWS.last = this; }
  send(s: string) { this.sent.push(s); }
  close() {}
  push(e: unknown) { this.onmessage?.({ data: JSON.stringify(e) }); }
}
vi.stubGlobal('WebSocket', FakeWS);
vi.stubGlobal('location', { protocol: 'http:', host: 'x' });

describe('live socket: slim player events', () => {
  it('asks for slim events, fills the queue from the last full event, fetches once when unknown', async () => {
    const { socket } = await import('./remote');
    const { api } = await import('../api');
    const got: { n: number | undefined; pos: unknown }[] = [];
    socket.on((e) => { if (e.type === 'player') got.push({ n: e.state.queue?.length, pos: e.state.positionMs }); });
    expect(FakeWS.last.url).toContain('slim=1');

    FakeWS.last.push(slim('r1', 100)); // joined mid-way: queue unknown -> one fetch
    FakeWS.last.push(slim('r1', 200)); // still fetching: dropped, not a second fetch
    await vi.waitFor(() => expect(got).toHaveLength(1));
    expect(api.playerState).toHaveBeenCalledTimes(1);
    expect(got[0]!.n).toBe(3);

    FakeWS.last.push(slim('r1', 1100)); // known revision: queue restored, no fetch
    expect(got.at(-1)).toEqual({ n: 3, pos: 1100 });
    FakeWS.last.push(fullState('r2', 5, 0)); // queue changed: full event replaces it
    FakeWS.last.push(slim('r2', 900));
    expect(got.at(-1)).toEqual({ n: 5, pos: 900 });
    expect(api.playerState).toHaveBeenCalledTimes(1);
  });

describe('live socket: the zones this tab views', () => {
  it('sends them once per burst of changes, counts repeats, and again on reconnect', async () => {
    const { socket, zoneTransport } = await import('./remote');
    socket.on(() => undefined);
    const ws = FakeWS.last;
    const viewing = () => ws.sent.map((m) => JSON.parse(m) as { type: string; zones?: string[] }).filter((m) => m.type === 'viewing').map((m) => m.zones);
    const offA = socket.view('spotify:a');
    const offA2 = socket.view('spotify:a');
    const offB = zoneTransport('spotify:b').subscribe(() => undefined);
    await Promise.resolve();
    expect(viewing()).toEqual([['spotify:a', 'spotify:b']]);
    offA(); offA();                                   // a second call is a no-op
    await Promise.resolve();
    expect(viewing().at(-1)).toEqual(['spotify:a', 'spotify:b']); // still viewed once
    offA2(); offB();
    await Promise.resolve();
    expect(viewing().at(-1)).toEqual([]);
    expect(viewing()).toHaveLength(3);
    const keep = socket.view('pc');
    await Promise.resolve();
    ws.sent.length = 0;
    ws.onopen?.();
    expect(viewing()).toEqual([['pc']]);
    keep();
  });
});
});
