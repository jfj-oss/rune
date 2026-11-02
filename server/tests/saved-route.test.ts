import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb } from '../src/db/index.js';
import { registerSavedRoute } from '../src/api/saved.js';
import { ensureSpotifyLibrarySchema } from '../src/spotify/library-schema.js';

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function setup() {
  const db = openDb(':memory:');
  ensureSpotifyLibrarySchema(db);
  db.prepare("INSERT INTO artists (id, name) VALUES ('ar:1', 'A')").run();
  const ins = db.prepare("INSERT INTO albums (id, source, title, artist_id, in_library, added_at) VALUES (?, ?, 'T', 'ar:1', ?, 0)");
  ins.run('sp:saved', 'spotify', 1);
  ins.run('sp:cat', 'spotify', 0);
  ins.run('la:1', 'local', 1);
  app = Fastify();
  await app.register(async (r) => registerSavedRoute(r, db), { prefix: '/api' });
  return app;
}

describe('GET /albums/:id/saved', () => {
  it('reports in_library for stored albums', async () => {
    const a = await setup();
    expect((await a.inject('/api/albums/sp:saved/saved')).json()).toEqual({ saved: true });
    expect((await a.inject('/api/albums/sp:cat/saved')).json()).toEqual({ saved: false });
    expect((await a.inject('/api/albums/la:1/saved')).json()).toEqual({ saved: true });
  });
  it('treats an unknown Spotify album as not saved, an unknown local one as 404', async () => {
    const a = await setup();
    expect((await a.inject('/api/albums/sp:never-fetched/saved')).json()).toEqual({ saved: false });
    expect((await a.inject('/api/albums/la:nope/saved')).statusCode).toBe(404);
  });
});
