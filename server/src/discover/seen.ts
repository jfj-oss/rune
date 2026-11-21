// Songs Discover (and song radio) has shown, remembered in memory so playing one by its id keeps its title, artists,
// album and cover. Without this a Spotify song rune never stored starts as a blank placeholder and is only named by a
// Web API lookup, which is skipped while the request budget is low (the player bar showed an empty song).
import type { Track } from '@liner/shared';
import type { DiscoverAlbum, DiscoverItem } from './types.js';

const MAX = 2000;
const seen = new Map<string, { track: Track; album: DiscoverAlbum }>();

export function rememberDiscoverItems(items: readonly DiscoverItem[]): void {
  for (const it of items) {
    if (!it?.track?.id || !it.track.title) continue;
    seen.delete(it.track.id);
    seen.set(it.track.id, { track: it.track, album: it.album });
  }
  while (seen.size > MAX) {
    const oldest = seen.keys().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}

export function seenDiscoverSong(id: string): { track: Track; album: DiscoverAlbum } | undefined {
  return seen.get(id);
}

/** Tests only. */
export function forgetDiscoverSongs(): void {
  seen.clear();
}
