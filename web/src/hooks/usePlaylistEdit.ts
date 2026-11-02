import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { playlistApi } from '../playlistApi';
import {
  SPOTIFY_ADD_NOTE, applyEdit, applyEditToSummary, isRunePlaylist, noteRecent, splitForTarget, toPlaylistTrack,
  type PlaylistEdit, type RunePlaylistDetail, type RunePlaylistSummary, type SmartBody,
} from '../lib/playlists';
import type { PlayItem } from '../lib/types';
import { plural } from '../lib/format';
import { useUi } from '../store/ui';

const DETAIL = (id: string) => ['playlist', id] as const;
const LIST = ['playlists'] as const;

// One request at a time per playlist, so a failed edit can never be undone on top of a newer one.
const chains = new Map<string, Promise<unknown>>();
function serial<T>(id: string, job: () => Promise<T>): Promise<T> {
  const run = (chains.get(id) ?? Promise.resolve()).catch(() => undefined).then(job);
  chains.set(id, run);
  return run;
}

/**
 * Optimistic edit: apply `edit` to the cached detail + list now, send the request, then either take the
 * server's answer or roll the caches back and say so. Resolves true on success.
 */
export async function optimisticEdit(
  qc: QueryClient,
  id: string,
  edit: PlaylistEdit,
  request: () => Promise<RunePlaylistDetail | void>,
  failMessage: string,
): Promise<boolean> {
  await qc.cancelQueries({ queryKey: DETAIL(id) });
  const prevDetail = qc.getQueryData<RunePlaylistDetail>(DETAIL(id));
  const prevList = qc.getQueryData<RunePlaylistSummary[]>(LIST);
  if (prevDetail) qc.setQueryData(DETAIL(id), applyEdit(prevDetail, edit));
  if (prevList) qc.setQueryData(LIST, prevList.map((p) => (p.id === id ? applyEditToSummary(p, edit) : p)));
  try {
    const fresh = await serial(id, request);
    if (fresh && typeof fresh === 'object' && 'tracks' in fresh) qc.setQueryData(DETAIL(id), fresh);
    void qc.invalidateQueries({ queryKey: LIST });
    return true;
  } catch (err) {
    if (prevDetail) qc.setQueryData(DETAIL(id), prevDetail);
    if (prevList) qc.setQueryData(LIST, prevList);
    void qc.invalidateQueries({ queryKey: DETAIL(id) });
    void qc.invalidateQueries({ queryKey: LIST });
    // the server's reason ("reconnect Spotify", "not your playlist") is more useful than a generic line
    const why = (err as { serverMessage?: string } | null)?.serverMessage;
    useUi.getState().toast(why && (err as { status?: number }).status !== 500 ? `${failMessage}: ${why}` : `${failMessage} — changes undone`);
    return false;
  }
}

