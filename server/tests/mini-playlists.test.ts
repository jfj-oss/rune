// rune mini playlists: the few playlists shown as dots on the mini player (rune's own table, separate from the pins).
import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerEvent } from '@liner/shared';
import { buildApp } from '../src/api/server.js';
import { openDb, type Db } from '../src/db/index.js';
import { ensureMyPlaylistSchema } from '../src/myplaylists/schema.js';
import { MINI_MAX, miniPlaylists, registerMiniPlaylistRoutes, setMiniPlaylists } from '../src/api/miniPlaylists.js';

process.env.LOG_LEVEL ??= 'silent';

function seed(db: Db, n = 10): void {
  ensureMyPlaylistSchema(db);
  const ins = db.prepare("INSERT INTO playlists (id, source, name, track_count, position, updated_at) VALUES (?, 'spotify', ?, 0, ?, 0)");
  for (let i = 1; i <= n; i++) ins.run(`pl:sp:p${i}`, `Mix ${i}`, i);
}

let app: FastifyInstance | null = null;
afterEach(async () => { await app?.close(); app = null; });

async function setup() {
  const db = openDb(':memory:');
  seed(db);
  let changes = 0;
  app = Fastify();
  await app.register(async (r) => registerMiniPlaylistRoutes(r, db, { onChange: () => { changes++; } }), { prefix: '/api' });
  const get = async () => (await app!.inject({ method: 'GET', url: '/api/mini/playlists' })).json().playlists as { id: string; name: string; color: number }[];
  return { db, changes: () => changes, get };
}

