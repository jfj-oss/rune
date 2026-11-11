// Wires every module into one Fastify app. Main-session code.
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync, mkdirSync, readFileSync, statSync, createReadStream } from 'node:fs';
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
import { createSpotify, type CreateSpotifyOptions, type SpotifyBudgetLevel } from '../spotify/index.js';
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
import { createPlaybackLog, startsSound, type PlaybackProbe } from '../play/playbackLog.js';
import { createSpotifyWatch, type SpotifyWatchOptions } from '../play/spotifyWatch.js';
import { createMprisBus, MprisPlaybackSource, type MprisBus, type MprisBusOptions } from '../spotify/mpris.js';
import { loadQueueItems, makeQueueId } from '../play/rows.js';
import { appStateStore, placeholderItem, QueueDriver } from '../play/driver.js';
import { MpvOutput, SpotifyAppOutput } from '../play/outputs.js';
import { albumSummaryFromTrack, mapTrack } from '../spotify/map.js';
import { createLocalTwins, normArtist, parseLocalIds, parseTwinQueries } from '../play/localTwins.js';
import { registerJsonCompression } from './compress.js';
import { registerCors } from './cors.js';
import { createClientPresence } from './presence.js';
import { registerSavedRoute } from './saved.js';
import { registerLikedRoutes } from './liked.js';
import { removeSpotifyPlaylistTracks } from './spotifyPlaylistWrite.js';
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
import { createUpdateService, registerUpdateRoutes } from '../update.js';

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
  /** Reads the PC's audio state for the playback log (tests inject a fake). */
  playbackProbe?: PlaybackProbe;
  /** Log MPRIS, the PipeWire stream and the Connect zone of this PC's Spotify app side by side (main.ts enables;
   *  tests pass fakes). It only listens. */
  spotifyWatch?: boolean | Partial<SpotifyWatchOptions>;
  /** Read this PC's Spotify app over MPRIS instead of polling /me/player for it (main.ts enables; config
   *  spotify.mprisReads: false turns it off). Tests pass a fake bus. */
  mpris?: boolean | { bus: MprisBus } | MprisBusOptions;
  /** How long a linked local artist page waits for Spotify (default 2 s; tests shorten it). */
  artistWaitMs?: number;
  webDist?: string;
  /** Server-owned queue tests: mpv's run player instead of a real mpv (config spotify.serverQueue picks the mode). */
  pcRunZone?: PcZone;
}

