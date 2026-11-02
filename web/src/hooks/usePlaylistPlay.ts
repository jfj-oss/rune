import type { PlaylistDetail, PlaylistTrack } from '@liner/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from '../api';
import type { PlayItem } from '../lib/types';
import { orderPlaylist } from '../lib/playlists';
import { usePlayer } from '../store/player';
import { usePlaylistUi } from '../store/playlistUi';
import { useUi } from '../store/ui';

export const LIKED_ID = 'pl:sp:liked';
export const isLiked = (id: string) => id === LIKED_ID;

export const playlistItem = (t: PlaylistTrack): PlayItem => {
  const { album, ...track } = t;
  return { track, album: { id: album.id, title: album.title, coverUrl: album.coverUrl } };
};
export const playlistItems = (d: PlaylistDetail): PlayItem[] => d.tracks.map(playlistItem);

/** The spotify: URI that opens this playlist in the Spotify app. */
export function playlistUri(id: string): string {
  return isLiked(id) ? 'spotify:collection:tracks' : `spotify:playlist:${id.replace(/^pl:sp:/, '')}`;
}

/** Play / queue a playlist by id (fetching it through the query cache). */
export function usePlaylistPlay() {
  const qc = useQueryClient();
  const get = useCallback((id: string) => qc.fetchQuery({ queryKey: ['playlist', id], queryFn: () => api.playlist(id), staleTime: 60_000 }), [qc]);
  const play = useCallback(
    async (id: string, opts?: { shuffle?: boolean; startIndex?: number }) => {
      try {
        const d = orderPlaylist(await get(id), usePlaylistUi.getState().order).view;
        await usePlayer.getState().playItems(playlistItems(d), opts?.startIndex ?? 0, { shuffle: opts?.shuffle, context: playlistUri(id) });
      } catch { useUi.getState().toast('Could not load that playlist'); }
    },
    [get],
  );
  const enqueue = useCallback(
    async (id: string) => {
      try { await usePlayer.getState().enqueueItems(playlistItems(orderPlaylist(await get(id), usePlaylistUi.getState().order).view)); }
      catch { useUi.getState().toast('Could not load that playlist'); }
    },
    [get],
  );
  return { play, enqueue, get };
}
