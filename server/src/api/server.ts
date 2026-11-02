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
import { createSpotify, type CreateSpotifyOptions } from '../spotify/index.js';
import { mergeSearchResults } from '../spotify/catalog.js';
import { createMeta, registerMetaRoutes } from '../meta/index.js';
import { createArtistMeta, registerArtistMetaRoutes } from '../meta/artist.js';
import { registerBrowseRoutes } from './browse.js';
import { registerSavedRoute } from './saved.js';
import { registerFrameRoutes } from './frame.js';
import { createHistory, registerHistoryRoutes } from '../history/index.js';
import { coverPath, getAlbum, getArtist, listAlbums, listArtists, search, publicTrack, type AlbumListQuery } from './library.js';

export interface AppOptions {
  /** Start mpv for the PC zone (false in tests). */
  pcZone?: boolean;
  /** Scan + match on startup. */
  scanOnStart?: boolean;
  /** Injected Spotify options (fake fetch/endpoints for tests and self-checks). */
  spotifyOptions?: Omit<CreateSpotifyOptions, 'onLogin'>;
  /** Sync the Spotify library shortly after startup (default true when connected). */
  spotifySyncOnStart?: boolean;
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
  const history = createHistory(db);
  const lastState = new Map<Zone, PlayerState>();
  const recordHistory = (state: PlayerState) => {
    const prev = lastState.get(state.zone);
    if (prev) history.recordFromState(prev, state);
    lastState.set(state.zone, state);
  };
  pc?.onChange((state) => {
    recordHistory(state);
    broadcast({ type: 'player', state: sanitize(state) });
  });
  const spotify = cfg.spotifyClientId
    ? createSpotify(db, cfg, {
        ...opts.spotifyOptions,
        // Login callback fires this without awaiting: the redirect must not wait
        // for the Spotify library to download.
        onLogin: () => {
          void runSpotifySync();
        },
      })
    : undefined;
  spotify?.registerRoutes(app);
  const spotifyListeners = new Map<Zone, () => void>();

  // One Spotify sync at a time; scan/scheduler/login/manual all share it.
  let spotifySyncInFlight: Promise<void> | null = null;
  function runSpotifySync(): Promise<void> {
    if (!spotify) return Promise.resolve();
    if (spotifySyncInFlight) return spotifySyncInFlight;
    spotifySyncInFlight = (async () => {
      try {
        const result = await spotify.syncLibrary();
        app.log.info({ result }, 'spotify library sync complete');
        broadcast({ type: 'library-changed' });
      } catch (err) {
        // 429s are handled/retried inside the API client; anything else is logged
        // and the next scheduled sync retries.
        app.log.warn({ err }, 'spotify library sync failed');
      } finally {
        spotifySyncInFlight = null;
      }
    })();
    return spotifySyncInFlight;
  }
  async function spotifySyncIfConnected(): Promise<void> {
    if (!spotify) return;
    try {
      if ((await spotify.auth.status()).connected) await runSpotifySync();
    } catch (err) {
      app.log.warn({ err }, 'spotify sync trigger failed');
    }
  }

  function zoneFor(id: Zone): PlaybackZone | undefined {
    if (id === 'pc') return pc;
    if (id.startsWith('spotify:') && spotify) {
      const z = spotify.zones.get(id);
      if (z && !spotifyListeners.has(id)) {
        spotifyListeners.set(
          id,
          z.onChange((state) => {
            recordHistory(state);
            broadcast({ type: 'player', state: sanitize(state) });
          }),
        );
      }
      return z;
    }
    return undefined;
  }

