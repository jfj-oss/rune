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
/** Spotify playlists whose own rows the signed-in user may change on Spotify (theirs, collaborative, or Liked Songs = unlike). */
export const isSpotifyEditable = (p: { id: string; canEdit?: boolean }) =>
  !isRunePlaylist(p.id) && (p.id === LIKED_PLAYLIST_ID || p.canEdit === true);
/** Spotify can't hold local files, so rune keeps them in an overlay on top of a synced Spotify playlist. */
export const hasOverlay = (p: { id: string }) => !isRunePlaylist(p.id) && p.id !== LIKED_PLAYLIST_ID;
/** Can local tracks be added to it? */
export const canAddTo = (p: { id: string; kind?: PlaylistKind }) => isEditable(p) || hasOverlay(p);
/** Is this row one of rune's own (editable) rows inside a Spotify playlist? Local files can only ever be overlay rows. */
export const isOverlayRow = (playlistId: string, t: { source: string; entrySource?: string }) =>
  !isRunePlaylist(playlistId) && (t.entrySource === 'rune-overlay' || (t.entrySource === undefined && t.source === 'local'));
/** Is this one of rune's own rows (the only ones that can be dragged)? */
export const rowEditable = (p: { id: string; kind?: PlaylistKind }, t: { source: string; entrySource?: string }) =>
  isEditable(p) || (hasOverlay(p) && isOverlayRow(p.id, t));
/**
 * Can this row be removed? Rune playlists: every row. Spotify playlists: rune's overlay
 * rows, plus Spotify's own rows when the user may edit the playlist (owned/collaborative).
 */
export const rowRemovable = (
  p: { id: string; kind?: PlaylistKind; canEdit?: boolean },
  t: { source: string; entrySource?: string },
) => rowEditable(p, t) || (isSpotifyEditable(p) && !isOverlayRow(p.id, t));

/**
 * Every playlist position a removal takes out. Spotify removes every copy of a URI, so
 * selecting one copy of a Spotify row selects all of them (rune playlists keep duplicate
 * entries independent). `d.tracks` must be in playlist order.
 */
export function removalPositions(d: RunePlaylistDetail, positions: number[]): number[] {
  const selected = new Set(positions);
  if (isRunePlaylist(d.id)) return [...selected].sort((a, b) => a - b);
  const trackIds = new Set<string>();
  for (const position of selected) {
    const track = d.tracks[position];
    if (track && !isOverlayRow(d.id, track)) trackIds.add(track.id);
  }
  if (trackIds.size > 0) {
    d.tracks.forEach((track, index) => {
      if (trackIds.has(track.id) && !isOverlayRow(d.id, track)) selected.add(index);
    });
  }
  return [...selected].sort((a, b) => a - b);
}

export const SPOTIFY_ADD_NOTE = 'Nothing to add';

/** The Spotify permission a removal on this playlist needs (Liked Songs = unlike, else a playlist edit). */
export const LIKED_WRITE_SCOPE = 'user-library-modify';
export const PLAYLIST_WRITE_SCOPES = ['playlist-modify-private', 'playlist-modify-public'];
/**
 * Which permission the current login lacks for removing songs here, or null when it may. `scopes` is what
 * GET /spotify/status reports (names only); an older server sends none, and then nothing is assumed missing.
 */
export function missingWriteScope(scopes: readonly string[] | null | undefined, playlistId: string): string | null {
  if (!scopes || isRunePlaylist(playlistId)) return null;
  if (playlistId === LIKED_PLAYLIST_ID) return scopes.includes(LIKED_WRITE_SCOPE) ? null : LIKED_WRITE_SCOPE;
  return PLAYLIST_WRITE_SCOPES.some((s) => scopes.includes(s)) ? null : PLAYLIST_WRITE_SCOPES[0]!;
}

/** Pinned items first, otherwise the given order (stable). */
export function pinnedFirst<T extends { pinned?: boolean }>(list: readonly T[]): T[] {
  return [...list.filter((x) => x.pinned === true), ...list.filter((x) => x.pinned !== true)];
}

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
  // rune playlists take anything; Spotify playlists take Spotify songs (added on Spotify) and
  // local files (kept in rune's overlay)
  void playlistId;
  return { add: items, refused: 0 };
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

/** How playlist tracks are listed: newest additions first (default) or the playlist's own order. */
export type PlaylistOrder = 'added' | 'playlist';

/**
 * The playlist as shown/played for `order`. 'added' lists the most recently added entries first
 * (entries added together keep their playlist order; undated ones go last). Smart playlists keep
 * their own rule-based order. `origIndex[i]` is the playlist position of shown row i.
 */
export function orderPlaylist<T extends { id: string; kind?: PlaylistKind; tracks: { addedAt?: number }[] }>(d: T, order: PlaylistOrder): { view: T; origIndex: number[]; sorted: boolean } {
  const ident = d.tracks.map((_, i) => i);
  if (order !== 'added' || isSmartPlaylist(d) || !d.tracks.some((t) => t.addedAt != null)) return { view: d, origIndex: ident, sorted: false };
  const at = (i: number) => d.tracks[i]!.addedAt ?? -Infinity;
  const origIndex = ident.slice().sort((a, b) => (at(b) - at(a)) || (a - b));
  if (origIndex.every((v, i) => v === i)) return { view: d, origIndex, sorted: false };
  return { view: { ...d, tracks: origIndex.map((i) => d.tracks[i]!) }, origIndex, sorted: true };
}
