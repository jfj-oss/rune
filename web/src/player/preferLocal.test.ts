import { describe, expect, it, vi } from 'vitest';
import type { PlayItem } from '../lib/types';
import { preferLocal, type TwinLookup } from './preferLocal';

const item = (id: string, source: 'local' | 'spotify'): PlayItem => ({
  track: { id, albumId: 'al', source, title: id, artists: [{ id: 'ar', name: 'A' }], disc: 1, number: 1, durationMs: 1000 },
  album: { id: 'al', title: 'Al' },
});

describe('preferLocal', () => {
  it('swaps Spotify tracks for their local copies and keeps the order', async () => {
    const lookup = vi.fn<TwinLookup>(async () => ({ 'sp:2': item('l:9', 'local') }));
    const out = await preferLocal([item('l:1', 'local'), item('sp:2', 'spotify'), item('sp:3', 'spotify')], lookup);
    expect(out.map((i) => i.track.id)).toEqual(['l:1', 'l:9', 'sp:3']);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0]?.[0].map((q) => q.id)).toEqual(['sp:2', 'sp:3']);
  });
  it('asks nothing for an all-local queue', async () => {
    const lookup = vi.fn<TwinLookup>(async () => ({}));
    await preferLocal([item('l:1', 'local')], lookup);
    expect(lookup).not.toHaveBeenCalled();
  });
  it('plays what was asked if the lookup fails', async () => {
    const items = [item('sp:2', 'spotify')];
    expect(await preferLocal(items, async () => { throw new Error('offline'); })).toBe(items);
  });
});
