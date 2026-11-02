// Wires every module into one Fastify app. Main-session code.
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync, mkdirSync, statSync, createReadStream } from 'node:fs';
import { join, extname } from 'node:path';
import { execFile } from 'node:child_process';
import type { AlbumSummary, ArtistRef, PlayerCommand, PlayerState, ScanProgress, ServerEvent, Track, Zone } from '@liner/shared';
import type { Db } from '../db/index.js';
import type { Config } from '../config.js';
import type { PlaybackZone } from '../modules.js';
import { createScanner } from '../scan/index.js';
import { createMatcher } from '../match/index.js';
import { createPcZone, registerStreamRoutes, type PcZone } from '../play/index.js';
import { createSpotify, type CreateSpotifyOptions } from '../spotify/index.js';
import { mergeSearchResults } from '../spotify/catalog.js';
import { spotifyAlbumIsFull } from '../spotify/library.js';
import { createLinking, registerLinkRoutes, ensureLinkSchema } from '../spotify/linking.js';
import { ensureSpotifyLibrarySchema } from '../spotify/library-schema.js';
import { createMeta, registerMetaRoutes } from '../meta/index.js';
import { createArtistMeta, registerArtistMetaRoutes } from '../meta/artist.js';
import { registerBrowseRoutes } from './browse.js';
import { registerSavedRoute } from './saved.js';
import { registerFrameRoutes } from './frame.js';
import { createHistory, ensureHistorySchema, registerHistoryRoutes } from '../history/index.js';
import { coverPath, getAlbum, getArtist, listAlbums, listArtists, publicTrack, type AlbumListQuery } from './library.js';
import { createLoudness, ensureLoudnessSchema, registerLoudnessRoutes } from '../loudness/index.js';
import { albumNotHiddenSql, ensureDupesSchema, registerDupesRoutes } from '../library/dupes.js';
import { createRadio, registerRadioRoutes } from '../radio/index.js';
import {
  getPlaylistDetail,
  listAllPlaylists,
  registerMyPlaylistRoutes,
} from '../myplaylists/index.js';
import { ensureMyPlaylistSchema } from '../myplaylists/schema.js';
import { createPeaks, registerPeaksRoutes } from '../peaks/index.js';
import { ensurePeopleSchema, registerPeopleRoutes } from '../people/index.js';
import { createEditions, ensureEditionsSchema, registerEditionsRoutes } from '../editions/index.js';
import { ensureStatsSchema, registerStatsRoutes } from '../stats/index.js';
import { createIradio, ensureRadioSchema, registerRadioStationRoutes } from '../iradio/index.js';
import { createSearch, ensureSearchSchema, registerSearchRoutes } from '../search/index.js';
import { createLibraryWatcher, type LibraryWatcher } from '../watch/index.js';
import { rootsStatus } from '../watch/root-status.js';
import {
  createBackupService,
  createShutdownHandler,
  registerOpsRoutes,
  type BackupService,
  type ShutdownResult,
} from '../ops/index.js';

export interface AppOptions {
  /** Start mpv for the PC zone (false in tests). */
  pcZone?: boolean;
  /** Scan + match on startup. */
  scanOnStart?: boolean;
  /** Injected Spotify options (fake fetch/endpoints for tests and self-checks). */
  spotifyOptions?: Omit<CreateSpotifyOptions, 'onLogin'>;
  /** Sync the Spotify library shortly after startup (default true when connected). */
  spotifySyncOnStart?: boolean;
  /** Watch library roots and start an incremental scan on change (default false; main.ts enables). */
  watch?: boolean;
  /** Nightly database backups + retention (default false; main.ts enables). */
  backups?: boolean;
  webDist?: string;
}

export interface BuiltApp {
  app: FastifyInstance;
  /** Stop background jobs and close playback/HTTP. Does not close the Db. */
  close: () => Promise<void>;
  /** Graceful SIGINT/SIGTERM teardown: watcher, in-flight work, WAL checkpoint, modules, Db. */
  shutdown: (reason?: string) => Promise<ShutdownResult>;
}

const IMAGE_TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

