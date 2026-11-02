// Worker V — album context from MusicBrainz release groups.
//
//   createEditions(db, cfg)        -> EditionsService
//   registerEditionsRoutes(app, s) -> GET /albums/:id/editions
//                                     GET /artists/:id/discography
//
// Album editions: a local album's MusicBrainz release -> its release group ->
// every release (edition) in that group, with date/country/label/catalog
// number/format/track count. The release group gives the original release date
// and primary/secondary types.
//
// Artist discography: every album/EP/live/compilation release group MusicBrainz
// knows for the artist, marked owned/not owned by matching `mb_release_group_id`
// against the library. Owned state is computed per request (never cached), so a
// rescan or a manual match immediately shows up.
//
// All MusicBrainz traffic goes through the shared MbClient (one 1 req/s limiter
// and the http_cache table shared with the matcher / other metadata workers).
// The MB-derived payload is additionally cached in `editions_cache` (30 days),
// because a discography browse costs several requests. Albums with no MB ids
// fall back to a minimal response built from local rows only.
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { AlbumSummary, Id } from '@liner/shared';
import { normalizeName, type Db } from '../db/index.js';
import { coverUrlFor } from '../api/cover.js';
import type { Config } from '../config.js';
import {
  MbClient,
  releaseTrackCount,
  sharedMbClient,
  yearFromDate,
  type FetchLike,
  type MbClientOptions,
  type MbRelease,
  type MbReleaseGroup,
  type NowFn,
  type RateLimiter,
  type SleepFn,
} from '../match/mb.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 30 * DAY_MS;
const PAGE_SIZE = 100;
const MAX_PAGES = 20; // safety cap: 2000 release groups / releases
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MB_BASE = 'https://musicbrainz.org/ws/2';

// ---------- public shapes ----------

export interface Edition {
  mbReleaseId: string;
  title: string;
  date?: string;
  country?: string;
  label?: string;
  catalogNumber?: string;
  /** Display format: "CD", "Vinyl", "Digital", "CD, DVD", ... */
  format?: string;
  trackCount: number;
  /** True for the release the local album was matched to. */
  isThisOne: boolean;
}

export interface AlbumEditions {
  /** Release group first-release-date (falls back to the earliest edition / local date). */
  originalReleaseDate?: string;
  /** "Album" | "EP" | "Live" | "Compilation" | "Soundtrack" | ... */
  releaseGroupType?: string;
  secondaryTypes: string[];
  editions: Edition[];
  /** Other library albums (local or saved Spotify) of the same release group. */
  otherVersionsInLibrary: AlbumSummary[];
}

export interface DiscographyReleaseGroup {
  mbReleaseGroupId: string;
  title: string;
  year?: number;
  /** First-release-date, more precise than `year` when MusicBrainz has it. */
  date?: string;
  /** Display type, e.g. "Album", "EP", "Live", "Compilation", "Soundtrack". */
  type?: string;
  secondaryTypes: string[];
  owned: boolean;
  /** Library album ids carrying this release group (may be more than one edition). */
  albumIds: Id[];
}

export interface ArtistDiscography {
  releaseGroups: DiscographyReleaseGroup[];
}

export interface EditionsService {
  /**
   * Edition list for one album. Returns null only when the album id is unknown.
   * Albums without MusicBrainz ids get a local-only minimal response.
   */
  getAlbumEditions(albumId: string, opts?: { refresh?: boolean }): Promise<AlbumEditions | null>;
  /** Full album/EP/live/compilation release-group discography, owned flags included. */
  getArtistDiscography(artistId: string, opts?: { refresh?: boolean }): Promise<ArtistDiscography | null>;
}

export interface EditionsDeps {
  /** Injectable fetch for offline tests (plus the recording script). */
  fetch?: FetchLike;
  sleep?: SleepFn;
  now?: NowFn;
  /** Share the matcher's MusicBrainz client (or a fake one in tests). */
  mbClient?: MbClient;
  mbLimiter?: RateLimiter;
  mbRateLimitMs?: number;
  /** How long the MB-derived payload stays fresh. Default 30 days. */
  ttlMs?: number;
}

export type CreateEditions = (db: Db, cfg: Config, deps?: EditionsDeps) => EditionsService;

// ---------- migration ----------

const migrationSql = readFileSync(new URL('../db/migrations-editions.sql', import.meta.url), 'utf8');

/** Applied idempotently after schema.sql. */
export function ensureEditionsSchema(db: Db): void {
  db.exec(migrationSql);
}

