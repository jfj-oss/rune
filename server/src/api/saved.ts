// Is a Spotify album part of the user's saved library? (albums.in_library; the album page's Save/Saved toggle.)
// Read-only. Registered under /api by the main server, next to the existing POST/DELETE /albums/:id/save.
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { ensureSpotifyLibrarySchema } from '../spotify/library-schema.js';

export function registerSavedRoute(r: FastifyInstance, db: Db): void {
  ensureSpotifyLibrarySchema(db); // albums.in_library (idempotent)
  r.get<{ Params: { id: string } }>('/albums/:id/saved', async (req, reply) => {
    const row = db.prepare('SELECT in_library AS saved FROM albums WHERE id = ?').get(req.params.id) as { saved: number } | undefined;
    // An album that was never fetched (a catalogue hit) is simply not saved.
    if (!row) return req.params.id.startsWith('sp:') ? { saved: false } : reply.code(404).send({ error: 'not found' });
    return { saved: row.saved === 1 };
  });
}
