// rune's own playlists: shapes of the /api/playlists routes (server/src/myplaylists) and the pure
// optimistic-update reducer the playlist screens use.
import type { PlaylistDetail, PlaylistSummary, PlaylistTrack } from '@liner/shared';
import type { PlayItem } from './types';

export type PlaylistKind = 'static' | 'smart';

export interface RunePlaylistSummary extends PlaylistSummary {
  kind?: PlaylistKind;
  /** Up to four distinct album ids for a 2x2 cover mosaic (rune playlists only). */
  coverAlbumIds?: string[];
}
/**
 * A row of a playlist. In synced Spotify playlists the server merges rune's overlay (local files that live only in
 * rune) into the Spotify list: such rows are `entrySource: 'rune-overlay'`, the rest `'spotify-playlist'`.
 */
export type EntryTrack = PlaylistTrack & { entryId?: string; entrySource?: 'spotify-playlist' | 'rune-overlay' };

export interface RunePlaylistDetail extends Omit<PlaylistDetail, 'tracks'> {
  kind?: PlaylistKind;
  coverAlbumIds?: string[];
  tracks: EntryTrack[];
}

/** rune playlist ids are `pl:rune:<uuid>`; everything else is synced from Spotify and read-only. */
export const isRunePlaylist = (id: string) => id.startsWith('pl:rune:');
export const isSmartPlaylist = (p: { id: string; kind?: PlaylistKind }) => isRunePlaylist(p.id) && p.kind === 'smart';
/** Can the user change this playlist's tracks by hand? (rune playlists only; Spotify ones take overlay rows, see below) */
export const isEditable = (p: { id: string; kind?: PlaylistKind }) => isRunePlaylist(p.id) && p.kind !== 'smart';
export const LIKED_PLAYLIST_ID = 'pl:sp:liked';
/** Spotify can't hold local files, so rune keeps them in an overlay on top of a synced Spotify playlist. */
export const hasOverlay = (p: { id: string }) => !isRunePlaylist(p.id) && p.id !== LIKED_PLAYLIST_ID;
/** Can local tracks be added to it? */
export const canAddTo = (p: { id: string; kind?: PlaylistKind }) => isEditable(p) || hasOverlay(p);
/** Is this row one of rune's own (editable) rows inside a Spotify playlist? Local files can only ever be overlay rows. */
export const isOverlayRow = (playlistId: string, t: { source: string; entrySource?: string }) =>
  !isRunePlaylist(playlistId) && (t.entrySource === 'rune-overlay' || (t.entrySource === undefined && t.source === 'local'));
/** Can this row be removed / dragged? */
export const rowEditable = (p: { id: string; kind?: PlaylistKind }, t: { source: string; entrySource?: string }) =>
  isEditable(p) || (hasOverlay(p) && isOverlayRow(p.id, t));
export const SPOTIFY_ADD_NOTE = 'Spotify songs can’t be added to Spotify playlists yet';

// ---------- smart rules (mirror of server/src/myplaylists/rules.ts) ----------
export type SmartField = 'genre' | 'artist' | 'year' | 'format' | 'added' | 'plays' | 'lastPlayed' | 'source';
export interface SmartRule { field: SmartField; op: string; value?: unknown }
export interface SmartSpec {
  rules: SmartRule[];
  match: 'all' | 'any';
  /** "field:asc" | "field:desc" */
  sort: string;
  limit?: number;
}
export interface SmartBody extends SmartSpec { name: string }

// ---------- optimistic edits ----------
export type PlaylistEdit =
  | { type: 'rename'; name: string }
  | { type: 'describe'; description: string }
  | { type: 'remove'; positions: number[] }
  | { type: 'move'; from: number; to: number }
  | { type: 'add'; tracks: EntryTrack[]; position?: number };

export function coverAlbums(tracks: { album: { id: string } }[]): string[] {
  const seen: string[] = [];
  for (const t of tracks) {
    if (!seen.includes(t.album.id)) seen.push(t.album.id);
    if (seen.length === 4) break;
  }
  return seen;
}

