// Worker Y — internet radio via radio-browser.info.
//
// createIradio(db, cfg) returns the module the main session hands to
// registerRadioStationRoutes(app, iradio); the exported register function mounts
// GET /radio/stations, /radio/favourites (GET/POST/DELETE), /radio/:id and
// /radio/:id/stream (plus /radio/:id/logo for cached station artwork).
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { RadioBrowserApi, type RadioBrowserOptions } from './client.js';
import { cachedLogo, cacheStationLogo } from './logo.js';
import { markStationPlayedWith, radioUserAgent, sharedRadioClient } from './playback.js';
import {
  ensureRadioSchema,
  getStation,
  getStationRowsByIds,
  listFavourites,
  mapRadioRow,
  setFavourite,
  upsertStation,
} from './store.js';
import { resolveStationStreamUrl, type MediaDeps } from './stream.js';
import { stationUuid, type AddFavouriteInput, type RadioSearchParams, type RadioSearchResult, type RadioStation } from './types.js';

export interface CreateIradioOptions {
  /** Force one radio-browser server (tests / self-check). */
  baseUrl?: string;
  serversUrl?: string;
  /** Injected API fetch (fixtures in tests). */
  fetchImpl?: typeof fetch;
  /** Injected fetch for logos and stream proxying (tests). */
  mediaFetch?: typeof fetch;
  minRequestIntervalMs?: number;
  timeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
  random?: () => number;
}

export interface Iradio {
  search(params: RadioSearchParams): Promise<RadioSearchResult>;
  /** Look up a station: DB cache first, then radio-browser byuuid. Upserts it so
   *  the queue can load it via its 'rs:' id. */
  station(id: string): Promise<RadioStation | undefined>;
  favourites(): RadioStation[];
  addFavourite(input: AddFavouriteInput): Promise<RadioStation | undefined>;
  removeFavourite(id: string): boolean;
  /** Radio-browser click counter; only for stations that actually play. */
  markPlayed(id: string): Promise<void>;
  /** Direct stream URL (playlist wrappers resolved, cached in the DB). */
  streamUrl(station: RadioStation): Promise<string>;
  /** Cached logo file, downloading the favicon on first use. */
  logo(id: string): Promise<{ path: string; mime: string } | undefined>;
  mediaDeps(): MediaDeps;
  close(): void;
}

class IradioImpl implements Iradio {
  private readonly db: Db;
  private readonly cfg: Config;
  private readonly api: RadioBrowserApi;
  private readonly mediaFetch: typeof fetch;

  constructor(db: Db, cfg: Config, api: RadioBrowserApi, mediaFetch: typeof fetch) {
    this.db = db;
    this.cfg = cfg;
    this.api = api;
    this.mediaFetch = mediaFetch;
    ensureRadioSchema(db);
  }

  async search(params: RadioSearchParams): Promise<RadioSearchResult> {
    const raw = await this.api.searchStations(params);
    const ids = raw.map((station) => upsertStation(this.db, station));
    const rows = getStationRowsByIds(this.db, ids);
    const items: RadioStation[] = [];
    for (let i = 0; i < raw.length; i++) {
      const row = rows.get(ids[i]!);
      if (row) items.push(mapRadioRow(row));
    }
    return { items, total: items.length };
  }

  async station(id: string): Promise<RadioStation | undefined> {
    const cached = getStation(this.db, id);
    if (cached) return cached;
    const uuid = stationUuid(id);
    if (!uuid) return undefined;
    const raw = await this.api.stationByUuid(uuid).catch(() => undefined);
    if (!raw) return undefined;
    const stored = upsertStation(this.db, raw);
    return getStation(this.db, stored);
  }

  favourites(): RadioStation[] {
    return listFavourites(this.db);
  }

  async addFavourite(input: AddFavouriteInput): Promise<RadioStation | undefined> {
    const uuid = favouriteUuid(input);
    if (!uuid) return undefined;
    let station = getStation(this.db, uuid);
    if (!station) {
      // A caller may pass a full station snapshot (e.g. a search result that was
      // never resolved). Prefer it over another API round-trip.
      const snapshot = input.station;
      if (snapshot && typeof snapshot.name === 'string' && typeof snapshot.url === 'string') {
        upsertStation(this.db, { ...snapshot, stationuuid: uuid } as Parameters<typeof upsertStation>[1]);
      } else {
        const raw = await this.api.stationByUuid(uuid).catch(() => undefined);
        if (!raw) return undefined;
        upsertStation(this.db, raw);
      }
      station = getStation(this.db, uuid);
    }
    if (!station) return undefined;
    setFavourite(this.db, station.id, true);
    // Fetch the logo now so favourites look right offline; failure is harmless.
    await cacheStationLogo(this.db, this.cfg, station, this.mediaFetch).catch(() => undefined);
    return getStation(this.db, station.id);
  }

  removeFavourite(id: string): boolean {
    return setFavourite(this.db, id, false);
  }

  async markPlayed(id: string): Promise<void> {
    await markStationPlayedWith(this.api, this.db, id);
  }

  async streamUrl(station: RadioStation): Promise<string> {
    return resolveStationStreamUrl(this.db, station, this.mediaDeps());
  }

  async logo(id: string): Promise<{ path: string; mime: string } | undefined> {
    const cached = cachedLogo(this.db, id);
    if (cached) return cached;
    const station = getStation(this.db, id);
    if (!station) return undefined;
    return cacheStationLogo(this.db, this.cfg, station, this.mediaFetch);
  }

  mediaDeps(): MediaDeps {
    return { userAgent: radioUserAgent(this.cfg), fetchImpl: this.mediaFetch };
  }

  close(): void {
    // No long-lived sockets are held by this module; per-request proxies abort
    // themselves when the reply closes.
  }
}

export function createIradio(db: Db, cfg: Config, opts: CreateIradioOptions = {}): Iradio {
  ensureRadioSchema(db);
  const custom =
    opts.baseUrl !== undefined ||
    opts.serversUrl !== undefined ||
    opts.fetchImpl !== undefined ||
    opts.minRequestIntervalMs !== undefined ||
    opts.timeoutMs !== undefined ||
    opts.cacheTtlMs !== undefined ||
    opts.now !== undefined ||
    opts.random !== undefined;
  const clientOptions: RadioBrowserOptions = {
    userAgent: radioUserAgent(cfg),
    ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.serversUrl !== undefined ? { serversUrl: opts.serversUrl } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.minRequestIntervalMs !== undefined ? { minRequestIntervalMs: opts.minRequestIntervalMs } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.cacheTtlMs !== undefined ? { cacheTtlMs: opts.cacheTtlMs } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.random !== undefined ? { random: opts.random } : {}),
  };
  const api = custom ? new RadioBrowserApi(clientOptions) : sharedRadioClient(cfg);
  return new IradioImpl(db, cfg, api, opts.mediaFetch ?? globalThis.fetch);
}

function favouriteUuid(input: AddFavouriteInput): string | undefined {
  const candidates = [input.id, input.stationuuid, input.station?.stationuuid, input.station?.id];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return stationUuid(candidate.trim());
    }
  }
  return undefined;
}

export { registerRadioStationRoutes } from './routes.js';
export * from './types.js';
export { ensureRadioSchema } from './store.js';
export { parseM3u, parsePls, parsePlaylist, playlistKind, resolvePlaylistUrl } from './stream.js';
export type { MediaDeps } from './stream.js';
