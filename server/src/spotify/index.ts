// Public entry point for the Spotify integration.
import { loadQueueItems } from '../play/rows.js';
import { SpotifyArtistPages, type SpotifyArtistPage } from './artist.js';
import type { FastifyInstance } from 'fastify';
import type { Album, PlaylistDetail, PlaylistSummary } from '@liner/shared';
import type { Db } from '../db/index.js';
import type { Config } from '../config.js';
import { getAlbum } from '../api/library.js';
import { SpotifyApi, type SpotifyBudgetLogger, type SpotifyHourlyUsage, type SpotifyUsageState } from './api.js';
import { SpotifyAuth, registerSpotifyRoutes, type SpotifyAuthOptions, type SpotifyStatus } from './auth.js';
import { SpotifyCatalog, type SearchResults } from './catalog.js';
import {
  fetchSpotifyAlbum,
  getPlaylist,
  listPlaylists,
  setSpotifyAlbumSaved,
  syncPlaylists,
  type PlaylistSyncResult,
} from './library.js';
import { syncSavedAlbums, type SyncResult } from './map.js';
import { createSpotifyZones, type ConnectZoneOptions, type SpotifyZones } from './zones.js';

export * from './api.js';
export * from './auth.js';
export * from './catalog.js';
export * from './fetch.js';
export * from './library.js';
export * from './map.js';
export * from './zones.js';

export interface CreateSpotifyOptions extends SpotifyAuthOptions, ConnectZoneOptions {
  /** Called after a successful login callback (the server kicks off a sync). */
  onLogin?: () => void;
  /** TTL for identical catalogue searches (default 60 s). */
  catalogTtlMs?: number;
  /** One pino line per completed hour of Spotify traffic (see SpotifyApiOptions). */
  onHourlyUsage?: (usage: SpotifyHourlyUsage) => void;
  /** Receives the budget-level warn line (normally the Fastify/pino logger). */
  logger?: SpotifyBudgetLogger;
}

export interface SpotifyLibrarySyncResult {
  playlists: PlaylistSyncResult;
  /** null when skipped or rate limited (see savedRetryAfterMs). */
  saved: SyncResult | null;
  savedRetryAfterMs?: number;
}

export interface SpotifyModule {
  auth: SpotifyAuth;
  api: SpotifyApi;
  zones: SpotifyZones;
  /** Pull the user's saved albums into the local DB. */
  syncSavedAlbums(): Promise<SyncResult>;
  /** Pull playlists + Liked Songs, then saved albums (keeps in_library correct). */
  syncLibrary(opts?: { skipLiked?: boolean; skipSaved?: boolean }): Promise<SpotifyLibrarySyncResult>;
  /** Spotify catalogue search, cached for identical queries. */
  searchCatalog(q: string): Promise<SearchResults>;
  /** GET /api/albums/sp:<id> for an album not yet in the DB (in_library = 0). */
  fetchAlbum(albumId: string): Promise<Album | undefined>;
  /** Spotify artist + discography for GET /api/artists/ar:sp:<id> (null for other ids). */
  artistPage(artistId: string): Promise<SpotifyArtistPage> | null;
  /** Spotify's picture of an ar:sp: artist (null when none / not a Spotify artist). */
  artistImage(artistId: string): Promise<string | null>;
  /** Save/unsave an album on Spotify and flip albums.in_library. */
  setAlbumSaved(albumId: string, saved: boolean): Promise<Album | undefined>;
  listPlaylists(): PlaylistSummary[];
  getPlaylist(id: string): PlaylistDetail | undefined;
  /** Register /api/spotify/* on the app given to us by the main session. */
  registerRoutes(app: FastifyInstance): SpotifyAuth;
  /** Persist request counters + breaker and stop the usage timer (idempotent). */
  close(): void;
}

const SPOTIFY_USAGE_KEY = 'spotify.usage';

/** The app_state table is normally created by the server; create it for standalone use too. */
function ensureAppState(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
}