// ---------- MusicBrainz URLs (exported for the recorder + tests) ----------

/** Release lookup used only to discover the release group of an old match. */
export function mbReleaseLookupUrl(releaseId: string): string {
  return `${MB_BASE}/release/${encodeURIComponent(releaseId)}?inc=release-groups&fmt=json`;
}

export function mbReleaseGroupLookupUrl(releaseGroupId: string): string {
  return `${MB_BASE}/release-group/${encodeURIComponent(releaseGroupId)}?fmt=json`;
}

export function mbReleaseGroupReleasesUrl(releaseGroupId: string, offset = 0, limit = PAGE_SIZE): string {
  const params = new URLSearchParams({
    'release-group': releaseGroupId,
    inc: 'labels+media',
    fmt: 'json',
    limit: String(limit),
    offset: String(offset),
  });
  return `${MB_BASE}/release/?${params.toString()}`;
}

/**
 * Official releases by artist, used to build the discography's release-group
 * list. Going through releases (rather than browsing release groups directly)
 * keeps bootleg live imports — hundreds of date-titled concert groups for acts
 * like The Smashing Pumpkins — out of the discography.
 */
export function mbArtistOfficialReleasesUrl(artistMbid: string, offset = 0, limit = PAGE_SIZE): string {
  const params = new URLSearchParams({
    artist: artistMbid,
    inc: 'release-groups',
    status: 'official',
    fmt: 'json',
    limit: String(limit),
    offset: String(offset),
  });
  return `${MB_BASE}/release/?${params.toString()}`;
}

// ---------- WS/2 shapes not in mb.ts ----------

interface MbReleaseBrowseResponse {
  // MusicBrainz names these after the entity being browsed.
  'release-count'?: number;
  'release-offset'?: number;
  count?: number;
  offset?: number;
  releases?: MbRelease[];
}

// ---------- helpers ----------

/**
 * Prefer a meaningful secondary type over the generic primary "Album":
 * a live album is primary=Album + secondary=Live and the UI wants "Live".
 * Other secondary types (Demo, Remix, ...) stay in `secondaryTypes`; the
 * display type falls back to the primary type.
 */
const MUSIC_SECONDARY = ['Live', 'Compilation', 'Soundtrack'];

export function releaseGroupType(group: Pick<MbReleaseGroup, 'primary-type' | 'secondary-types'>): string | undefined {
  const primary = group['primary-type'] ?? undefined;
  const secondary = group['secondary-types'] ?? [];
  const preferred = secondary.find((t) => MUSIC_SECONDARY.includes(t));
  return preferred ?? primary ?? secondary[0];
}

const NON_MUSIC_SECONDARY = new Set(['Interview', 'Audiobook', 'Audio drama', 'Spokenword']);

/** Release groups that belong in a discography (albums, EPs, live, compilations). */
export function isDiscographyGroup(group: Pick<MbReleaseGroup, 'primary-type' | 'secondary-types'>): boolean {
  const primary = group['primary-type'] ?? undefined;
  const secondary = group['secondary-types'] ?? [];
  if (primary === 'Single' || primary === 'Broadcast') {
    // A single is not an album even when it also carries a secondary type.
    return false;
  }
  // Interviews/audiobooks are not music releases. A group that is also live or
  // a compilation still belongs (e.g. "Interview + Live").
  if (secondary.length > 0 && secondary.every((t) => NON_MUSIC_SECONDARY.has(t))) return false;
  if (primary === 'Album' || primary === 'EP') return true;
  return secondary.some((t) => MUSIC_SECONDARY.includes(t));
}

/** "Digital Media" -> "Digital", "12\" Vinyl" -> "Vinyl"; other formats kept. */
export function normalizeEditionFormat(raw: string | null | undefined): string | undefined {
  const value = (raw ?? '').trim();
  if (!value) return undefined;
  if (/digital/i.test(value)) return 'Digital';
  if (/vinyl/i.test(value)) return 'Vinyl';
  if (/^cd$/i.test(value)) return 'CD';
  if (/^cd[- ]?r$/i.test(value)) return 'CD-R';
  return value;
}

