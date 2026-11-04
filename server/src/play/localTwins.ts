// "Play my own copy": a Spotify track the user also has locally plays from the local file.
//
// Two ways a Spotify track finds its local twin:
//   1. track_links: the exact pair stored when a local album was linked to its Spotify album.
//   2. Same song by name: normalised title + an artist in common + length within TOLERANCE_MS.
//      Playlists often hold a different Spotify copy of a song (the single, a remaster, a
//      compilation) than the album rune linked, so the link table alone misses them.
// Versions that differ in content ("Live", "Remix", "Acoustic", "Demo"…) keep those words in the
// normalised title, so they never match the studio track; only packaging words are dropped.
import type { QueueItem } from '@liner/shared';
import type { Db } from '../db/index.js';
import { loadQueueItems, loadTracks } from './rows.js';

export const TOLERANCE_MS = 6_000; // same recording, different fade or lead-in silence (Free Bird: 547 vs 552 s)
const INDEX_TTL_MS = 5 * 60_000;
export const MAX_QUERIES = 5_000;

export interface TwinQuery {
  /** 'sp:<id>' */
  id: string;
  title: string;
  artists: string[];
  durationMs: number;
}

/** Packaging-only suffixes: "(2011 Remaster)", "- Remastered 2009", "[Deluxe Edition]", "- Mono", "(feat. X)". */
const PACKAGING =
  /\s*[([]\s*(?:\d{4}\s+)?(?:re-?master(?:ed)?(?:\s+\d{4})?(?:\s+version)?|deluxe(?:\s+edition)?|bonus\s+track|album\s+version|original\s+version|single\s+version|explicit|clean|mono|stereo|(?:feat|ft|featuring)\.?\s+[^)\]]*)\s*[)\]]/gi;
const PACKAGING_DASH =
  /\s+-\s+(?:\d{4}\s+)?(?:re-?master(?:ed)?(?:\s+\d{4})?(?:\s+version)?|album\s+version|single\s+version|mono|stereo|explicit)\s*$/i;

export function normTitle(s: string): string {
  return s
    .replace(PACKAGING, ' ')
    .replace(PACKAGING_DASH, ' ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function normArtist(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** "A & B", "A, B", "A feat. B" → each name on its own. */
function artistKeys(names: string[]): Set<string> {
  const out = new Set<string>();
  for (const n of names) {
    out.add(normArtist(n));
    for (const part of n.split(/\s*(?:,|&|\band\b|\bx\b|\bfeat\.?|\bft\.?|\bwith\b)\s*/i)) {
      const k = normArtist(part);
      if (k) out.add(k);
    }
  }
  out.delete('');
  return out;
}

interface Entry {
  id: string;
  artists: Set<string>;
  durationMs: number;
}

export interface LocalTwins {
  /** Spotify id → local track id, for the queries that have a local copy. */
  find(queries: TwinQuery[]): Map<string, string>;
  /** find() + the local tracks as queue items (album title/cover filled in). */
  items(queries: TwinQuery[]): Record<string, Pick<QueueItem, 'track' | 'album'>>;
}

export function createLocalTwins(db: Db, now: () => number = Date.now): LocalTwins {
  let index: Map<string, Entry[]> | null = null;
  let builtAt = 0;

  const build = (): Map<string, Entry[]> => {
    if (index && now() - builtAt < INDEX_TTL_MS) return index;
    const ids = (db.prepare("SELECT id FROM tracks WHERE source = 'local'").all() as { id: string }[]).map((r) => r.id);
    const albumArtist = db.prepare(
      'SELECT ar.name AS name FROM tracks t JOIN albums a ON a.id = t.album_id JOIN artists ar ON ar.id = a.artist_id WHERE t.id = ?',
    );
    const next = new Map<string, Entry[]>();
    for (const t of loadTracks(db, ids)) {
      const key = normTitle(t.title);
      if (!key) continue;
      const names = t.artists.map((a) => a.name);
      const aa = albumArtist.get(t.id) as { name: string } | undefined;
      if (aa?.name) names.push(aa.name);
      const list = next.get(key) ?? [];
      list.push({ id: t.id, artists: artistKeys(names), durationMs: t.durationMs });
      next.set(key, list);
    }
    index = next;
    builtAt = now();
    return next;
  };

  const linked = db.prepare(
    "SELECT tl.track_id AS id FROM track_links tl JOIN tracks t ON t.id = tl.track_id WHERE tl.spotify_track_id = ? AND t.source = 'local' LIMIT 1",
  );

  const find = (queries: TwinQuery[]): Map<string, string> => {
    const out = new Map<string, string>();
    let idx: Map<string, Entry[]> | null = null;
    for (const q of queries.slice(0, MAX_QUERIES)) {
      if (!q.id.startsWith('sp:') || out.has(q.id)) continue;
      const link = linked.get(q.id.slice(3)) as { id: string } | undefined;
      if (link) {
        out.set(q.id, link.id);
        continue;
      }
      idx ??= build();
      const cands = idx.get(normTitle(q.title));
      if (!cands) continue;
      const want = artistKeys(q.artists);
      let best: Entry | null = null;
      let bestDiff = Infinity;
      for (const c of cands) {
        if (![...want].some((a) => c.artists.has(a))) continue;
        const diff = q.durationMs > 0 && c.durationMs > 0 ? Math.abs(q.durationMs - c.durationMs) : Infinity;
        if (diff > TOLERANCE_MS) continue;
        if (diff < bestDiff) { best = c; bestDiff = diff; }
      }
      if (best) out.set(q.id, best.id);
    }
    return out;
  };

  return {
    find,
    items(queries) {
      const pairs = find(queries);
      const byLocal = new Map(loadQueueItems(db, [...new Set(pairs.values())]).map((qi) => [qi.track.id, qi]));
      const out: Record<string, Pick<QueueItem, 'track' | 'album'>> = {};
      for (const [sp, local] of pairs) {
        const qi = byLocal.get(local);
        if (qi) out[sp] = { track: qi.track, album: qi.album };
      }
      return out;
    },
  };
}

/** Validates the POST body: { tracks: TwinQuery[] }. */
export function parseTwinQueries(v: unknown): TwinQuery[] | null {
  const list = (v as { tracks?: unknown } | null)?.tracks;
  if (!Array.isArray(list)) return null;
  const out: TwinQuery[] = [];
  for (const t of list.slice(0, MAX_QUERIES)) {
    const o = t as Partial<TwinQuery> | null;
    if (!o || typeof o.id !== 'string' || typeof o.title !== 'string' || o.id.length > 200 || o.title.length > 500) continue;
    const artists = Array.isArray(o.artists) ? o.artists.filter((a): a is string => typeof a === 'string').slice(0, 20) : [];
    out.push({ id: o.id, title: o.title, artists, durationMs: Number.isFinite(o.durationMs) ? Number(o.durationMs) : 0 });
  }
  return out;
}