/** Everything the playlist screens can do to rune playlists. Each action toasts its own outcome. */
export function usePlaylistActions() {
  const qc = useQueryClient();
  const toast = useUi.getState().toast;

  const addItems = useCallback(async (playlistId: string, playlistName: string, all: PlayItem[]): Promise<boolean> => {
    if (!all.length) return false;
    // Spotify playlists: Spotify songs go to the playlist on Spotify; local files stay in rune's overlay
    const { add: items, refused } = splitForTarget(playlistId, all);
    if (!items.length) { toast(SPOTIFY_ADD_NOTE); return false; }
    const overlay = !isRunePlaylist(playlistId);
    const tracks = items.map((i) => ({ ...toPlaylistTrack(i), ...(overlay && i.track.source !== 'spotify' ? { entrySource: 'rune-overlay' as const } : {}), addedAt: Date.now() }));
    const ok = await optimisticEdit(qc, playlistId, { type: 'add', tracks }, () => playlistApi.addTracks(playlistId, items.map((i) => i.track.id), tracks), `Could not add to “${playlistName}”`);
    if (ok) {
      noteRecent(playlistId);
      toast(refused ? `Added ${plural(items.length, 'track')} to “${playlistName}” — ${SPOTIFY_ADD_NOTE.replace(/^S/, 's')}` : `Added ${plural(items.length, 'track')} to “${playlistName}”`);
    }
    return ok;
  }, [qc, toast]);

  const create = useCallback(async (name: string, opts?: { description?: string; items?: PlayItem[] }): Promise<RunePlaylistDetail | null> => {
    try {
      let d = await playlistApi.create(name, opts?.description);
      void qc.invalidateQueries({ queryKey: LIST });
      qc.setQueryData(DETAIL(d.id), d);
      noteRecent(d.id);
      if (opts?.items?.length) {
        const tracks = opts.items.map(toPlaylistTrack);
        try {
          d = await playlistApi.addTracks(d.id, opts.items.map((i) => i.track.id), tracks);
          qc.setQueryData(DETAIL(d.id), d);
          toast(`Created “${d.name}” with ${plural(opts.items.length, 'track')}`);
        } catch { toast(`Created “${d.name}”, but could not add the tracks`); }
        void qc.invalidateQueries({ queryKey: LIST });
      } else toast(`Created “${d.name}”`);
      return d;
    } catch {
      toast('Could not create the playlist — is the rune server reachable?');
      return null;
    }
  }, [qc, toast]);

  const createSmart = useCallback(async (body: SmartBody): Promise<RunePlaylistDetail | null> => {
    try {
      const d = await playlistApi.createSmart(body);
      qc.setQueryData(DETAIL(d.id), d);
      void qc.invalidateQueries({ queryKey: LIST });
      toast(`Created smart playlist “${d.name}” — ${plural(d.trackCount, 'track')}`);
      return d;
    } catch (e) {
      toast(e instanceof Error && e.message ? `Could not create the smart playlist — ${e.message.replace(/^\d{3} [^—]*— /, '')}` : 'Could not create the smart playlist');
      return null;
    }
  }, [qc, toast]);

  const rename = useCallback((id: string, name: string) => optimisticEdit(qc, id, { type: 'rename', name }, () => playlistApi.update(id, { name }), 'Could not rename the playlist'), [qc]);
  const describe = useCallback((id: string, description: string) => optimisticEdit(qc, id, { type: 'describe', description }, () => playlistApi.update(id, { description }), 'Could not save the description'), [qc]);
  const removeAt = useCallback(async (id: string, positions: number[]) => {
    // in a Spotify playlist only rune's own rows can go; name them by entry id when the server gave us ids
    const entryIds = isRunePlaylist(id) ? undefined : positions.map((p) => qc.getQueryData<RunePlaylistDetail>(DETAIL(id))?.tracks[p]?.entryId);
    const ids = entryIds && entryIds.every((x): x is string => !!x) ? entryIds : undefined;
    const ok = await optimisticEdit(qc, id, { type: 'remove', positions }, () => playlistApi.removeTracks(id, positions, ids), 'Could not remove the tracks');
    if (ok) toast(`Removed ${plural(positions.length, 'track')}`);
    return ok;
  }, [qc, toast]);
  const move = useCallback((id: string, from: number, to: number) => optimisticEdit(qc, id, { type: 'move', from, to }, () => playlistApi.move(id, from, to), 'Could not reorder the playlist'), [qc]);

  const remove = useCallback(async (id: string, name: string): Promise<boolean> => {
    const prevList = qc.getQueryData<RunePlaylistSummary[]>(LIST);
    if (prevList) qc.setQueryData(LIST, prevList.filter((p) => p.id !== id));
    try {
      await serial(id, () => playlistApi.remove(id));
      qc.removeQueries({ queryKey: DETAIL(id) });
      void qc.invalidateQueries({ queryKey: LIST });
      toast(`Deleted “${name}”`);
      return true;
    } catch {
      if (prevList) qc.setQueryData(LIST, prevList);
      void qc.invalidateQueries({ queryKey: LIST });
      toast('Could not delete the playlist — nothing was changed');
      return false;
    }
  }, [qc, toast]);

  const duplicate = useCallback(async (id: string): Promise<RunePlaylistDetail | null> => {
    try {
      const d = await playlistApi.duplicate(id);
      qc.setQueryData(DETAIL(d.id), d);
      void qc.invalidateQueries({ queryKey: LIST });
      noteRecent(d.id);
      toast(`Created “${d.name}”`);
      return d;
    } catch {
      toast('Could not duplicate the playlist');
      return null;
    }
  }, [qc, toast]);

  const exportM3u8 = useCallback(async (id: string, name: string) => {
    try { await playlistApi.exportM3u8(id, name); toast(`Exported “${name}” as .m3u8`); }
    catch { toast('Could not export the playlist'); }
  }, [toast]);

  return { addItems, create, createSmart, rename, describe, removeAt, move, remove, duplicate, exportM3u8 };
}
