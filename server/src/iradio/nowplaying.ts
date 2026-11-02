// Pure ICY "now playing" parsing. mpv exposes the stream's ICY headers on its
// `metadata` property and the stream title on `media-title`; both are shaped into
// PlayerState.nowPlaying (worker Y's additive shared field).
import type { PlayerState } from '@liner/shared';

type NowPlaying = NonNullable<PlayerState['nowPlaying']>;

/** Case-insensitive lookup in mpv's metadata node map. */
export function metadataValue(
  metadata: Record<string, unknown> | undefined,
  names: readonly string[],
): string | undefined {
  if (!metadata) return undefined;
  const byKey = new Map<string, unknown>();
  for (const [key, value] of Object.entries(metadata)) byKey.set(key.toLowerCase(), value);
  for (const name of names) {
    const value = byKey.get(name.toLowerCase());
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/**
 * ICY titles are free-form. Handle the two common shapes:
 *   "Artist - Title"      → { artist, title }
 *   "Title by Artist"     → { title, artist }
 * A trailing " - <station> on ..." branding suffix is removed first.
 */
export function parseIcyTitle(raw: string, station?: string): { title?: string; artist?: string } {
  let text = raw.trim();
  if (!text) return {};
  if (station) {
    const suffix = new RegExp(`\\s+-\\s+${escapeRegex(station)}(?:\\s+on\\s+.*)?$`, 'i');
    text = text.replace(suffix, '').trim();
  }
  const by = /^(.*?)\s+by\s+(.+)$/i.exec(text);
  if (by?.[1] && by[2]) {
    const title = by[1].trim();
    const artist = by[2].trim();
    if (title && artist) return { title, artist };
  }
  const dash = text.indexOf(' - ');
  if (dash > 0) {
    const artist = text.slice(0, dash).trim();
    const title = text.slice(dash + 3).trim();
    if (artist && title) return { title, artist };
  }
  return { title: text };
}

/**
 * Build PlayerState.nowPlaying from mpv's metadata/media-title. `stationName`
 * is the fallback; `streamUrl` lets us ignore mpv's placeholder media-title
 * (e.g. "jazz" for .../jazz) before ICY title metadata arrives.
 *
 * Returns undefined until there is an actual title/artist: the queue already
 * shows the station name, so a station-only nowPlaying adds noise.
 */
export function nowPlayingFromMetadata(
  metadata: Record<string, unknown> | undefined,
  mediaTitle: string | undefined,
  stationName: string,
  streamUrl?: string,
): NowPlaying | undefined {
  const station =
    metadataValue(metadata, ['icy-name', 'icy-station', 'icy-description']) || stationName;
  const icyRaw = metadataValue(metadata, ['icy-title', 'streamtitle', 'icy-song', 'title']);
  const usableMediaTitle =
    mediaTitle && mediaTitle !== stationName && !isStreamFilename(mediaTitle, streamUrl)
      ? mediaTitle
      : undefined;
  const raw = icyRaw ?? usableMediaTitle;
  const parsed = raw ? parseIcyTitle(raw, station) : {};
  if (!parsed.title && !parsed.artist) return undefined;
  const result: NowPlaying = { station };
  if (parsed.artist) result.artist = parsed.artist;
  if (parsed.title) result.title = parsed.title;
  return result;
}

/** True when mpv's media-title is just the stream URL's file name. */
function isStreamFilename(mediaTitle: string, streamUrl: string | undefined): boolean {
  if (!streamUrl) return false;
  try {
    const last = new URL(streamUrl).pathname.split('/').filter(Boolean).pop() ?? '';
    const base = decodeURIComponent(last).replace(/\.(mp3|aac|ogg|opus|flac)$/i, '');
    return base.length > 0 && base.toLowerCase() === mediaTitle.trim().toLowerCase();
  } catch {
    return false;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
