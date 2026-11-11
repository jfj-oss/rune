// Worker W — link local albums to their Spotify equivalents.
//
// Strategy:
//   1. If the album has a MusicBrainz release, read its barcode (UPC/EAN) through
//      the shared MusicBrainz client and search Spotify with `upc:<barcode>`.
//      A barcode identifies one release exactly, so that match is trusted.
//   2. Otherwise (or when the UPC search finds nothing) search
//      `album:"<title>" artist:"<artist>"` and verify each candidate against the
//      local track list: exact track count + normalized title agreement +
//      durations within ±3 s. A deluxe edition with a different track count is
//      rejected and the next candidate is tried.
//   3. Store the album in `album_links` and the per-track mapping in
//      `track_links`, so a local queue can be handed to a Spotify Connect device.
//
// All Spotify requests go through a ~1 req/s limiter; SpotifyApi itself retries
// 429 responses after the server's Retry-After. `linkPending()` is safe to run
// in the background: concurrent calls share one in-flight batch, and an album
// that cannot be linked is remembered (method = 'not_found') instead of being
// re-searched on the next run.
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import type { Config } from '../config.js';
import { RateLimiter, defaultSleep, sharedMbClient, type MbRelease, type SleepFn } from '../match/mb.js';
import { titleSimilarity } from '../match/scoring.js';
import { HttpError } from './fetch.js';
import type { SpotifyAlbum, SpotifyPaging, SpotifySearchResult, SpotifyTrack } from './api.js';
import { spotifyAlbumId, spotifyTrackId } from './map.js';

// ---------- schema ----------

const migrationSql = readFileSync(new URL('../db/migrations-splink.sql', import.meta.url), 'utf8');

/** Apply db/migrations-splink.sql after schema.sql. Safe to call many times. */
export function ensureLinkSchema(db: Db): void {
  for (const statement of migrationSql.split(';')) {
    const sql = statement.trim();
    if (!sql) continue;
    try {
      db.exec(sql);
    } catch (err) {
      // SQLite has no ALTER TABLE ... ADD COLUMN IF NOT EXISTS; re-application is fine.
      if (!/duplicate column name/i.test(String(err))) throw err;
    }
  }
}

// ---------- public types ----------

export type LinkMethod = 'upc' | 'search' | 'not_found';

export interface AlbumLink {
  albumId: string;
  /** Bare Spotify album id (no `sp:` prefix). */
  spotifyAlbumId: string;
  method: LinkMethod;
  confidence: number;
  checkedAt: number;
}

export interface TrackLink {
  trackId: string;
  /** Bare Spotify track id (no `sp:` prefix). */
  spotifyTrackId: string;
}

export interface LinkBatchResult {
  /** Albums considered in this run (the pending set). */
  total: number;
  /** Albums processed before the batch ended. */
  attempted: number;
  linked: number;
  notFound: number;
  /** Albums whose lookup errored (network etc.); they are retried next run. */
  failed: number;
  /** True when a 429 with a long Retry-After stopped the batch early. */
  rateLimited: boolean;
}

/** Subset of src/spotify/api.ts used here; tests inject a fake via SpotifyApi. */
export interface LinkSpotifyApi {
  search(
    q: string,
    opts?: { types?: string[]; limit?: number; market?: string },
  ): Promise<SpotifySearchResult>;
  albumTracks(id: string, opts?: { offset?: number; limit?: number }): Promise<SpotifyPaging<SpotifyTrack>>;
}

/** MusicBrainz client subset (the shared MbClient satisfies this). */
export interface MbBarcodeClient {
  getRelease(id: string): Promise<MbRelease & { barcode?: string | null }>;
}

export interface LinkingOptions {
  api: LinkSpotifyApi;
  /** Defaults to the shared MusicBrainz client; pass null to disable barcode lookups. */
  mb?: MbBarcodeClient | null;
  now?: () => number;
  sleep?: SleepFn;
  /** Minimum spacing between Spotify requests (default 1000 ms ≈ 1 req/s). */
  rateLimitMs?: number;
  limiter?: RateLimiter;
  /** How many fallback search candidates to fetch and verify (default 5). */
  maxCandidates?: number;
  /** Duration agreement tolerance (default 3000 ms, as required by the contract). */
  durationToleranceMs?: number;
  /** Minimum score to accept a fallback match (default 0.78). */
  minConfidence?: number;
  /** Re-check an established link after this long (default 90 days). */
  relinkAfterMs?: number;
  /** Retry albums where no match was found after this long (default 7 days). */
  retryNotFoundAfterMs?: number;
  /** Albums one linkPending() run works through at most (default 40); the rest wait for the next run. */
  maxAlbumsPerRun?: number;
}