  // ---------- scan + match pipeline
  const scanner = createScanner(db, cfg);
  const matcher = createMatcher(db, cfg);
  const meta = createMeta(db, cfg);
  const artistMeta = createArtistMeta(db, cfg);
  let detailsRunning = false;
  /** Prefetch album details in the background (one album at a time, after matching). */
  async function prefetchDetails(): Promise<void> {
    if (detailsRunning) return;
    detailsRunning = true;
    try {
      const pending = db
        .prepare(
          `SELECT a.id FROM albums a LEFT JOIN album_details d ON d.album_id = a.id
           WHERE d.album_id IS NULL AND a.source = 'local' ORDER BY a.mb_release_id IS NULL, a.added_at DESC`,
        )
        .all() as { id: string }[];
      for (const { id } of pending) {
        if (scanning) break; // a rescan/match is running; resume afterwards
        await meta.getDetails(id).catch((e) => app.log.warn({ err: e, id }, 'details failed'));
      }
    } finally {
      detailsRunning = false;
    }
  }
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
          await runSpotifySync();
        }
      } catch (e) {
        app.log.error({ err: e }, 'scan failed');
      } finally {
        last = { ...last, running: false };
        broadcast({ type: 'scan', progress: last });
        broadcast({ type: 'library-changed' });
        scanning = null;
        // after scanning is cleared — prefetchDetails stops while a scan runs
        setTimeout(() => void prefetchDetails(), 1000);
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
        let album = getAlbum(db, req.params.id);
        // Spotify albums referenced by search/playlists may not be stored yet:
        // fetch on demand (in_library = 0) and return the stored row.
        if (!album && spotify && req.params.id.startsWith('sp:')) {
          try {
            if ((await spotify.auth.status()).connected) {
              album = await spotify.fetchAlbum(req.params.id);
            }
          } catch (err) {
            app.log.warn({ err, albumId: req.params.id }, 'on-demand spotify album fetch failed');
          }
        }
        return album ?? reply.code(404).send({ error: 'not found' });
      });

      r.post<{ Params: { id: string } }>('/albums/:id/save', async (req, reply) => {
        if (!spotify || !(await spotify.auth.status()).connected) {
          return reply.code(400).send({ error: 'not_connected' });
        }
        if (!req.params.id.startsWith('sp:')) {
          return reply.code(400).send({ error: 'only Spotify albums can be saved' });
        }
        try {
          const album = await spotify.setAlbumSaved(req.params.id, true);
          if (!album) return reply.code(404).send({ error: 'not found' });
          broadcast({ type: 'library-changed' });
          return album;
        } catch (err) {
          return reply.code(502).send({ error: (err as Error).message });
        }
      });

      r.delete<{ Params: { id: string } }>('/albums/:id/save', async (req, reply) => {
        if (!spotify || !(await spotify.auth.status()).connected) {
          return reply.code(400).send({ error: 'not_connected' });
        }
        if (!req.params.id.startsWith('sp:')) {
          return reply.code(400).send({ error: 'only Spotify albums can be saved' });
        }
        try {
          const album = await spotify.setAlbumSaved(req.params.id, false);
          if (!album) return reply.code(404).send({ error: 'not found' });
          broadcast({ type: 'library-changed' });
          return album;
        } catch (err) {
          return reply.code(502).send({ error: (err as Error).message });
        }
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
        meta.invalidate(req.params.id);
        broadcast({ type: 'library-changed' });
        return getAlbum(db, req.params.id);
      });

      registerMetaRoutes(r, meta);
      registerArtistMetaRoutes(r, artistMeta);
      registerBrowseRoutes(r, db);
      registerSavedRoute(r, db);
      registerFrameRoutes(r);
      registerHistoryRoutes(r, history);

      r.get<{ Params: { id: string } }>('/artists/:id', async (req, reply) => {
        const a = getArtist(db, req.params.id);
        return a ?? reply.code(404).send({ error: 'not found' });
      });
      r.get<{ Querystring: { q?: string } }>('/artists', async (req) => listArtists(db, req.query.q));

      r.get<{ Querystring: { q?: string } }>('/search', async (req) => {
        const q = (req.query.q ?? '').trim();
        if (!q) return { albums: [], artists: [], tracks: [] };
        const local = search(db, q);
        if (!spotify) return local;
        try {
          if (!(await spotify.auth.status()).connected) return local;
          // Local hits first, then Spotify catalogue hits (60 s cache inside).
          return mergeSearchResults(local, await spotify.searchCatalog(q));
        } catch (err) {
          app.log.warn({ err }, 'spotify catalogue search failed');
          return local;
        }
      });

      r.get('/playlists', async () => (spotify ? spotify.listPlaylists() : []));

      r.get<{ Params: { id: string } }>('/playlists/:id', async (req, reply) => {
        const playlist = spotify?.getPlaylist(req.params.id);
        return playlist ?? reply.code(404).send({ error: 'not found' });
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

      // Manual Spotify sync: starts in the background, never waits for Spotify.
      r.post('/spotify/sync', async (_req, reply) => {
        if (!spotify) return reply.code(404).send({ error: 'spotify not configured' });
        if (!(await spotify.auth.status()).connected) {
          return reply.code(400).send({ error: 'not_connected' });
        }
        const started = spotifySyncInFlight === null;
        void runSpotifySync();
        return { started, running: true };
      });
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

  // Spotify library: once shortly after startup, then every 30 minutes. The
  // first sync waits for the DB/HTTP server to settle; neither trigger blocks a
  // request (runSpotifySync is fire-and-forget from routes).
  let spotifyStartTimer: ReturnType<typeof setTimeout> | null = null;
  let spotifyInterval: ReturnType<typeof setInterval> | null = null;
  if (spotify && opts.spotifySyncOnStart !== false) {
    spotifyStartTimer = setTimeout(() => {
      void spotifySyncIfConnected();
    }, 1000);
    spotifyStartTimer.unref?.();
    spotifyInterval = setInterval(() => {
      void spotifySyncIfConnected();
    }, 30 * 60_000);
    spotifyInterval.unref?.();
  }

  return {
    app,
    close: async () => {
      if (spotifyStartTimer) clearTimeout(spotifyStartTimer);
      if (spotifyInterval) clearInterval(spotifyInterval);
      if (spotifySyncInFlight) await spotifySyncInFlight.catch(() => undefined);
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
