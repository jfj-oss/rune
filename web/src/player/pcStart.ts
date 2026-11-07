// On-demand Spotify app for the "Linux PC speakers" zone.
//
// The desktop app is usually closed, so a Spotify track sent to the pc zone first
// needs that app running (it then appears as the Connect device "HORSE"). The server
// starts it; this waits (briefly) for the device to show up in GET /zones before the
// caller continues the switch exactly as if the app had been there all along.
import type { PlayItem, ZoneInfo } from '../lib/types';

/** How often to re-read /zones while waiting. Each read is one Spotify devices call
 *  (the server caches it for 5 s), so keep the total small. */
export const PC_SPOTIFY_POLL_MS = 2_000;
/** 15 × 2 s = 30 s, the most reads the server ever sees for one start. */
export const PC_SPOTIFY_MAX_READS = 15;
export const PC_SPOTIFY_STARTING = 'Starting Spotify on the PC…';
export const PC_SPOTIFY_FAILED = "Spotify didn't start on the PC — is it signed in? The music stays where it is.";

export const itemsHaveSpotify = (items: PlayItem[]): boolean => items.some((i) => i.track.source === 'spotify');

/** Would playing these items on this zone need the app the PC does not have yet? */
export function needsPcSpotify(zone: ZoneInfo | undefined, items: PlayItem[]): boolean {
  // A server-owned pc queue starts the app itself when it reaches a Spotify song.
  return !!zone && zone.kind === 'pc' && !zone.serverQueue && !zone.spotifyDeviceId && itemsHaveSpotify(items);
}

export interface PcStartDeps {
  /** POST /api/pc/spotify/start (launches the app on the PC; debounced server-side). */
  start(): Promise<unknown>;
  /** Re-read GET /api/zones (and usually refresh the store from it). */
  readZones(): Promise<ZoneInfo[]>;
  toast(message: string): void;
  /** Injected in tests; fake timers also cover the default. */
  sleep?(ms: number): Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask the server to start Spotify, then poll zones until the pc zone has a Connect
 * device. Returns that zone (now indistinguishable from one that was already there),
 * or null if it never appeared — in which case nothing has been paused or moved.
 */
export async function startPcSpotifyAndWait(deps: PcStartDeps): Promise<ZoneInfo | null> {
  deps.toast(PC_SPOTIFY_STARTING);
  try {
    await deps.start();
  } catch {
    // The timeout message below explains the failure; keep waiting in case a
    // previous request already launched the app.
  }
  const sleep = deps.sleep ?? defaultSleep;
  for (let read = 0; read < PC_SPOTIFY_MAX_READS; read++) {
    await sleep(PC_SPOTIFY_POLL_MS);
    try {
      const pc = (await deps.readZones()).find((z) => z.kind === 'pc');
      if (pc?.spotifyDeviceId) return pc;
    } catch {
      // server restarting / offline: keep trying until the deadline
    }
  }
  deps.toast(PC_SPOTIFY_FAILED);
  return null;
}
