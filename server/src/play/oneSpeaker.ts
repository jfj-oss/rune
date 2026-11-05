// The PC speakers have two players: mpv (rune's "pc" zone) and the Spotify app. Rune shows them as one zone, so they
// must never sound together: a tab, the voice assistant or Spotify's own autoplay can each start one while the other
// plays, and then the page only controls one of them. Whichever starts playing last wins; the other is paused.
import type { PlayerState } from '@liner/shared';

export interface SpeakerZone {
  state(): PlayerState;
  command(cmd: { type: 'pause' }): Promise<unknown>;
}

export type SpeakerSide = 'pc' | 'spotify';

export function createSpeakerGuard(zones: { pc(): SpeakerZone | undefined; spotify(): SpeakerZone | undefined }, onError: (err: unknown) => void = () => {}) {
  const last: Partial<Record<SpeakerSide, PlayerState['status']>> = {};
  return {
    /** Call with every state change of either player. */
    changed(side: SpeakerSide, state: PlayerState): void {
      const started = state.status === 'playing' && last[side] !== 'playing';
      last[side] = state.status;
      if (!started) return;
      const other = side === 'pc' ? zones.spotify() : zones.pc();
      if (other?.state().status === 'playing') void other.command({ type: 'pause' }).catch(onError);
    },
  };
}
