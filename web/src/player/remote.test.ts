import type { PlayerState } from '@liner/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  playerState: vi.fn(),
  playerSend: vi.fn(),
}));

vi.mock('../api', () => ({ api: { playerState: mocks.playerState, playerSend: mocks.playerSend } }));

// The socket singleton only needs something constructible; no messages are exchanged here.
class FakeWS {
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}
vi.stubGlobal('WebSocket', FakeWS);
vi.stubGlobal('location', { protocol: 'http:', host: 'x' });

const state = (ids: string[]): PlayerState => ({
  zone: 'pc',
  status: ids.length ? 'playing' : 'stopped',
  queue: ids.map((queueId, i) => ({
    queueId,
    track: {
      id: `l:${i}`,
      albumId: 'la:a',
      source: 'local',
      title: queueId,
      artists: [],
      disc: 1,
      number: i + 1,
      durationMs: 60_000,
    },
    album: { id: 'la:a', title: 'Album' },
  })),
  index: ids.length ? 0 : -1,
  positionMs: 0,
  volume: 100,
  shuffle: false,
  repeat: 'off',
  updatedAt: 0,
});

describe('RemoteBackend queue commands', () => {
  beforeEach(() => {
    mocks.playerState.mockReset();
    mocks.playerSend.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sends a move to the server as a single command', async () => {
    mocks.playerState.mockResolvedValue(state(['q:1', 'q:2', 'q:3']));
    mocks.playerSend.mockResolvedValue(state(['q:2', 'q:1', 'q:3']));
    const { RemoteBackend } = await import('./remote');
    const backend = new RemoteBackend('pc');
    await vi.waitFor(() => expect(backend.state.queue).toHaveLength(3));

    await backend.send({ type: 'move', queueId: 'q:2', toIndex: 0 });

    expect(mocks.playerSend).toHaveBeenCalledTimes(1);
    expect(mocks.playerSend).toHaveBeenCalledWith('pc', { type: 'move', queueId: 'q:2', toIndex: 0 });
    backend.dispose();
  });

  it('sends clear as one command instead of one remove per track', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `q:${i}`);
    mocks.playerState.mockResolvedValue(state(ids));
    mocks.playerSend.mockResolvedValue(state([]));
    const { RemoteBackend } = await import('./remote');
    const backend = new RemoteBackend('pc');
    await vi.waitFor(() => expect(backend.state.queue).toHaveLength(ids.length));

    await backend.send({ type: 'clear' });

    expect(mocks.playerSend).toHaveBeenCalledTimes(1);
    expect(mocks.playerSend).toHaveBeenCalledWith('pc', { type: 'clear' });
    expect(mocks.playerSend.mock.calls.some(([, cmd]) => cmd.type === 'remove')).toBe(false);
    expect(backend.state.queue).toEqual([]);
    backend.dispose();
  });
});