function unique(values: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/** Unique media formats in medium order, comma-separated. */
export function editionFormat(release: Pick<MbRelease, 'media'>): string | undefined {
  const formats = unique((release.media ?? []).map((m) => normalizeEditionFormat(m.format)));
  return formats.length > 0 ? formats.join(', ') : undefined;
}

export function editionLabel(release: Pick<MbRelease, 'label-info'>): {
  label?: string;
  catalogNumber?: string;
} {
  const infos = release['label-info'] ?? [];
  const label = unique(infos.map((i) => i.label?.name)).join(' / ');
  const catalogNumber = unique(infos.map((i) => i['catalog-number'])).join(' / ');
  return {
    ...(label ? { label } : {}),
    ...(catalogNumber ? { catalogNumber } : {}),
  };
}

function dateSortKey(date: string | undefined): string {
  return date && /^\d{4}/.test(date) ? date : '9999-99-99';
}

function compareEditions(a: Edition, b: Edition): number {
  return (
    dateSortKey(a.date).localeCompare(dateSortKey(b.date)) ||
    a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) ||
    (a.country ?? '').localeCompare(b.country ?? '')
  );
}

/** Earliest known date from a release list, used when the group has none. */
function earliestReleaseDate(releases: MbRelease[]): string | undefined {
  let best: string | undefined;
  for (const release of releases) {
    const date = release.date?.trim();
    if (!date || !/^\d{4}/.test(date)) continue;
    if (!best || date < best) best = date;
  }
  return best;
}

// ---------- library rows ----------

interface AlbumRow {
  id: string;
  source: string;
  title: string;
  artist_id: string;
  artist_name: string | null;
  year: number | null;
  release_date: string | null;
  label: string | null;
  format: string | null;
  cover_path: string | null;
  mb_release_id: string | null;
  mb_release_group_id: string | null;
  added_at: number;
}

const ALBUM_SELECT = `
  SELECT a.id, a.source, a.title, a.artist_id, ar.name AS artist_name, a.year,
         a.release_date, a.label, a.format, a.cover_path, a.mb_release_id,
         a.mb_release_group_id, a.added_at
    FROM albums a LEFT JOIN artists ar ON ar.id = a.artist_id`;

interface ArtistRow {
  id: string;
  name: string;
  mbid: string | null;
}

