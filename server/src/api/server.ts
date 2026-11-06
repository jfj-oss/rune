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
import {
  createPcSpotify,
  createPcZone,
  registerPcSpotifyRoutes,
  registerStreamRoutes,
  type PcSpotifyOptions,
  type PcZone,
} from '../play/index.js';
import { createSpotify, type CreateSpotifyOptions } from '../spotify/index.js';
import { HttpError } from '../spotify/fetch.js';
import { createDiscover, registerDiscoverRoutes } from '../discover/index.js';
import { mergeSearchResults } from '../spotify/catalog.js';
import { normalizeName } from '../db/index.js';
import { LIKED_SONGS_PLAYLIST_ID, SpotifyReconnectNeeded, addTracksToSpotifyPlaylist, spotifyAlbumIsFull } from '../spotify/library.js';
import { createLinking, registerLinkRoutes, ensureLinkSchema } from '../spotify/linking.js';
import { ensureSpotifyLibrarySchema } from '../spotify/library-schema.js';
import { createMeta, registerMetaRoutes } from '../meta/index.js';
import { createArtistMeta, registerArtistMetaRoutes } from '../meta/artist.js';
import { registerBrowseRoutes } from './browse.js';
import { createSpeakerGuard } from '../play/oneSpeaker.js';
import { createLocalTwins, normArtist, parseLocalIds, parseTwinQueries } from '../play/localTwins.js';
import { registerJsonCompression } from './compress.js';
import { createClientPresence } from './presence.js';
import { registerSavedRoute } from './saved.js';
import { registerFrameRoutes } from './frame.js';
import { createHistory, ensureHistorySchema, registerHistoryRoutes } from '../history/index.js';
import { albumsByIds, coverPath, getAlbum, getArtist, listAlbums, listArtists, publicTrack, type AlbumListQuery } from './library.js';
import { parsePlayerCommand } from './playerCommand.js';
import { createLoudness, ensureLoudnessSchema, registerLoudnessRoutes } from '../loudness/index.js';
import { albumNotHiddenSql, ensureDupesSchema, registerDupesRoutes } from '../library/dupes.js';
import { createRadio, registerRadioRoutes } from '../radio/index.js';
import {
  PlaylistConflictError,
  getPlaylistDetail,
  listAllPlaylists,
  registerMyPlaylistRoutes,
} from '../myplaylists/index.js';
import { clearPlaylistImage, MAX_IMAGE_BYTES, playlistImageFile, playlistImageUrl, savePlaylistImage } from '../myplaylists/image.js';
import { ensureMyPlaylistSchema } from '../myplaylists/schema.js';
import { createPeaks, registerPeaksRoutes } from '../peaks/index.js';
import { ensurePeopleSchema, registerPeopleRoutes } from '../people/index.js';
import { createEditions, ensureEditionsSchema, registerEditionsRoutes } from '../editions/index.js';
import { ensureStatsSchema, registerStatsRoutes } from '../stats/index.js';
import { createIradio, ensureRadioSchema, registerRadioStationRoutes } from '../iradio/index.js';
import { createSearch, ensureSearchSchema, registerSearchRoutes } from '../search/index.js';
import { createLocalSearchCache } from '../search/local-cache.js';
import { createSemaphore } from './semaphore.js';
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
  /** Inject the flatpak/qdbus runner behind the on-demand Spotify start route (tests). */
  pcSpotify?: PcSpotifyOptions;
  webDist?: string;
}

export interface BuiltApp {
  app: FastifyInstance;
  /** Stop background jobs and close playback/HTTP. Does not close the Db. */
  close: () => Promise<void>;
  /** Graceful SIGINT/SIGTERM teardown: watcher, in-flight work, WAL checkpoint, modules, Db. */
  shutdown: (reason?: string) => Promise<ShutdownResult>;
}

/** The local (library-only) half of GET /search, as returned by the cache. */
interface LocalSearchResult {
  albums: AlbumSummary[];
  artists: ArtistRef[];
  tracks: Track[];
}

const IMAGE_TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

/** Client → server websocket messages larger than this are dropped unparsed. */
const MAX_CLIENT_MESSAGE = 16 * 1024;

/** ws gives a Buffer/ArrayBuffer (or an array of them); tests may hand over a string. */
function clientMessageText(data: unknown): string | null {
  if (typeof data === 'string') return data;
  try {
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
    if (Array.isArray(data)) {
      return Buffer.concat(data.map((d) => (Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer)))).toString('utf8');
    }
  } catch {
    return null;
  }
  return null;
}

