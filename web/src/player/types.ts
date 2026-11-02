import type { PlayerState } from '@liner/shared';
import type { ExtCommand, PlayItem } from '../lib/types';

export interface Backend {
  readonly zone: string;
  readonly state: PlayerState;
  /** Called with the new state whenever it changes (not on every position tick). */
  subscribe(fn: (s: PlayerState) => void): () => void;
  send(cmd: ExtCommand, items?: PlayItem[]): Promise<void>;
  /** Pull fresh state (remote zones). */
  refresh(): Promise<void>;
  dispose(): void;
}

export function emptyState(zone: string): PlayerState {
  return { zone, status: 'stopped', queue: [], index: -1, positionMs: 0, volume: 70, shuffle: false, repeat: 'off', updatedAt: Date.now() };
}

/** Position right now, interpolated from the last snapshot while playing. */
export function livePosition(s: PlayerState, now = Date.now()): number {
  const cur = s.queue[s.index];
  const base = s.positionMs + (s.status === 'playing' ? now - s.updatedAt : 0);
  const max = cur?.track.durationMs ?? base;
  return Math.max(0, Math.min(base, max));
}
