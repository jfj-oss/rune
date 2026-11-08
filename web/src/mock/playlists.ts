// Mock rune playlists: an in-memory store that mirrors server/src/myplaylists (static + smart).
import type { PlaylistTrack, Track } from '@liner/shared';
import { coverAlbums, type EntryTrack, type RunePlaylistDetail, type RunePlaylistSummary, type SmartSpec } from '../lib/playlists';
import { mockCover } from './covers';
import { ALBUMS, FULL_ALBUM_ID } from './data';
import { LIKED_ID, PLAYLISTS as SPOTIFY_PLAYLISTS, playlistDetail as spotifyDetail, removeFromPlaylistMock, setTrackLiked } from './spotify';

interface Row { id: string; name: string; description?: string; kind: 'static' | 'smart'; tracks: PlaylistTrack[]; spec?: SmartSpec }

// Overlay of local files inside synced Spotify playlists: entries hold their absolute position in the merged list.
interface Overlay { entryId: string; pos: number; track: PlaylistTrack }
const overlays = new Map<string, Overlay[]>();
let en = 0;

const rows: Row[] = [];
let n = 0;
const newId = () => `pl:rune:${(0xa11ce000 + ++n * 7919).toString(16).padStart(8, '0')}-mock`;

const albumOf = new Map(ALBUMS.map((a) => [a.id, a]));
export function asPlaylistTrack(t: Track): PlaylistTrack {
  const al = albumOf.get(t.albumId);
  return { ...t, album: { id: t.albumId, title: al?.title ?? '', coverUrl: al ? mockCover(al.id, al.title) : undefined } };
}
const allTracks = (): PlaylistTrack[] => ALBUMS.flatMap((a) => a.tracks.map(asPlaylistTrack));

// ---------- smart evaluation (a small subset of rules.ts) ----------
const albumYear = (t: Track) => albumOf.get(t.albumId)?.year ?? 0;
const albumAdded = (t: Track) => albumOf.get(t.albumId)?.addedAt ?? 0;
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /\D/.test(v) ? Date.parse(v) : Number(v));
function ruleMatches(t: Track, r: SmartSpec['rules'][number]): boolean {
  const al = albumOf.get(t.albumId);
  let have: string[] | number;
  switch (r.field) {
    case 'genre': have = al?.genres ?? []; break;
    case 'artist': have = t.artists.map((a) => a.name); break;
    case 'format': have = [t.format ?? ''] ; break;
    case 'source': have = [t.source]; break;
    case 'year': have = albumYear(t); break;
    case 'added': have = albumAdded(t); break;
    default: have = 0;
  }
  if (Array.isArray(have)) {
    const v = String(r.value ?? '').toLowerCase();
    const any = (f: (s: string) => boolean) => have.some((s) => f(s.toLowerCase()));
    switch (r.op) {
      case 'eq': return any((s) => s === v);
      case 'ne': return !any((s) => s === v);
      case 'contains': return any((s) => s.includes(v));
      case 'notContains': return !any((s) => s.includes(v));
      case 'startsWith': return any((s) => s.startsWith(v));
      case 'endsWith': return any((s) => s.endsWith(v));
      default: return true;
    }
  }
  const x = num(r.value);
  switch (r.op) {
    case 'eq': return have === x;
    case 'ne': return have !== x;
    case 'gt': return have > x;
    case 'gte': return have >= x;
    case 'lt': return have < x;
    case 'lte': return have <= x;
    case 'between': { const [a, b] = (r.value as unknown[]).map(num) as [number, number]; return have >= a && have <= b; }
    default: return true;
  }
}
export function evaluateSmart(spec: SmartSpec): PlaylistTrack[] {
  let list = allTracks().filter((t) => (spec.match === 'any' ? spec.rules.some((r) => ruleMatches(t, r)) : spec.rules.every((r) => ruleMatches(t, r))));
  const [field, dir] = spec.sort.split(':');
  const key = (t: PlaylistTrack): string | number =>
    field === 'title' ? t.title.toLowerCase() : field === 'album' ? t.album.title.toLowerCase() : field === 'year' ? albumYear(t) : field === 'added' ? albumAdded(t) : field === 'duration' ? t.durationMs : (t.artists[0]?.name ?? '').toLowerCase();
  list = list.sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * (dir === 'desc' ? -1 : 1); });
  return spec.limit ? list.slice(0, spec.limit) : list;
}