/** A real MusicBrainz release id: 5 hyphen-separated hex groups (not just 36 of anything). */
const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fastify yields an array for repeated query keys (`?q=a&q=b`); take the first. */
function queryValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Local wall-clock HH:MM (24 h), e.g. for "Spotify songs play again around 19:42". */
function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export interface Hotkeys { albumKey: string; playlistKeys: Record<string, { id: string; name: string }> }

/** A well-formed hotkeys value (album key '' = off; letters/digits only; at most 36 playlist keys), else null. */
export function parseHotkeys(v: unknown): Hotkeys | null {
  if (!v || typeof v !== 'object') return null;
  const { albumKey, playlistKeys } = v as { albumKey?: unknown; playlistKeys?: unknown };
  if (typeof albumKey !== 'string' || !/^[a-z0-9]?$/.test(albumKey)) return null;
  if (!playlistKeys || typeof playlistKeys !== 'object' || Array.isArray(playlistKeys)) return null;
  const out: Hotkeys['playlistKeys'] = {};
  const entries = Object.entries(playlistKeys as Record<string, unknown>);
  if (entries.length > 36) return null;
  for (const [k, p] of entries) {
    const e = p as { id?: unknown; name?: unknown } | null;
    if (!/^[a-z0-9]$/.test(k) || !e || typeof e.id !== 'string' || typeof e.name !== 'string') return null;
    if (!e.id || e.id.length > 200 || e.name.length > 300) return null;
    out[k] = { id: e.id, name: e.name };
  }
  return { albumKey, playlistKeys: out };
}

