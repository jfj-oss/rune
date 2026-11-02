// radio_stations persistence: search-result cache + favourites, and the mapping
// from a station row to the shared Track used by the playback queue.
import { readFileSync } from 'node:fs';
import type { QueueItem, Track } from '@liner/shared';
import type { Db } from '../db/index.js';
import type { PlayableTrack } from '../play/rows.js';
import type { RadioBrowserStation, RadioStation } from './types.js';
import { stationId, stationUuid } from './types.js';

const migrationSql = readFileSync(new URL('../db/migrations-iradio.sql', import.meta.url), 'utf8');
const ensured = new WeakSet<Db>();

/** Create radio_stations if it is not there yet (idempotent). */
export function ensureRadioSchema(db: Db): void {
  if (ensured.has(db)) return;
  db.exec(migrationSql);
  ensured.add(db);
}

interface RadioRow {
  id: string;
  stationuuid: string;
  name: string;
  url: string;
  url_resolved: string | null;
  stream_url: string | null;
  homepage: string | null;
  favicon: string | null;
  tags: string;
  country: string | null;
  countrycode: string | null;
  state: string | null;
  language: string | null;
  codec: string | null;
  bitrate: number | null;
  votes: number;
  clickcount: number;
  clicktrend: number;
  geo_lat: number | null;
  geo_long: number | null;
  lastcheckok: number | null;
  favourite: number;
  logo_path: string | null;
  logo_mime: string | null;
  raw_json: string | null;
  added_at: number;
  updated_at: number;
}

export function logoRoute(id: string): string {
  return `/api/radio/${encodeURIComponent(id)}/logo`;
}

function parseTags(tags: string | null | undefined): string[] {
  if (!tags) return [];
  const raw = tags.trim();
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
    } catch {
      // fall through to the comma form
    }
  }
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

