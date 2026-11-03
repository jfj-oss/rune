import type { Track } from '@liner/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayItem, ZoneInfo } from '../lib/types';
import {
  PC_SPOTIFY_FAILED,
  PC_SPOTIFY_MAX_READS,
  PC_SPOTIFY_POLL_MS,
  PC_SPOTIFY_STARTING,
  needsPcSpotify,
  startPcSpotifyAndWait,
} from './pcStart';
import { routeItems } from './routing';

afterEach(() => {
  vi.useRealTimers();
});

const item = (id: string, source: 'local' | 'spotify'): PlayItem => ({
  track: { id, albumId: source === 'spotify' ? 'sp:alb' : 'la:alb', source, title: id, artists: [], disc: 1, number: 1, durationMs: 1000 } as Track,
  album: { id: source === 'spotify' ? 'sp:alb' : 'la:alb', title: 'Album' },
});
const PC = (id?: string): ZoneInfo => ({ id: 'pc', name: 'Linux PC speakers', kind: 'pc', ...(id ? { spotifyDeviceId: id, spotifyDeviceName: 'HORSE' } : {}) });
const BROWSER: ZoneInfo = { id: 'browser', name: 'This computer', kind: 'browser' };

describe('needsPcSpotify', () => {
  it('only when the pc zone is missing its app and Spotify tracks are involved', () => {
    expect(needsPcSpotify(PC(), [item('sp:1', 'spotify')])).toBe(true);
    expect(needsPcSpotify(PC(), [item('l:1', 'local'), item('sp:1', 'spotify')])).toBe(true);
    expect(needsPcSpotify(PC(), [item('l:1', 'local')])).toBe(false);
    expect(needsPcSpotify(PC('dev'), [item('sp:1', 'spotify')])).toBe(false);
    expect(needsPcSpotify({ id: 'spotify:x', name: 'Phone', kind: 'spotify' }, [item('sp:1', 'spotify')])).toBe(false);
    expect(needsPcSpotify(undefined, [item('sp:1', 'spotify')])).toBe(false);
  });
});

describe('startPcSpotifyAndWait', () => {
  it('asks the server once, then polls /zones every 2 s until the pc device appears', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const toast = vi.fn();
    const start = vi.fn(async () => ({ started: true, running: false }));
    const readZones = vi.fn(async () => {
      reads++;
      return [reads < 3 ? PC() : PC('dev1'), BROWSER];
    });

    const pending = startPcSpotifyAndWait({ start, readZones, toast });
    expect(start).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenNthCalledWith(1, PC_SPOTIFY_STARTING);

    // Not before the first two polls answer "not yet".
    await vi.advanceTimersByTimeAsync(PC_SPOTIFY_POLL_MS * 2);
    expect(reads).toBe(2);

    await vi.advanceTimersByTimeAsync(PC_SPOTIFY_POLL_MS);
    const pc = await pending;
    expect(reads).toBe(3);
    expect(pc).toMatchObject({ id: 'pc', kind: 'pc', spotifyDeviceId: 'dev1' });
    expect(start).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledTimes(1); // only “Starting…”, no failure

    // The original switch can now run as if the device had been there all along.
    const items = [item('l:1', 'local'), item('sp:1', 'spotify'), item('sp:2', 'spotify')];
    const route = routeItems(pc!, items, 1, { sdk: false });
    expect(route.ok).toBe(true);
    expect(route.ok && route.dropped).toBe(0);
    expect(route.ok && route.items.map((i) => i.track.id)).toEqual(['l:1', 'sp:1', 'sp:2']);
  });

  it('reads at most 15 times, then reports failure and returns null after 30 s', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const toast = vi.fn();
    const start = vi.fn(async () => ({ started: true, running: false }));
    const readZones = vi.fn(async () => {
      reads++;
      return [PC(), BROWSER]; // the app never registers a device
    });

    const pending = startPcSpotifyAndWait({ start, readZones, toast });
    await vi.advanceTimersByTimeAsync(PC_SPOTIFY_MAX_READS * PC_SPOTIFY_POLL_MS - 1);
    expect(reads).toBe(PC_SPOTIFY_MAX_READS - 1);

    await vi.advanceTimersByTimeAsync(1);
    const pc = await pending;
    expect(pc).toBeNull();
    expect(reads).toBe(PC_SPOTIFY_MAX_READS);
    expect(toast).toHaveBeenLastCalledWith(PC_SPOTIFY_FAILED);
    expect(toast).toHaveBeenNthCalledWith(1, PC_SPOTIFY_STARTING);
  });

  it('shows the failure message even when the start request itself fails', async () => {
    vi.useFakeTimers();
    const toast = vi.fn();
    const pending = startPcSpotifyAndWait({
      start: async () => {
        throw new Error('server offline');
      },
      readZones: async () => [PC()],
      toast,
    });
    await vi.advanceTimersByTimeAsync(PC_SPOTIFY_MAX_READS * PC_SPOTIFY_POLL_MS);
    expect(await pending).toBeNull();
    expect(toast).toHaveBeenLastCalledWith(PC_SPOTIFY_FAILED);
  });
});