/** A real MusicBrainz release id: 5 hyphen-separated hex groups (not just 36 of anything). */
const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fastify yields an array for repeated query keys (`?q=a&q=b`); take the first. */
function queryValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export async function buildApp(db: Db, cfg: Config, opts: AppOptions = {}): Promise<BuiltApp> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  await app.register(websocket);
  const startedAt = Date.now();

  // ---------- migrations (schema.sql ran in openDb; module migrations run here)
  // Order matters where one module builds on another: Spotify playlists exist
  // before rune playlists add columns, history exists before stats index it.
  ensureSpotifyLibrarySchema(db);
  ensureMyPlaylistSchema(db);
  ensureHistorySchema(db);
  ensureStatsSchema(db);
  ensureLoudnessSchema(db);
  ensureDupesSchema(db);
  ensurePeopleSchema(db);
  ensureEditionsSchema(db);
  ensureSearchSchema(db);
  ensureLinkSchema(db);
  ensureRadioSchema(db);

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
  const pc: PcZone | undefined = opts.pcZone === false ? undefined : await createPcZone(db, cfg);
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
          void runSpotifySync({ force: true });
        },
      })
    : undefined;
  spotify?.registerRoutes(app);
  const spotifyListeners = new Map<Zone, () => void>();

  // ---------- feature modules (services; their routes are registered under /api)
  const loudness = createLoudness(db, cfg, { log: (msg) => app.log.warn(msg) });
  const radio = createRadio(db);
  const peaks = createPeaks(db, cfg);
  const editions = createEditions(db, cfg);
  const iradio = createIradio(db, cfg);
  const searchIndex = createSearch(db);
  // Linking shares the Spotify API (and its 429/Retry-After handling) with the
  // library sync; MusicBrainz goes through the shared client in src/match/mb.ts.
  const linking = spotify ? createLinking(db, cfg, { api: spotify.api }) : undefined;

  // One Spotify sync at a time; scan/scheduler/login/manual all share it.
  // Persisted throttle: restarts must not resync (a full Liked Songs pass is ~100
  // requests), and a long Retry-After from Spotify is honoured across restarts.
  db.exec('CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const getState = (k: string) => (db.prepare('SELECT value FROM app_state WHERE key = ?').get(k) as { value: string } | undefined)?.value;
  const setState = (k: string, v: string) =>
    db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
  // Auto-radio: keep the PC zone playing when its queue runs out (default on).
  const AUTO_RADIO_KEY = 'settings.autoRadio';
  const autoRadioEnabled = (): boolean => getState(AUTO_RADIO_KEY) !== '0';
  const SYNC_MIN_GAP_MS = 25 * 60_000;
  let spotifySyncInFlight: Promise<void> | null = null;
  function runSpotifySync(opts: { force?: boolean } = {}): Promise<void> {
    if (!spotify) return Promise.resolve();
    if (spotifySyncInFlight) return spotifySyncInFlight;
    const nowMs = Date.now();
    const blockedUntil = Number(getState('spotify.blockedUntil') ?? 0);
    if (blockedUntil > nowMs) {
      app.log.warn({ until: new Date(blockedUntil).toISOString() }, 'spotify sync skipped: rate limited');
      return Promise.resolve();
    }
    // Liked Songs has its own block so a /me/tracks rate limit never stops playlist syncs.
    const skipLiked = Number(getState('spotify.likedBlockedUntil') ?? 0) > nowMs;
    const skipSaved = Number(getState('spotify.savedBlockedUntil') ?? 0) > nowMs;
    if (!opts.force && nowMs - Number(getState('spotify.lastSync') ?? 0) < SYNC_MIN_GAP_MS) return Promise.resolve();
    spotifySyncInFlight = (async () => {
      try {
        setState('spotify.lastSync', String(Date.now()));
        const result = await spotify.syncLibrary({ skipLiked, skipSaved });
        const likedRetry = result.playlists?.likedRetryAfterMs;
        if (likedRetry) setState('spotify.likedBlockedUntil', String(Date.now() + likedRetry));
        if (result.savedRetryAfterMs) setState('spotify.savedBlockedUntil', String(Date.now() + result.savedRetryAfterMs));
        app.log.info({ result }, 'spotify library sync complete');
        try {
          searchIndex.reindex();
        } catch (e) {
          app.log.warn({ err: e }, 'search reindex failed');
        }
        broadcast({ type: 'library-changed' });
      } catch (err) {
        const retry = (err as { status?: number; retryAfterMs?: number }).status === 429 ? (err as { retryAfterMs?: number }).retryAfterMs : undefined;
        if (retry) setState('spotify.blockedUntil', String(Date.now() + retry));
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

  // Spotify ↔ local linking (worker W): runs in the background after matching,
  // never blocks a scan. Sharing the persisted throttle means a long Retry-After
  // from Spotify suppresses linking as well as the library sync.
  let linkingInFlight: Promise<void> | null = null;
  function runLinkingInBackground(): void {
    if (!linking || linkingInFlight) return;
    if (Number(getState('spotify.blockedUntil') ?? 0) > Date.now()) return;
    linkingInFlight = (async () => {
      try {
        if (!(await spotify!.auth.status()).connected) return;
        const result = await linking!.linkPending();
        if (result.linked > 0) broadcast({ type: 'library-changed' });
        app.log.info({ result }, 'spotify linking complete');
      } catch (err) {
        app.log.warn({ err }, 'spotify linking failed');
      } finally {
        linkingInFlight = null;
      }
    })();
  }

  async function zoneFor(id: Zone): Promise<PlaybackZone | undefined> {
    if (id === 'pc') return pc;
    if (id.startsWith('spotify:') && spotify) {
      // After a restart the Connect zones are unknown until the device list is read.
      if (!spotify.zones.get(id)) await spotify.zones.listZones().catch(() => undefined);
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
  let lastScanAt: number | null = null;
  let watcher: LibraryWatcher | undefined;
  let backups: BackupService | undefined;
  // Loudness analysis starts only after the first scan+match pass and then
  // pauses itself whenever the scanner is running (src/scan/state.ts).
  let loudnessStarted = false;
  function runScan(): Promise<void> {
    if (scanning) return scanning;
    // Deleting vanished files is destructive: if the drive is unmounted, an
    // "empty" scan would purge the whole library. Skip until it is back.
    if (watcher && !watcher.anyMounted()) {
      app.log.warn({ roots: cfg.libraryRoots }, 'scan skipped: no library root is mounted');
      return Promise.resolve();
    }
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
        // One-off: the improved matcher retries albums the old one missed or matched weakly.
        if (getState('match.rematchVersion') !== '2') {
          const r = await matcher.rematchWeak(0.8).catch((e) => {
            app.log.warn({ err: e }, 'rematch failed');
            return null;
          });
          if (r) {
            setState('match.rematchVersion', '2');
            app.log.warn({ rematch: r }, 'rematch done');
            broadcast({ type: 'library-changed' });
          }
        }
        lastScanAt = Date.now();
        if (!loudnessStarted) {
          loudnessStarted = true;
          loudness.start();
        }
        if (spotify && (await spotify.auth.status()).connected) {
          await runSpotifySync();
        }
        // Keep the ranked search index in step with the library/sync.
        try {
          searchIndex.reindex();
        } catch (e) {
          app.log.warn({ err: e }, 'search reindex failed');
        }
        // Only after matching, in the background, and only when connected.
        runLinkingInBackground();
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

  // ---------- library watcher + nightly backups
  if (opts.watch) {
    watcher = createLibraryWatcher({
      roots: cfg.libraryRoots,
      logger: app.log,
      onChange: (batch) => {
        app.log.info({ reason: batch.reason, files: batch.files.length }, 'library changed');
        void runScan();
      },
    });
    // A watcher failing to attach (odd filesystem, permissions) degrades to
    // poll-only inside the module; it must never stop the server from starting.
    try {
      await watcher.start();
    } catch (e) {
      app.log.warn({ err: e }, 'library watcher failed to start');
    }
  }
  if (opts.backups) {
    backups = createBackupService(db, { dataDir: cfg.dataDir, logger: app.log });
    backups.start();
  }

  // ---------- auto-radio: continue the PC queue when it runs out
  let autoPrev: PlayerState | undefined;
  let autoRunning = false;
  const autoSeen = new Set<string>();
  pc?.onChange((state) => {
    const prev = autoPrev;
    autoPrev = state;
    // Warm the waveform cache for the next few queue entries.
    if (state.index >= 0) {
      peaks.prefetch(state.queue.slice(state.index + 1, state.index + 4).map((q) => q.track.id));
    }
    if (!pc || autoRunning || !autoRadioEnabled()) return;
    if (!prev || (prev.status !== 'playing' && prev.status !== 'loading')) return;
    if (state.status !== 'stopped' || state.queue.length === 0) return;
    const zone = pc;
    const seedIds = state.queue.map((q) => q.track.id);
    let fresh: string[];
    try {
      fresh = radio
        .planNext({ trackIds: seedIds.slice(-10), recentTrackIds: seedIds }, 20)
        .map((p) => p.trackId)
        .filter((id) => !seedIds.includes(id) && !autoSeen.has(id));
    } catch (e) {
      app.log.warn({ err: e }, 'auto-radio planning failed');
      return;
    }
    if (fresh.length === 0) return;
    for (const id of fresh) autoSeen.add(id);
    autoRunning = true;
    const appendAt = state.queue.length;
    void (async () => {
      try {
        // Append (the queue is stopped at its end), move to the first new entry
        // and start it. Three serialized commands avoid replacing the queue, so
        // the user's history stays visible in the UI.
        await zone.command({ type: 'enqueue', trackIds: fresh });
        await zone.command({ type: 'jump', index: appendAt });
        await zone.command({ type: 'resume' });
        app.log.info({ added: fresh.length }, 'auto-radio appended');
      } catch (e) {
        app.log.warn({ err: e }, 'auto-radio failed');
      } finally {
        autoRunning = false;
      }
    })();
  });

  // ---------- routes
  await app.register(
    async (r) => {
      r.get('/ws', { websocket: true }, (socket) => {
        clients.add(socket);
        socket.on('close', () => clients.delete(socket));
        if (pc) socket.send(JSON.stringify({ type: 'player', state: sanitize(pc.state()) } satisfies ServerEvent));
        socket.send(JSON.stringify({ type: 'scan', progress: last } satisfies ServerEvent));
      });

      r.get<{ Querystring: Record<string, string | string[] | undefined> }>('/library/albums', async (req) => {
        const q = req.query;
        const offset = queryValue(q.offset);
        const limit = queryValue(q.limit);
        const year = queryValue(q.year);
        const query: AlbumListQuery = {
          q: queryValue(q.q),
          source: (queryValue(q.source) as AlbumListQuery['source']) ?? 'all',
          sort: queryValue(q.sort) as AlbumListQuery['sort'],
          offset: offset ? Number(offset) : undefined,
          limit: limit ? Number(limit) : undefined,
          genre: queryValue(q.genre),
          label: queryValue(q.label),
          year: year ? Number(year) : undefined,
          artistId: queryValue(q.artist),
        };
        return listAlbums(db, query);
      });

      r.get<{ Params: { id: string } }>('/albums/:id', async (req, reply) => {
        let album = getAlbum(db, req.params.id);
        // Spotify albums referenced by search/playlists may not be stored yet:
        // fetch on demand (in_library = 0) and return the stored row.
        // Albums known only through a playlist / liked song hold just those tracks: fetch the
        // full tracklist once (one Spotify call per album, ever).
        if (spotify && req.params.id.startsWith('sp:') && (!album || !spotifyAlbumIsFull(db, req.params.id))) {
          try {
            if ((await spotify.auth.status()).connected) {
              album = (await spotify.fetchAlbum(req.params.id)) ?? album;
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
        if (!mbid || !MBID_RE.test(mbid)) return reply.code(400).send({ error: 'musicbrainzReleaseId required' });
        // Check before matching: matcher.setRelease throws for unknown ids (500) and
        // would hit MusicBrainz for a release nobody can apply.
        if (!getAlbum(db, req.params.id)) return reply.code(404).send({ error: 'not found' });
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
      registerLoudnessRoutes(r, loudness);
      registerDupesRoutes(r, db);
      registerRadioRoutes(r, radio);
      registerRadioStationRoutes(r, iradio);
      registerMyPlaylistRoutes(r, db);
      registerPeaksRoutes(r, peaks);
      registerPeopleRoutes(r, db);
      registerEditionsRoutes(r, editions);
      registerStatsRoutes(r, db);
      registerSearchRoutes(r, searchIndex);
      if (linking) registerLinkRoutes(r, linking);

      // Ops endpoint (task contract: GET /api/health). Everything is injected so
      // a module that is disabled reports neutral values.
      registerOpsRoutes(r, {
        version: '0.1.0',
        startedAt,
        db,
        library: () => ({
          roots: watcher ? watcher.status() : rootsStatus(cfg.libraryRoots),
          lastScanAt,
        }),
        mpv: () => ({ pid: pc?.mpvPid(), alive: pc?.mpvPid() !== undefined }),
        spotify: async () => ({ connected: spotify ? (await spotify.auth.status()).connected : false }),
        jobs: () => ({
          matching: scanning !== null,
          details: detailsRunning,
          loudness: loudness.status().running,
        }),
        logger: app.log,
      });

      // Whether an empty PC queue continues with generated radio tracks.
      r.get('/settings/autoRadio', async () => ({ enabled: autoRadioEnabled() }));
      r.post<{ Body: { enabled?: unknown } }>('/settings/autoRadio', async (req, reply) => {
        const raw = req.body?.enabled;
        const enabled = raw === true || raw === 'true' || raw === 1 ? true : raw === false || raw === 'false' || raw === 0 ? false : undefined;
        if (enabled === undefined) return reply.code(400).send({ error: 'enabled boolean required' });
        setState(AUTO_RADIO_KEY, enabled ? '1' : '0');
        return { enabled };
      });

      r.get<{ Params: { id: string } }>('/artists/:id', async (req, reply) => {
        const a = getArtist(db, req.params.id);
        return a ?? reply.code(404).send({ error: 'not found' });
      });
      r.get<{ Querystring: { q?: string | string[] } }>('/artists', async (req) =>
        listArtists(db, queryValue(req.query.q)),
      );

      r.get<{ Querystring: { q?: string | string[] } }>('/search', async (req) => {
        const q = (queryValue(req.query.q) ?? '').trim();
        if (!q) return { albums: [], artists: [], tracks: [] };
        // Ranked search (worker T). Hidden albums stay out of every search
        // surface, exactly like the library grid.
        const found = searchIndex.search(q);
        // Keep the historical response shape (no `top`; /search2 exposes that).
        let local: { albums: AlbumSummary[]; artists: ArtistRef[]; tracks: Track[] } = {
          albums: found.albums,
          artists: found.artists,
          tracks: found.tracks,
        };
        const hiddenRows = db
          .prepare('SELECT album_id FROM album_prefs WHERE hidden = 1')
          .all() as { album_id: string }[];
        if (hiddenRows.length > 0) {
          const hidden = new Set(hiddenRows.map((r) => r.album_id));
          const visibleArtists = new Set(
            (
              db
                .prepare(
                  `SELECT DISTINCT ar.id AS id FROM artists ar
                   WHERE EXISTS (SELECT 1 FROM albums a WHERE a.artist_id = ar.id AND a.in_library = 1 AND ${albumNotHiddenSql(db, 'a')})`,
                )
                .all() as { id: string }[]
            ).map((r) => r.id),
          );
          local = {
            albums: found.albums.filter((a) => !hidden.has(a.id)),
            artists: found.artists.filter((a) => visibleArtists.has(a.id)),
            tracks: found.tracks.filter((t) => !hidden.has(t.albumId)),
          };
        }
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

      // One playlist collection for both sources: rune playlists first, then
      // the synced Spotify ones (worker P's readers handle both).
      r.get('/playlists', async () => listAllPlaylists(db));

      r.get<{ Params: { id: string } }>('/playlists/:id', async (req, reply) => {
        const playlist = getPlaylistDetail(db, req.params.id);
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
        const zones: {
          id: Zone;
          name: string;
          kind: 'pc' | 'browser' | 'spotify';
          /** For 'pc': the Spotify Connect device that is the same machine, so
           *  the UI can hand Spotify tracks to the desktop app. */
          spotifyDeviceId?: string;
          spotifyDeviceName?: string;
        }[] = [];
        let spotifyZones: { id: Zone; name: string; kind: 'pc' | 'browser' | 'spotify' }[] = [];
        if (spotify && (await spotify.auth.status()).connected) {
          try {
            spotifyZones = await spotify.zones.listZones();
            zones.push(...spotifyZones);
          } catch (e) {
            app.log.warn({ err: e }, 'spotify devices failed');
          }
        }
        if (pc) {
          const entry: (typeof zones)[number] = { id: 'pc', name: 'Linux PC speakers', kind: 'pc' };
          // cfg.pcSpotifyDevice defaults to 'HORSE', the Spotify desktop app on
          // this machine. Exact (case-insensitive) match first, then substring,
          // because Spotify appends the OS/device type on some platforms.
          const wanted = (cfg.pcSpotifyDevice ?? 'HORSE').trim().toLowerCase();
          const match =
            spotifyZones.find((z) => z.name.toLowerCase() === wanted) ??
            (wanted ? spotifyZones.find((z) => z.name.toLowerCase().includes(wanted)) : undefined);
          if (match) {
            const deviceId = match.id.startsWith('spotify:') ? match.id.slice('spotify:'.length) : match.id;
            entry.spotifyDeviceId = deviceId;
            entry.spotifyDeviceName = match.name;
          }
          // PC speakers first: the phone's default target.
          zones.unshift(entry);
        }
        return zones;
      });

      r.get<{ Params: { zone: string } }>('/player/:zone', async (req, reply) => {
        const z = await zoneFor(req.params.zone);
        return z ? sanitize(z.state()) : reply.code(404).send({ error: 'unknown zone' });
      });

      r.post<{ Params: { zone: string }; Body: PlayerCommand }>('/player/:zone', async (req, reply) => {
        const z = await zoneFor(req.params.zone);
        if (!z) return reply.code(404).send({ error: 'unknown zone' });
        try {
          if (req.params.zone.startsWith('spotify:')) app.log.warn({ zone: req.params.zone, cmd: req.body?.type }, 'spotify command');
          return sanitize(await z.command(req.body));
        } catch (e) {
          app.log.warn({ zone: req.params.zone, cmd: req.body?.type, err: (e as Error).message }, 'player command failed');
          return reply.code(400).send({ error: (e as Error).message });
        }
      });

      // Browsers report their errors here (e.g. the Spotify Web Playback SDK on the Mac)
      // so problems on other devices show up in the server log.
      const clientLog: { at: number; ua?: string; level: string; msg: string; data?: unknown }[] = [];
      r.post<{ Body: { level?: string; msg?: string; data?: unknown } }>('/client-log', async (req) => {
        const e = { at: Date.now(), ua: req.headers['user-agent'], level: String(req.body?.level ?? 'info').slice(0, 10), msg: String(req.body?.msg ?? '').slice(0, 500), data: req.body?.data };
        clientLog.push(e);
        if (clientLog.length > 300) clientLog.shift();
        app.log.warn({ client: e }, 'client log');
        return { ok: true };
      });
      r.get('/client-log', async () => clientLog.slice(-100));

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
        void runSpotifySync({ force: true });
        return { started, running: true };
      });
    },
    { prefix: '/api' },
  );
  registerStreamRoutes(app, db, cfg);

  // ---------- web UI (built) with SPA fallback
  const dist = opts.webDist ?? new URL('../../../web/dist', import.meta.url).pathname;
  if (existsSync(join(dist, 'index.html'))) {
    await app.register(fastifyStatic, { root: dist, wildcard: true, index: ["index.html"] });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/assets/')) return reply.code(404).send({ error: 'not found' });
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

  const stopTimers = (): void => {
    if (spotifyStartTimer) clearTimeout(spotifyStartTimer);
    if (spotifyInterval) clearInterval(spotifyInterval);
  };
  const settleJobs = async (): Promise<void> => {
    // Never reject teardown: a failed sync/link must not stop the server exiting.
    await Promise.all([
      spotifySyncInFlight?.catch(() => undefined) ?? Promise.resolve(),
      linkingInFlight?.catch(() => undefined) ?? Promise.resolve(),
    ]);
  };

  // Idempotent teardown for callers that do not own the Db (tests, main's
  // graceful path uses shutdown() instead, which closes it last).
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    stopTimers();
    watcher?.stop();
    backups?.stop();
    await loudness.stop().catch((err) => app.log.warn({ err }, 'loudness stop failed'));
    peaks.close();
    iradio.close();
    await settleJobs();
    for (const off of spotifyListeners.values()) off();
    await spotify?.zones.close();
    await pc?.close();
    await app.close();
  };

  // Signal path: watcher → flush in-flight DB work → WAL checkpoint → mpv →
  // modules/HTTP → Db last (see src/ops/shutdown.ts for the ordering contract).
  const shutdown = createShutdownHandler({
    watcher,
    flushDb: async () => {
      stopTimers();
      backups?.stop();
      await backups?.idle();
      await loudness.stop().catch(() => undefined);
      await settleJobs();
      await scanning?.catch(() => undefined);
    },
    mpv: pc,
    extra: [
      { name: 'peaks-close', run: () => peaks.close() },
      { name: 'iradio-close', run: () => iradio.close() },
      { name: 'spotify-zones-close', run: () => spotify?.zones.close() },
      { name: 'http-close', run: () => app.close() },
    ],
    // Wrap the better-sqlite3 handle: its close() returns the Database, which
    // CloseableDb deliberately does not model.
    db: {
      close: () => {
        db.close();
      },
      pragma: (sql: string) => db.pragma(sql),
    },
    logger: app.log,
  });

  return { app, close, shutdown };
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