// ---------- store ----------
const tracksOf = (r: Row) => (r.kind === 'smart' && r.spec ? evaluateSmart(r.spec) : r.tracks);
function summary(r: Row): RunePlaylistSummary {
  const tracks = tracksOf(r);
  return { id: r.id, name: r.name, trackCount: tracks.length, source: 'local', kind: r.kind, coverAlbumIds: coverAlbums(tracks) };
}
function detail(r: Row): RunePlaylistDetail {
  const tracks = tracksOf(r);
  return { ...summary(r), description: r.description, tracks };
}
const find = (id: string) => rows.find((r) => r.id === id);
function mustRune(id: string): Row {
  const r = find(id);
  if (!r) throw Object.assign(new Error(SPOTIFY_PLAYLISTS.some((p) => p.id === id) ? 'only rune playlists can be modified' : 'playlist not found'), { status: SPOTIFY_PLAYLISTS.some((p) => p.id === id) ? 409 : 404 });
  return r;
}

const isSp = (id: string) => SPOTIFY_PLAYLISTS.some((p) => p.id === id);
const conflict = (m: string) => Object.assign(new Error(m), { status: 409 });

/** Spotify's own rows with rune's overlay rows spliced in at their positions. */
function mergedSpotify(id: string): EntryTrack[] | undefined {
  const base = spotifyDetail(id);
  if (!base) return undefined;
  const out: EntryTrack[] = base.tracks.map((t, i) => ({ ...t, entryId: `sp:${i}`, entrySource: 'spotify-playlist' as const }));
  for (const o of [...(overlays.get(id) ?? [])].sort((a, b) => a.pos - b.pos)) out.splice(Math.min(o.pos, out.length), 0, { ...o.track, entryId: o.entryId, entrySource: 'rune-overlay' });
  return out;
}
/** After an edit of the merged list, remember where the overlay rows ended up. */
function storeOverlay(id: string, merged: EntryTrack[]) {
  overlays.set(id, merged.flatMap((t, pos) => (t.entrySource === 'rune-overlay' ? [{ entryId: t.entryId!, pos, track: t }] : [])));
}
function spotifyView(id: string): RunePlaylistDetail | undefined {
  const d = spotifyDetail(id);
  const tracks = mergedSpotify(id);
  return d && tracks ? { ...d, trackCount: tracks.length, tracks } : undefined;
}

export const mockPlaylists = {
  list: (): RunePlaylistSummary[] => [...rows.map(summary), ...SPOTIFY_PLAYLISTS.map((p) => ({ ...p, trackCount: p.trackCount + (overlays.get(p.id)?.length ?? 0) }))],
  get(id: string): RunePlaylistDetail | undefined {
    const r = find(id);
    return r ? detail(r) : spotifyView(id);
  },
  create(name: string, description?: string): RunePlaylistDetail {
    const r: Row = { id: newId(), name: name.trim(), description: description?.trim() || undefined, kind: 'static', tracks: [] };
    rows.unshift(r);
    return detail(r);
  },
  update(id: string, patch: { name?: string; description?: string }): RunePlaylistDetail {
    const r = mustRune(id);
    if (patch.name !== undefined) r.name = patch.name.trim() || r.name;
    if (patch.description !== undefined) r.description = patch.description.trim() || undefined;
    return detail(r);
  },
  remove(id: string) { mustRune(id); rows.splice(rows.findIndex((r) => r.id === id), 1); },
  add(id: string, tracks: PlaylistTrack[], position?: number): RunePlaylistDetail {
    if (isSp(id) && !find(id)) {
      if (tracks.some((t) => t.source === 'spotify')) throw conflict('Spotify tracks cannot be added to a Spotify playlist yet');
      const merged = mergedSpotify(id)!;
      merged.splice(position === undefined ? merged.length : Math.min(position, merged.length), 0, ...tracks.map((t) => ({ ...t, entryId: `ov:${++en}`, entrySource: 'rune-overlay' as const })));
      storeOverlay(id, merged);
      return spotifyView(id)!;
    }
    const r = mustRune(id);
    if (r.kind === 'smart') throw Object.assign(new Error('smart playlist tracks are defined by rules'), { status: 409 });
    r.tracks.splice(position === undefined ? r.tracks.length : Math.min(position, r.tracks.length), 0, ...tracks);
    return detail(r);
  },
  removeAt(id: string, positions: number[]): RunePlaylistDetail {
    if (isSp(id) && !find(id)) {
      const merged = mergedSpotify(id)!;
      const sum = SPOTIFY_PLAYLISTS.find((p) => p.id === id)!;
      const drop = new Set(positions);
      // Spotify removes every copy of a song it is asked to delete; rune's overlay rows go locally.
      const baseDrops = new Set<string>();
      for (const p of drop) {
        const entry = merged[p];
        if (!entry || entry.entrySource === 'rune-overlay') continue;
        if (sum.canEdit !== true) throw conflict('This Spotify playlist is not yours and is not collaborative');
        baseDrops.add(entry.id);
      }
      const kept = merged.filter((entry, i) =>
        !drop.has(i) && !(entry.entrySource !== 'rune-overlay' && baseDrops.has(entry.id)),
      );
      if (baseDrops.size > 0) {
        if (id === LIKED_ID) for (const trackId of baseDrops) setTrackLiked(trackId, false);
        removeFromPlaylistMock(id, [...baseDrops]);
      }
      storeOverlay(id, kept);
      return spotifyView(id)!;
    }
    const r = mustRune(id);
    if (r.kind === 'smart') throw Object.assign(new Error('smart playlist tracks are defined by rules'), { status: 409 });
    const drop = new Set(positions);
    r.tracks = r.tracks.filter((_, i) => !drop.has(i));
    return detail(r);
  },
  move(id: string, from: number, to: number): RunePlaylistDetail {
    if (isSp(id) && !find(id)) {
      const merged = mergedSpotify(id)!;
      if (merged[from]?.entrySource !== 'rune-overlay') throw conflict('Spotify tracks cannot be moved');
      const [t] = merged.splice(from, 1);
      merged.splice(to, 0, t!);
      storeOverlay(id, merged);
      return spotifyView(id)!;
    }
    const r = mustRune(id);
    const [t] = r.tracks.splice(from, 1);
    if (t) r.tracks.splice(to, 0, t);
    return detail(r);
  },
  duplicate(id: string): RunePlaylistDetail {
    const src = find(id);
    const d = src ? detail(src) : spotifyView(id);
    if (!d) throw Object.assign(new Error('playlist not found'), { status: 404 });
    const r: Row = { id: newId(), name: `${d.name} copy`, description: d.description, kind: src?.kind ?? 'static', tracks: src?.kind === 'smart' ? [] : d.tracks.map((t) => ({ ...t })), spec: src?.spec };
    rows.unshift(r);
    return detail(r);
  },
  createSmart(name: string, spec: SmartSpec): RunePlaylistDetail {
    const r: Row = { id: newId(), name: name.trim(), kind: 'smart', tracks: [], spec };
    rows.unshift(r);
    return detail(r);
  },
  previewSmart: (spec: SmartSpec) => { const t = evaluateSmart(spec); return { count: t.length, sample: t.slice(0, 3).map((x) => x.title) }; },
  exportM3u8(id: string): { name: string; content: string } {
    const d = this.get(id);
    if (!d) throw Object.assign(new Error('playlist not found'), { status: 404 });
    const lines = ['#EXTM3U', `#PLAYLIST:${d.name}`, ...d.tracks.flatMap((t) => [`#EXTINF:${Math.round(t.durationMs / 1000)},${t.artists.map((a) => a.name).join(', ')} - ${t.title}`, t.spotifyUri ?? `/mock/${t.id}.flac`])];
    return { name: d.name, content: lines.join('\n') + '\n' };
  },
};

