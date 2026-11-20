import type { MiniPlaylist } from '@liner/shared';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { api, type ApiError } from '../api';
import { MINI_MAX, withMini } from '../lib/miniPlaylists';
import { useUi } from '../store/ui';

export const MINI_KEY = ['mini-playlists'] as const;

/** The playlists chosen for the rune mini, in order. */
export function useMiniPlaylists() {
  return useQuery({ queryKey: MINI_KEY, queryFn: () => api.miniPlaylists() });
}

/** Show a change at once, send it, then take the server's list; on a failure put the old list back and say so. */
export async function applyMini(qc: QueryClient, next: MiniPlaylist[] | null, send: () => Promise<MiniPlaylist[]>, failed: string): Promise<boolean> {
  const before = qc.getQueryData<MiniPlaylist[]>(MINI_KEY);
  if (next) qc.setQueryData(MINI_KEY, next);
  try {
    qc.setQueryData(MINI_KEY, await send());
    return true;
  } catch (e) {
    qc.setQueryData(MINI_KEY, before);
    useUi.getState().toast((e as ApiError).serverMessage ?? failed);
    return false;
  }
}

/** Put a playlist on the rune mini or take it off. */
export async function setOnMini(qc: QueryClient, id: string, name: string, on: boolean): Promise<boolean> {
  const cur = qc.getQueryData<MiniPlaylist[]>(MINI_KEY) ?? [];
  if (on && !cur.some((p) => p.id === id) && cur.length >= MINI_MAX) {
    useUi.getState().toast(`The rune mini has room for ${MINI_MAX} playlists — remove one in Settings first`);
    return false;
  }
  const ok = await applyMini(qc, withMini(cur, id, name, on), () => api.setMiniPlaylist(id, on), on ? 'Could not add it to the rune mini' : 'Could not remove it from the rune mini');
  if (ok) useUi.getState().toast(on ? 'Shown in rune mini' : 'Removed from rune mini');
  return ok;
}

/** "Show in rune mini" for one playlist: whether it is on, and a toggle. */
export function useMiniToggle(id: string, name: string) {
  const qc = useQueryClient();
  const list = useMiniPlaylists().data;
  const [busy, setBusy] = useState(false);
  const mine = list?.find((p) => p.id === id);
  const on = !!mine;
  const toggle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try { await setOnMini(qc, id, name, !on); } finally { setBusy(false); }
  }, [busy, id, name, on, qc]);
  return { on, color: mine?.color, toggle, busy };
}
