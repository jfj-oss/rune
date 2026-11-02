import { useEffect, useState } from 'react';
import { livePosition } from '../player/types';
import { usePlayer } from '../store/player';

/** Smoothly interpolated playback position in ms (re-renders ~4×/s while playing). */
export function usePosition(intervalMs = 250): number {
  const state = usePlayer((s) => s.state);
  const [, force] = useState(0);
  useEffect(() => {
    if (state.status !== 'playing') return;
    const t = setInterval(() => force((n) => n + 1), intervalMs);
    return () => clearInterval(t);
  }, [state.status, state.updatedAt, intervalMs]);
  return livePosition(state);
}
