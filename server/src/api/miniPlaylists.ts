// rune mini playlists: the few playlists (at most 8) shown as coloured dots on the mini player, each one click from a
// shuffled play. Kept in rune's own `mini_playlists` table (schema.sql, created on every start, so an existing database
// gets it without a migration step). It is a separate choice from the Library pins; nothing here talks to Spotify.
import type { FastifyInstance } from 'fastify';
import type { MiniPlaylist } from '@liner/shared';
import type { Db } from '../db/index.js';

export const MINI_MAX = 8;


interface Row { item_id: string; color: number; name: string | null }

/** The chosen playlists in order. A playlist rune no longer has is skipped (its row is cleaned up on the next write). */
export function miniPlaylists(db: Db): MiniPlaylist[] {
  const rows = db
    .prepare('SELECT m.item_id, m.color, p.name FROM mini_playlists m LEFT JOIN playlists p ON p.id = m.item_id ORDER BY m.position')
    .all() as Row[];
  return rows.filter((r) => r.name !== null).map((r) => ({ id: r.item_id, name: r.name as string, color: r.color }));
}

function exists(db: Db, id: string): boolean {
  return db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(id) !== undefined;
}

/**
 * Make `ids` the list (order = order given). Unknown and repeated ids are dropped; colours of ids already on the list are
 * kept and new ones take the lowest colour no one else uses. Returns false (nothing written) when more than MINI_MAX remain.
 */
export function setMiniPlaylists(db: Db, ids: string[]): boolean {
  const want = [...new Set(ids)].filter((id) => exists(db, id));
  if (want.length > MINI_MAX) return false;
  const had = new Map((db.prepare('SELECT item_id, color FROM mini_playlists').all() as { item_id: string; color: number }[]).map((r) => [r.item_id, r.color]));
  const used = new Set(want.filter((id) => had.has(id)).map((id) => had.get(id)!));
  const next = () => { let c = 0; while (used.has(c)) c++; used.add(c); return c; };
  const colors = want.map((id) => had.get(id) ?? next());
  db.transaction(() => {
    db.prepare('DELETE FROM mini_playlists').run();
    const ins = db.prepare('INSERT INTO mini_playlists (item_id, position, color) VALUES (?, ?, ?)');
    want.forEach((id, i) => ins.run(id, i, colors[i]));
  })();
  return true;
}

export interface MiniRouteDeps {
  /** Called after the list really changed (open minis redraw). */
  onChange?(): void;
}

/**
 * GET /mini/playlists → { playlists: [{ id, name, color }] }
 * PUT /mini/playlists { ids } → the same (replace / reorder; unknown ids dropped; 400 over 8)
 * PUT /mini/playlists/:id → add at the end (404 unknown, 409 when 8 are chosen)   DELETE /mini/playlists/:id → remove
 */
export function registerMiniPlaylistRoutes(r: FastifyInstance, db: Db, deps: MiniRouteDeps = {}): void {
  const view = () => ({ playlists: miniPlaylists(db) });
  const apply = (ids: string[]) => {
    const before = JSON.stringify(miniPlaylists(db));
    if (!setMiniPlaylists(db, ids)) return false;
    if (JSON.stringify(miniPlaylists(db)) !== before) deps.onChange?.();
    return true;
  };

  r.get('/mini/playlists', async () => view());

  r.put<{ Body: { ids?: unknown } }>('/mini/playlists', async (req, reply) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) return reply.code(400).send({ error: 'send { ids: [playlist ids] }' });
    if (!apply(ids as string[])) return reply.code(400).send({ error: `at most ${MINI_MAX} playlists fit on the mini` });
    return view();
  });

  r.put<{ Params: { id: string } }>('/mini/playlists/:id', async (req, reply) => {
    const id = req.params.id;
    if (!exists(db, id)) return reply.code(404).send({ error: 'not found' });
    const cur = miniPlaylists(db).map((p) => p.id);
    if (cur.includes(id)) return view();
    if (cur.length >= MINI_MAX) return reply.code(409).send({ error: `the mini has room for ${MINI_MAX} playlists` });
    apply([...cur, id]);
    return view();
  });

  r.delete<{ Params: { id: string } }>('/mini/playlists/:id', async (req) => {
    apply(miniPlaylists(db).map((p) => p.id).filter((x) => x !== req.params.id));
    return view();
  });
}