export interface Linking {
  /** Link every local album that is new, previously not found, or stale. */
  linkPending(onProgress?: (done: number, total: number) => void): Promise<LinkBatchResult>;
  /** Link one album now. Returns null when no Spotify album matched. */
  linkAlbum(albumId: string): Promise<AlbumLink | null>;
  getAlbumLink(albumId: string): AlbumLink | undefined;
  getTrackLink(trackId: string): TrackLink | undefined;
  albumExists(albumId: string): boolean;
  trackExists(trackId: string): boolean;
  /** Registers GET /albums/:id/links and GET /tracks/:id/spotify. */
  registerRoutes(app: FastifyInstance, opts?: RegisterLinkRoutesOptions): void;
}

export interface RegisterLinkRoutesOptions {
  /** Mount prefix ('' when registered inside the /api plugin, '/api' on the root app). */
  prefix?: string;
}

// ---------- track matching ----------

export interface LocalTrackForLink {
  id: string;
  title: string;
  disc: number;
  number: number;
  durationMs: number;
}

export interface SpotifyTrackForLink {
  id: string | null;
  name: string;
  disc_number: number;
  track_number: number;
  duration_ms: number;
}

export interface TrackPair {
  localTrackId: string;
  spotifyTrackId: string;
}

export interface TrackMatchMetrics {
  mapping: TrackPair[];
  /** Average normalized title similarity over matched pairs (0..1). */
  titleScore: number;
  /** Average continuous duration agreement over matched pairs (0..1). */
  durationScore: number;
  /** Fraction of matched pairs whose durations are within the tolerance. */
  durationWithinFraction: number;
  /** Fraction of matched pairs whose disc/number positions agree. */
  positionFraction: number;
  confidence: number;
  /** True when the album passes every acceptance test. */
  ok: boolean;
}

export const DURATION_TOLERANCE_MS = 3000;
const MIN_TITLE_AGREEMENT = 0.78;
const MIN_DURATION_WITHIN = 0.7;
const MIN_PAIR_SCORE = 0.45;
const DEFAULT_MIN_CONFIDENCE = 0.78;

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Greedily pair local tracks with Spotify tracks and score the album.
 *
 * The pair score combines normalized title similarity (60%), duration agreement
 * (35%) and matching disc/number (5%). The album is accepted only when every
 * local track has a partner, the tracks agree on titles, at least 70% of the
 * durations are within ±3 s, and the overall confidence clears the threshold.
 * A different track count (e.g. a deluxe edition) is rejected outright.
 */
export function matchAlbumTracks(
  local: readonly LocalTrackForLink[],
  spotify: readonly SpotifyTrackForLink[],
  opts: { durationToleranceMs?: number; minConfidence?: number } = {},
): TrackMatchMetrics {
  const tolerance = opts.durationToleranceMs ?? DURATION_TOLERANCE_MS;
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const candidates = spotify.filter(
    (s): s is SpotifyTrackForLink & { id: string } => typeof s.id === 'string' && s.id.length > 0,
  );

  const empty: TrackMatchMetrics = {
    mapping: [],
    titleScore: 0,
    durationScore: 0,
    durationWithinFraction: 0,
    positionFraction: 0,
    confidence: 0,
    ok: false,
  };
  if (local.length === 0 || candidates.length !== local.length) return empty;

  interface Pair {
    li: number;
    si: number;
    title: number;
    duration: number;
    within: boolean;
    comparable: boolean;
    position: number;
    score: number;
  }

  const pairs: Pair[] = [];
  local.forEach((l, li) => {
    candidates.forEach((s, si) => {
      const title = titleSimilarity(l.title, s.name);
      const comparable = l.durationMs > 0 && s.duration_ms > 0;
      const diff = comparable ? Math.abs(l.durationMs - s.duration_ms) : 0;
      const within = comparable && diff <= tolerance;
      const duration = !comparable ? 0.5 : within ? 1 : Math.max(0, 1 - (diff - tolerance) / 12_000);
      const position = l.disc === s.disc_number && l.number === s.track_number ? 1 : 0;
      pairs.push({
        li,
        si,
        title,
        duration,
        within,
        comparable,
        position,
        score: 0.6 * title + 0.35 * duration + 0.05 * position,
      });
    });
  });
  pairs.sort((a, b) => b.score - a.score);

  const usedLocal = new Set<number>();
  const usedSpotify = new Set<number>();
  const chosen: Pair[] = [];
  for (const pair of pairs) {
    if (usedLocal.has(pair.li) || usedSpotify.has(pair.si)) continue;
    if (pair.score < MIN_PAIR_SCORE) continue;
    usedLocal.add(pair.li);
    usedSpotify.add(pair.si);
    chosen.push(pair);
  }
  if (chosen.length === 0) return empty;

  let titleSum = 0;
  let durationSum = 0;
  let positionSum = 0;
  let comparable = 0;
  let within = 0;
  for (const pair of chosen) {
    titleSum += pair.title;
    durationSum += pair.duration;
    positionSum += pair.position;
    if (pair.comparable) {
      comparable++;
      if (pair.within) within++;
    }
  }

  const titleScore = titleSum / chosen.length;
  const durationScore = durationSum / chosen.length;
  const positionFraction = positionSum / chosen.length;
  const durationWithinFraction = comparable === 0 ? 0.5 : within / comparable;
  const confidence = round4(0.5 * titleScore + 0.4 * durationScore + 0.1 * positionFraction);
  const allMapped = chosen.length === local.length;

  return {
    mapping: chosen.map((pair) => ({
      localTrackId: local[pair.li]!.id,
      spotifyTrackId: candidates[pair.si]!.id,
    })),
    titleScore: round4(titleScore),
    durationScore: round4(durationScore),
    durationWithinFraction: round4(durationWithinFraction),
    positionFraction: round4(positionFraction),
    confidence,
    ok:
      allMapped &&
      titleScore >= MIN_TITLE_AGREEMENT &&
      durationWithinFraction >= MIN_DURATION_WITHIN &&
      confidence >= minConfidence,
  };
}

