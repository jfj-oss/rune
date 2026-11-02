// Public entry point for the Spotify integration.
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import type { Config } from '../config.js';
import { SpotifyApi } from './api.js';
import { SpotifyAuth, registerSpotifyRoutes, type SpotifyAuthOptions, type SpotifyStatus } from './auth.js';
import { syncSavedAlbums, type SyncResult } from './map.js';
import { createSpotifyZones, type ConnectZoneOptions, type SpotifyZones } from './zones.js';

export * from './api.js';
export * from './auth.js';
export * from './fetch.js';
export * from './map.js';
export * from './zones.js';

export interface CreateSpotifyOptions extends SpotifyAuthOptions, ConnectZoneOptions {}

export interface SpotifyModule {
  auth: SpotifyAuth;
  api: SpotifyApi;
  zones: SpotifyZones;
  /** Pull the user's saved albums into the local DB. */
  syncSavedAlbums(): Promise<SyncResult>;
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

  return {
    auth,
    api,
    zones,
    syncSavedAlbums: () => syncSavedAlbums(api, db),
    registerRoutes: (app: FastifyInstance) => registerSpotifyRoutes(app, db, cfg, { ...opts, auth }),
  };
}

export type { SpotifyStatus };
