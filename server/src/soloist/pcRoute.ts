// How a Spotify song plays on the "Linux PC speakers" zone: through Spotify Soloist when it can play (no app launch,
// no device polling, no Web API), otherwise through the Spotify desktop app as before. Pure: GET /zones and the
// server-owned queue both ask this, so the page and the server never disagree about the engine.
import type { Zone } from '@liner/shared';
import type { SoloistRun } from './supervisor.js';

export type PcSpotifyEngine = 'soloist' | 'app';

/** The part of Soloist's status the choice depends on. */
export interface SoloistAvailability {
  run: SoloistRun;
  connected: boolean;
  loggedIn: boolean;
}

export interface PcSpotifyRoute {
  /** null: Spotify songs cannot play on the PC at all (no Soloist, and no Spotify account for the app). */
  engine: PcSpotifyEngine | null;
  /** The zone that plays them: 'soloist', or the app's Connect zone (null while the app is not running yet). */
  zone: Zone | null;
  /** One line for the page when Soloist is configured but the app has to stand in. Never silent about an expiry. */
  notice: string | null;
}

export const soloistAvailable = (s: SoloistAvailability): boolean =>
  (s.run === 'running' || s.run === 'starting') && s.connected && s.loggedIn;

/** Why Spotify songs go to the app instead of Soloist, in one line; null when Soloist is fine. */
export function soloistFallbackNotice(s: SoloistAvailability): string | null {
  const using = 'using the Spotify app';
  switch (s.run) {
    case 'expired':
      return `Soloist needs updating (its build expired) — ${using}`;
    case 'no-binary':
      return `Soloist is not installed — ${using}`;
    case 'no-key':
      return `Soloist has no API key — ${using}`;
    case 'crashed':
      return `Soloist crashed and is restarting — ${using}`;
    case 'off':
      return `Soloist is switched off — ${using}`;
    default:
      break;
  }
  if (!s.connected) return `Soloist is not running yet — ${using}`;
  if (!s.loggedIn) return `Soloist is not signed in to Spotify (pair it once with soloist --pair) — ${using}`;
  return null;
}

/**
 * `soloist` undefined: Soloist is not part of this rune, and the app route is the only one (as before).
 * `app` is the Connect zone of the Spotify app on this PC when it is known (null: the app must be started first).
 */
export function pcSpotifyRoute(soloist: SoloistAvailability | undefined, app: Zone | null, spotifyConnected: boolean): PcSpotifyRoute {
  if (soloist && soloistAvailable(soloist)) return { engine: 'soloist', zone: 'soloist', notice: null };
  const notice = soloist ? soloistFallbackNotice(soloist) : null;
  if (!spotifyConnected) return { engine: null, zone: null, notice };
  return { engine: 'app', zone: app, notice };
}
