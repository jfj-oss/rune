// Spotify on the "Linux PC speakers" zone.
//
// The server queue starts whatever plays a Spotify song when it reaches one: Spotify Soloist when it is running and signed
// in (nothing to start, nothing to poll), or the Spotify desktop app, which rune launches by itself. The page only names
// which of the two stands in, so it can say why.
import type { PlayItem, ZoneInfo } from '../lib/types';

export const itemsHaveSpotify = (items: PlayItem[]): boolean => items.some((i) => i.track.source === 'spotify');

/** The one line to show when Spotify songs head for the pc zone and the app stands in for Soloist. */
export function pcSpotifyFallbackNotice(zone: ZoneInfo | undefined, items: PlayItem[]): string | null {
  if (!zone || zone.kind !== 'pc' || !itemsHaveSpotify(items)) return null;
  return zone.spotifyNotice ?? null;
}
