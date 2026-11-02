// Shared types + tiny pure helpers for the Discover feed and song radio.
// Mirrors server/src/discover/types.ts (the same JSON shapes cross the wire).
import type { Track } from '@liner/shared';
import type { PlayItem } from './types';

export interface DiscoverAlbum {
  id: string;
  title: string;
  coverUrl?: string;
}

export interface DiscoverItem {
  track: Track;
  album: DiscoverAlbum;
  /** "Similar to “Creep”" / "Nirvana is similar to Radiohead" */
  reason: string;
  spotifyTrackId: string;
  recordingMbid?: string;
}

export interface DiscoverSeed {
  trackId: string;
  title: string;
  artist: string;
  artistId?: string;
  recordingMbid?: string;
  artistMbid?: string;
}

export interface FeedGroup {
  title: string;
  seed?: { id: string; name: string };
  items: DiscoverItem[];
}

export type DiscoverStatus = 'ok' | 'empty' | 'unavailable' | 'rate_limited';

export interface SimilarResponse {
  status: DiscoverStatus;
  seed: DiscoverSeed | null;
  items: DiscoverItem[];
  cached: boolean;
  generatedAt: number;
  blockedUntil?: number;
  message?: string;
}

export interface FeedResponse {
  status: DiscoverStatus;
  groups: FeedGroup[];
  cached: boolean;
  generatedAt: number;
  blockedUntil?: number;
  message?: string;
  /** Stale cached results with a note about why they could not refresh. */
  notice?: string;
}

/** Drop the endpoint-only fields so the player can queue it. */
export function discoverPlayItem(item: DiscoverItem): PlayItem {
  return { track: item.track, album: item.album };
}

/**
 * Place a cursor-anchored menu inside the viewport.
 *
 * `clientX/clientY` is the click point, `width/height` the measured menu.
 * Near an edge the menu flips so its far edge stays `pad` px from the viewport.
 */
export function contextMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  pad = 8,
): { left: number; top: number } {
  let left = x;
  let top = y;
  if (left + width > viewportWidth - pad) left = Math.max(pad, viewportWidth - pad - width);
  if (left < pad) left = pad;
  if (top + height > viewportHeight - pad) top = Math.max(pad, viewportHeight - pad - height);
  if (top < pad) top = pad;
  return { left, top };
}

/** Same wording as the server, for mock/offline rate-limit states. */
export function rateLimitMessage(until: number): string {
  const when = new Date(until).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `Spotify is rate-limiting rune — try again after ${when}.`;
}
