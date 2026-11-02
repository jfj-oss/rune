// Worker AA — local-track overlay for synced Spotify playlists.
//
// Spotify's Web API cannot add local files to a Spotify playlist, so rune stores
// the user's local additions in `playlist_overlay` and merges them into the synced
// Spotify track list on every read. Spotify is never written to.
//
// Each overlay entry is anchored AFTER one specific Spotify entry, identified by
// its track id plus occurrence (the same song may appear twice), or NULL = top.
// The merged order is resolved at read time, so it survives a resync that inserts,
// removes or reorders Spotify tracks. If an anchor disappears the entry falls back
// to the nearest previous surviving anchor (or the top).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Db } from '../db/index.js';
import { ensureMyPlaylistSchema } from './schema.js';

const migrationSql = readFileSync(new URL('../db/migrations-overlay.sql', import.meta.url), 'utf8');

// Strip -- comments first so prose semicolons don't split a statement in half.
const statements = migrationSql.replace(/--[^\n]*/g, '').split(';');

const applied = new WeakSet<Db>();

/** Safe to call many times; also applies the Spotify-library + rune-playlist schemas. */
export function ensureOverlaySchema(db: Db): void {
  if (applied.has(db)) return;
  ensureMyPlaylistSchema(db);
  for (const statement of statements) {
    const sql = statement.trim();
    if (!sql) continue;
    try {
      db.exec(sql);
    } catch (err) {
      // SQLite has no ALTER TABLE ... ADD COLUMN IF NOT EXISTS; re-application is fine.
      if (!/duplicate column name/i.test(String(err))) throw err;
    }
  }
  applied.add(db);
}

/** Raised for a malformed overlay operation (mapped to HTTP 400 by the routes). */
export class OverlayInputError extends Error {}
/** Raised when an operation would touch a Spotify-owned entry (HTTP 409). */
export class OverlayConflictError extends Error {}

export type PlaylistEntrySource = 'spotify-playlist' | 'rune-overlay';

export interface BaseEntry {
  trackId: string;
  addedAt: number | null;
}

export interface OverlayRow {
  id: string;
  playlist_id: string;
  track_id: string;
  anchor_track_id: string | null;
  anchor_occurrence: number;
  added_at: number;
}

/** One row of a merged playlist: either a synced Spotify entry or a rune overlay. */
export interface MergedEntry {
  trackId: string;
  entrySource: PlaylistEntrySource;
  /** Stable id for entry operations; overlay rows use the value stored in the table. */
  entryId: string;
  addedAt: number | null;
  /** Spotify entries only: 0-based occurrence of this track id in the playlist. */
  occurrence?: number;
}

/** The synced Spotify entries of a playlist, in Spotify order. */
export function readBaseEntries(db: Db, playlistId: string): BaseEntry[] {
  const rows = db
    .prepare(
      'SELECT track_id, added_at FROM playlist_tracks WHERE playlist_id = ? ORDER BY position',
    )
    .all(playlistId) as { track_id: string; added_at: number | null }[];
  return rows.map((r) => ({ trackId: r.track_id, addedAt: r.added_at }));
}

/** Overlay rows in insertion order (added_at, then SQLite rowid as a tie-break). */
export function readOverlayRows(db: Db, playlistId: string): OverlayRow[] {
  ensureOverlaySchema(db);
  return db
    .prepare(
      `SELECT id, playlist_id, track_id, anchor_track_id, anchor_occurrence, added_at
         FROM playlist_overlay WHERE playlist_id = ? ORDER BY added_at, rowid`,
    )
    .all(playlistId) as OverlayRow[];
}

function keyOf(trackId: string, occurrence: number): string {
  return `${trackId}\u0000${occurrence}`;
}

/**
 * Merge overlay rows into the synced base entries.
 *
 * Entries whose anchor still exists are placed directly after that occurrence of
 * the anchor track. Entries whose anchor vanished go after the nearest previous
 * surviving anchor (i.e. the resolved position of the previous overlay entry), or
 * the top. Entries anchored to the same position keep insertion order.
 */
