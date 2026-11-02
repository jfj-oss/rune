// Glue used by the PC zone: the shared radio-browser client, click counting for
// stations that actually play, and .pls/.m3u resolution before `loadfile`.
//
// Kept apart from index.ts/routes so src/play/zone.ts does not pull in Fastify.
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { RadioBrowserApi } from './client.js';
import { getStation } from './store.js';
import { resolveStationStreamUrl } from './stream.js';

export function radioUserAgent(cfg: Config): string {
  return `${cfg.userAgent} radio-browser/1.0`;
}

const shared = new Map<string, RadioBrowserApi>();

/** One client per process so the 1 req/s gate is shared by routes and the zone. */
export function sharedRadioClient(cfg: Config): RadioBrowserApi {
  const key = radioUserAgent(cfg);
  let client = shared.get(key);
  if (!client) {
    client = new RadioBrowserApi({ userAgent: key });
    shared.set(key, client);
  }
  return client;
}

/** Reset the process-wide client (tests only). */
export function resetSharedRadioClient(): void {
  shared.clear();
}

const recentClicks = new Map<string, number>();
const CLICK_DEDUPE_MS = 60_000;

/** Shared click/dedupe implementation; lets createIradio use its injected client. */
export async function markStationPlayedWith(
  client: Pick<RadioBrowserApi, 'click'>,
  db: Db,
  id: string,
  now = Date.now(),
): Promise<void> {
  const station = getStation(db, id);
  if (!station) return;
  const last = recentClicks.get(station.id) ?? 0;
  if (now - last < CLICK_DEDUPE_MS) return;
  recentClicks.set(station.id, now);
  try {
    await client.click(station.stationuuid);
  } catch {
    recentClicks.delete(station.id); // allow a later attempt
  }
}

/**
 * Tell radio-browser a station was actually played (their click counter). Only
 * called once mpv accepted the stream; deduped so a PC-zone respawn seconds later
 * does not count twice.
 */
export async function markStationPlayed(
  db: Db,
  cfg: Config,
  id: string,
  now = Date.now(),
): Promise<void> {
  await markStationPlayedWith(sharedRadioClient(cfg), db, id, now);
}

/** Direct stream URL for a queued radio track (resolves playlist wrappers). */
export async function resolveRadioStreamUrlForTrack(
  db: Db,
  cfg: Config,
  id: string,
): Promise<string | undefined> {
  const station = getStation(db, id);
  if (!station) return undefined;
  try {
    return await resolveStationStreamUrl(db, station, {
      userAgent: radioUserAgent(cfg),
      fetchImpl: globalThis.fetch,
    });
  } catch {
    return station.urlResolved ?? station.url;
  }
}

/** Clear click de-duplication state (tests only). */
export function resetPlayedState(): void {
  recentClicks.clear();
}