export async function buildApp(db: Db, cfg: Config, opts: AppOptions = {}): Promise<BuiltApp> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  registerJsonCompression(app);
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
  const clients = new Set<{ send: (s: string) => void; slim?: boolean }>();
  /** A hidden tab is connected but not watching, so Spotify zones may idle. */
  const presence = createClientPresence();
  /** Per zone: the queue fingerprint last broadcast (slim clients then get position updates without it). */
  const sentQueueRev = new Map<string, string>();
  /** /search?local=1 and /search share this 15 s memo; library changes clear it. */
  const localSearchCache = createLocalSearchCache<LocalSearchResult>();
  const broadcast = (ev: ServerEvent) => {
    // Every scan/sync/link path announces itself this way; drop stale local hits.
    if (ev.type === 'library-changed') localSearchCache.clear();
    let full: string;
    let slim: string | null = null;
    if (ev.type === 'player') {
      // Spotify states arrive every poll; their queue (10–400 KB) rarely changes
      const queueRev = fingerprint(JSON.stringify(ev.state.queue));
      full = JSON.stringify({ ...ev, queueRev });
      if (sentQueueRev.get(ev.state.zone) === queueRev) {
        const { queue: _queue, ...rest } = ev.state;
        slim = JSON.stringify({ type: 'player', state: rest, queueRev });
      }
      sentQueueRev.set(ev.state.zone, queueRev);
    } else full = JSON.stringify(ev);
    for (const c of clients) {
      try {
        c.send(c.slim && slim ? slim : full);
      } catch {
        /* dropped */
      }
    }
  };

  // ---------- zones
  const pc: PcZone | undefined =
    opts.pcZone === false
      ? undefined
      : await createPcZone(db, cfg, {
          log: (message, err) => app.log.warn({ err }, message),
        });
  // "Linux PC speakers" can host Spotify by starting the desktop app on demand.
  // Creating it does nothing; the app only launches from POST /api/pc/spotify/start.
  const pcSpotify = createPcSpotify(cfg, {
    log: (message, err) => app.log.warn({ err }, message),
    ...opts.pcSpotify,
  });
  const history = createHistory(db);
  const localTwins = createLocalTwins(db);
  const lastState = new Map<Zone, PlayerState>();
  const recordHistory = (state: PlayerState) => {
    const prev = lastState.get(state.zone);
    if (prev) history.recordFromState(prev, state);
    lastState.set(state.zone, state);
  };
  // The Spotify app on this PC and mpv share the speakers: only one may sound (play/oneSpeaker.ts).
  let pcSpotifyDevice: { id: Zone; name: string } | null = null;
  const speakers = createSpeakerGuard(
    { pc: () => pc, spotify: () => (pcSpotifyDevice ? spotify?.zones.get(pcSpotifyDevice.id) : undefined) },
    {
      onError: (err) => app.log.warn({ err }, 'could not pause the other player on the PC speakers'),
      // 'out' allows one background poll in ten minutes: mpv starting must not add to that.
      canWake: () => spotify?.api.budgetLevel() !== 'out',
    },
  );
  const notePcSpotify = (list: { id: Zone; name: string }[]): void => {
    const wanted = (cfg.pcSpotifyDevice ?? 'HORSE').trim().toLowerCase();
    const match = list.find((z) => z.name.toLowerCase() === wanted) ?? (wanted ? list.find((z) => z.name.toLowerCase().includes(wanted)) : undefined);
    pcSpotifyDevice = match ? { id: match.id, name: match.name } : null;
  };
  pc?.onChange((state) => speakers.changed('pc', state));
  pc?.onChange((state) => {
    recordHistory(state);
    broadcast({ type: 'player', state: sanitize(state) });
  });
  const spotify = cfg.spotifyClientId
    ? createSpotify(db, cfg, {
        ...opts.spotifyOptions,
        // Connect zones poll just after each song ends while somebody is watching;
        // with no live socket they poll slower still and skip the queue.
        hasClients: () => presence.hasVisible(),
        // Budget-level changes get one warn line each.
        logger: app.log,
        // One line per hour of Spotify traffic: enough to see a runaway poller.
        onHourlyUsage: (usage) => {
          app.log.info(
            {
              hour: new Date(usage.hourStart).toISOString(),
              requests: usage.total,
              top: usage.topPaths,
            },
            'spotify requests last hour',
          );
        },
        // Login callback fires this without awaiting: the redirect must not wait
        // for the Spotify library to download.
        onLogin: () => {
          void runSpotifySync({ force: true });
        },
      })
    : undefined;
  spotify?.registerRoutes(app);
  /** One live subscription per zone id; the zone object can be replaced (Connect ↔ go-librespot). */
  const spotifyListeners = new Map<Zone, { zone: PlaybackZone; off: () => void }>();
  /**
   * Background Spotify work (syncs, linking, discovery warm-ups) is deferred when the
   * rolling daily budget is low or used up. A user command is never deferred.
   */
  function spotifyBudgetDefers(job: string): boolean {
    const level = spotify?.api.budgetLevel() ?? 'normal';
    if (level !== 'low' && level !== 'out') return false;
    app.log.info({ level, job }, `spotify budget low: deferring ${job}`);
    return true;
  }

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
  // New songs + song radio: ListenBrainz similarity → Spotify catalogue, through
  // a small persisted request budget shared by every discovery call.
  const discover = createDiscover(db, cfg, spotify, {
    onWarn: (msg, err) => app.log.warn({ err }, msg),
    onInfo: (msg) => app.log.info(msg),
  });
  // Build "Find new songs" in the background (a full build is ~1–2 min of rate-limited
  // lookups), so opening Discover shows a ready feed. feed() is a no-op while it is fresh.
  const warmDiscover = () => {
    if (spotifyBudgetDefers('discover warm-up')) return;
    void discover.feed({ limit: 100 }).catch((err) => app.log.warn({ err }, 'discover warm-up failed'));
  };
  setTimeout(warmDiscover, 90_000).unref();
  setInterval(warmDiscover, 6 * 60 * 60_000).unref();

  // One Spotify sync at a time; scan/scheduler/login/manual all share it.
  // Persisted throttle: restarts must not resync (a full Liked Songs pass is ~100
  // requests), and a long Retry-After from Spotify is honoured across restarts.
  db.exec('CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const getState = (k: string) => (db.prepare('SELECT value FROM app_state WHERE key = ?').get(k) as { value: string } | undefined)?.value;
  const setState = (k: string, v: string) =>
    db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
  // Auto-radio: keep the PC zone playing when its queue runs out (default on).
  const AUTO_RADIO_KEY = 'settings.autoRadio';
  const HIDDEN_ZONES_KEY = 'zones.hiddenNames';
  const hiddenZoneNames = (): string[] => {
    try {
      const v = JSON.parse(getState(HIDDEN_ZONES_KEY) ?? '[]') as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  const autoRadioEnabled = (): boolean => getState(AUTO_RADIO_KEY) !== '0';
  const SYNC_MIN_GAP_MS = 25 * 60_000;
  let spotifySyncInFlight: Promise<void> | null = null;
  function runSpotifySync(opts: { force?: boolean } = {}): Promise<void> {
    if (!spotify) return Promise.resolve();
    if (spotifySyncInFlight) return spotifySyncInFlight;
    // Background syncs pause once the daily budget is low; a manual/forced sync is a user action.
    if (!opts.force && spotifyBudgetDefers('library sync')) return Promise.resolve();
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
    if (spotifyBudgetDefers('spotify linking')) return;
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
      return watchSpotifyZone(id);
    }
    return undefined;
  }

  /** Keep polling a Connect zone and broadcasting its changes (track changes on their own,
   *  e.g. the next song of a playlist, must reach every open rune page). */
  function watchSpotifyZone(id: Zone): PlaybackZone | undefined {
    const z = spotify?.zones.get(id);
    if (!z) return undefined;
    const watched = spotifyListeners.get(id);
    if (watched?.zone === z) return z;
    watched?.off();
    const off = z.onChange((state) => {
      if (id === pcSpotifyDevice?.id) speakers.changed('spotify', state);
      recordHistory(state);
      broadcast({ type: 'player', state: sanitize(state) });
    });
    spotifyListeners.set(id, { zone: z, off });
    return z;
  }

  /** After a (re)start nothing would watch the Spotify devices until a page asked: watch them all now. */
  async function watchAllSpotifyZones(): Promise<void> {
    if (!spotify) return;
    try {
      if (!(await spotify.auth.status()).connected) return;
      const list = await spotify.zones.listZones();
      notePcSpotify(list);
      for (const z of list) watchSpotifyZone(z.id);
    } catch (err) {
      app.log.warn({ err }, 'watching spotify devices failed');
    }
  }
  setTimeout(() => void watchAllSpotifyZones(), 2000).unref();

  // ---------- scan + match pipeline
  const scanner = createScanner(db, cfg);
  const matcher = createMatcher(db, cfg);
  const meta = createMeta(db, cfg);
  const artistMeta = createArtistMeta(db, cfg);
  /** Local artists without a Wikimedia photo: the exact-name Spotify artist's picture (looked up once). */
  const spotifyArtistPhoto = (() => {
    db.exec('CREATE TABLE IF NOT EXISTS artist_spotify_photo (artist_id TEXT PRIMARY KEY, url TEXT, checked_at INTEGER NOT NULL)');
    const get = db.prepare('SELECT url, checked_at FROM artist_spotify_photo WHERE artist_id = ?');
    const put = db.prepare('INSERT OR REPLACE INTO artist_spotify_photo (artist_id, url, checked_at) VALUES (?, ?, ?)');
    const nameOf = db.prepare('SELECT name FROM artists WHERE id = ?');
    return {
      get: (id: string): string | null => (get.get(id) as { url: string | null } | undefined)?.url ?? null,
      async lookup(id: string): Promise<void> {
        if (!spotify || get.get(id)) return;
        const name = (nameOf.get(id) as { name: string } | undefined)?.name;
        if (!name) return;
        try {
          if (!(await spotify.auth.status()).connected) return;
          const res = await spotify.api.search(name, { types: ['artist'], limit: 5 });
          const want = normalizeName(name);
          const hit = (res.artists?.items ?? []).find((a) => normalizeName(a.name) === want);
          const url = hit?.images?.length ? [...hit.images].sort((x, y) => (y.width ?? 0) - (x.width ?? 0))[0]!.url : null;
          put.run(id, url, Date.now());
          await new Promise((r) => setTimeout(r, 1500)); // gentle on Spotify's rate limit
        } catch (err) {
          app.log.warn({ err, id }, 'spotify artist photo lookup failed'); // not stored: retried next run
        }
      },
    };
  })();
  let detailsRunning = false;
  /** Prefetch album details in the background (one album at a time, after matching). */
  async function prefetchDetails(): Promise<void> {
    if (detailsRunning) return;
    detailsRunning = true;
    try {
      // Artist pictures are a background extra: skip them (once, with one log line) at low budget.
      const spotifyPhotos = !spotifyBudgetDefers('artist photo lookup');
      const pending = db
        .prepare(
          `SELECT a.id FROM albums a LEFT JOIN album_details d ON d.album_id = a.id
           WHERE d.album_id IS NULL AND a.source = 'local' ORDER BY a.mb_release_id IS NULL, a.added_at DESC`,
        )
        .all() as { id: string }[];
      // Artist photos + bios first (the Artists grid shows them), one artist at a time; the
      // MusicBrainz limiter paces it. Spotify artists use Spotify's own picture instead.
      const artists = db
        .prepare(
          `SELECT DISTINCT a.artist_id AS id FROM albums a LEFT JOIN artist_info i ON i.artist_id = a.artist_id
           WHERE a.in_library = 1 AND a.source = 'local' AND i.artist_id IS NULL`,
        )
        .all() as { id: string }[];
      for (const { id } of artists) {
        if (scanning) break;
        const info = await artistMeta.getArtistInfo(id).catch((e) => {
          app.log.warn({ err: e, id }, 'artist info failed');
          return null;
        });
        if (spotifyPhotos && info && !info.imagePath) await spotifyArtistPhoto.lookup(id);
      }
      // Artists looked up before the Spotify fallback existed.
      if (spotifyPhotos) {
        const noPhoto = db
          .prepare(
            `SELECT DISTINCT a.artist_id AS id FROM albums a JOIN artist_info i ON i.artist_id = a.artist_id
             WHERE a.in_library = 1 AND a.source = 'local' AND i.image_path IS NULL`,
          )
          .all() as { id: string }[];
        for (const { id } of noPhoto) {
          if (scanning) break;
          await spotifyArtistPhoto.lookup(id);
        }
      }
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

  // ---------- local search (shared by /search and /search?local=1)
  /**
   * Rank the local library and drop hidden albums/artists/tracks. This is the
   * expensive half of search; both query variants go through localSearchCache.
   */
  function computeLocalSearch(q: string): LocalSearchResult {
    const found = searchIndex.search(q);
    let local: LocalSearchResult = {
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
    return local;
  }

  // ---------- routes
  await app.register(
    async (r) => {
      r.get<{ Querystring: { slim?: string } }>('/ws', { websocket: true }, (socket, req) => {
        const client = socket as typeof socket & { slim?: boolean };
        client.slim = req.query.slim === '1';
        clients.add(client);
        presence.add(socket);
        // Somebody is watching again: Spotify zones return to the watched schedule right now.
        spotify?.zones.wake();
        socket.on('close', () => {
          clients.delete(socket);
          presence.remove(socket);
        });
        // Client → server: tab visibility (hidden tabs do not count as watching) and the
        // browser Spotify SDK's own playback reports (a free alternative to GET /me/player).
        socket.on('message', (data: unknown) => {
          const text = clientMessageText(data);
          if (text === null || Buffer.byteLength(text, 'utf8') > MAX_CLIENT_MESSAGE) return;
          let msg: unknown;
          try {
            msg = JSON.parse(text);
          } catch {
            return; // garbage
          }
          if (!msg || typeof msg !== 'object') return;
          const m = msg as { type?: unknown; visible?: unknown };
          if (m.type === 'presence') {
            if (typeof m.visible !== 'boolean') return;
            // Hidden → visible: the zones poll again now.
            if (presence.setVisible(socket, m.visible)) spotify?.zones.wake();
          } else if (m.type === 'sdk-state') {
            spotify?.reportLocalPlayback(msg);
          }
        });
        if (pc) {
          const state = sanitize(pc.state());
          socket.send(JSON.stringify({ type: 'player', state, queueRev: fingerprint(JSON.stringify(state.queue)) } satisfies ServerEvent));
        }
        socket.send(JSON.stringify({ type: 'scan', progress: last } satisfies ServerEvent));
      });

      r.get<{ Querystring: Record<string, string | string[] | undefined> }>('/library/albums', async (req, reply) => {
        const q = req.query;
        // ?ids=a,b,c: batch summaries in the caller's order (the Home page fetches
        // exactly the albums it shows instead of N /albums/:id requests).
        const idsParam = queryValue(q.ids);
        if (idsParam !== undefined) {
          const ids = idsParam
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean);
          if (ids.length === 0) return reply.code(400).send({ error: 'ids required' });
          if (ids.length > 100) return reply.code(400).send({ error: 'at most 100 ids' });
          return albumsByIds(db, ids);
        }
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
      registerArtistMetaRoutes(r, artistMeta, {
        externalImage: (id) => (spotify && id.startsWith('ar:sp:') ? spotify.artistImage(id) : null),
        fallbackImage: (id) => spotifyArtistPhoto.get(id),
      });
      registerBrowseRoutes(r, db);
      registerSavedRoute(r, db);
      registerFrameRoutes(r);
      registerHistoryRoutes(r, history);
      registerLoudnessRoutes(r, loudness);
      registerDupesRoutes(r, db);
      registerRadioRoutes(r, radio);
      registerRadioStationRoutes(r, iradio);
      registerMyPlaylistRoutes(r, db, {
        addToSpotifyPlaylist: async (playlistId, trackIds) => {
          if (!spotify || !(await spotify.auth.status()).connected) {
            throw new PlaylistConflictError('Spotify is not connected');
          }
          const writes = playlistId === LIKED_SONGS_PLAYLIST_ID ? 'user-library-modify' : 'playlist-modify-private';
          if (!spotify.auth.grantedScopes().includes(writes)) throw new PlaylistConflictError(new SpotifyReconnectNeeded().message);
          try {
            await addTracksToSpotifyPlaylist(spotify.api, db, playlistId, trackIds);
          } catch (err) {
            const status = (err as { status?: number }).status;
            app.log.warn({ err, playlistId }, 'adding to a Spotify playlist failed');
            if (status === 403) throw new PlaylistConflictError('Spotify only lets you add songs to playlists you own or that are collaborative');
            if (status === 429) throw new PlaylistConflictError('Spotify is busy (rate limit) — try again in a few minutes');
            if (status === 404) throw new PlaylistConflictError('Spotify could not find that playlist — it may have been deleted');
            throw new PlaylistConflictError('Spotify refused the change');
          }
          broadcast({ type: 'library-changed' });
        },
      });
      registerPeaksRoutes(r, peaks);
      registerPeopleRoutes(r, db);
      registerEditionsRoutes(r, editions);
      registerStatsRoutes(r, db);
      registerSearchRoutes(r, searchIndex);
      registerDiscoverRoutes(r, discover);
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

      // The app background (ambient) is shared by every device: picked on the Mac, the phone follows.
      r.get('/settings/ambient', async () => ({ ambient: getState('ui.ambient') ?? null }));
      r.post<{ Body: { ambient?: unknown } }>('/settings/ambient', async (req, reply) => {
        const a = req.body?.ambient;
        if (typeof a !== 'string' || !/^[a-z]{1,12}(-[a-z]{1,12})?$/.test(a)) return reply.code(400).send({ error: 'ambient name required' });
        setState('ui.ambient', a);
        return { ambient: a };
      });

      // Dither dot size ("fine" | "classic"), shared the same way.
      r.get('/settings/dots', async () => ({ dots: getState('ui.dots') ?? null }));
      r.post<{ Body: { dots?: unknown } }>('/settings/dots', async (req, reply) => {
        const d = req.body?.dots;
        if (d !== 'fine' && d !== 'classic') return reply.code(400).send({ error: 'dots must be fine or classic' });
        setState('ui.dots', d);
        return { dots: d };
      });

      // Spotify tracks the user also has locally: the client swaps them for the local copy before playing.
      r.post<{ Body: unknown }>('/local-twins', async (req, reply) => {
        const queries = parseTwinQueries(req.body);
        if (!queries) return reply.code(400).send({ error: 'tracks: [{ id, title, artists, durationMs }] required' });
        return { twins: localTwins.items(queries) };
      });
      // The reverse, for Spotify-only zones: local files that have a Spotify copy play that instead of being skipped.
      r.post<{ Body: unknown }>('/spotify-twins', async (req, reply) => {
        const ids = parseLocalIds(req.body);
        if (!ids) return reply.code(400).send({ error: 'ids: [local track id] required' });
        return { twins: localTwins.spotifyItems(ids) };
      });

      // Hotkeys (album key + playlist keys), shared too: browsers that clear site data on exit would lose them.
      r.get('/settings/hotkeys', async () => {
        try { return { hotkeys: parseHotkeys(JSON.parse(getState('ui.hotkeys') ?? 'null')) }; } catch { return { hotkeys: null }; }
      });
      r.post<{ Body: { hotkeys?: unknown } }>('/settings/hotkeys', async (req, reply) => {
        const h = parseHotkeys(req.body?.hotkeys);
        if (!h) return reply.code(400).send({ error: 'hotkeys { albumKey, playlistKeys } required' });
        setState('ui.hotkeys', JSON.stringify(h));
        return { hotkeys: h };
      });

      r.get<{ Params: { id: string } }>('/artists/:id', async (req, reply) => {
        const a = getArtist(db, req.params.id);
        // Spotify artists (search results, playlist artists) and local artists linked to one: add the Spotify
        // discography. A local artist only uses it under the same name, in case the stored link is wrong.
        const linked = spotify && a ? (db.prepare('SELECT spotify_id AS id FROM artists WHERE id = ?').get(req.params.id) as { id: string | null } | undefined)?.id : null;
        const remote = spotify?.artistPage(linked ? `ar:sp:${linked}` : req.params.id);
        if (remote) {
          try {
            if ((await spotify!.auth.status()).connected) {
              const sp = await remote;
              if (linked && a && normArtist(sp.name) !== normArtist(a.name)) return a;
              const have = new Set([...(a?.albums ?? []), ...(a?.appearsOn ?? [])].map((x) => x.id));
              return {
                id: req.params.id,
                name: a?.name ?? sp.name,
                ...(a?.imageUrl ?? sp.imageUrl ? { imageUrl: a?.imageUrl ?? sp.imageUrl } : {}),
                albums: [...(a?.albums ?? []), ...sp.albums.filter((x) => !have.has(x.id))],
                appearsOn: a?.appearsOn ?? [],
                similar: a?.similar ?? [],
                ...(a?.musicbrainzArtistId ? { musicbrainzArtistId: a.musicbrainzArtistId } : {}),
              };
            }
          } catch (err) {
            app.log.warn({ err, artistId: req.params.id }, 'spotify artist fetch failed');
          }
        }
        return a ?? reply.code(404).send({ error: 'not found' });
      });
      r.get<{ Querystring: { q?: string | string[] } }>('/artists', async (req) =>
        listArtists(db, queryValue(req.query.q)),
      );

      r.get<{ Querystring: { q?: string | string[]; local?: string } }>('/search', async (req) => {
        const q = (queryValue(req.query.q) ?? '').trim();
        if (!q) return { albums: [], artists: [], tracks: [] };
        // Ranked search (worker T). Hidden albums stay out of every search
        // surface, exactly like the library grid. ?local=1 and the plain request
        // share one cached computation (cleared by library-changed events).
        // Keep the historical response shape (no `top`; /search2 exposes that).
        const local = localSearchCache.get(q, () => computeLocalSearch(q));
        // ?local=1: library hits only (milliseconds), so the page can show them before Spotify answers
        if (!spotify || queryValue(req.query.local) === '1') return local;
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

      // A picture chosen for a playlist: the raw file as the body (myplaylists/image.ts).
      r.addContentTypeParser(/^image\//, { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES }, (_req, body, done) => done(null, body));
      r.post<{ Params: { id: string }; Body: Buffer }>('/playlists/:id/image', { bodyLimit: MAX_IMAGE_BYTES }, async (req, reply) => {
        if (!getPlaylistDetail(db, req.params.id)) return reply.code(404).send({ error: 'not found' });
        if (!Buffer.isBuffer(req.body)) return reply.code(400).send({ error: 'send the picture as the request body' });
        if (!(await savePlaylistImage(db, cfg.dataDir, req.params.id, req.body))) return reply.code(400).send({ error: 'use a JPEG, PNG, GIF or WebP picture' });
        return { imageUrl: playlistImageUrl(db, req.params.id) };
      });
      r.delete<{ Params: { id: string } }>('/playlists/:id/image', async (req) => {
        clearPlaylistImage(db, cfg.dataDir, req.params.id);
        return { ok: true };
      });
      r.get<{ Params: { id: string } }>('/playlists/:id/image', async (req, reply) => {
        const file = playlistImageFile(cfg.dataDir, req.params.id);
        if (!existsSync(file)) return reply.code(404).send({ error: 'no picture' });
        reply.type('image/jpeg').header('cache-control', 'public, max-age=31536000, immutable');
        return reply.send(createReadStream(file));
      });

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
        if (/^https?:\/\//.test(p)) {
          // Old clients still ask for /api/cover for Spotify albums; a redirect is
          // cached like the image itself so it is only paid once.
          reply.header('cache-control', 'public, max-age=86400');
          return reply.redirect(p);
        }
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
        const spotifyConnected = !!spotify && (await spotify.auth.status()).connected;
        if (spotifyConnected) {
          try {
            const spotifyZones = await spotify.zones.listZones();
            notePcSpotify(spotifyZones);
            for (const z of spotifyZones) watchSpotifyZone(z.id);
            zones.push(...spotifyZones);
          } catch (e) {
            app.log.warn({ err: e }, 'spotify devices failed');
          }
        }
        if (pc) {
          const entry: (typeof zones)[number] = { id: 'pc', name: 'Linux PC speakers', kind: 'pc' };
          // The device notePcSpotify matched (cfg.pcSpotifyDevice, default 'HORSE': the Spotify desktop app on this
          // machine). After a failed list it is still the last one known: an answer without it means "the app went
          // away" to the page, which then throws out a mixed queue.
          const match = spotifyConnected ? pcSpotifyDevice : null;
          if (match) {
            const deviceId = match.id.startsWith('spotify:') ? match.id.slice('spotify:'.length) : match.id;
            entry.spotifyDeviceId = deviceId;
            entry.spotifyDeviceName = match.name;
          }
          // PC speakers first: the phone's default target.
          zones.unshift(entry);
        }
        // Spotify devices the user hid ("does nothing" duplicates such as the Spotify app on the
        // same Mac as a rune tab). The pc zone's own Spotify app is matched above regardless.
        const hidden = new Set(hiddenZoneNames());
        return zones.filter((z) => !(z.kind === 'spotify' && hidden.has(z.name)));
      });

      r.get('/zones/hidden', async () => hiddenZoneNames());
      r.post<{ Body: { name?: unknown; hidden?: unknown } }>('/zones/hidden', async (req, reply) => {
        const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 200) : '';
        if (!name) return reply.code(400).send({ error: 'name required' });
        const names = new Set(hiddenZoneNames());
        if (req.body?.hidden === false) names.delete(name);
        else names.add(name);
        setState(HIDDEN_ZONES_KEY, JSON.stringify([...names]));
        return [...names];
      });

      // On-demand Spotify app for the pc zone: the UI calls this only when the user
      // actually sends Spotify tracks to the PC speakers (never from GET /zones).
      registerPcSpotifyRoutes(r, pcSpotify);

      r.get<{ Params: { zone: string } }>('/player/:zone', async (req, reply) => {
        const z = await zoneFor(req.params.zone);
        return z ? sanitize(z.state()) : reply.code(404).send({ error: 'unknown zone' });
      });

      r.post<{ Params: { zone: string }; Body: unknown }>('/player/:zone', async (req, reply) => {
        // Validate first: a malformed command must never reach a zone (and must not depend
        // on which zones happen to exist). 400 with a short message the client can toast.
        const parsed = parsePlayerCommand(req.body);
        if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
        const z = await zoneFor(req.params.zone);
        if (!z) return reply.code(404).send({ error: 'unknown zone' });
        try {
          if (req.params.zone.startsWith('spotify:')) app.log.warn({ zone: req.params.zone, cmd: parsed.command.type }, 'spotify command');
          return sanitize(await z.command(parsed.command));
        } catch (e) {
          if (e instanceof HttpError && e.status === 429) {
            const until = spotify?.api.blockedUntil() ?? Date.now() + (e.retryAfterMs ?? 0);
            const message =
              `Spotify's daily limit is used up — Spotify songs play again around ${clockTime(until)}. ` +
              'Local music still works.';
            app.log.warn({ zone: req.params.zone, cmd: parsed.command.type, until: new Date(until).toISOString() }, 'player command rate limited');
            return reply.code(429).send({ error: message });
          }
          app.log.warn({ zone: req.params.zone, cmd: parsed.command.type, err: (e as Error).message }, 'player command failed');
          // Zones throw a plain Error for expected, user-actionable failures (e.g. Spotify
          // Connect cannot remove queue items) — show those. Anything else (TypeError,
          // SqliteError, …) is an internal bug: log it without echoing its text.
          if (!(e instanceof Error) || e.constructor !== Error) {
            return reply.code(500).send({ error: 'the player could not complete that command' });
          }
          return reply.code(400).send({ error: e.message });
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
      /** Files the last scan could not read, so Settings can show which ones. */
      r.get('/scan/errors', async () => scanner.scanErrors());

      // Without a Spotify client id there is no Spotify module to register its
      // routes; answer the status the UI asks for on every load instead of 404ing.
      if (!spotify) r.get('/spotify/status', async () => ({ connected: false, configured: false }));

      // Spotify request counters and the quota circuit breaker, for diagnosing runaway polling.
      r.get('/spotify/usage', async (_req, reply) => {
        if (!spotify) return reply.code(404).send({ error: 'spotify not configured' });
        return spotify.api.usage();
      });

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
    await app.register(fastifyStatic, {
      root: dist,
      wildcard: true,
      index: ['index.html'],
      // web/scripts/compress.mjs writes .br/.gz next to each file at build time
      preCompressed: true,
      setHeaders(res, path) {
        // /assets/* names carry a content hash: they never change, so the browser keeps them for good;
        // everything else (index.html, icons, manifest) is re-checked so a new build shows up at once
        res.header('cache-control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
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
    for (const watched of spotifyListeners.values()) watched.off();
    await spotify?.zones.close();
    spotify?.close();
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
      { name: 'spotify-usage-flush', run: () => spotify?.close() },
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
/** At most 3 ffmpeg processes at once; the rest wait in FIFO order. */
const thumbnailSlots = createSemaphore(3);
/** Resize covers with ffmpeg into <dataDir>/thumbs, cached by source mtime. */
function thumbnail(cfg: Config, albumId: string, src: string, size: number): Promise<string> {
  const dir = join(cfg.dataDir, 'thumbs');
  mkdirSync(dir, { recursive: true });
  const mtime = Math.round(statSync(src).mtimeMs);
  const out = join(dir, `${albumId.replace(/[^a-z0-9]/gi, '_')}-${size}-${mtime}.jpg`);
  if (existsSync(out)) return Promise.resolve(out);
  let job = thumbJobs.get(out);
  if (!job) {
    job = (async () => {
      await thumbnailSlots.acquire();
      try {
        return await new Promise<string>((resolve) => {
          execFile(
            'ffmpeg',
            ['-v', 'error', '-y', '-i', src, '-vf', `scale='min(${size},iw)':-2:flags=lanczos`, '-frames:v', '1', '-q:v', '3', out],
            { timeout: 20_000 },
            (err) => resolve(err ? src : out),
          );
        });
      } finally {
        thumbnailSlots.release();
      }
    })().finally(() => thumbJobs.delete(out));
    thumbJobs.set(out, job);
  }
  return job;
}

/** Short FNV-1a fingerprint of a string (queue revisions on the live socket). */
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(36)}.${text.length.toString(36)}`;
}
