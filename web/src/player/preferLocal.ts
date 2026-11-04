// "Play my own copy": before a queue starts, Spotify tracks the user also has locally are swapped
// for the local file (the server finds them: album links first, then title + artist + length).
// Only on zones that can play local files — a Spotify Connect device keeps the Spotify track.
import type { PlayItem } from '../lib/types';

export type TwinLookup = (tracks: { id: string; title: string; artists: string[]; durationMs: number }[]) => Promise<Record<string, PlayItem>>;

const BATCH = 1_000;

export async function preferLocal(items: PlayItem[], lookup: TwinLookup): Promise<PlayItem[]> {
  const sp = items.filter((i) => i.track.source === 'spotify');
  if (!sp.length) return items;
  const queries = [...new Map(sp.map((i) => [i.track.id, i.track])).values()].map((t) => ({
    id: t.id, title: t.title, artists: t.artists.map((a) => a.name), durationMs: t.durationMs,
  }));
  const twins: Record<string, PlayItem> = {};
  try {
    for (let i = 0; i < queries.length; i += BATCH) Object.assign(twins, await lookup(queries.slice(i, i + BATCH)));
  } catch {
    return items; // lookup failed: play exactly what was asked
  }
  return items.map((i) => twins[i.track.id] ?? i);
}

/** Local track ids → their Spotify copies (for zones that can only play Spotify). */
export type SpotifyTwinLookup = (localIds: string[]) => Promise<Record<string, PlayItem>>;

/** The reverse of preferLocal: local files that have a Spotify copy become that Spotify track. */
export async function preferSpotify(items: PlayItem[], lookup: SpotifyTwinLookup): Promise<PlayItem[]> {
  const ids = [...new Set(items.filter((i) => i.track.source === 'local').map((i) => i.track.id))];
  if (!ids.length) return items;
  const twins: Record<string, PlayItem> = {};
  try {
    for (let i = 0; i < ids.length; i += BATCH) Object.assign(twins, await lookup(ids.slice(i, i + BATCH)));
  } catch {
    return items;
  }
  return items.map((i) => twins[i.track.id] ?? i);
}

/** What a zone can play: local files (mpv, the browser's <audio>) and/or Spotify. */
export interface ZoneAbility {
  local: boolean;
  spotify: boolean;
  /** For a local-only zone: Spotify is connected, so a list can be sent to a Spotify device instead. */
  spotifyElsewhere: boolean;
}

/**
 * Pick the copy of each song that the zone can play, so nothing the user owns (or can stream) is skipped.
 * - local + Spotify (PC speakers, desktop browser): own files first.
 * - Spotify only (Connect device, the phone's Spotify app): owned files become their Spotify copies.
 * - local only (iPhone/iPad browser): own files; but when that would skip songs that a Spotify device
 *   could play, the whole list goes the Spotify way instead (the caller then asks where to play it),
 *   whichever version skips fewer. `whole` = false (adding to the queue) keeps the zone as it is.
 */
export async function fitForZone(
  items: PlayItem[],
  startIndex: number,
  can: ZoneAbility,
  lookups: { toLocal: TwinLookup; toSpotify: SpotifyTwinLookup },
  whole = true,
): Promise<PlayItem[]> {
  if (can.local && can.spotify) return preferLocal(items, lookups.toLocal);
  if (can.spotify) return preferSpotify(items, lookups.toSpotify);
  if (!can.local) return items;
  const here = await preferLocal(items, lookups.toLocal);
  const skippedHere = here.filter((i) => i.track.source === 'spotify').length;
  if (!whole || !skippedHere || !can.spotifyElsewhere) return here;
  const there = await preferSpotify(items, lookups.toSpotify);
  if (there[startIndex]?.track.source !== 'spotify') return here;
  const skippedThere = there.filter((i) => i.track.source !== 'spotify').length;
  return skippedThere < skippedHere ? there : here;
}