export function mergeEntries(base: BaseEntry[], overlays: OverlayRow[]): MergedEntry[] {
  const occurrences: number[] = [];
  const seen = new Map<string, number>();
  const indexByKey = new Map<string, number>();
  base.forEach((entry, index) => {
    const occurrence = seen.get(entry.trackId) ?? 0;
    seen.set(entry.trackId, occurrence + 1);
    occurrences[index] = occurrence;
    indexByKey.set(keyOf(entry.trackId, occurrence), index);
  });

  // Resolve each overlay to a base index (-1 = top) in insertion order.
  let lastResolved = -1;
  const groups = new Map<number, OverlayRow[]>();
  for (const row of overlays) {
    let anchorIndex: number;
    if (row.anchor_track_id === null) {
      anchorIndex = -1;
      lastResolved = -1;
    } else {
      const found = indexByKey.get(keyOf(row.anchor_track_id, row.anchor_occurrence));
      if (found !== undefined) {
        anchorIndex = found;
        lastResolved = found;
      } else {
        anchorIndex = lastResolved;
      }
    }
    const group = groups.get(anchorIndex);
    if (group) group.push(row);
    else groups.set(anchorIndex, [row]);
  }

  const out: MergedEntry[] = [];
  const pushOverlay = (row: OverlayRow): void => {
    out.push({
      trackId: row.track_id,
      entrySource: 'rune-overlay',
      entryId: row.id,
      addedAt: row.added_at,
    });
  };

  for (const row of groups.get(-1) ?? []) pushOverlay(row);
  base.forEach((entry, index) => {
    out.push({
      trackId: entry.trackId,
      entrySource: 'spotify-playlist',
      entryId: `sp:${entry.trackId}#${occurrences[index] ?? 0}`,
      addedAt: entry.addedAt,
      occurrence: occurrences[index] ?? 0,
    });
    for (const row of groups.get(index) ?? []) pushOverlay(row);
  });
  return out;
}

/** Merged ordered entries for any playlist (empty base for unknown ids). */
export function mergedEntries(db: Db, playlistId: string): MergedEntry[] {
  ensureOverlaySchema(db);
  return mergeEntries(readBaseEntries(db, playlistId), readOverlayRows(db, playlistId));
}

/**
 * Number of overlay entries whose track still exists. Used to keep
 * `trackCount` in lists/details in step with the merged track list.
 */