// ---------- link selection helpers ----------

/** Strip formatting from a UPC/EAN so Spotify's `upc:` filter sees digits. */
export function normalizeBarcode(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/\D+/g, '');
  return digits.length > 0 ? digits : undefined;
}

/** `album:"<title>" artist:"<artist>"`, with Spotify-hostile characters removed. */
export function buildSearchQuery(title: string, artist: string): string {
  const clean = (value: string): string => value.replace(/["\\\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  const parts: string[] = [];
  const t = clean(title);
  const a = clean(artist);
  if (t) parts.push(`album:"${t}"`);
  if (a) parts.push(`artist:"${a}"`);
  return parts.join(' ');
}

export function spotifyAlbumUrl(spotifyAlbumId: string): string {
  return `https://open.spotify.com/album/${spotifyAlbumId}`;
}

export function spotifyTrackUrl(spotifyTrackId: string): string {
  return `https://open.spotify.com/track/${spotifyTrackId}`;
}

function isRateLimit(err: unknown): boolean {
  return err instanceof HttpError && err.status === 429;
}

// ---------- factory ----------

interface LocalAlbumForLink {
  albumId: string;
  title: string;
  artistName: string;
  mbReleaseId: string | null;
  tracks: LocalTrackForLink[];
}

interface FoundAlbum {
  spotifyAlbumId: string;
  method: Exclude<LinkMethod, 'not_found'>;
  confidence: number;
  metrics: TrackMatchMetrics;
  title: string;
}

const DEFAULT_RELINK_AFTER_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_RETRY_NOT_FOUND_MS = 7 * 24 * 60 * 60 * 1000;
/** One run links this many albums at most: a whole library in one go is hundreds of requests in a few minutes. */
const DEFAULT_MAX_ALBUMS_PER_RUN = 40;

interface AlbumLinkRow {
  album_id: string;
  spotify_album_id: string;
  method: string;
  confidence: number;
  checked_at: number;
}

interface TrackLinkRow {
  track_id: string;
  spotify_track_id: string;
}

export function createLinking(db: Db, cfg: Config, opts: LinkingOptions): Linking {
  ensureLinkSchema(db);
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep;
  const limiter = opts.limiter ?? new RateLimiter(opts.rateLimitMs ?? 1000, sleep ?? defaultSleep, now);
  const maxCandidates = Math.max(1, opts.maxCandidates ?? 5);
  const matchOpts = {
    durationToleranceMs: opts.durationToleranceMs ?? DURATION_TOLERANCE_MS,
    minConfidence: opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
  };
  const relinkAfterMs = opts.relinkAfterMs ?? DEFAULT_RELINK_AFTER_MS;
  const retryNotFoundMs = opts.retryNotFoundAfterMs ?? DEFAULT_RETRY_NOT_FOUND_MS;
  const maxAlbumsPerRun = Math.max(1, opts.maxAlbumsPerRun ?? DEFAULT_MAX_ALBUMS_PER_RUN);

  /** A candidate with a different track count can never verify (matchAlbumTracks rejects it): skip its track list. */
  const sameTrackCount = (candidate: SpotifyAlbum, album: LocalAlbumForLink): boolean =>
    typeof candidate.total_tracks !== 'number' || candidate.total_tracks === album.tracks.length;

  const mb: MbBarcodeClient | null =
    opts.mb === null
      ? null
      : (opts.mb ?? (sharedMbClient(db, { userAgent: cfg.userAgent, db }) as unknown as MbBarcodeClient));

  // ---------- Spotify (rate limited) ----------

  async function searchAlbums(query: string, limit: number): Promise<SpotifyAlbum[]> {
    await limiter.wait();
    const result = await opts.api.search(query, { types: ['album'], limit });
    return (result.albums?.items ?? []).filter((album) => !!album && !!album.id);
  }

  async function fetchAlbumTracks(spotifyAlbumId: string): Promise<SpotifyTrack[]> {
    const out: SpotifyTrack[] = [];
    let offset = 0;
    for (;;) {
      await limiter.wait();
      const page = await opts.api.albumTracks(spotifyAlbumId, { limit: 50, offset });
      out.push(...page.items);
      offset += page.items.length;
      if (!page.next || page.items.length === 0 || offset >= 1000) break;
    }
    return out;
  }

  function spotifyTrackInputs(tracks: SpotifyTrack[]): SpotifyTrackForLink[] {
    return tracks.map((t) => ({
      id: t.id,
      name: t.name,
      disc_number: t.disc_number,
      track_number: t.track_number,
      duration_ms: t.duration_ms,
    }));
  }

  // ---------- MusicBrainz barcode ----------

  async function barcodeFor(album: LocalAlbumForLink): Promise<string | undefined> {
    if (!mb || !album.mbReleaseId) return undefined;
    try {
      const release = await mb.getRelease(album.mbReleaseId);
      return normalizeBarcode((release as MbRelease & { barcode?: string | null }).barcode);
    } catch {
      // A release lookup failure must not block the title/artist fallback.
      return undefined;
    }
  }

  // ---------- matching ----------

  async function findViaUpc(album: LocalAlbumForLink, barcode: string): Promise<FoundAlbum | undefined> {
    const candidates = await searchAlbums(`upc:${barcode}`, 10);
    if (candidates.length === 0) return undefined;

    // The barcode is authoritative, so a different-count edition is still kept as a last resort, but the track lists
    // (one request per 50 tracks each) are read only for the candidates that can verify.
    const exact = candidates.filter((c) => sameTrackCount(c, album));
    const ordered = exact.length ? exact : candidates.slice(0, 1);

    for (const candidate of ordered.slice(0, 3)) {
      let tracks: SpotifyTrack[];
      try {
        tracks = await fetchAlbumTracks(candidate.id);
      } catch (err) {
        if (isRateLimit(err)) throw err;
        continue;
      }
      const metrics = matchAlbumTracks(album.tracks, spotifyTrackInputs(tracks), matchOpts);
      // The barcode is authoritative: keep the link even when the local tags are
      // too different for full track verification, but score it lower.
      return {
        spotifyAlbumId: candidate.id,
        method: 'upc',
        confidence: metrics.ok ? 0.98 : 0.9,
        metrics,
        title: candidate.name,
      };
    }
    return undefined;
  }

  async function findViaSearch(album: LocalAlbumForLink): Promise<FoundAlbum | undefined> {
    const query = buildSearchQuery(album.title, album.artistName);
    if (!query) return undefined;
    const candidates = await searchAlbums(query, 10);

    // Deluxe editions, singles and compilations in the results are rejected by their track count without a request.
    for (const candidate of candidates.filter((c) => sameTrackCount(c, album)).slice(0, maxCandidates)) {
      let tracks: SpotifyTrack[];
      try {
        tracks = await fetchAlbumTracks(candidate.id);
      } catch (err) {
        if (isRateLimit(err)) throw err;
        continue;
      }
      const metrics = matchAlbumTracks(album.tracks, spotifyTrackInputs(tracks), matchOpts);
      if (!metrics.ok) continue; // wrong edition (e.g. different track count) or wrong album
      return {
        spotifyAlbumId: candidate.id,
        method: 'search',
        // Searching is weaker evidence than a barcode even when verification passes.
        confidence: round4(Math.min(0.95, metrics.confidence)),
        metrics,
        title: candidate.name,
      };
    }
    return undefined;
  }

  // ---------- persistence ----------

  function loadAlbum(albumId: string): LocalAlbumForLink | undefined {
    const row = db
      .prepare(
        `SELECT a.id, a.title, ar.name AS artist_name, a.mb_release_id
           FROM albums a LEFT JOIN artists ar ON ar.id = a.artist_id
          WHERE a.id = ? AND a.source = 'local'`,
      )
      .get(albumId) as
      | { id: string; title: string; artist_name: string | null; mb_release_id: string | null }
      | undefined;
    if (!row) return undefined;
    const tracks = db
      .prepare('SELECT id, title, disc, number, duration_ms FROM tracks WHERE album_id = ? ORDER BY disc, number')
      .all(albumId) as { id: string; title: string; disc: number; number: number; duration_ms: number }[];
    if (tracks.length === 0) return undefined;
    return {
      albumId: row.id,
      title: row.title,
      artistName: row.artist_name ?? '',
      mbReleaseId: row.mb_release_id,
      tracks: tracks.map((t) => ({
        id: t.id,
        title: t.title,
        disc: t.disc,
        number: t.number,
        durationMs: t.duration_ms,
      })),
    };
  }

  const upsertLink = db.prepare(
    `INSERT INTO album_links (album_id, spotify_album_id, method, confidence, checked_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(album_id) DO UPDATE SET
       spotify_album_id = excluded.spotify_album_id,
       method = excluded.method,
       confidence = excluded.confidence,
       checked_at = excluded.checked_at`,
  );
  const upsertNotFound = db.prepare(
    `INSERT INTO album_links (album_id, spotify_album_id, method, confidence, checked_at)
     VALUES (?, NULL, 'not_found', 0, ?)
     ON CONFLICT(album_id) DO UPDATE SET
       method = 'not_found',
       confidence = 0,
       checked_at = excluded.checked_at
     WHERE album_links.spotify_album_id IS NULL`,
  );
  const deleteTrackLinks = db.prepare(
    'DELETE FROM track_links WHERE track_id IN (SELECT id FROM tracks WHERE album_id = ?)',
  );
  const upsertTrackLink = db.prepare(
    `INSERT INTO track_links (track_id, spotify_track_id, linked_at) VALUES (?, ?, ?)
     ON CONFLICT(track_id) DO UPDATE SET
       spotify_track_id = excluded.spotify_track_id,
       linked_at = excluded.linked_at`,
  );

  function saveLink(album: LocalAlbumForLink, found: FoundAlbum): AlbumLink {
    const checkedAt = now();
    const tx = db.transaction(() => {
      upsertLink.run(album.albumId, found.spotifyAlbumId, found.method, found.confidence, checkedAt);
      deleteTrackLinks.run(album.albumId);
      for (const pair of found.metrics.mapping) {
        upsertTrackLink.run(pair.localTrackId, pair.spotifyTrackId, checkedAt);
      }
    });
    tx();
    return {
      albumId: album.albumId,
      spotifyAlbumId: found.spotifyAlbumId,
      method: found.method,
      confidence: found.confidence,
      checkedAt,
    };
  }

  function saveNotFound(albumId: string): void {
    upsertNotFound.run(albumId, now());
  }

  function getAlbumLink(albumId: string): AlbumLink | undefined {
    const row = db
      .prepare(
        `SELECT album_id, spotify_album_id, method, confidence, checked_at
           FROM album_links
          WHERE album_id = ? AND spotify_album_id IS NOT NULL`,
      )
      .get(albumId) as AlbumLinkRow | undefined;
    if (!row) return undefined;
    return {
      albumId: row.album_id,
      spotifyAlbumId: row.spotify_album_id,
      method: row.method as LinkMethod,
      confidence: row.confidence,
      checkedAt: row.checked_at,
    };
  }

  // ---------- public operations ----------

  async function linkAlbum(albumId: string): Promise<AlbumLink | null> {
    const album = loadAlbum(albumId);
    if (!album) return null;

    const barcode = await barcodeFor(album);
    let found: FoundAlbum | undefined;
    if (barcode) found = await findViaUpc(album, barcode);
    if (!found) found = await findViaSearch(album);

    if (!found) {
      saveNotFound(albumId);
      return null;
    }
    return saveLink(album, found);
  }

  function pendingAlbumIds(): string[] {
    const current = now();
    const rows = db
      .prepare(
        `SELECT a.id
           FROM albums a
           LEFT JOIN album_links l ON l.album_id = a.id
          WHERE a.source = 'local'
            AND (
              l.album_id IS NULL
              OR (l.spotify_album_id IS NULL AND l.checked_at <= ?)
              OR (l.spotify_album_id IS NOT NULL AND l.checked_at <= ?)
            )
          ORDER BY (l.album_id IS NULL) DESC, a.added_at DESC, a.id`,
      )
      .all(current - retryNotFoundMs, current - relinkAfterMs) as { id: string }[];
    return rows.map((row) => row.id);
  }

  let inFlight: Promise<LinkBatchResult> | null = null;

  function linkPending(onProgress?: (done: number, total: number) => void): Promise<LinkBatchResult> {
    if (inFlight) return inFlight;
    inFlight = runBatch(onProgress).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function runBatch(onProgress?: (done: number, total: number) => void): Promise<LinkBatchResult> {
    const ids = pendingAlbumIds();
    const result: LinkBatchResult = {
      total: ids.length,
      attempted: 0,
      linked: 0,
      notFound: 0,
      failed: 0,
      rateLimited: false,
    };
    onProgress?.(0, ids.length);

    // The rest of the pending set waits for the next run (the next scan or library sync starts one).
    for (const albumId of ids.slice(0, maxAlbumsPerRun)) {
      try {
        const link = await linkAlbum(albumId);
        if (link) result.linked++;
        else result.notFound++;
      } catch (err) {
        if (isRateLimit(err)) {
          // SpotifyApi already retried using Retry-After. If it still surfaced,
          // the wait is longer than we are willing to hold the batch for: stop
          // here and let the next run (or the scheduler) resume.
          result.rateLimited = true;
          result.failed++;
          result.attempted++;
          onProgress?.(result.attempted, ids.length);
          break;
        }
        result.failed++;
      }
      result.attempted++;
      onProgress?.(result.attempted, ids.length);
    }
    return result;
  }

  const linking: Linking = {
    linkPending,
    linkAlbum,
    getAlbumLink,
    getTrackLink(trackId: string): TrackLink | undefined {
      const row = db
        .prepare('SELECT track_id, spotify_track_id FROM track_links WHERE track_id = ?')
        .get(trackId) as TrackLinkRow | undefined;
      return row ? { trackId: row.track_id, spotifyTrackId: row.spotify_track_id } : undefined;
    },
    albumExists(albumId: string): boolean {
      return !!db.prepare('SELECT 1 FROM albums WHERE id = ?').get(albumId);
    },
    trackExists(trackId: string): boolean {
      return !!db.prepare('SELECT 1 FROM tracks WHERE id = ?').get(trackId);
    },
    registerRoutes(app: FastifyInstance, routeOpts: RegisterLinkRoutesOptions = {}) {
      registerLinkRoutes(app, linking, routeOpts);
    },
  };
  return linking;
}

/** Alias for `createLinking` (workers/main session may use either name). */
export const createLinker = createLinking;

// ---------- routes ----------

/** Routes are relative by default, like registerBrowseRoutes: mount them inside
 *  the /api plugin. On the root app pass `{ prefix: '/api' }`. */
export function registerLinkRoutes(
  app: FastifyInstance,
  linking: Linking,
  opts: RegisterLinkRoutesOptions = {},
): void {
  const prefix = (opts.prefix ?? '').replace(/\/$/, '');

  app.get<{ Params: { id: string } }>(`${prefix}/albums/:id/links`, async (req, reply) => {
    if (!linking.albumExists(req.params.id)) return reply.code(404).send({ error: 'not found' });
    const link = linking.getAlbumLink(req.params.id);
    if (!link) return {};
    return {
      spotify: {
        id: spotifyAlbumId(link.spotifyAlbumId),
        url: spotifyAlbumUrl(link.spotifyAlbumId),
        confidence: link.confidence,
      },
    };
  });

  app.get<{ Params: { id: string } }>(`${prefix}/tracks/:id/spotify`, async (req, reply) => {
    if (!linking.trackExists(req.params.id)) return reply.code(404).send({ error: 'not found' });
    const link = linking.getTrackLink(req.params.id);
    if (!link) return {};
    return {
      spotify: {
        id: spotifyTrackId(link.spotifyTrackId),
        uri: `spotify:track:${link.spotifyTrackId}`,
        url: spotifyTrackUrl(link.spotifyTrackId),
      },
    };
  });
}
