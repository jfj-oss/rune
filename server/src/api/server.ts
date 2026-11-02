// Wires every module into one Fastify app. Main-session code.
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync, mkdirSync, statSync, createReadStream } from 'node:fs';
import { join, extname } from 'node:path';
import { execFile } from 'node:child_process';
import type { PlayerCommand, PlayerState, ScanProgress, ServerEvent, Zone } from '@liner/shared';
import type { Db } from '../db/index.js';
import type { Config } from '../config.js';
import type { PlaybackZone } from '../modules.js';
import { createScanner } from '../scan/index.js';
import { createMatcher } from '../match/index.js';
import { createPcZone, registerStreamRoutes } from '../play/index.js';
import { createSpotify } from '../spotify/index.js';
import { coverPath, getAlbum, getArtist, listAlbums, listArtists, search, publicTrack, type AlbumListQuery } from './library.js';

export interface AppOptions {
  /** Start mpv for the PC zone (false in tests). */
  pcZone?: boolean;
  /** Scan + match on startup. */
  scanOnStart?: boolean;
  webDist?: string;
}

const IMAGE_TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

export async function buildApp(db: Db, cfg: Config, opts: AppOptions = {}): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  await app.register(websocket);

  // ---------- live events
  const clients = new Set<{ send: (s: string) => void }>();
  const broadcast = (ev: ServerEvent) => {
    const s = JSON.stringify(ev);
    for (const c of clients) {
      try {
        c.send(s);
      } catch {
        /* dropped */
      }
    }
  };

  // ---------- zones
  const pc: PlaybackZone | undefined = opts.pcZone === false ? undefined : await createPcZone(db, cfg);
  pc?.onChange((state) => broadcast({ type: 'player', state: sanitize(state) }));
  const spotify = cfg.spotifyClientId ? createSpotify(db, cfg) : undefined;
  spotify?.registerRoutes(app);
  const spotifyListeners = new Map<Zone, () => void>();

  function zoneFor(id: Zone): PlaybackZone | undefined {
    if (id === 'pc') return pc;
    if (id.startsWith('spotify:') && spotify) {
      const z = spotify.zones.get(id);
      if (z && !spotifyListeners.has(id)) {
        spotifyListeners.set(id, z.onChange((state) => broadcast({ type: 'player', state: sanitize(state) })));
      }
      return z;
    }
    return undefined;
  }

  // ---------- scan + match pipeline
  const scanner = createScanner(db, cfg);
  const matcher = createMatcher(db, cfg);
  let scanning: Promise<void> | null = null;
  let last: ScanProgress = { running: false, filesSeen: 0, albumsFound: 0, matched: 0, errors: 0 };
  function runScan(): Promise<void> {
    if (scanning) return scanning;
    scanning = (async () => {
      try {
        last = await scanner.scan((p) => {
          last = p;
          broadcast({ type: 'scan', progress: p });
        });
        broadcast({ type: 'library-changed' });
        await matcher.matchPending((done, total) => {
          last = { ...last, running: true, matched: done };
          broadcast({ type: 'scan', progress: last });
          if (done % 10 === 0 || done === total) broadcast({ type: 'library-changed' });
        });
        if (spotify && (await spotify.auth.status()).connected) {
          await spotify.syncSavedAlbums().catch((e) => app.log.warn({ err: e }, 'spotify sync failed'));
        }
      } catch (e) {
        app.log.error({ err: e }, 'scan failed');
      } finally {
        last = { ...last, running: false };
        broadcast({ type: 'scan', progress: last });
        broadcast({ type: 'library-changed' });
        scanning = null;
      }
    })();
    return scanning;
  }

  // ---------- routes
  await app.register(
    async (r) => {
      r.get('/ws', { websocket: true }, (socket) => {
        clients.add(socket);
        socket.on('close', () => clients.delete(socket));
        if (pc) socket.send(JSON.stringify({ type: 'player', state: sanitize(pc.state()) } satisfies ServerEvent));
        socket.send(JSON.stringify({ type: 'scan', progress: last } satisfies ServerEvent));
      });

      r.get<{ Querystring: Record<string, string | undefined> }>('/library/albums', async (req) => {
        const q = req.query;
        const query: AlbumListQuery = {
          q: q.q,
          source: (q.source as AlbumListQuery['source']) ?? 'all',
          sort: q.sort as AlbumListQuery['sort'],
          offset: q.offset ? Number(q.offset) : undefined,
          limit: q.limit ? Number(q.limit) : undefined,
          genre: q.genre,
          label: q.label,
          year: q.year ? Number(q.year) : undefined,
          artistId: q.artist,
        };
        return listAlbums(db, query);
      });

      r.get<{ Params: { id: string } }>('/albums/:id', async (req, reply) => {
        const a = getAlbum(db, req.params.id);
        return a ?? reply.code(404).send({ error: 'not found' });
      });

      r.get<{ Params: { id: string } }>('/albums/:id/candidates', async (req, reply) => {
        if (!getAlbum(db, req.params.id)) return reply.code(404).send({ error: 'not found' });
        const c = await matcher.candidates(req.params.id);
        return c.map((x) => ({ musicbrainzReleaseId: x.mbReleaseId, title: x.title, artist: x.artist, year: x.year, trackCount: x.tracks, country: x.country, score: x.score }));
      });

      r.post<{ Params: { id: string }; Body: { musicbrainzReleaseId?: string } }>('/albums/:id/match', async (req, reply) => {
        const mbid = req.body?.musicbrainzReleaseId;
        if (!mbid || !/^[0-9a-f-]{36}$/i.test(mbid)) return reply.code(400).send({ error: 'musicbrainzReleaseId required' });
        await matcher.setRelease(req.params.id, mbid);
        broadcast({ type: 'library-changed' });
        return getAlbum(db, req.params.id);
      });

      r.get<{ Params: { id: string } }>('/artists/:id', async (req, reply) => {
        const a = getArtist(db, req.params.id);
        return a ?? reply.code(404).send({ error: 'not found' });
      });
      r.get<{ Querystring: { q?: string } }>('/artists', async (req) => listArtists(db, req.query.q));

      r.get<{ Querystring: { q?: string } }>('/search', async (req) => {
        const q = (req.query.q ?? '').trim();
        if (!q) return { albums: [], artists: [], tracks: [] };
        return search(db, q);
      });

      r.get<{ Params: { id: string } }>('/tracks/:id', async (req, reply) => {
        const { loadTrack } = await import('../play/rows.js');
        const t = loadTrack(db, req.params.id);
        return t ? publicTrack(t) : reply.code(404).send({ error: 'not found' });
      });

      r.get<{ Params: { id: string }; Querystring: { size?: string } }>('/cover/:id', async (req, reply) => {
        const p = coverPath(db, req.params.id);
        if (!p) return reply.code(404).send({ error: 'no cover' });
        if (/^https?:\/\//.test(p)) return reply.redirect(p);
        if (!existsSync(p)) return reply.code(404).send({ error: 'cover missing' });
        const size = req.query.size === '200' ? 200 : req.query.size === 'full' ? 0 : 600;
        const file = size ? await thumbnail(cfg, req.params.id, p, size) : p;
        reply.header('cache-control', 'public, max-age=86400');
        reply.type(IMAGE_TYPES[extname(file).toLowerCase()] ?? 'image/jpeg');
        return reply.send(createReadStream(file));
      });

      r.get('/zones', async () => {
        const zones: { id: Zone; name: string; kind: 'pc' | 'browser' | 'spotify' }[] = [];
        if (pc) zones.push({ id: 'pc', name: 'Linux PC speakers', kind: 'pc' });
        if (spotify && (await spotify.auth.status()).connected) {
          try {
            zones.push(...(await spotify.zones.listZones()));
          } catch (e) {
            app.log.warn({ err: e }, 'spotify devices failed');
          }
        }
        return zones;
      });

      r.get<{ Params: { zone: string } }>('/player/:zone', async (req, reply) => {
        const z = zoneFor(req.params.zone);
        return z ? sanitize(z.state()) : reply.code(404).send({ error: 'unknown zone' });
      });

      r.post<{ Params: { zone: string }; Body: PlayerCommand }>('/player/:zone', async (req, reply) => {
        const z = zoneFor(req.params.zone);
        if (!z) return reply.code(404).send({ error: 'unknown zone' });
        try {
          return sanitize(await z.command(req.body));
        } catch (e) {
          return reply.code(400).send({ error: (e as Error).message });
        }
      });

      r.post('/scan', async () => {
        void runScan();
        return { started: true };
      });
      r.get('/scan', async () => last);
    },
    { prefix: '/api' },
  );
  registerStreamRoutes(app, db, cfg);

  // ---------- web UI (built) with SPA fallback
  const dist = opts.webDist ?? new URL('../../../web/dist', import.meta.url).pathname;
  if (existsSync(join(dist, 'index.html'))) {
    await app.register(fastifyStatic, { root: dist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  if (opts.scanOnStart !== false) setTimeout(() => void runScan(), 500);

  return {
    app,
    close: async () => {
      for (const off of spotifyListeners.values()) off();
      await spotify?.zones.close();
      await pc?.close();
      await app.close();
    },
  };
}

/** Player states carry Track objects; never leak file paths. */
function sanitize(s: PlayerState): PlayerState {
  return { ...s, queue: s.queue.map((q) => ({ ...q, track: publicTrack(q.track) })) };
}

const thumbJobs = new Map<string, Promise<string>>();
/** Resize covers with ffmpeg into <dataDir>/thumbs, cached by source mtime. */
function thumbnail(cfg: Config, albumId: string, src: string, size: number): Promise<string> {
  const dir = join(cfg.dataDir, 'thumbs');
  mkdirSync(dir, { recursive: true });
  const mtime = Math.round(statSync(src).mtimeMs);
  const out = join(dir, `${albumId.replace(/[^a-z0-9]/gi, '_')}-${size}-${mtime}.jpg`);
  if (existsSync(out)) return Promise.resolve(out);
  let job = thumbJobs.get(out);
  if (!job) {
    job = new Promise<string>((resolve) => {
      execFile(
        'ffmpeg',
        ['-v', 'error', '-y', '-i', src, '-vf', `scale='min(${size},iw)':-2:flags=lanczos`, '-frames:v', '1', '-q:v', '3', out],
        { timeout: 20_000 },
        (err) => resolve(err ? src : out),
      );
    }).finally(() => thumbJobs.delete(out));
    thumbJobs.set(out, job);
  }
  return job;
}
