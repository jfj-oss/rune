import type { PlaylistTrack } from '@liner/shared';
import { describe, expect, it } from 'vitest';
import { canAddTo, hasOverlay, isOverlayRow, rowEditable, splitForTarget, applyEdit, applyEditToSummary, coverAlbums, isEditable, isMixed, isRunePlaylist, moved, orderByRecent, selectRow, type RunePlaylistDetail } from './playlists';

const tr = (id: string, album = 'a1', source: 'local' | 'spotify' = 'local'): PlaylistTrack => ({
  id, albumId: album, source, title: id, artists: [], disc: 1, number: 1, durationMs: 1000, album: { id: album, title: album },
});
const base = (tracks: PlaylistTrack[]): RunePlaylistDetail => ({ id: 'pl:rune:1', name: 'Mix', source: 'local', kind: 'static', trackCount: tracks.length, tracks });
const ids = (d: RunePlaylistDetail) => d.tracks.map((t) => t.id);

describe('applyEdit', () => {
  const d = base([tr('a', 'x'), tr('b', 'y'), tr('c', 'x'), tr('d', 'z')]);
  it('renames and describes (empty description clears it)', () => {
    expect(applyEdit(d, { type: 'rename', name: 'New' }).name).toBe('New');
    expect(applyEdit({ ...d, description: 'x' }, { type: 'describe', description: '' }).description).toBeUndefined();
    expect(applyEdit(d, { type: 'describe', description: 'hi' }).description).toBe('hi');
  });
  it('removes by position and keeps count + mosaic in step', () => {
    const r = applyEdit(d, { type: 'remove', positions: [0, 3, 3, 99] });
    expect(ids(r)).toEqual(['b', 'c']);
    expect(r.trackCount).toBe(2);
    expect(r.coverAlbumIds).toEqual(['y', 'x']);
  });
  it('moves a row like the server does (remove, then insert at the target)', () => {
    expect(ids(applyEdit(d, { type: 'move', from: 0, to: 2 }))).toEqual(['b', 'c', 'a', 'd']);
    expect(ids(applyEdit(d, { type: 'move', from: 3, to: 0 }))).toEqual(['d', 'a', 'b', 'c']);
    expect(applyEdit(d, { type: 'move', from: 1, to: 1 })).toBe(d);
    expect(applyEdit(d, { type: 'move', from: 1, to: 9 })).toBe(d);
  });
  it('adds at the end or at a position, mixing sources', () => {
    const sp = tr('sp:1', 'sa', 'spotify');
    expect(ids(applyEdit(d, { type: 'add', tracks: [sp] }))).toEqual(['a', 'b', 'c', 'd', 'sp:1']);
    expect(ids(applyEdit(d, { type: 'add', tracks: [sp], position: 1 }))).toEqual(['a', 'sp:1', 'b', 'c', 'd']);
    expect(ids(applyEdit(d, { type: 'add', tracks: [sp], position: 99 })).at(-1)).toBe('sp:1');
    expect(applyEdit(d, { type: 'add', tracks: [sp] }).trackCount).toBe(5);
  });
  it('never mutates its input (so a rollback snapshot stays valid)', () => {
    const before = JSON.stringify(d);
    applyEdit(d, { type: 'remove', positions: [1] });
    applyEdit(d, { type: 'move', from: 0, to: 3 });
    applyEdit(d, { type: 'add', tracks: [tr('z')] });
    expect(JSON.stringify(d)).toBe(before);
  });
  it('round trip: an edit followed by restoring the snapshot is the original', () => {
    const snap = d;
    const optimistic = applyEdit(d, { type: 'remove', positions: [0, 1] });
    expect(optimistic).not.toBe(snap);
    expect(ids(snap)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('applyEditToSummary', () => {
  const s = { id: 'pl:rune:1', name: 'Mix', source: 'local' as const, trackCount: 4 };
  it('tracks name and count', () => {
    expect(applyEditToSummary(s, { type: 'rename', name: 'X' }).name).toBe('X');
    expect(applyEditToSummary(s, { type: 'remove', positions: [0, 0, 2] }).trackCount).toBe(2);
    expect(applyEditToSummary(s, { type: 'add', tracks: [tr('q'), tr('r')] }).trackCount).toBe(6);
    expect(applyEditToSummary(s, { type: 'move', from: 0, to: 1 })).toBe(s);
  });
});

describe('helpers', () => {
  it('knows which playlists are editable', () => {
    expect(isRunePlaylist('pl:rune:abc')).toBe(true);
    expect(isRunePlaylist('pl:sp:abc')).toBe(false);
    expect(isEditable({ id: 'pl:rune:abc', kind: 'static' })).toBe(true);
    expect(isEditable({ id: 'pl:rune:abc', kind: 'smart' })).toBe(false);
    expect(isEditable({ id: 'pl:sp:liked' })).toBe(false);
  });
  it('moved / coverAlbums / isMixed', () => {
    expect(moved([1, 2, 3, 4], 3, 1)).toEqual([1, 4, 2, 3]);
    expect(coverAlbums([tr('a', '1'), tr('b', '1'), tr('c', '2'), tr('d', '3'), tr('e', '4'), tr('f', '5')])).toEqual(['1', '2', '3', '4']);
    expect(isMixed([tr('a'), tr('b', 'x', 'spotify')])).toBe(true);
    expect(isMixed([tr('a'), tr('b')])).toBe(false);
  });
  it('orders by recency, then list order', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    expect(orderByRecent(list, ['c', 'a']).map((p) => p.id)).toEqual(['c', 'a', 'b', 'd']);
  });
  it('selects like a file manager', () => {
    let r = selectRow(new Set(), null, 2, {});
    expect([...r.sel]).toEqual([2]);
    r = selectRow(r.sel, r.anchor, 5, { shift: true });
    expect([...r.sel].sort()).toEqual([2, 3, 4, 5].map(String).sort().map(Number));
    r = selectRow(r.sel, r.anchor, 3, { toggle: true });
    expect(r.sel.has(3)).toBe(false);
    expect(r.sel.has(4)).toBe(true);
    r = selectRow(r.sel, r.anchor, 0, {});
    expect([...r.sel]).toEqual([0]);
  });
});

describe('Spotify playlists with rune’s local overlay', () => {
  const sp = { id: 'pl:sp:abc' };
  it('accepts local files but locks Spotify rows', () => {
    expect(hasOverlay(sp)).toBe(true);
    expect(hasOverlay({ id: 'pl:sp:liked' })).toBe(false);
    expect(hasOverlay({ id: 'pl:rune:1' })).toBe(false);
    expect(canAddTo(sp)).toBe(true);
    expect(canAddTo({ id: 'pl:rune:1', kind: 'smart' })).toBe(false);
    expect(rowEditable(sp, { source: 'local', entrySource: 'rune-overlay' })).toBe(true);
    expect(rowEditable(sp, { source: 'spotify', entrySource: 'spotify-playlist' })).toBe(false);
    expect(rowEditable(sp, { source: 'local' })).toBe(true); // server without entrySource: local rows can only be overlay
    expect(rowEditable({ id: 'pl:rune:1' }, { source: 'spotify' })).toBe(true);
    expect(isOverlayRow('pl:rune:1', { source: 'local' })).toBe(false);
  });
  it('refuses Spotify songs for Spotify playlists, keeps everything for rune ones', () => {
    const item = (id: string, source: 'local' | 'spotify') => ({ track: tr(id, 'a', source), album: { id: 'a', title: 'A' } });
    const items = [item('l:1', 'local'), item('sp:1', 'spotify'), item('l:2', 'local')];
    const r = splitForTarget('pl:sp:abc', items);
    expect(r.add.map((i) => i.track.id)).toEqual(['l:1', 'l:2']);
    expect(r.refused).toBe(1);
    expect(splitForTarget('pl:rune:1', items)).toEqual({ add: items, refused: 0 });
    expect(splitForTarget('pl:sp:abc', [items[1]!]).add).toEqual([]);
  });
});
