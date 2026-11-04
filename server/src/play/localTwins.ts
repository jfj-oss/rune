// "Play my own copy": a Spotify track the user also has locally plays from the local file.
//
// Two ways a Spotify track finds its local twin:
//   1. track_links: the exact pair stored when a local album was linked to its Spotify album.
//   2. Same song by name: normalised title + an artist in common + length within TOLERANCE_MS.
//      Playlists often hold a different Spotify copy of a song (the single, a remaster, a
//      compilation) than the album rune linked, so the link table alone misses them.
// The reverse (spotifyItems) maps a local file to its Spotify copy, for zones that can only play
// Spotify (Connect devices, the phone's Spotify app): same two steps, against rune's Spotify tracks.
// Versions that differ in content ("Live", "Remix", "Acoustic", "Demo"…) keep those words in the
// normalised title, so they never match the studio track; only packaging words are dropped.
import type { QueueItem, Track } from '@liner/shared';
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
  /** The reverse: local track id → its Spotify copy as a queue item (for Spotify-only zones). */
  spotifyItems(localIds: string[]): Record<string, Pick<QueueItem, 'track' | 'album'>>;
}

/** Never hand a file path to a browser. */
const publicItem = (qi: QueueItem): Pick<QueueItem, 'track' | 'album'> => {
  const { path: _p, ...track } = qi.track as Track & { path?: string };
  return { track, album: qi.album };
};

export function createLocalTwins(db: Db, now: () => number = Date.now): LocalTwins {
  const indexes = new Map<'local' | 'spotify', { index: Map<string, Entry[]>; builtAt: number }>();

  const build = (source: 'local' | 'spotify'): Map<string, Entry[]> => {
    const cached = indexes.get(source);
    if (cached && now() - cached.builtAt < INDEX_TTL_MS) return cached.index;
    const ids = (db.prepare('SELECT id FROM tracks WHERE source = ?').all(source) as { id: string }[]).map((r) => r.id);
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
    indexes.set(source, { index: next, builtAt: now() });
    return next;
  };

  /** The best same-song entry: an artist in common and the closest length within tolerance. */
  const bestMatch = (idx: Map<string, Entry[]>, title: string, artists: string[], durationMs: number): Entry | null => {
    const cands = idx.get(normTitle(title));
    if (!cands) return null;
    const want = artistKeys(artists);
    let best: Entry | null = null;
    let bestDiff = Infinity;
    for (const c of cands) {
      if (![...want].some((a) => c.artists.has(a))) continue;
      const diff = durationMs > 0 && c.durationMs > 0 ? Math.abs(durationMs - c.durationMs) : Infinity;
      if (diff > TOLERANCE_MS) continue;
      if (diff < bestDiff) { best = c; bestDiff = diff; }
    }
    return best;
  };

  const linked = db.prepare(
    "SELECT tl.track_id AS id FROM track_links tl JOIN tracks t ON t.id = tl.track_id WHERE tl.spotify_track_id = ? AND t.source = 'local' LIMIT 1",
  );

  const spotifyLink = db.prepare('SELECT spotify_track_id AS id FROM track_links WHERE track_id = ? AND spotify_track_id IS NOT NULL LIMIT 1');

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
      idx ??= build('local');
      const best = bestMatch(idx, q.title, q.artists, q.durationMs);
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
        if (qi) out[sp] = publicItem(qi);
      }
      return out;
    },
    spotifyItems(localIds) {
      const ids = [...new Set(localIds.filter((id) => id.startsWith('l:')))].slice(0, MAX_QUERIES);
      const locals = loadQueueItems(db, ids);
      const pairs = new Map<string, string>(); // local id → 'sp:<id>'
      let idx: Map<string, Entry[]> | null = null;
      for (const qi of locals) {
        const link = spotifyLink.get(qi.track.id) as { id: string } | undefined;
        if (link) { pairs.set(qi.track.id, `sp:${link.id}`); continue; }
        idx ??= build('spotify');
        const best = bestMatch(idx, qi.track.title, qi.track.artists.map((a) => a.name), qi.track.durationMs);
        if (best) pairs.set(qi.track.id, best.id);
      }
      const known = new Map(loadQueueItems(db, [...new Set(pairs.values())]).map((qi) => [qi.track.id, qi]));
      const out: Record<string, Pick<QueueItem, 'track' | 'album'>> = {};
      for (const qi of locals) {
        const sp = pairs.get(qi.track.id);
        if (!sp) continue;
        // A linked Spotify track rune never stored: the local metadata under the Spotify id plays fine.
        const hit = known.get(sp);
        if (hit) { out[qi.track.id] = publicItem(hit); continue; }
        const { path: _p, format: _f, sampleRate: _r, bitDepth: _b, bitrateKbps: _k, cue: _c, ...rest } = qi.track as Track & { path?: string };
        out[qi.track.id] = { track: { ...rest, id: sp, source: 'spotify', spotifyUri: `spotify:track:${sp.slice(3)}` }, album: qi.album };
      }
      return out;
    },
  };
}

/** Validates the POST body of /spotify-twins: { ids: string[] } (local track ids). */
export function parseLocalIds(v: unknown): string[] | null {
  const list = (v as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(list)) return null;
  return list.filter((id): id is string => typeof id === 'string' && id.length <= 200).slice(0, MAX_QUERIES);
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
