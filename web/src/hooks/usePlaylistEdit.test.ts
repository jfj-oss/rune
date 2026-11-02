import type { PlaylistTrack } from '@liner/shared';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunePlaylistDetail, RunePlaylistSummary } from '../lib/playlists';

const toast = vi.fn();
vi.mock('../store/ui', () => ({ useUi: { getState: () => ({ toast }) } }));
vi.mock('../playlistApi', () => ({ playlistApi: {} }));
const { optimisticEdit } = await import('./usePlaylistEdit');

const tr = (id: string): PlaylistTrack => ({ id, albumId: 'a', source: 'local', title: id, artists: [], disc: 1, number: 1, durationMs: 1000, album: { id: 'a', title: 'A' } });
const detail = (): RunePlaylistDetail => ({ id: 'pl:rune:1', name: 'Mix', source: 'local', kind: 'static', trackCount: 3, tracks: [tr('a'), tr('b'), tr('c')] });
const summary = (): RunePlaylistSummary => ({ id: 'pl:rune:1', name: 'Mix', source: 'local', kind: 'static', trackCount: 3 });
const ids = (qc: QueryClient) => qc.getQueryData<RunePlaylistDetail>(['playlist', 'pl:rune:1'])!.tracks.map((t) => t.id);

let qc: QueryClient;
beforeEach(() => {
  toast.mockClear();
  qc = new QueryClient();
  qc.setQueryData(['playlist', 'pl:rune:1'], detail());
  qc.setQueryData(['playlists'], [summary()]);
});

describe('optimisticEdit', () => {
  it('shows the change before the server answers, then takes the server’s version', async () => {
    let release!: (d: RunePlaylistDetail) => void;
    const pending = new Promise<RunePlaylistDetail>((r) => { release = r; });
    const done = optimisticEdit(qc, 'pl:rune:1', { type: 'remove', positions: [1] }, () => pending, 'x');
    await new Promise((r) => setTimeout(r, 5));
    expect(ids(qc)).toEqual(['a', 'c']);
    expect(qc.getQueryData<RunePlaylistSummary[]>(['playlists'])![0]!.trackCount).toBe(2);
    release({ ...detail(), tracks: [tr('a'), tr('c')], trackCount: 2, name: 'from server' });
    expect(await done).toBe(true);
    expect(qc.getQueryData<RunePlaylistDetail>(['playlist', 'pl:rune:1'])!.name).toBe('from server');
    expect(toast).not.toHaveBeenCalled();
  });

  it('rolls back and says so when the request fails', async () => {
    const ok = await optimisticEdit(qc, 'pl:rune:1', { type: 'move', from: 0, to: 2 }, () => Promise.reject(new Error('500')), 'Could not reorder');
    expect(ok).toBe(false);
    expect(ids(qc)).toEqual(['a', 'b', 'c']);
    expect(qc.getQueryData<RunePlaylistSummary[]>(['playlists'])![0]!.trackCount).toBe(3);
    expect(toast).toHaveBeenCalledWith('Could not reorder — changes undone');
  });

  it('a rename that fails goes back to the old name', async () => {
    await optimisticEdit(qc, 'pl:rune:1', { type: 'rename', name: 'Nope' }, () => Promise.reject(new Error('409')), 'Could not rename');
    expect(qc.getQueryData<RunePlaylistDetail>(['playlist', 'pl:rune:1'])!.name).toBe('Mix');
    expect(qc.getQueryData<RunePlaylistSummary[]>(['playlists'])![0]!.name).toBe('Mix');
  });

  it('runs edits to one playlist one after the other', async () => {
    const order: string[] = [];
    const slow = (label: string, ms: number) => () => new Promise<void>((r) => setTimeout(() => { order.push(label); r(); }, ms));
    await Promise.all([
      optimisticEdit(qc, 'pl:rune:1', { type: 'remove', positions: [0] }, slow('first', 20), 'x'),
      optimisticEdit(qc, 'pl:rune:1', { type: 'remove', positions: [0] }, slow('second', 1), 'x'),
    ]);
    expect(order).toEqual(['first', 'second']);
  });

  it('works when the playlist is not cached (add from a track menu)', async () => {
    const empty = new QueryClient();
    const ok = await optimisticEdit(empty, 'pl:rune:9', { type: 'add', tracks: [tr('z')] }, async () => undefined, 'x');
    expect(ok).toBe(true);
    expect(empty.getQueryData(['playlist', 'pl:rune:9'])).toBeUndefined();
  });
});
