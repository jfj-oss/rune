import { useEffect, useState } from 'react';
import { usePlayer } from '../store/player';

/** Smoothly interpolated playback position in ms (re-renders ~4×/s while playing). */
export function usePosition(intervalMs = 250): number {
  // Only the fields livePosition() reads: unrelated state changes never re-render position consumers.
  const status = usePlayer((s) => s.state.status);
  const updatedAt = usePlayer((s) => s.state.updatedAt);
  const positionMs = usePlayer((s) => s.state.positionMs);
  const durationMs = usePlayer((s) => s.state.queue[s.state.index]?.track.durationMs ?? 0);
  const [, force] = useState(0);
  useEffect(() => {
    if (status !== 'playing') return;
    const t = setInterval(() => force((n) => n + 1), intervalMs);
    return () => clearInterval(t);
  }, [status, updatedAt, intervalMs]);
  // Same maths as livePosition(): interpolate while playing, clamp to the track, let a live stream (duration 0) grow.
  const base = positionMs + (status === 'playing' ? Date.now() - updatedAt : 0);
  return Math.max(0, Math.min(base, durationMs || base));
}
