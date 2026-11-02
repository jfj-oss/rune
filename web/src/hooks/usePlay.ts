import type { Album } from '@liner/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from '../api';
import type { PlayItem } from '../lib/types';
import { usePlayer } from '../store/player';
import { useUi } from '../store/ui';

export const albumItems = (a: Album): PlayItem[] =>
  [...a.tracks]
    .sort((x, y) => x.disc - y.disc || x.number - y.number)
    .map((track) => ({ track, album: { id: a.id, title: a.title, coverUrl: a.coverUrl } }));

/** Play / queue helpers that resolve albums through the query cache. */
export function usePlay() {
  const qc = useQueryClient();
  const getAlbum = useCallback(
    (id: string) => qc.fetchQuery({ queryKey: ['album', id], queryFn: () => api.album(id), staleTime: 60_000 }),
    [qc],
  );
  const playAlbum = useCallback(
    async (id: string, opts?: { shuffle?: boolean; startIndex?: number }) => {
      try {
        const a = await getAlbum(id);
        await usePlayer.getState().playItems(albumItems(a), opts?.startIndex ?? 0, { shuffle: opts?.shuffle });
      } catch { useUi.getState().toast('Could not load that album'); }
    },
    [getAlbum],
  );
  const playAlbums = useCallback(
    async (ids: string[], opts?: { shuffle?: boolean }) => {
      try {
        const albums = await Promise.all(ids.slice(0, 12).map(getAlbum));
        await usePlayer.getState().playItems(albums.flatMap(albumItems), 0, { shuffle: opts?.shuffle });
      } catch { useUi.getState().toast('Could not load those albums'); }
    },
    [getAlbum],
  );
  const enqueueAlbum = useCallback(
    async (id: string, next?: boolean) => {
      try { await usePlayer.getState().enqueueItems(albumItems(await getAlbum(id)), next); }
      catch { useUi.getState().toast('Could not load that album'); }
    },
    [getAlbum],
  );
  return { playAlbum, playAlbums, enqueueAlbum, getAlbum };
}
