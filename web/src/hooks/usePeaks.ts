import { useEffect, useState } from 'react';
import { listenApi } from '../listenApi';
import type { PeaksResult } from '../lib/listenTypes';
import { isLiveTrack } from '../lib/listenTypes';
import { generatedPeaks } from '../lib/waveform';

export type PeaksStatus = 'none' | 'loading' | 'ready';

interface PeaksState {
  key: string;
  status: PeaksStatus;
  data: PeaksResult | null;
}

const NONE: PeaksState = { key: '', status: 'none', data: null };

/**
 * Peaks for the current track, cached for the session by listenApi. Local files
 * give their real waveform; a Spotify song gives the real waveform of its local
 * twin when the library has one, else a generated stand-in (`generated: true`).
 * Live radio has none.
 */
export function usePeaks(
  track: { id: string; source?: string; durationMs?: number } | undefined,
  buckets: number,
): { status: PeaksStatus; data: PeaksResult | null; generated: boolean } {
  const unavailable = !track || isLiveTrack(track);
  const id = track && !unavailable ? track.id : '';
  const spotify = track?.source === 'spotify';
  const durationMs = track?.durationMs ?? 0;
  const key = id ? `${id}|${buckets}` : '';
  const [state, setState] = useState<PeaksState & { generated: boolean }>({ ...NONE, generated: false });

  useEffect(() => {
    if (!key) {
      setState({ ...NONE, generated: false });
      return;
    }
    let alive = true;
    // a generated stand-in shows at once for Spotify; a local twin replaces it
    const stand = spotify && durationMs > 0 ? { buckets, data: generatedPeaks(id, buckets, durationMs) } : null;
    setState((prev) =>
      prev.key === key ? prev : stand
        ? { key, status: 'ready', data: stand, generated: true }
        : { key, status: 'loading', data: null, generated: false });
    void listenApi.peaks(id, buckets).then((data) => {
      if (!alive) return;
      if (data) setState({ key, status: 'ready', data, generated: false });
      else if (stand) setState({ key, status: 'ready', data: stand, generated: true });
      else setState({ key, status: 'none', data: null, generated: false });
    });
    return () => { alive = false; };
  }, [key, id, buckets, spotify, durationMs]);

  if (!key) return { status: 'none', data: null, generated: false };
  if (state.key !== key) return { status: 'loading', data: null, generated: false };
  return { status: state.status, data: state.data, generated: state.generated };
}
