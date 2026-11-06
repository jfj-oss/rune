// The PC speakers have two players: mpv (rune's "pc" zone) and the Spotify app. Rune shows them as one zone, so they
// must never sound together: a tab, the voice assistant or Spotify's own autoplay can each start one while the other
// plays, and then the page only controls one of them. Whichever started playing last wins; the other is paused.
import type { PlayerState } from '@liner/shared';

export interface SpeakerZone {
  state(): PlayerState;
  command(cmd: { type: 'pause' }): Promise<unknown>;
  /** When the current playing began. Only a player seen by polling needs this: it can show a start long after. */
  startedAt?(): number;
  /** Look at the player now instead of at its next poll. */
  wake?(): void;
}

export type SpeakerSide = 'pc' | 'spotify';

export interface SpeakerGuardOptions {
  onError?: (err: unknown) => void;
  /** May mpv starting spend a Spotify read? Default yes. */
  canWake?: () => boolean;
  now?: () => number;
}

export function createSpeakerGuard(zones: { pc(): SpeakerZone | undefined; spotify(): SpeakerZone | undefined }, opts: SpeakerGuardOptions = {}) {
  const now = opts.now ?? Date.now;
  const last: Partial<Record<SpeakerSide, PlayerState['status']>> = {};
  let pcStartedAt = Number.NEGATIVE_INFINITY;
  const pause = (zone: SpeakerZone) => void zone.command({ type: 'pause' }).catch(opts.onError ?? (() => {}));
  return {
    /** Call with every state change of either player. */
    changed(side: SpeakerSide, state: PlayerState): void {
      const started = state.status === 'playing' && last[side] !== 'playing';
      last[side] = state.status;
      if (!started) return;
      const pc = zones.pc();
      const spotify = zones.spotify();
      if (side === 'pc') {
        pcStartedAt = now();
        if (spotify?.state().status === 'playing') pause(spotify);
        // Spotify may have started since its last poll: look now, so whichever is older is the one paused.
        else if (opts.canWake?.() ?? true) spotify?.wake?.();
        return;
      }
      if (pc?.state().status !== 'playing') return;
      // Seen now, but it may have begun before mpv did: then mpv is the newer one and stays.
      const spotifyAt = spotify?.startedAt?.() ?? now();
      pause(spotify && spotifyAt < pcStartedAt ? spotify : pc);
    },
  };
}
