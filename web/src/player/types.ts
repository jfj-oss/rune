import type { PlayerState } from '@liner/shared';
import type { ExtCommand, PlayItem } from '../lib/types';

/** Rune's repeat/shuffle setting for the queue it is starting. */
export interface PlayModes {
  shuffle: boolean;
  repeat: PlayerState['repeat'];
}

export interface Backend {
  readonly zone: string;
  readonly state: PlayerState;
  /** Called with the new state whenever it changes (not on every position tick). */
  subscribe(fn: (s: PlayerState) => void): () => void;
  send(cmd: ExtCommand, items?: PlayItem[]): Promise<void>;
  /** Make the player behind this backend match rune's repeat/shuffle, "off" included, writing only what differs. */
  matchModes?(want: PlayModes): Promise<void>;
  /** Pull fresh state (remote zones). */
  refresh(): Promise<void>;
  /** False until a remote zone answered: `state` is only a placeholder before that. */
  readonly ready?: boolean;
  /** The level the user chose, when `state.volume` may be a voice-assistant duck passing by. */
  userVolume?(): number;
  dispose(): void;
}

export function emptyState(zone: string): PlayerState {
  return { zone, status: 'stopped', queue: [], index: -1, positionMs: 0, volume: 100, shuffle: false, repeat: 'off', updatedAt: Date.now() };
}

/** Position right now, interpolated from the last snapshot while playing. */
export function livePosition(s: PlayerState, now = Date.now()): number {
  const cur = s.queue[s.index];
  const base = s.positionMs + (s.status === 'playing' ? now - s.updatedAt : 0);
  // duration 0 means a live stream: let its elapsed time grow instead of clamping to 0
  const max = cur?.track.durationMs ? cur.track.durationMs : base;
  return Math.max(0, Math.min(base, max));
}