// ---------- seed ----------
function seed() {
  const local = ALBUMS.filter((a) => a.source === 'local');
  const spot = ALBUMS.filter((a) => a.source === 'spotify');
  const pick = (a: (typeof ALBUMS)[number] | undefined, i: number) => (a?.tracks[i] ? asPlaylistTrack(a.tracks[i]!) : undefined);
  const full = ALBUMS.find((a) => a.id === FULL_ALBUM_ID) ?? local[0]!;
  const mix: (PlaylistTrack | undefined)[] = [
    pick(full, 2), pick(spot[0], 0), pick(local[3], 1), pick(spot[1], 2), pick(full, 5), pick(local[5], 0), pick(spot[2], 1),
    pick(local[7], 2), pick(spot[3], 3), pick(local[1], 0), pick(spot[0], 4), pick(full, 8),
  ];
  // HORSE: local rips slotted into the synced Spotify playlist
  const horse = SPOTIFY_PLAYLISTS.find((p) => p.name === 'HORSE');
  if (horse) {
    const localTracks = [pick(full, 3), pick(local[2], 0), pick(local[4], 1)].filter((t): t is PlaylistTrack => !!t);
    overlays.set(horse.id, localTracks.map((track, i) => ({ entryId: `ov:${++en}`, pos: [2, 6, 11][i]!, track })));
  }
  rows.push({ id: newId(), name: 'Coast road', description: 'Local rips and Spotify finds, one queue.', kind: 'static', tracks: mix.filter((t): t is PlaylistTrack => !!t) });
  rows.push({ id: newId(), name: 'Late night focus', kind: 'static', tracks: [full, local[2], local[4], local[6]].flatMap((a, i) => pick(a, i + 1) ?? []) });
  rows.push({ id: newId(), name: 'Everything since 2005', description: undefined, kind: 'smart', tracks: [], spec: { rules: [{ field: 'year', op: 'gte', value: 2005 }], match: 'all', sort: 'year:desc', limit: 40 } });
}
seed();