describe('mini playlists (list)', () => {
  it('keeps the order given, names them, and gives each a distinct colour', () => {
    const db = openDb(':memory:');
    seed(db);
    expect(setMiniPlaylists(db, ['pl:sp:p3', 'pl:sp:p1', 'pl:sp:p2'])).toBe(true);
    const list = miniPlaylists(db);
    expect(list.map((p) => p.id)).toEqual(['pl:sp:p3', 'pl:sp:p1', 'pl:sp:p2']);
    expect(list.map((p) => p.name)).toEqual(['Mix 3', 'Mix 1', 'Mix 2']);
    expect(new Set(list.map((p) => p.color)).size).toBe(3);
  });

  it('a playlist keeps its colour when others are added, removed or reordered, and a freed colour is reused', () => {
    const db = openDb(':memory:');
    seed(db);
    setMiniPlaylists(db, ['pl:sp:p1', 'pl:sp:p2', 'pl:sp:p3']);
    const col = () => Object.fromEntries(miniPlaylists(db).map((p) => [p.id, p.color]));
    const first = col();
    setMiniPlaylists(db, ['pl:sp:p3', 'pl:sp:p1']);
    expect(col()).toEqual({ 'pl:sp:p3': first['pl:sp:p3'], 'pl:sp:p1': first['pl:sp:p1'] });
    setMiniPlaylists(db, ['pl:sp:p3', 'pl:sp:p1', 'pl:sp:p4']);
    expect(col()['pl:sp:p4']).toBe(first['pl:sp:p2']); // p2's colour was free
  });

  it('skips a playlist that no longer exists and drops unknown / repeated ids', () => {
    const db = openDb(':memory:');
    seed(db);
    setMiniPlaylists(db, ['pl:sp:p1', 'pl:sp:nope', 'pl:sp:p2', 'pl:sp:p1']);
    expect(miniPlaylists(db).map((p) => p.id)).toEqual(['pl:sp:p1', 'pl:sp:p2']);
    db.prepare("DELETE FROM playlists WHERE id = 'pl:sp:p1'").run();
    expect(miniPlaylists(db).map((p) => p.id)).toEqual(['pl:sp:p2']);
  });

  it(`takes at most ${MINI_MAX} and writes nothing past that`, () => {
    const db = openDb(':memory:');
    seed(db);
    expect(setMiniPlaylists(db, ['pl:sp:p1'])).toBe(true);
    expect(setMiniPlaylists(db, Array.from({ length: 9 }, (_, i) => `pl:sp:p${i + 1}`))).toBe(false);
    expect(miniPlaylists(db).map((p) => p.id)).toEqual(['pl:sp:p1']);
    expect(setMiniPlaylists(db, Array.from({ length: 8 }, (_, i) => `pl:sp:p${i + 1}`))).toBe(true);
    expect(new Set(miniPlaylists(db).map((p) => p.color)).size).toBe(8);
  });

  it('is created by the schema on start: an older database gains the table on reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rune-miniplaylists-'));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'a.db');
    try {
      const first = openDb(file);
      seed(first);
      first.exec('DROP TABLE mini_playlists'); // pretend it predates the feature
      first.close();
      const again = openDb(file);
      expect(setMiniPlaylists(again, ['pl:sp:p2'])).toBe(true);
      again.close();
      const third = openDb(file);
      expect(miniPlaylists(third).map((p) => p.id)).toEqual(['pl:sp:p2']);
      third.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mini playlists (routes)', () => {
  it('adds, lists, reorders and removes, and says so only when something changed', async () => {
    const s = await setup();
    expect(await s.get()).toEqual([]);
    expect((await app!.inject({ method: 'PUT', url: '/api/mini/playlists/pl:sp:p2' })).statusCode).toBe(200);
    await app!.inject({ method: 'PUT', url: '/api/mini/playlists/pl:sp:p1' });
    await app!.inject({ method: 'PUT', url: '/api/mini/playlists/pl:sp:p1' }); // idempotent
    expect(s.changes()).toBe(2);
    expect((await s.get()).map((p) => p.id)).toEqual(['pl:sp:p2', 'pl:sp:p1']);
    const put = await app!.inject({ method: 'PUT', url: '/api/mini/playlists', payload: { ids: ['pl:sp:p1', 'pl:sp:p2'] } });
    expect(put.json().playlists.map((p: { id: string }) => p.id)).toEqual(['pl:sp:p1', 'pl:sp:p2']);
    expect(s.changes()).toBe(3);
    await app!.inject({ method: 'PUT', url: '/api/mini/playlists', payload: { ids: ['pl:sp:p1', 'pl:sp:p2'] } });
    expect(s.changes()).toBe(3); // same list: no push
    await app!.inject({ method: 'DELETE', url: '/api/mini/playlists/pl:sp:p1' });
    expect((await s.get()).map((p) => p.id)).toEqual(['pl:sp:p2']);
    expect(s.changes()).toBe(4);
  });

  it('refuses unknown playlists, a ninth one, and a bad body', async () => {
    const s = await setup();
    expect((await app!.inject({ method: 'PUT', url: '/api/mini/playlists/pl:sp:nope' })).statusCode).toBe(404);
    for (let i = 1; i <= 8; i++) expect((await app!.inject({ method: 'PUT', url: `/api/mini/playlists/pl:sp:p${i}` })).statusCode).toBe(200);
    expect((await app!.inject({ method: 'PUT', url: '/api/mini/playlists/pl:sp:p9' })).statusCode).toBe(409);
    expect((await app!.inject({ method: 'PUT', url: '/api/mini/playlists', payload: { ids: 'x' } })).statusCode).toBe(400);
    expect((await app!.inject({ method: 'PUT', url: '/api/mini/playlists', payload: { ids: Array.from({ length: 9 }, (_, i) => `pl:sp:p${i + 1}`) } })).statusCode).toBe(400);
    expect(await s.get()).toHaveLength(8);
  });
});

describe('mini playlists (websocket push)', () => {
  it('a change made over HTTP reaches every connected client as { type: "mini-playlists" }', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rune-miniplaylists-ws-'));
    const db = openDb(':memory:');
    seed(db);
    const built = await buildApp(db, { libraryRoots: [], dataDir: root, port: 0, audioDevice: 'pipewire', userAgent: 'test' }, { pcZone: false, scanOnStart: false, webDist: join(root, 'none') });
    try {
      const base = (await built.app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws');
      const ws = new WebSocket(`${base}/api/ws`);
      const got: ServerEvent[] = [];
      ws.addEventListener('message', (m) => got.push(JSON.parse(String(m.data))));
      await new Promise<void>((res, rej) => { ws.addEventListener('open', () => res()); ws.addEventListener('error', () => rej(new Error('ws failed'))); });
      await new Promise((r) => setTimeout(r, 100));
      const put = await built.app.inject({ method: 'PUT', url: '/api/mini/playlists/pl:sp:p1' });
      expect(put.statusCode).toBe(200);
      const t0 = Date.now();
      while (!got.some((e) => e.type === 'mini-playlists') && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 25));
      expect(got.filter((e) => e.type === 'mini-playlists')).toHaveLength(1);
      ws.close();
    } finally {
      await built.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
