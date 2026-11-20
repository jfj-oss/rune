import type { MiniPlaylist } from '@liner/shared';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MINI_COLORS, MINI_MAX, isOnMini, miniColor, moveMini, withMini } from './miniPlaylists';

const toast = vi.fn();
const api = { setMiniPlaylist: vi.fn(), setMiniPlaylists: vi.fn(), miniPlaylists: vi.fn() };
vi.mock('../store/ui', () => ({ useUi: { getState: () => ({ toast }) } }));
vi.mock('../api', () => ({ api }));
const { applyMini, setOnMini, MINI_KEY } = await import('../hooks/useMiniPlaylists');

const p = (id: string, color: number): MiniPlaylist => ({ id, name: id.toUpperCase(), color });
const ids = (qc: QueryClient) => qc.getQueryData<MiniPlaylist[]>(MINI_KEY)!.map((x) => x.id);

describe('the list helpers', () => {
  it('moves an item and leaves the original alone', () => {
    const l = ['a', 'b', 'c', 'd'];
    expect(moveMini(l, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveMini(l, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveMini(l, 1, 9)).toEqual(l);
    expect(l).toEqual(['a', 'b', 'c', 'd']);
  });
  it('shows a switched-on playlist at the end with the lowest free colour, and a switched-off one gone', () => {
    const l = [p('a', 0), p('b', 2)];
    expect(withMini(l, 'c', 'C', true)).toEqual([...l, { id: 'c', name: 'C', color: 1 }]);
    expect(withMini(l, 'a', 'A', true)).toEqual(l);
    expect(withMini(l, 'a', 'A', false).map((x) => x.id)).toEqual(['b']);
    expect(isOnMini(l, 'b')).toBe(true);
    expect(isOnMini(l, 'z')).toBe(false);
    expect(isOnMini(undefined, 'z')).toBe(false);
  });
  it('has the same eight colours as the mini and wraps an out-of-range index', () => {
    expect(MINI_COLORS).toHaveLength(MINI_MAX);
    expect(miniColor(0)).toBe('#C9785A');
    expect(miniColor(8)).toBe('#C9785A');
  });
});

describe('the toggle', () => {
  let qc: QueryClient;
  beforeEach(() => {
    toast.mockClear();
    Object.values(api).forEach((f) => f.mockReset());
    qc = new QueryClient();
    qc.setQueryData(MINI_KEY, [p('pl:a', 0)]);
  });

  it('adds at once, then takes the server\'s list', async () => {
    let release!: (l: MiniPlaylist[]) => void;
    api.setMiniPlaylist.mockReturnValue(new Promise((r) => { release = r; }));
    const done = setOnMini(qc, 'pl:b', 'B', true);
    expect(ids(qc)).toEqual(['pl:a', 'pl:b']);
    release([p('pl:a', 0), p('pl:b', 5)]);
    expect(await done).toBe(true);
    expect(api.setMiniPlaylist).toHaveBeenCalledWith('pl:b', true);
    expect(qc.getQueryData<MiniPlaylist[]>(MINI_KEY)![1]!.color).toBe(5);
    expect(toast).toHaveBeenCalledWith('Shown in rune mini');
  });

  it('removes', async () => {
    api.setMiniPlaylist.mockResolvedValue([]);
    expect(await setOnMini(qc, 'pl:a', 'A', false)).toBe(true);
    expect(ids(qc)).toEqual([]);
    expect(toast).toHaveBeenCalledWith('Removed from rune mini');
  });

  it('puts the list back and says why when the server refuses', async () => {
    api.setMiniPlaylist.mockRejectedValue(Object.assign(new Error('409'), { serverMessage: 'the mini has room for 8 playlists' }));
    expect(await setOnMini(qc, 'pl:b', 'B', true)).toBe(false);
    expect(ids(qc)).toEqual(['pl:a']);
    expect(toast).toHaveBeenCalledWith('the mini has room for 8 playlists');
  });

  it('does not ask the server for a ninth', async () => {
    qc.setQueryData(MINI_KEY, Array.from({ length: 8 }, (_, i) => p(`pl:${i}`, i)));
    expect(await setOnMini(qc, 'pl:x', 'X', true)).toBe(false);
    expect(api.setMiniPlaylist).not.toHaveBeenCalled();
    expect(ids(qc)).toHaveLength(8);
  });

  it('a reorder from Settings is shown at once and rolled back on a failure', async () => {
    qc.setQueryData(MINI_KEY, [p('pl:a', 0), p('pl:b', 1), p('pl:c', 2)]);
    api.setMiniPlaylists.mockRejectedValue(new Error('500'));
    const next = moveMini(qc.getQueryData<MiniPlaylist[]>(MINI_KEY)!, 2, 0);
    const done = applyMini(qc, next, () => api.setMiniPlaylists(next.map((x) => x.id)), 'Could not change the rune mini');
    expect(ids(qc)).toEqual(['pl:c', 'pl:a', 'pl:b']);
    expect(await done).toBe(false);
    expect(ids(qc)).toEqual(['pl:a', 'pl:b', 'pl:c']);
    expect(api.setMiniPlaylists).toHaveBeenCalledWith(['pl:c', 'pl:a', 'pl:b']);
    expect(toast).toHaveBeenCalledWith('Could not change the rune mini');
  });
});