/** Apply an edit to a playlist detail without mutating it (what the server will do, minus the roundtrip). */
export function applyEdit(d: RunePlaylistDetail, e: PlaylistEdit): RunePlaylistDetail {
  switch (e.type) {
    case 'rename':
      return { ...d, name: e.name };
    case 'describe':
      return { ...d, description: e.description || undefined };
    case 'remove': {
      const drop = new Set(e.positions);
      const tracks = d.tracks.filter((_, i) => !drop.has(i));
      return { ...d, tracks, trackCount: tracks.length, coverAlbumIds: coverAlbums(tracks) };
    }
    case 'move': {
      const n = d.tracks.length;
      if (e.from === e.to || e.from < 0 || e.to < 0 || e.from >= n || e.to >= n) return d;
      const tracks = d.tracks.slice();
      const [t] = tracks.splice(e.from, 1);
      tracks.splice(e.to, 0, t as EntryTrack);
      return { ...d, tracks, coverAlbumIds: coverAlbums(tracks) };
    }
    case 'add': {
      const at = e.position === undefined ? d.tracks.length : Math.max(0, Math.min(e.position, d.tracks.length));
      const tracks = d.tracks.slice();
      tracks.splice(at, 0, ...e.tracks);
      return { ...d, tracks, trackCount: tracks.length, coverAlbumIds: coverAlbums(tracks) };
    }
  }
}

/** The same edit as it shows on the playlists list (name and count only). */
export function applyEditToSummary(s: RunePlaylistSummary, e: PlaylistEdit): RunePlaylistSummary {
  switch (e.type) {
    case 'rename': return { ...s, name: e.name };
    case 'remove': return { ...s, trackCount: Math.max(0, s.trackCount - new Set(e.positions).size) };
    case 'add': return { ...s, trackCount: s.trackCount + e.tracks.length };
    default: return s;
  }
}

/** Reorder a list the way a drag from `from` to `to` does (also what the row shifting preview needs). */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const out = list.slice();
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x as T);
  return out;
}

/** Positions selected with a click: plain = just that one, cmd/ctrl = toggle, shift = range from the anchor. */
export function selectRow(sel: ReadonlySet<number>, anchor: number | null, i: number, mod: { shift?: boolean; toggle?: boolean }): { sel: Set<number>; anchor: number } {
  if (mod.shift && anchor !== null) {
    const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
    const next = new Set(mod.toggle ? sel : []);
    for (let k = a; k <= b; k++) next.add(k);
    return { sel: next, anchor };
  }
  if (mod.toggle) {
    const next = new Set(sel);
    if (next.has(i)) next.delete(i); else next.add(i);
    return { sel: next, anchor: i };
  }
  return { sel: new Set([i]), anchor: i };
}

/** A queue / album item as a playlist row (used to show an add before the server has answered). */
export function toPlaylistTrack(i: PlayItem): EntryTrack {
  return { ...i.track, album: { id: i.album.id, title: i.album.title, coverUrl: i.album.coverUrl } };
}

/** Split items for a target playlist: Spotify playlists only take local files (for now). */
export function splitForTarget(playlistId: string, items: PlayItem[]): { add: PlayItem[]; refused: number } {
  if (isRunePlaylist(playlistId)) return { add: items, refused: 0 };
  const add = items.filter((i) => i.track.source !== 'spotify');
  return { add, refused: items.length - add.length };
}

/** True when the playlist holds both local and Spotify tracks. */
export function isMixed(tracks: { source: string }[]): boolean {
  return tracks.some((t) => t.source === 'spotify') && tracks.some((t) => t.source !== 'spotify');
}

/** Suggestion for "Save queue as playlist". */
export function queueName(now = new Date()): string {
  return `Queue — ${now.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}

// ---------- recent playlists (for the quick "Add to playlist" list) ----------
const RECENT_KEY = 'rune.recentPlaylists';
export function loadRecent(): string[] {
  try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
}
export function noteRecent(id: string) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...loadRecent().filter((x) => x !== id)].slice(0, 12))); } catch { /* storage blocked */ }
}
/** Editable playlists, most recently used first, then in list order. */
export function orderByRecent<T extends { id: string }>(list: readonly T[], recent: readonly string[]): T[] {
  const rank = (id: string) => { const i = recent.indexOf(id); return i < 0 ? Infinity : i; };
  return list.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p.id) - rank(b.p.id) || a.i - b.i).map((x) => x.p);
}
