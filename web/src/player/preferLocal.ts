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
