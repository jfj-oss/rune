// Public entry point for the Spotify integration.
import type { FastifyInstance } from 'fastify';
import type { Album, PlaylistDetail, PlaylistSummary } from '@liner/shared';
import type { Db } from '../db/index.js';
import type { Config } from '../config.js';
import { getAlbum } from '../api/library.js';
import { SpotifyApi } from './api.js';
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
}

export interface SpotifyLibrarySyncResult {
  playlists: PlaylistSyncResult;
  saved: SyncResult;
}

export interface SpotifyModule {
  auth: SpotifyAuth;
  api: SpotifyApi;
  zones: SpotifyZones;
  /** Pull the user's saved albums into the local DB. */
  syncSavedAlbums(): Promise<SyncResult>;
  /** Pull playlists + Liked Songs, then saved albums (keeps in_library correct). */
  syncLibrary(): Promise<SpotifyLibrarySyncResult>;
  /** Spotify catalogue search, cached for identical queries. */
  searchCatalog(q: string): Promise<SearchResults>;
  /** GET /api/albums/sp:<id> for an album not yet in the DB (in_library = 0). */
  fetchAlbum(albumId: string): Promise<Album | undefined>;
  /** Save/unsave an album on Spotify and flip albums.in_library. */
  setAlbumSaved(albumId: string, saved: boolean): Promise<Album | undefined>;
  listPlaylists(): PlaylistSummary[];
  getPlaylist(id: string): PlaylistDetail | undefined;
  /** Register /api/spotify/* on the app given to us by the main session. */
  registerRoutes(app: FastifyInstance): SpotifyAuth;
}

export function createSpotify(db: Db, cfg: Config, opts: CreateSpotifyOptions = {}): SpotifyModule {
  const auth = new SpotifyAuth(db, cfg, opts);
  const api = new SpotifyApi({
    fetch: opts.fetch,
    baseUrl: opts.endpoints?.api,
    getToken: (force) => auth.getAccessToken(force),
  });
  const zones = createSpotifyZones(api, opts);
  const catalog = new SpotifyCatalog(api, { ttlMs: opts.catalogTtlMs, now: opts.now });
  const now = opts.now ?? Date.now;

  return {
    auth,
    api,
    zones,
    syncSavedAlbums: () => syncSavedAlbums(api, db, { now }),
    syncLibrary: async () => {
      // Playlists first: saved-album cleanup must see the current playlist refs.
      const playlists = await syncPlaylists(api, db, { now });
      const saved = await syncSavedAlbums(api, db, { now });
      return { playlists, saved };
    },
    searchCatalog: (q) => catalog.search(q),
    fetchAlbum: (albumId) => fetchSpotifyAlbum(api, db, albumId, { now }),
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
  };
}

export type { SpotifyStatus };
