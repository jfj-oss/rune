// Cover URL helpers shared by the read paths. Kept free of Db/play imports so
// lower layers (play/rows, myplaylists) can use them without an import cycle.

/** URL of rune's own cached/thumbnail cover route. */
export function coverUrl(albumId: string, size: 200 | 600 | 'full' = 600): string {
  return `/api/cover/${encodeURIComponent(albumId)}?size=${size}`;
}

/**
 * Cover URL for an album row. Spotify covers are stored as absolute CDN URLs;
 * clients already use those directly and the old /api/cover redirect only added
 * a round trip, so return the URL itself when cover_path is http(s).
 */
export function coverUrlFor(
  albumId: string,
  coverPath: string | null | undefined,
  size: 200 | 600 | 'full' = 600,
): string | undefined {
  if (!coverPath) return undefined;
  return /^https?:\/\//i.test(coverPath) ? coverPath : coverUrl(albumId, size);
}
