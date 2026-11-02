import { useEffect, useState } from 'react';
import { listenApi } from '../listenApi';
import type { PeaksResult } from '../lib/listenTypes';
import { isLiveTrack } from '../lib/listenTypes';

export type PeaksStatus = 'none' | 'loading' | 'ready';

interface PeaksState {
  key: string;
  status: PeaksStatus;
  data: PeaksResult | null;
}

const NONE: PeaksState = { key: '', status: 'none', data: null };

/**
 * Peaks for a local track, cached for the session by listenApi. Spotify tracks and
 * live radio have no peaks (the server 404s), so they immediately report `none`.
 */
export function usePeaks(track: { id: string; source?: string } | undefined, buckets: number): { status: PeaksStatus; data: PeaksResult | null } {
  const unavailable = !track || track.source === 'spotify' || isLiveTrack(track);
  const id = track && !unavailable ? track.id : '';
  const key = id ? `${id}|${buckets}` : '';
  const [state, setState] = useState<PeaksState>(NONE);

  useEffect(() => {
    if (!key) {
      setState(NONE);
      return;
    }
    let alive = true;
    setState((prev) => (prev.key === key ? prev : { key, status: 'loading', data: null }));
    void listenApi.peaks(id, buckets).then((data) => {
      if (!alive) return;
      setState({ key, status: data ? 'ready' : 'none', data });
    });
    return () => { alive = false; };
  }, [key, id, buckets]);

  if (!key) return { status: 'none', data: null };
  if (state.key !== key) return { status: 'loading', data: null };
  return { status: state.status, data: state.data };
}