/** Corrupt/legacy JSON is treated as "nothing persisted" rather than failing startup. */
function loadSpotifyUsage(db: Db): SpotifyUsageState | undefined {
  try {
    const raw = (
      db.prepare('SELECT value FROM app_state WHERE key = ?').get(SPOTIFY_USAGE_KEY) as
        | { value: string }
        | undefined
    )?.value;
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<SpotifyUsageState> | null;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const blockedUntil = typeof parsed.blockedUntil === 'number' ? parsed.blockedUntil : null;
    return { buckets: Array.isArray(parsed.buckets) ? parsed.buckets : [], blockedUntil };
  } catch {
    return undefined;
  }
}

function saveSpotifyUsage(db: Db, usage: SpotifyUsageState): void {
  db.prepare(
    'INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(SPOTIFY_USAGE_KEY, JSON.stringify(usage));
}

export function createSpotify(db: Db, cfg: Config, opts: CreateSpotifyOptions = {}): SpotifyModule {
  const auth = new SpotifyAuth(db, cfg, opts);
  ensureAppState(db);
  const api = new SpotifyApi({
    fetch: opts.fetch,
    baseUrl: opts.endpoints?.api,
    getToken: (force) => auth.getAccessToken(force),
    now: opts.now,
    onHourlyUsage: opts.onHourlyUsage,
    dailyBudget: cfg.spotify?.dailyBudget,
    logger: opts.logger,
    // Request counts and the circuit breaker outlive a rune restart.
    loadUsage: () => loadSpotifyUsage(db),
    saveUsage: (usage) => saveSpotifyUsage(db, usage),
  });
  // songs rune has stored (played, saved, in playlists) start with their titles + covers, no lookup
  const zones = createSpotifyZones(api, {
    knownTracks: (ids) => loadQueueItems(db, ids),
    // While Spotify is out of quota the zone loop parks itself until the breaker expires.
    blockedUntil: () => api.blockedUntil(),
    // Background polls slow down as the rolling daily budget fills up.
    budgetLevel: () => api.budgetLevel(),
    // The PC's own speaker (go-librespot) is driven locally, costing no Web API requests.
    librespotUrl: cfg.librespotUrl,
    ...opts,
  });
  const catalog = new SpotifyCatalog(api, { ttlMs: opts.catalogTtlMs, now: opts.now });
  const now = opts.now ?? Date.now;
  const artistPages = new SpotifyArtistPages(api, now);

  return {
    auth,
    api,
    zones,
    syncSavedAlbums: () => syncSavedAlbums(api, db, { now }),
    syncLibrary: async (syncOpts = {}) => {
      // Playlists first: saved-album cleanup must see the current playlist refs.
      const playlists = await syncPlaylists(api, db, { now, skipLiked: syncOpts.skipLiked });
      // Saved albums can be rate limited on their own; never lose the playlist sync for it.
      if (syncOpts.skipSaved) return { playlists, saved: null };
      try {
        const saved = await syncSavedAlbums(api, db, { now });
        return { playlists, saved };
      } catch (err) {
        const e = err as { status?: number; retryAfterMs?: number };
        if (e.status === 429) return { playlists, saved: null, savedRetryAfterMs: e.retryAfterMs ?? 60 * 60_000 };
        throw err;
      }
    },
    // User-facing reads are allowed at every level but 'out': then serve what the DB has.
    searchCatalog: (q) =>
      api.budgetLevel() === 'out' ? Promise.resolve({ albums: [], artists: [], tracks: [] }) : catalog.search(q),
    fetchAlbum: (albumId) =>
      api.budgetLevel() === 'out' ? Promise.resolve(getAlbum(db, albumId)) : fetchSpotifyAlbum(api, db, albumId, { now }),
    artistPage: (artistId) => (api.budgetLevel() === 'out' ? null : artistPages.get(artistId)),
    artistImage: (artistId) => (api.budgetLevel() === 'out' ? Promise.resolve(null) : artistPages.image(artistId)),
    setAlbumSaved: async (albumId, saved) => {
      if (saved && !getAlbum(db, albumId)) {
        await fetchSpotifyAlbum(api, db, albumId, { now });
      }
      await setSpotifyAlbumSaved(api, db, albumId, saved);
      return getAlbum(db, albumId);
    },
    listPlaylists: () => listPlaylists(db),
    getPlaylist: (id) => getPlaylist(db, id),
    registerRoutes: (app: FastifyInstance) =>
      registerSpotifyRoutes(app, db, cfg, { ...opts, auth }),
    close: () => api.close(),
  };
}

export type { SpotifyStatus };