function hasColumn(db: Db, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

function coverUrl(albumId: string): string {
  return `/api/cover/${encodeURIComponent(albumId)}?size=600`;
}

function albumSummary(row: AlbumRow): AlbumSummary {
  return {
    id: row.id,
    source: row.source === 'spotify' ? 'spotify' : 'local',
    title: row.title,
    artist: { id: row.artist_id, name: row.artist_name ?? 'Unknown Artist' },
    ...(row.year ? { year: row.year } : {}),
    ...(row.cover_path ? { coverUrl: coverUrlFor(row.id, row.cover_path) } : {}),
    ...(row.format ? { format: row.format } : {}),
    addedAt: row.added_at,
  };
}

/** Artists.mbid, or the uuid embedded in an `ar:<uuid>` id. */
export function editionsArtistMbid(artistId: string, mbid?: string | null): string | undefined {
  if (mbid && UUID.test(mbid)) return mbid;
  if (artistId.startsWith('ar:')) {
    const rest = artistId.slice(3);
    if (UUID.test(rest)) return rest;
  }
  return undefined;
}

// ---------- cached payloads ----------

interface CachedEdition extends Omit<Edition, 'isThisOne'> {}

interface AlbumPayload {
  originalReleaseDate?: string;
  releaseGroupType?: string;
  secondaryTypes: string[];
  editions: CachedEdition[];
}

interface CachedDiscographyGroup {
  mbReleaseGroupId: string;
  title: string;
  year?: number;
  date?: string;
  type?: string;
  secondaryTypes: string[];
}

interface ArtistPayload {
  releaseGroups: CachedDiscographyGroup[];
}

interface CacheRow {
  mb_key: string;
  payload_json: string;
  fetched_at: number;
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

// ---------- service ----------

export function createEditions(db: Db, cfg: Config, deps: EditionsDeps = {}): EditionsService {
  ensureEditionsSchema(db);

  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;

  const mbOpts: MbClientOptions = {
    userAgent: cfg.userAgent,
    db,
    fetch: deps.fetch,
    sleep: deps.sleep,
    now: deps.now,
    rateLimitMs: deps.mbRateLimitMs ?? 1000,
    limiter: deps.mbLimiter,
  };
  const injectedMb =
    deps.fetch != null ||
    deps.sleep != null ||
    deps.now != null ||
    deps.mbLimiter != null ||
    deps.mbRateLimitMs != null;
  const mb = deps.mbClient ?? (injectedMb ? new MbClient(mbOpts) : sharedMbClient(db, mbOpts));

  const inLibrary = hasColumn(db, 'albums', 'in_library') ? 'a.in_library = 1' : '1 = 1';
  const albumStmt = db.prepare(`${ALBUM_SELECT} WHERE a.id = ?`);
  const artistStmt = db.prepare('SELECT id, name, mbid FROM artists WHERE id = ?');
  const siblingsByGroupStmt = db.prepare(
    `${ALBUM_SELECT} WHERE a.mb_release_group_id = ? AND a.id != ? AND ${inLibrary}
     ORDER BY a.year, a.added_at, a.title`,
  );
  const albumsOfArtistStmt = db.prepare(
    `${ALBUM_SELECT} WHERE a.artist_id = ? AND a.id != ? AND ${inLibrary}`,
  );
  const ownedGroupsStmt = db.prepare(
    `SELECT a.id, a.mb_release_group_id FROM albums a
      WHERE a.mb_release_group_id IS NOT NULL AND ${inLibrary}`,
  );
  const cacheReadStmt = db.prepare('SELECT mb_key, payload_json, fetched_at FROM editions_cache WHERE kind = ? AND ref_id = ?');
  const cacheWriteStmt = db.prepare(
    `INSERT INTO editions_cache (kind, ref_id, mb_key, payload_json, fetched_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(kind, ref_id) DO UPDATE SET
       mb_key = excluded.mb_key,
       payload_json = excluded.payload_json,
       fetched_at = excluded.fetched_at`,
  );

  const albumInflight = new Map<string, Promise<AlbumEditions>>();
  const artistInflight = new Map<string, Promise<ArtistDiscography>>();

  /** Deduplicate concurrent requests; `refresh` starts a new fetch. */
  function runOnce<T>(map: Map<string, Promise<T>>, key: string, refresh: boolean, run: () => Promise<T>): Promise<T> {
    if (!refresh) {
      const existing = map.get(key);
      if (existing) return existing;
    }
    let promise: Promise<T>;
    promise = run().finally(() => {
      // A concurrent refresh may have replaced this entry; only remove our own.
      if (map.get(key) === promise) map.delete(key);
    });
    map.set(key, promise);
    return promise;
  }

  function readCache<T>(kind: string, refId: string, mbKey: string): T | null {
    const row = cacheReadStmt.get(kind, refId) as CacheRow | undefined;
    if (!row) return null;
    if (row.mb_key !== mbKey) return null;
    if (now() - row.fetched_at >= ttlMs) return null;
    try {
      return JSON.parse(row.payload_json) as T;
    } catch {
      return null;
    }
  }

  /**
   * Album cache rows are keyed by `releaseId|releaseGroupId`. A legacy album may
   * only have the release id, so the stored key (which carries the group found
   * on the first fetch) is accepted while either side still matches. Returns the
   * group id too, so sibling albums are found even when the album row lacks it.
   */
  function readAlbumCache(row: AlbumRow): { payload: AlbumPayload; releaseGroupId: string } | null {
    const cached = cacheReadStmt.get('album-editions', row.id) as CacheRow | undefined;
    if (!cached) return null;
    if (now() - cached.fetched_at >= ttlMs) return null;
    const [releaseId = '', releaseGroupId = ''] = cached.mb_key.split('|');
    if (!releaseGroupId) return null;
    if (row.mb_release_group_id && row.mb_release_group_id !== releaseGroupId) return null;
    if (row.mb_release_id && row.mb_release_id !== releaseId) return null;
    try {
      return { payload: JSON.parse(cached.payload_json) as AlbumPayload, releaseGroupId };
    } catch {
      return null;
    }
  }

  function writeCache(kind: string, refId: string, mbKey: string, payload: unknown): void {
    cacheWriteStmt.run(kind, refId, mbKey, JSON.stringify(payload), now());
  }

  // ---------- album editions ----------

  async function fetchReleaseGroupReleases(releaseGroupId: string): Promise<MbRelease[]> {
    const out: MbRelease[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_SIZE;
      const data = await mb.getJson<MbReleaseBrowseResponse>(mbReleaseGroupReleasesUrl(releaseGroupId, offset));
      if (!data) break;
      const batch = data.releases ?? [];
      out.push(...batch);
      if (batch.length === 0) break;
      const count = data['release-count'] ?? data.count ?? offset + batch.length;
      if (offset + batch.length >= count) break;
    }
    return out;
  }

  async function fetchAlbumPayload(row: AlbumRow): Promise<{ mbKey: string; payload: AlbumPayload } | null> {
    let releaseGroupId = row.mb_release_group_id?.trim() || undefined;
    if (!releaseGroupId && row.mb_release_id) {
      const release = await safe(() => mb.getJson<MbRelease>(mbReleaseLookupUrl(row.mb_release_id as string)));
      releaseGroupId = release?.['release-group']?.id;
    }
    if (!releaseGroupId) return null;

    const group = await safe(() => mb.getJson<MbReleaseGroup>(mbReleaseGroupLookupUrl(releaseGroupId)));
    const releaseList = await safe(() => fetchReleaseGroupReleases(releaseGroupId));
    // The editions are the point of this endpoint: never cache a list we failed
    // to download. Fall back to local data instead (the next request retries).
    if (releaseList === null) return null;
    // An empty group with no releases means the group is gone/not public.
    if (!group && releaseList.length === 0) return null;
    const releases = releaseList;

    const editions = releases
      .filter((release) => release.id)
      .map((release): CachedEdition => {
        const { label, catalogNumber } = editionLabel(release);
        const format = editionFormat(release);
        return {
          mbReleaseId: release.id,
          title: release.title,
          ...(release.date ? { date: release.date } : {}),
          ...(release.country ? { country: release.country } : {}),
          ...(label ? { label } : {}),
          ...(catalogNumber ? { catalogNumber } : {}),
          ...(format ? { format } : {}),
          trackCount: releaseTrackCount(release),
        };
      });

    const secondaryTypes = group?.['secondary-types'] ?? [];
    const originalReleaseDate =
      group?.['first-release-date'] || earliestReleaseDate(releases ?? []) || row.release_date || undefined;
    const type = group
      ? releaseGroupType({ 'primary-type': group['primary-type'], 'secondary-types': secondaryTypes })
      : undefined;

    return {
      mbKey: `${row.mb_release_id ?? ''}|${releaseGroupId}`,
      payload: {
        ...(originalReleaseDate ? { originalReleaseDate } : {}),
        ...(type ? { releaseGroupType: type } : {}),
        secondaryTypes,
        editions,
      },
    };
  }

  function localEditions(row: AlbumRow): AlbumEditions {
    const own = albumsOfArtistStmt.all(row.artist_id, row.id) as AlbumRow[];
    const titleKey = normalizeName(row.title);
    const others = own.filter((candidate) => normalizeName(candidate.title) === titleKey);
    return {
      ...(row.release_date || row.year
        ? { originalReleaseDate: row.release_date ?? String(row.year) }
        : {}),
      secondaryTypes: [],
      editions: [],
      otherVersionsInLibrary: others.map(albumSummary),
    };
  }

  /** Decorate a cached/fetched MB payload with request-time library state. */
  function albumResponse(row: AlbumRow, payload: AlbumPayload, releaseGroupId: string): AlbumEditions {
    const editions = payload.editions
      .map(
        (edition): Edition => ({
          ...edition,
          isThisOne: row.mb_release_id != null && edition.mbReleaseId === row.mb_release_id,
        }),
      )
      .sort(compareEditions);
    const siblings = siblingsByGroupStmt.all(releaseGroupId, row.id) as AlbumRow[];
    return {
      ...payload,
      editions,
      otherVersionsInLibrary: siblings.map(albumSummary),
    };
  }

  async function fetchAlbumEditions(row: AlbumRow, refresh: boolean): Promise<AlbumEditions> {
    if (!refresh) {
      const stored = readAlbumCache(row);
      if (stored) return albumResponse(row, stored.payload, stored.releaseGroupId);
    }

    const fetched = await safe(() => fetchAlbumPayload(row));
    if (!fetched) return localEditions(row);

    writeCache('album-editions', row.id, fetched.mbKey, fetched.payload);
    // Re-resolve siblings by the release group the fetch found, so a legacy
    // album without mb_release_group_id still lists its other editions.
    const releaseGroupId = fetched.mbKey.slice(fetched.mbKey.indexOf('|') + 1);
    return albumResponse(row, fetched.payload, releaseGroupId);
  }

  // ---------- artist discography ----------

  async function fetchArtistPayload(artistMbid: string): Promise<ArtistPayload> {
    // Deduplicate by release-group id: one group has many releases (editions).
    const groups = new Map<string, MbReleaseGroup>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_SIZE;
      const data = await mb.getJson<MbReleaseBrowseResponse>(mbArtistOfficialReleasesUrl(artistMbid, offset));
      if (!data) break;
      const batch = data.releases ?? [];
      for (const release of batch) {
        const group = release['release-group'];
        if (group?.id && !groups.has(group.id)) groups.set(group.id, group);
      }
      if (batch.length === 0) break;
      const count = data['release-count'] ?? data.count ?? offset + batch.length;
      if (offset + batch.length >= count) break;
    }

    const releaseGroups = [...groups.values()]
      .filter((group) => group.id && isDiscographyGroup(group))
      .map((group): CachedDiscographyGroup => {
        const date = group['first-release-date'] || undefined;
        const year = yearFromDate(date);
        const type = releaseGroupType(group);
        return {
          mbReleaseGroupId: group.id,
          title: group.title ?? '(untitled)',
          ...(year ? { year } : {}),
          ...(date ? { date } : {}),
          ...(type ? { type } : {}),
          secondaryTypes: group['secondary-types'] ?? [],
        };
      })
      .sort(
        (a, b) =>
          dateSortKey(a.date).localeCompare(dateSortKey(b.date)) ||
          a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
      );

    return { releaseGroups };
  }

  function decorateDiscography(payload: ArtistPayload): ArtistDiscography {
    const owned = new Map<string, Id[]>();
    for (const row of ownedGroupsStmt.all() as { id: string; mb_release_group_id: string }[]) {
      const list = owned.get(row.mb_release_group_id);
      if (list) list.push(row.id);
      else owned.set(row.mb_release_group_id, [row.id]);
    }
    return {
      releaseGroups: payload.releaseGroups.map((group) => {
        const albumIds = owned.get(group.mbReleaseGroupId) ?? [];
        return { ...group, owned: albumIds.length > 0, albumIds };
      }),
    };
  }

  async function fetchArtistDiscography(artistId: string, mbid: string, refresh: boolean): Promise<ArtistDiscography> {
    if (!refresh) {
      const stored = readCache<ArtistPayload>('artist-discography', artistId, mbid);
      if (stored) return decorateDiscography(stored);
    }

    const payload = await safe(() => fetchArtistPayload(mbid));
    if (!payload) return { releaseGroups: [] };
    writeCache('artist-discography', artistId, mbid, payload);
    return decorateDiscography(payload);
  }

  return {
    async getAlbumEditions(albumId, opts = {}) {
      const row = albumStmt.get(albumId) as AlbumRow | undefined;
      if (!row) return null;

      const hasMb = Boolean(row.mb_release_id || row.mb_release_group_id);
      if (!hasMb) return localEditions(row);

      return runOnce(albumInflight, albumId, opts.refresh === true, () =>
        fetchAlbumEditions(row, opts.refresh === true),
      );
    },

    async getArtistDiscography(artistId, opts = {}) {
      const artist = artistStmt.get(artistId) as ArtistRow | undefined;
      if (!artist) return null;
      const mbid = editionsArtistMbid(artist.id, artist.mbid);
      if (!mbid) return { releaseGroups: [] };

      return runOnce(artistInflight, artistId, opts.refresh === true, () =>
        fetchArtistDiscography(artistId, mbid, opts.refresh === true),
      );
    },
  };
}

// ---------- routes ----------

/** Wire the editions routes. The API prefix (`/api`) is added by the app. */
export function registerEditionsRoutes(app: FastifyInstance, editions: EditionsService): void {
  app.get('/albums/:id/editions', async (request, reply) => {
    const { id } = request.params as { id?: string };
    if (!id) return reply.code(400).send({ error: 'missing album id' });
    const refresh = (request.query as { refresh?: string } | undefined)?.refresh;
    const result = await editions.getAlbumEditions(id, { refresh: refresh === '1' || refresh === 'true' });
    if (!result) return reply.code(404).send({ error: 'album not found' });
    return result;
  });

  app.get('/artists/:id/discography', async (request, reply) => {
    const { id } = request.params as { id?: string };
    if (!id) return reply.code(400).send({ error: 'missing artist id' });
    const refresh = (request.query as { refresh?: string } | undefined)?.refresh;
    const result = await editions.getArtistDiscography(id, { refresh: refresh === '1' || refresh === 'true' });
    if (!result) return reply.code(404).send({ error: 'artist not found' });
    return result;
  });
}
