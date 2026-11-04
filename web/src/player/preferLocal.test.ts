import { describe, expect, it, vi } from 'vitest';
import type { PlayItem } from '../lib/types';
import { fitForZone, preferLocal, type SpotifyTwinLookup, type TwinLookup } from './preferLocal';

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

describe('fitForZone: each zone gets the copy it can play', () => {
  const toLocal = vi.fn<TwinLookup>(async () => ({ 'sp:1': item('l:1', 'local') }));
  // l:1 and l:2 have Spotify copies; l:3 does not.
  const toSpotify = vi.fn<SpotifyTwinLookup>(async (ids) =>
    Object.fromEntries(ids.filter((id) => id !== 'l:3').map((id) => [id, item(id.replace('l:', 'sp:'), 'spotify')])),
  );
  const lookups = { toLocal, toSpotify };
  const ids = (xs: PlayItem[]) => xs.map((i) => i.track.id);
  const phone = { local: true, spotify: false, spotifyElsewhere: true };

  it('PC / desktop browser: own files first', async () => {
    const out = await fitForZone([item('sp:1', 'spotify'), item('sp:2', 'spotify')], 0, { local: true, spotify: true, spotifyElsewhere: true }, lookups);
    expect(ids(out)).toEqual(['l:1', 'sp:2']);
  });
  it('Spotify device: owned files play their Spotify copy instead of being skipped', async () => {
    const out = await fitForZone([item('l:1', 'local'), item('l:2', 'local'), item('l:3', 'local')], 0, { local: false, spotify: true, spotifyElsewhere: true }, lookups);
    expect(ids(out)).toEqual(['sp:1', 'sp:2', 'l:3']);
  });
  it('iPhone: a Spotify album with one owned song goes to Spotify whole, not 1 song + 17 skipped', async () => {
    const album = [item('sp:1', 'spotify'), item('sp:5', 'spotify'), item('sp:6', 'spotify')];
    const out = await fitForZone(album, 0, phone, lookups);
    expect(ids(out)).toEqual(['sp:1', 'sp:5', 'sp:6']);
  });
  it('iPhone: a fully owned list plays from the files on the phone', async () => {
    const allOwned = vi.fn<TwinLookup>(async () => ({ 'sp:1': item('l:1', 'local'), 'sp:2': item('l:2', 'local') }));
    const out = await fitForZone([item('sp:1', 'spotify'), item('sp:2', 'spotify')], 0, phone, { toLocal: allOwned, toSpotify });
    expect(ids(out)).toEqual(['l:1', 'l:2']);
  });
  it('iPhone: stays local when the Spotify way would skip more (or Spotify is not connected)', async () => {
    const mostlyLocal = [item('l:3', 'local'), item('l:1', 'local'), item('sp:9', 'spotify')];
    expect(ids(await fitForZone(mostlyLocal, 0, phone, lookups))).toEqual(['l:3', 'l:1', 'sp:9']);
    const album = [item('sp:1', 'spotify'), item('sp:5', 'spotify')];
    expect(ids(await fitForZone(album, 0, { ...phone, spotifyElsewhere: false }, lookups))).toEqual(['l:1', 'sp:5']);
  });
});
