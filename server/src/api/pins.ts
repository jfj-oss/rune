// Pins: albums and playlists the user keeps at the top of their Library lists.
// Stored in rune's own `pins` table (schema.sql, created on every start, so an
// existing database gets it without a separate migration step). Nothing here
// talks to Spotify: a pin is rune's own note about an item, whatever its source.
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';

export type PinKind = 'album' | 'playlist';

/** Playlist ids start with `pl:`; everything else that can be pinned is an album. */
export function pinKindOf(id: string): PinKind {
  return id.startsWith('pl:') ? 'playlist' : 'album';
}

/** Something that exists in rune: an album row or a playlist row. */
function itemExists(db: Db, id: string, kind: PinKind): boolean {
  const table = kind === 'playlist' ? 'playlists' : 'albums';
  return db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined;
}

export function isPinned(db: Db, id: string): boolean {
  return db.prepare('SELECT 1 FROM pins WHERE item_id = ?').get(id) !== undefined;
}

/** Pinned ids of one kind, newest pin first. */
export function pinnedIds(db: Db, kind: PinKind): string[] {
  return (
    db.prepare('SELECT item_id FROM pins WHERE kind = ? ORDER BY pinned_at DESC').all(kind) as { item_id: string }[]
  ).map((r) => r.item_id);
}

/** Pin or unpin; returns whether anything changed. */
export function setPinned(db: Db, id: string, pinned: boolean, now = Date.now()): boolean {
  if (pinned) {
    const r = db
      .prepare('INSERT INTO pins (item_id, kind, pinned_at) VALUES (?, ?, ?) ON CONFLICT(item_id) DO NOTHING')
      .run(id, pinKindOf(id), now);
    return r.changes > 0;
  }
  return db.prepare('DELETE FROM pins WHERE item_id = ?').run(id).changes > 0;
}

export interface PinRouteDeps {
  /** Called after a pin really changed (lists re-sort). */
  onChange?(): void;
}

/**
 * GET /pins → { albums: string[], playlists: string[] } (newest pin first)
 * PUT /pins/:id → { pinned: true }      DELETE /pins/:id → { pinned: false }
 * 404 when the album / playlist is unknown to rune.
 */
export function registerPinRoutes(r: FastifyInstance, db: Db, deps: PinRouteDeps = {}): void {
  r.get('/pins', async () => ({ albums: pinnedIds(db, 'album'), playlists: pinnedIds(db, 'playlist') }));

  r.put<{ Params: { id: string } }>('/pins/:id', async (req, reply) => {
    const id = req.params.id;
    const kind = pinKindOf(id);
    if (!itemExists(db, id, kind)) return reply.code(404).send({ error: 'not found' });
    if (setPinned(db, id, true)) deps.onChange?.();
    return { pinned: true, kind };
  });

  r.delete<{ Params: { id: string } }>('/pins/:id', async (req) => {
    const id = req.params.id;
    if (setPinned(db, id, false)) deps.onChange?.();
    return { pinned: false, kind: pinKindOf(id) };
  });
}
