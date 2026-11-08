import type { Backend, PlayModes } from './types';

/** A queue rune drives one song at a time (mixed queue, Web Playback SDK): Spotify must not repeat or reorder it. */
export const PLAIN_MODES: PlayModes = { shuffle: false, repeat: 'off' };

/**
 * Make the player behind `b` match rune's repeat and shuffle — "off" included. A Spotify device left with repeat
 * "context" from the Spotify app (or an earlier session) would loop the queue it was just sent, or the one song a
 * one-track queue holds. One request per mode, only when the player differs: Spotify's request budget is tight.
 */
export async function matchBackendModes(b: Backend, want: PlayModes): Promise<void> {
  const s = b.state;
  // Before its first answer a remote zone's state is only a placeholder: write rather than trust it.
  const known = b.ready !== false;
  if (!known || s.repeat !== want.repeat) {
    // Out of quota: one refused write is enough, do not spend a second one.
    try {
      await b.send({ type: 'repeat', mode: want.repeat });
    } catch {
      return;
    }
  }
  if (!known || s.shuffle !== want.shuffle) await b.send({ type: 'shuffle', on: want.shuffle }).catch(() => undefined);
}