export function overlayCount(db: Db, playlistId: string): number {
  ensureOverlaySchema(db);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM playlist_overlay o
        WHERE o.playlist_id = ? AND EXISTS (SELECT 1 FROM tracks t WHERE t.id = o.track_id)`,
    )
    .get(playlistId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function isOverlayEntryId(db: Db, playlistId: string, entryId: string): boolean {
  ensureOverlaySchema(db);
  return (
    db
      .prepare('SELECT 1 FROM playlist_overlay WHERE playlist_id = ? AND id = ?')
      .get(playlistId, entryId) !== undefined
  );
}

/** The anchor (Spotify track id + occurrence) after the given merged position. */
function anchorBefore(
  entries: MergedEntry[],
  at: number,
): { trackId: string | null; occurrence: number } {
  const limit = Math.min(Math.max(at, 0), entries.length);
  for (let i = limit - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry && entry.entrySource === 'spotify-playlist' && entry.occurrence !== undefined) {
      return { trackId: entry.trackId, occurrence: entry.occurrence };
    }
  }
  return { trackId: null, occurrence: 0 };
}

/**
 * Stable ids of the overlay entries that sit directly after the anchor in the given
 * merged list (leading overlays for the top anchor). These are the entries whose
 * relative order can be changed without changing a Spotify anchor.
 */
function groupMemberIds(
  entries: MergedEntry[],
  anchor: { trackId: string | null; occurrence: number },
): string[] {
  let start = 0;
  if (anchor.trackId !== null) {
    const found = entries.findIndex(
      (entry) =>
        entry.entrySource === 'spotify-playlist' &&
        entry.trackId === anchor.trackId &&
        entry.occurrence === anchor.occurrence,
    );
    if (found < 0) return [];
    start = found + 1;
  }
  const ids: string[] = [];
  for (let i = start; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || entry.entrySource === 'spotify-playlist') break;
    ids.push(entry.entryId);
  }
  return ids;
}

/**
 * Insert local tracks into a synced playlist at a merged position. The position is
 * converted to a Spotify anchor: the Spotify entry immediately before it (top when
 * none). Position may equal the merged length (append). Entries already in that
 * anchor group are re-numbered so the new tracks land at exactly the requested spot.
 */
export function addOverlayTracks(
  db: Db,
  playlistId: string,
  trackIds: string[],
  position: number | undefined,
  now: () => number = Date.now,
): void {
  ensureOverlaySchema(db);
  const entries = mergedEntries(db, playlistId);
  const at = Math.min(Math.max(position ?? entries.length, 0), entries.length);
  const anchor = anchorBefore(entries, at);
  const newIds = trackIds.map(() => `ovl:${randomUUID()}`);
  const inserted: MergedEntry[] = newIds.map((entryId, index) => ({
    trackId: trackIds[index] ?? '',
    entrySource: 'rune-overlay',
    entryId,
    addedAt: null,
  }));
  const finalList = [...entries.slice(0, at), ...inserted, ...entries.slice(at)];
  const groupIds = groupMemberIds(finalList, anchor);

  const insert = db.prepare(
    `INSERT INTO playlist_overlay
       (id, playlist_id, track_id, anchor_track_id, anchor_occurrence, added_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const updateTime = db.prepare(
    'UPDATE playlist_overlay SET added_at = ? WHERE playlist_id = ? AND id = ?',
  );
  const existingTimes = readOverlayRows(db, playlistId)
    .filter((row) => groupIds.includes(row.id))
    .map((row) => row.added_at);
  const base = Math.min(now(), ...(existingTimes.length > 0 ? existingTimes : [now()]));
  const tx = db.transaction(() => {
    groupIds.forEach((entryId, index) => {
      const trackIndex = newIds.indexOf(entryId);
      if (trackIndex >= 0) {
        insert.run(
          entryId,
          playlistId,
          trackIds[trackIndex] ?? '',
          anchor.trackId,
          anchor.occurrence,
          base + index,
        );
      } else {
        updateTime.run(base + index, playlistId, entryId);
      }
    });
  });
  tx();
}

/** Remove overlay entries by their stable entry id. */
export function deleteOverlayEntries(db: Db, playlistId: string, entryIds: string[]): void {
  ensureOverlaySchema(db);
  const del = db.prepare('DELETE FROM playlist_overlay WHERE playlist_id = ? AND id = ?');
  const tx = db.transaction(() => {
    for (const entryId of entryIds) del.run(playlistId, entryId);
  });
  tx();
}

function overlayRow(db: Db, playlistId: string, entryId: string): OverlayRow | undefined {
  return db
    .prepare(
      `SELECT id, playlist_id, track_id, anchor_track_id, anchor_occurrence, added_at
         FROM playlist_overlay WHERE playlist_id = ? AND id = ?`,
    )
    .get(playlistId, entryId) as OverlayRow | undefined;
}

/**
 * Move an overlay entry to another merged position (same semantics as the rune
 * playlist move: remove at `from`, insert at `to` in the shortened list).
 * Spotify-owned entries cannot be moved (409).
 */
export function moveOverlayEntry(db: Db, playlistId: string, from: number, to: number): void {
  ensureOverlaySchema(db);
  const entries = mergedEntries(db, playlistId);
  if (from >= entries.length || to >= entries.length) {
    throw new OverlayInputError('from/to out of range');
  }
  const moving = entries[from];
  if (!moving) throw new OverlayInputError('from/to out of range');
  if (moving.entrySource !== 'rune-overlay') {
    throw new OverlayConflictError(
      'Spotify tracks can only be reordered in the Spotify app; move local entries instead',
    );
  }
  const movingRow = overlayRow(db, playlistId, moving.entryId);
  if (!movingRow) throw new OverlayInputError('overlay entry not found');

  const without = [...entries.slice(0, from), ...entries.slice(from + 1)];
  const anchor = anchorBefore(without, to);
  const finalList = [...without.slice(0, to), moving, ...without.slice(to)];

  // Re-number the target group in the desired final order so the read-time grouping
  // reproduces the requested position exactly, even inside an existing group.
  const groupIds = groupMemberIds(finalList, anchor);
  const groupTimes = readOverlayRows(db, playlistId)
    .filter((row) => groupIds.includes(row.id))
    .map((row) => row.added_at);
  const base = groupTimes.length > 0 ? Math.min(...groupTimes) : movingRow.added_at;

  const updateTime = db.prepare(
    'UPDATE playlist_overlay SET added_at = ? WHERE playlist_id = ? AND id = ?',
  );
  const updateMoved = db.prepare(
    `UPDATE playlist_overlay
        SET anchor_track_id = ?, anchor_occurrence = ?, added_at = ?
      WHERE playlist_id = ? AND id = ?`,
  );
  const tx = db.transaction(() => {
    groupIds.forEach((entryId, index) => {
      if (entryId === moving.entryId) {
        updateMoved.run(anchor.trackId, anchor.occurrence, base + index, playlistId, entryId);
      } else {
        updateTime.run(base + index, playlistId, entryId);
      }
    });
  });
  tx();
}