export interface BuiltApp {
  app: FastifyInstance;
  /** Stop background jobs and close playback/HTTP. Does not close the Db. */
  close: () => Promise<void>;
  /** Graceful SIGINT/SIGTERM teardown: watcher, in-flight work, WAL checkpoint, modules, Db. */
  shutdown: (reason?: string) => Promise<ShutdownResult>;
  /** The Connect zones with a polling subscription (tests). */
  watchedSpotifyZones: () => string[];
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
/** Spotify Connect device ids are 40 hex characters; only such ids get an on-demand zone (see zoneFor). */
const SPOTIFY_DEVICE_ID = /^[0-9a-f]{20,64}$/i;

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

/** The git checkout's top-level directory, or a safe fallback when rune is not in one. */
async function findUpdateRepoRoot(cwd: string): Promise<string> {
  const root = await new Promise<string | null>((resolve) => {
    execFile('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: 10_000 }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim() || null);
    });
  });
  if (root) return root;
  const parent = join(cwd, '..');
  return existsSync(join(parent, 'pnpm-workspace.yaml')) ? parent : cwd;
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

/** How long a linked local artist page waits for Spotify before it answers with what rune has. */
const ARTIST_WAIT_MS = 2_000;
/** A failed Spotify artist fetch is not tried again for a while: each page would wait on it for nothing. */
const ARTIST_FAILURE_MEMORY_MS = 60_000;
const ARTIST_FAILURES_KEPT = 500;

/** The promise's value, or null if it takes longer than `ms`. Its later failure is not lost: the race has handled it. */
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref();
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export async function buildApp(db: Db, cfg: Config, opts: AppOptions = {}): Promise<BuiltApp> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  registerJsonCompression(app);
  // Narrow, origin-checked CORS for Megatron's play-into-call tab (api/cors.ts).
  registerCors(app, cfg);
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
  // Phase 3 (config spotify.serverQueue, default off): the pc zone's queue lives in play/driver.ts and mpv only plays
  // the runs of local songs it is given, so mpv keeps no session of its own (player.pc.session is left as it was).
  const serverQueueWanted = cfg.spotify?.serverQueue === true;
  const pc: PcZone | undefined =
    opts.pcRunZone ??
    (opts.pcZone === false
      ? undefined
      : await createPcZone(db, cfg, {
          log: (message, err) => app.log.warn({ err }, message),
          session: !serverQueueWanted,
        }));
  const serverQueue = serverQueueWanted && !!pc;
  // "Linux PC speakers" can host Spotify by starting the desktop app on demand.
  // Creating it does nothing; the app only launches from POST /api/pc/spotify/start.
  const pcSpotify = createPcSpotify(cfg, {
    log: (message, err) => app.log.warn({ err }, message),
    ...opts.pcSpotify,
  });
  const playbackLog = createPlaybackLog({ dataDir: cfg.dataDir, probe: opts.playbackProbe, logger: app.log });
  const spotifyWatch = opts.spotifyWatch
    ? createSpotifyWatch({ dataDir: cfg.dataDir, logger: app.log, ...(typeof opts.spotifyWatch === 'object' ? opts.spotifyWatch : {}) })
    : undefined;
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
  /** Linked Spotify artist id -> until when not to ask for it again. */
  const artistFailedUntil = new Map<string, number>();
  const speakers = createSpeakerGuard(
    { pc: () => pc, spotify: () => (pcSpotifyDevice ? spotify?.zones.get(pcSpotifyDevice.id) : undefined) },
    {
      onError: (err) => app.log.warn({ err }, 'could not pause the other player on the PC speakers'),
      // 'out' allows one background poll in ten minutes: mpv starting must not add to that (an MPRIS read is free).
      canWake: () =>
        spotify?.api.budgetLevel() !== 'out' || (!!pcSpotifyDevice && !!mpris?.readsFree(pcSpotifyDevice.id.slice('spotify:'.length))),
      // warn: rune runs at LOG_LEVEL=warn, and this is how a silent song gets explained
      onPause: (info) => app.log.warn(info, 'speaker guard paused a player'),
    },
  );
  // Phase 2: the Spotify app on this PC is read over MPRIS (free) instead of GET /me/player; commands stay on the Web API.
  // The server-owned queue reads the app's facts from the same bus.
  const mprisBus: MprisBus | undefined =
    opts.mpris && cfg.spotifyClientId && (cfg.spotify?.mprisReads !== false || serverQueue)
      ? typeof opts.mpris === 'object' && 'bus' in opts.mpris
        ? opts.mpris.bus
        : createMprisBus({ logger: app.log, ...(typeof opts.mpris === 'object' ? opts.mpris : {}) })
      : undefined;
  const mpris: MprisPlaybackSource | undefined =
    mprisBus && cfg.spotify?.mprisReads !== false
      ? new MprisPlaybackSource(
          mprisBus,
          {
            deviceId: () => (pcSpotifyDevice ? pcSpotifyDevice.id.slice('spotify:'.length) : null),
            knownTracks: (ids) => loadQueueItems(db, ids),
            budgetLevel: (): SpotifyBudgetLevel => spotify?.api.budgetLevel() ?? 'normal',
            logger: app.log,
          },
        )
      : undefined;
  const notePcSpotify = (list: { id: Zone; name: string }[]): void => {
    const wanted = (cfg.pcSpotifyDevice ?? 'HORSE').trim().toLowerCase();
    const match = list.find((z) => z.name.toLowerCase() === wanted) ?? (wanted ? list.find((z) => z.name.toLowerCase().includes(wanted)) : undefined);
    pcSpotifyDevice = match ? { id: match.id, name: match.name } : null;
  };
  // With the server-owned queue, mpv's own states are the driver's business: the driver's states are the pc zone's.
  if (!serverQueue) {
    pc?.onChange((state) => speakers.changed('pc', state));
    pc?.onChange((state) => {
      recordHistory(state);
      broadcast({ type: 'player', state: sanitize(state) });
    });
  }
  const spotify = cfg.spotifyClientId
    ? createSpotify(db, cfg, {
        ...opts.spotifyOptions,
        // Connect zones poll just after each song ends while somebody is watching;
        // with no live socket they poll slower still and skip the queue.
        hasClients: () => presence.hasVisible(),
        // Only a zone some visible tab shows or drives is polled in the background, and the PC's own Spotify app
        // always (the speaker guard and history need it). Every other Connect device costs no reads until viewed.
        viewed: (zone) => zone === pcSpotifyDevice?.id || presence.viewing(zone),
        // Spotify's queue is read only for a zone a visible tab shows (the PC's own app included).
        shown: (zone) => presence.viewing(zone),
        mpris,
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

  // ---------- the server-owned pc queue (phase 3, flag spotify.serverQueue)
  const horseDeviceId = (): string | null => (pcSpotifyDevice ? pcSpotifyDevice.id.slice('spotify:'.length) : null);
  const spotifyOut =
    serverQueue && spotify && mprisBus
      ? new SpotifyAppOutput({
          bus: mprisBus,
          api: spotify.zones.controlApi,
          deviceId: horseDeviceId,
          findDevice: async () => {
            notePcSpotify(await spotify.zones.listZones());
            return horseDeviceId();
          },
          startApp: () => pcSpotify.start(),
          log: (obj, msg) => app.log.warn(obj, msg),
        })
      : undefined;
  const driver: QueueDriver | undefined =
    serverQueue && pc
      ? new QueueDriver({
          load: (ids) => loadDriverItems(ids),
          outputs: { mpv: new MpvOutput(pc), spotify: spotifyOut },
          store: appStateStore(db),
          rateLimitedUntil: () => spotify?.api.blockedUntil() ?? null,
          mirror: () => (pcSpotifyDevice ? spotify?.zones.get(pcSpotifyDevice.id) : undefined),
          describe: (items) => describeSpotify(items),
          onPlay: (play) => history.record(play),
          log: (obj, msg) => app.log.warn(obj, msg),
        })
      : undefined;
  /** Queue items for the driver: every id rune knows, and Spotify ids it never stored as placeholders, in order. */
  function loadDriverItems(ids: string[]): ReturnType<typeof loadQueueItems> {
    const known = loadQueueItems(db, ids);
    const out: typeof known = [];
    let k = 0;
    for (const id of ids) {
      const hit = known[k];
      if (hit && hit.track.id === id) {
        out.push(hit);
        k++;
      } else if (id.startsWith('sp:')) out.push(placeholderItem(id, makeQueueId()));
    }
    return out;
  }
  /** Titles and covers for a few Spotify songs rune never stored (a lookup each), while the budget allows. */
  async function describeSpotify(items: ReturnType<typeof loadQueueItems>): Promise<ReturnType<typeof loadQueueItems>> {
    if (!spotify) return [];
    const level = spotify.api.budgetLevel();
    if (level === 'low' || level === 'out') return [];
    const out: ReturnType<typeof loadQueueItems> = [];
    for (const item of items.slice(0, 8)) {
      try {
        const sp = await spotify.api.track(item.track.id.slice(3));
        if (sp?.id) out.push({ queueId: item.queueId, track: mapTrack(sp), album: albumSummaryFromTrack(sp) });
      } catch (err) {
        if ((err as { status?: number }).status === 429) break;
      }
    }
    return out;
  }
  driver?.onChange((state) => broadcast({ type: 'player', state: sanitize(state) }));
  /** One live subscription per Connect zone id. */
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
  // Linking is a background nicety: a few albums per run, spaced out. One run at 1 request/s over the whole library
  // (≈900 requests in an hour) is what earned the account an 11-hour lockout.
  const linking = spotify ? createLinking(db, cfg, { api: spotify.api, rateLimitMs: 2500, maxAlbumsPerRun: 40 }) : undefined;
  let lastDevicesRateLimitLog = 0;
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
  // Auto-radio: keep the PC zone playing when its queue runs out (off by default).
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
  // Off unless switched on: it starts music on the speakers with nobody asking.
  const autoRadioEnabled = (): boolean => getState(AUTO_RADIO_KEY) === '1';
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
    if (id === 'pc') return driver ?? pc;
    if (id.startsWith('spotify:') && spotify) {
      // After a restart the Connect zones are unknown until the device list is read.
      if (!spotify.zones.get(id)) await spotify.zones.listZones().catch(() => undefined);
      // Still unknown (Spotify unreachable and never listed): make the zone anyway, so a page that remembers the device
      // can read it and send to it. Spotify then answers a command with its own reason (the daily limit, an unknown
      // device), which beats a 404 "unknown zone" that looks like a broken app.
      const deviceId = id.slice('spotify:'.length);
      if (!spotify.zones.get(id) && SPOTIFY_DEVICE_ID.test(deviceId)) spotify.zones.ensureZone(deviceId, 'Spotify device');
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
    let owned = false;
    const off = z.onChange((state) => {
      if (id === pcSpotifyDevice?.id) {
        if (!driver) speakers.changed('spotify', state);
        spotifyWatch?.connect(state);
        driver?.mirrorChanged();
        // The server-owned queue writes its own plays from explicit ends: the app's zone counts only what rune did not
        // start (one stopped state first closes whatever it was counting).
        const mine = !!driver?.ownsSpotifyApp();
        if (mine && !owned) recordHistory({ ...state, status: 'stopped', queue: [], index: -1 });
        owned = mine;
        if (!mine) recordHistory(state);
      } else recordHistory(state);
      broadcast({ type: 'player', state: sanitize(state) });
    });
    spotifyListeners.set(id, { zone: z, off });
    return z;
  }

  /**
   * Which Connect devices get a subscription (and so a polling loop): the PC's own Spotify app, the account's
   * active device and any zone a tab has said it views. Every other device is only listed; the picker's
   * on-demand fresh read of the device list gives it all it needs, and a command or a tab viewing it starts watching.
   */
  const worthWatching = (z: { id: Zone; isActive?: boolean }): boolean =>
    z.id === pcSpotifyDevice?.id || z.isActive === true || presence.declared(z.id);

  /** After a (re)start nothing would watch the Spotify devices until a page asked: watch the ones that matter now. */
  async function watchAllSpotifyZones(): Promise<void> {
    if (!spotify) return;
    try {
      if (!(await spotify.auth.status()).connected) return;
      const list = await spotify.zones.listZones();
      notePcSpotify(list);
      for (const z of list) if (worthWatching(z)) watchSpotifyZone(z.id);
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
  // The server-owned queue says when it ran out (an explicit event), and plays the radio songs itself.
  driver?.onChange((state) => {
    if (state.index >= 0 && !state.hold) peaks.prefetch(state.queue.slice(state.index + 1, state.index + 4).map((q) => q.track.id));
  });
  driver?.onQueueEnded((state) => {
    if (autoRunning || !autoRadioEnabled()) return;
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
        await driver.command({ type: 'enqueue', trackIds: fresh });
        await driver.command({ type: 'jump', index: appendAt });
        await driver.command({ type: 'resume' });
        app.log.warn({ reason: 'queue ran out', queueLength: appendAt, added: fresh.length, trackId: fresh[0] }, 'auto-radio started a song');
      } catch (e) {
        app.log.warn({ err: e }, 'auto-radio failed');
      } finally {
        autoRunning = false;
      }
    })();
  });
  if (!driver) pc?.onChange((state) => {
    const prev = autoPrev;
    autoPrev = state;
    // Warm the waveform cache for the next few queue entries.
    if (state.index >= 0) {
      peaks.prefetch(state.queue.slice(state.index + 1, state.index + 4).map((q) => q.track.id));
    }
    if (!pc || autoRunning || !autoRadioEnabled()) return;
    if (!prev || (prev.status !== 'playing' && prev.status !== 'loading')) return;
    // A one-track queue is a tab driving mpv song by song (a mixed queue): that song ending is not the queue running out.
    if (state.status !== 'stopped' || state.queue.length < 2) return;
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
        // warn: rune runs at LOG_LEVEL=warn, and music that starts by itself has to be traceable
        app.log.warn({ reason: 'queue ran out', queueLength: appendAt, added: fresh.length, trackId: fresh[0] }, 'auto-radio started a song');
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

  // ---------- self-update
  // The served web build lives in the git checkout's web/dist; both the static
  // plugin and the update module need that path, so resolve it once here.
  const dist = opts.webDist ?? new URL('../../../web/dist', import.meta.url).pathname;
  const updateService = createUpdateService({
    repoRoot: () => findUpdateRepoRoot(process.cwd()),
    webDist: dist,
    // Music playing (or paused mid-song) on the PC blocks an update, whatever
    // zone owns the PC queue (mpv directly, or the server-owned driver).
    isPlayingOnPc: () => {
      const zone = driver ?? pc;
      if (!zone) return false;
      const s = zone.state();
      return s.status === 'playing' || s.status === 'paused' || s.status === 'loading';
    },
    logger: { warn: (obj, msg) => app.log.warn(obj, msg), info: (obj, msg) => app.log.info(obj, msg) },
  });

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
          const m = msg as { type?: unknown; visible?: unknown; zones?: unknown };
          if (m.type === 'presence') {
            if (typeof m.visible !== 'boolean') return;
            // Hidden → visible: the zones poll again now.
            if (presence.setVisible(socket, m.visible)) spotify?.zones.wake();
          } else if (m.type === 'viewing') {
            if (!Array.isArray(m.zones) || !m.zones.every((z) => typeof z === 'string' && z.length <= 200)) return;
            // A zone a tab starts showing is read now, not at its next (possibly far-off) poll.
            const started = presence.setViewing(socket, m.zones as string[]);
            // A tab showing a Connect device makes it worth a subscription (the list may not have been read since a restart).
            for (const z of m.zones as string[]) if (z.startsWith('spotify:')) watchSpotifyZone(z);
            for (const z of started) spotify?.zones.get(z)?.wake();
          } else if (m.type === 'sdk-state') {
            spotify?.reportLocalPlayback(msg);
          }
        });
        // The server-owned queue says hello first: a tab built from another web build, or one that still drives a
        // mixed queue itself, is told to reload.
        if (driver) socket.send(JSON.stringify({ type: 'hello', build: webBuildId(), serverQueue: true } satisfies ServerEvent));
        const pcZone = driver ?? pc;
        if (pcZone) {
          const state = sanitize(pcZone.state());
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
      registerLikedRoutes(r, db, spotify ? {
        api: spotify.api,
        connected: async () => (await spotify.auth.status()).connected,
        grantedScopes: () => spotify.auth.grantedScopes(),
        onChange: () => broadcast({ type: 'library-changed' }),
      } : undefined);
      registerFrameRoutes(r);
      registerHistoryRoutes(r, history);
      registerLoudnessRoutes(r, loudness);
      registerDupesRoutes(r, db);
      registerRadioRoutes(r, radio);
      registerRadioStationRoutes(r, iradio);
      registerMyPlaylistRoutes(r, db, {
        dataDir: cfg.dataDir,
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
        ...(spotify
          ? {
              removeFromSpotifyPlaylist: async (playlistId: string, trackIds: string[]) => {
                await removeSpotifyPlaylistTracks(
                  {
                    auth: spotify.auth,
                    api: spotify.api,
                    db,
                    onChange: () => broadcast({ type: 'library-changed' }),
                  },
                  playlistId,
                  trackIds,
                );
              },
            }
          : {}),
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

      // Self-update: status + install. The install route rebuilds and restarts
      // rune, so it is guarded by a same-origin check of its own.
      registerUpdateRoutes(r, updateService);

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

      // "Dither · Custom" colours ({ mid, light } as #rrggbb), shared the same way.
      r.get('/settings/duotone', async () => {
        const raw = getState('ui.duotone');
        try { return { duotone: raw ? JSON.parse(raw) : null }; } catch { return { duotone: null }; }
      });
      r.post<{ Body: { duotone?: unknown } }>('/settings/duotone', async (req, reply) => {
        const d = req.body?.duotone as { mid?: unknown; light?: unknown } | undefined;
        const hex = (v: unknown) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
        if (!d || !hex(d.mid) || !hex(d.light)) return reply.code(400).send({ error: 'duotone needs mid and light as #rrggbb' });
        const duotone = { mid: (d.mid as string).toLowerCase(), light: (d.light as string).toLowerCase() };
        setState('ui.duotone', JSON.stringify(duotone));
        return { duotone };
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
        // A second local entry for the same artist (a different spelling source) may not carry the link: use its twin's.
        const linked = spotify && a
          ? ((db.prepare('SELECT spotify_id AS id FROM artists WHERE id = ?').get(req.params.id) as { id: string | null } | undefined)?.id
            ?? (db.prepare('SELECT spotify_id AS id FROM artists WHERE name = ? COLLATE NOCASE AND spotify_id IS NOT NULL LIMIT 1').get(a.name) as { id: string } | undefined)?.id
            ?? null)
          : null;
        // A linked local artist has a page without Spotify, so Spotify may add to it but never hold it up.
        const hasLocalPage = !!(linked && a);
        if (hasLocalPage) {
          if ((artistFailedUntil.get(linked!) ?? 0) > Date.now()) return a;
        }
        try {
          if (spotify && (await spotify.auth.status()).connected) {
            const remote = spotify.artistPage(linked ? `ar:sp:${linked}` : req.params.id);
            if (remote) {
              if (hasLocalPage) {
                // Even after the page has been answered: a late failure still spares the next page the wait.
                remote.catch(() => {
                  if (artistFailedUntil.size >= ARTIST_FAILURES_KEPT) artistFailedUntil.clear();
                  artistFailedUntil.set(linked!, Date.now() + ARTIST_FAILURE_MEMORY_MS);
                });
              }
              // Past the wait the fetch keeps going and fills the cache, so the next visit has the full page.
              const sp = hasLocalPage ? await within(remote, opts.artistWaitMs ?? ARTIST_WAIT_MS) : await remote;
              if (!sp) return a;
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
          }
        } catch (err) {
          app.log.warn({ err, artistId: req.params.id }, 'spotify artist fetch failed');
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

      r.get<{ Querystring: { refresh?: string } }>('/zones', async (req) => {
        const zones: {
          id: Zone;
          name: string;
          kind: 'pc' | 'browser' | 'spotify';
          /** For 'pc': the Spotify Connect device that is the same machine, so
           *  the UI can hand Spotify tracks to the desktop app. */
          spotifyDeviceId?: string;
          spotifyDeviceName?: string;
          /** For 'pc': its queue lives on the server (phase 3); the page is a plain remote. */
          serverQueue?: boolean;
          /** For 'spotify': Spotify's own description, so the picker can label phones and sleeping devices. */
          deviceType?: string;
          isActive?: boolean;
          isRestricted?: boolean;
        }[] = [];
        // The picker opening asks for the list even if the 5 s cache is warm; the API keeps this budget-aware.
        const fresh = req.query.refresh === '1';
        const spotifyConnected = !!spotify && (await spotify.auth.status()).connected;
        if (spotifyConnected) {
          try {
            const spotifyZones = await spotify.zones.listZones({ fresh });
            notePcSpotify(spotifyZones);
            for (const z of spotifyZones) if (worthWatching(z)) watchSpotifyZone(z.id);
            zones.push(...spotifyZones);
          } catch (e) {
            // During a lockout every read fails the same way: one line a minute says so, not one per poll.
            if (e instanceof HttpError && e.status === 429) {
              const now = Date.now();
              if (now - lastDevicesRateLimitLog > 60_000) {
                lastDevicesRateLimitLog = now;
                app.log.info({ until: new Date(spotify.api.blockedUntil() ?? now).toISOString() }, 'spotify devices: resting (rate limited)');
              }
            } else app.log.warn({ err: e }, 'spotify devices failed');
          }
        }
        if (pc) {
          const entry: (typeof zones)[number] = { id: 'pc', name: 'Linux PC speakers', kind: 'pc', ...(driver ? { serverQueue: true } : {}) };
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
          // Who sent it: music that starts by itself has to be traceable to a tab, phone or the voice assistant.
          const ua = String(req.headers['user-agent'] ?? '');
          const from = /iPhone|iPad/.test(ua) ? 'iPhone' : /Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux browser' : ua.slice(0, 24) || 'unknown';
          if (req.params.zone.startsWith('spotify:') || ['play', 'resume', 'next', 'jump'].includes(parsed.command.type)) {
            app.log.warn({ zone: req.params.zone, cmd: parsed.command.type, from }, 'player command');
          }
          const state = await z.command(parsed.command);
          if (req.params.zone.startsWith('spotify:') && startsSound(parsed.command)) playbackLog.started({ zone: req.params.zone, state: () => z.state() });
          return sanitize(state);
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
      // Small by design: 300 entries are kept in memory and each is written to the log.
      r.post<{ Body: { level?: string; msg?: string; data?: unknown } }>('/client-log', { bodyLimit: 16 * 1024 }, async (req) => {
        let data = req.body?.data;
        if (data !== undefined) {
          const text = JSON.stringify(data) ?? '';
          if (text.length > 2000) data = `${text.slice(0, 2000)}… (truncated, ${text.length} chars)`;
        }
        const e = { at: Date.now(), ua: req.headers['user-agent'], level: String(req.body?.level ?? 'info').slice(0, 10), msg: String(req.body?.msg ?? '').slice(0, 500), data };
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
  /** The web build served now (web/dist/build-id.txt, written by the web build); null when there is none. */
  let buildCache: { mtimeMs: number; id: string | null } | null = null;
  function webBuildId(): string | null {
    try {
      const file = join(dist, 'build-id.txt');
      const st = statSync(file);
      if (buildCache?.mtimeMs !== st.mtimeMs) buildCache = { mtimeMs: st.mtimeMs, id: readFileSync(file, 'utf8').trim() || null };
      return buildCache.id;
    } catch {
      return null;
    }
  }
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
    spotifyWatch?.close();
    await driver?.close();
    spotifyOut?.close();
    mpris?.close();
    mprisBus?.close();
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
      // The queue's last position is written before the database closes.
      await driver?.close();
    },
    mpv: pc,
    extra: [
      { name: 'peaks-close', run: () => peaks.close() },
      { name: 'iradio-close', run: () => iradio.close() },
      { name: 'playback-log-close', run: () => playbackLog.close() },
      { name: 'spotify-watch-close', run: () => spotifyWatch?.close() },
      { name: 'mpris-close', run: () => mpris?.close() },
      { name: 'spotify-out-close', run: () => spotifyOut?.close() },
      { name: 'mpris-bus-close', run: () => mprisBus?.close() },
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

  return { app, close, shutdown, watchedSpotifyZones: () => [...spotifyListeners.keys()] };
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