export function mapRadioRow(row: RadioRow): RadioStation {
  return {
    id: row.id,
    stationuuid: row.stationuuid,
    name: row.name,
    url: row.url,
    ...(row.url_resolved ? { urlResolved: row.url_resolved } : {}),
    ...(row.logo_path || row.favicon ? { logoUrl: logoRoute(row.id) } : {}),
    ...(row.favicon ? { favicon: row.favicon } : {}),
    ...(row.homepage ? { homepage: row.homepage } : {}),
    tags: parseTags(row.tags),
    ...(row.country ? { country: row.country } : {}),
    ...(row.countrycode ? { countrycode: row.countrycode } : {}),
    ...(row.state ? { state: row.state } : {}),
    ...(row.language ? { language: row.language } : {}),
    ...(row.codec ? { codec: row.codec } : {}),
    bitrate: row.bitrate ?? 0,
    votes: row.votes,
    clickcount: row.clickcount,
    clicktrend: row.clicktrend,
    hls: /\.m3u8(?:[?#]|$)/i.test(row.url_resolved ?? row.url),
    favourite: row.favourite === 1,
    ...(row.lastcheckok != null ? { lastCheckOk: row.lastcheckok === 1 } : {}),
  };
}

/** Station URL the player should try first (direct stream if already resolved). */
export function stationStreamUrl(row: RadioRow): string {
  return row.stream_url ?? row.url_resolved ?? row.url;
}

/**
 * Insert/refresh a radio-browser station. User state (favourite, cached logo,
 * first-seen time) is never overwritten; a changed upstream URL drops the cached
 * playlist resolution.
 */
export function upsertStation(db: Db, raw: RadioBrowserStation, now = Date.now()): string {
  ensureRadioSchema(db);
  const id = stationId(raw.stationuuid);
  const tags = parseTags(typeof raw.tags === 'string' ? raw.tags : undefined);
  db.prepare(
    `INSERT INTO radio_stations (
       id, stationuuid, name, url, url_resolved, stream_url, homepage, favicon, tags,
       country, countrycode, state, language, codec, bitrate, votes, clickcount, clicktrend,
       geo_lat, geo_long, lastcheckok, favourite, logo_path, logo_mime, raw_json,
       added_at, updated_at
     ) VALUES (
       @id, @stationuuid, @name, @url, @url_resolved, NULL, @homepage, @favicon, @tags,
       @country, @countrycode, @state, @language, @codec, @bitrate, @votes, @clickcount, @clicktrend,
       @geo_lat, @geo_long, @lastcheckok, 0, NULL, NULL, @raw_json,
       @now, @now
     )
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       url = excluded.url,
       url_resolved = excluded.url_resolved,
       stream_url = CASE
         WHEN radio_stations.url = excluded.url
          AND ifnull(radio_stations.url_resolved, '') = ifnull(excluded.url_resolved, '')
         THEN radio_stations.stream_url ELSE NULL END,
       homepage = excluded.homepage,
       favicon = excluded.favicon,
       tags = excluded.tags,
       country = excluded.country,
       countrycode = excluded.countrycode,
       state = excluded.state,
       language = excluded.language,
       codec = excluded.codec,
       bitrate = excluded.bitrate,
       votes = excluded.votes,
       clickcount = excluded.clickcount,
       clicktrend = excluded.clicktrend,
       geo_lat = excluded.geo_lat,
       geo_long = excluded.geo_long,
       lastcheckok = excluded.lastcheckok,
       raw_json = excluded.raw_json,
       updated_at = excluded.updated_at`,
  ).run({
    id,
    stationuuid: raw.stationuuid,
    name: (raw.name ?? '').trim() || raw.stationuuid,
    url: raw.url ?? '',
    url_resolved: raw.url_resolved ?? null,
    homepage: raw.homepage ?? null,
    favicon: raw.favicon ?? null,
    tags: JSON.stringify(tags),
    country: raw.country ?? null,
    countrycode: raw.countrycode ?? null,
    state: raw.state ?? null,
    language: raw.language ?? null,
    codec: raw.codec ?? null,
    bitrate: numberOrNull(raw.bitrate),
    votes: numberOr(raw.votes),
    clickcount: numberOr(raw.clickcount),
    clicktrend: numberOr(raw.clicktrend),
    geo_lat: numberOrNull(raw.geo_lat),
    geo_long: numberOrNull(raw.geo_long),
    lastcheckok: raw.lastcheckok == null ? null : raw.lastcheckok ? 1 : 0,
    raw_json: JSON.stringify(raw),
    now,
  });
  return id;
}

export function getStation(db: Db, id: string): RadioStation | undefined {
  ensureRadioSchema(db);
  const row = db.prepare('SELECT * FROM radio_stations WHERE id = ?').get(stationId(stationUuid(id))) as
    | RadioRow
    | undefined;
  return row ? mapRadioRow(row) : undefined;
}

/** Raw row (internal helpers need logo_path / stream_url, which the public type hides). */
export function getStationRow(db: Db, id: string): RadioRow | undefined {
  ensureRadioSchema(db);
  return db.prepare('SELECT * FROM radio_stations WHERE id = ?').get(stationId(stationUuid(id))) as
    | RadioRow
    | undefined;
}

export function getStationRowsByIds(db: Db, ids: string[]): Map<string, RadioRow> {
  ensureRadioSchema(db);
  const out = new Map<string, RadioRow>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM radio_stations WHERE id IN (${placeholders})`)
    .all(...ids.map((id) => stationId(stationUuid(id)))) as RadioRow[];
  for (const row of rows) out.set(row.id, row);
  return out;
}

export function listFavourites(db: Db): RadioStation[] {
  ensureRadioSchema(db);
  const rows = db
    .prepare('SELECT * FROM radio_stations WHERE favourite = 1 ORDER BY name COLLATE NOCASE, id')
    .all() as RadioRow[];
  return rows.map(mapRadioRow);
}

export function setFavourite(db: Db, id: string, favourite: boolean, now = Date.now()): boolean {
  ensureRadioSchema(db);
  const result = db
    .prepare('UPDATE radio_stations SET favourite = ?, updated_at = ? WHERE id = ?')
    .run(favourite ? 1 : 0, now, stationId(stationUuid(id)));
  return result.changes > 0;
}

export function saveLogo(
  db: Db,
  id: string,
  logoPath: string,
  mime: string,
  now = Date.now(),
): void {
  ensureRadioSchema(db);
  db.prepare('UPDATE radio_stations SET logo_path = ?, logo_mime = ?, updated_at = ? WHERE id = ?').run(
    logoPath,
    mime,
    now,
    stationId(stationUuid(id)),
  );
}

export function saveStreamUrl(db: Db, id: string, streamUrl: string, now = Date.now()): void {
  ensureRadioSchema(db);
  db.prepare('UPDATE radio_stations SET stream_url = ?, updated_at = ? WHERE id = ?').run(
    streamUrl,
    now,
    stationId(stationUuid(id)),
  );
}

function codecFormat(codec: string | undefined): Track['format'] {
  const c = (codec ?? '').toLowerCase();
  if (c.includes('flac')) return 'flac';
  if (c.includes('mp3')) return 'mp3';
  if (c) return 'other';
  return undefined;
}

/**
 * A live-radio Track: source 'radio' (the shared Source union predates it, hence
 * the cast), duration 0, and the stream URL carried in the non-contract `path`
 * field that the PC zone uses for `loadfile` and the API strips from responses.
 */
export function radioTrack(row: RadioRow): Track {
  const format = codecFormat(row.codec ?? undefined);
  const track: Track = {
    id: row.id,
    albumId: row.id,
    // The shared Source type only knows local/spotify; radio is additive and the
    // runtime value is what clients switch on. See worker report.
    source: 'radio' as unknown as Track['source'],
    title: row.name,
    artists: [],
    disc: 1,
    number: 1,
    durationMs: 0,
    ...(format ? { format } : {}),
    ...(row.bitrate && row.bitrate > 0 ? { bitrateKbps: row.bitrate } : {}),
  };
  (track as PlayableTrack).path = stationStreamUrl(row);
  return track;
}

export interface RadioQueueSource {
  track: Track;
  station: RadioStation;
}

export function radioTrackForStation(db: Db, id: string): RadioQueueSource | undefined {
  const row = getStationRow(db, id);
  if (!row) return undefined;
  return { track: radioTrack(row), station: mapRadioRow(row) };
}

/** Album stub for a radio queue item (the UI shows the station logo). */
export function radioQueueAlbum(station: RadioStation): QueueItem['album'] {
  return {
    id: station.id,
    title: station.name,
    ...(station.logoUrl ? { coverUrl: station.logoUrl } : {}),
  };
}

function numberOr(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : 0;
}

function numberOrNull(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
