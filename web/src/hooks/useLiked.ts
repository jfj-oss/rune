// Liked Songs heart state: a cheap per-track query against the server's synced
// Liked Songs mirror, plus an optimistic toggle that rolls back on failure.
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { api } from '../api';
import { LIKED_PLAYLIST_ID } from '../lib/playlists';
import { useUi } from '../store/ui';

export const likedKey = (trackId: string) => ['liked', trackId] as const;

/**
 * Flip the cached heart before the server answers; restore it and toast when the
 * request fails. On success the Liked Songs page/list are invalidated, so the
 * playlist, its cover and its count follow the heart at once.
 */
export async function optimisticLiked(
  qc: QueryClient,
  trackId: string,
  on: boolean,
  request: () => Promise<unknown>,
  failure = 'Could not update Liked Songs',
): Promise<boolean> {
  await qc.cancelQueries({ queryKey: likedKey(trackId) });
  const prev = qc.getQueryData<boolean>(likedKey(trackId));
  qc.setQueryData(likedKey(trackId), on);
  try {
    await request();
  } catch (e) {
    qc.setQueryData(likedKey(trackId), prev ?? false);
    const server = (e as { serverMessage?: string }).serverMessage;
    useUi.getState().toast(`${server ?? failure} — changes undone`);
    return false;
  }
  void qc.invalidateQueries({ queryKey: likedKey(trackId) });
  void qc.invalidateQueries({ queryKey: ['playlist', LIKED_PLAYLIST_ID] });
  void qc.invalidateQueries({ queryKey: ['playlists'] });
  return true;
}

/** Heart state for one Spotify track (`sp:` id). Loads from the local mirror; no Spotify request. */
export function useLiked(trackId: string) {
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const q = useQuery({
    queryKey: likedKey(trackId),
    queryFn: () => api.trackLiked(trackId),
    staleTime: 30_000,
  });

  const toggle = useCallback(async () => {
    if (pending) return;
    const next = !(q.data === true);
    setPending(true);
    try {
      await optimisticLiked(qc, trackId, next, () => api.setTrackLiked(trackId, next));
    } finally {
      setPending(false);
    }
  }, [qc, trackId, q.data, pending]);

  return { liked: q.data === true, loading: q.isPending, pending, toggle };
}
