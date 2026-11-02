// Worker H — artist pages: a Wikipedia lead-section bio and a cached Wikidata
// (P18 / Wikimedia Commons) picture, with author + licence for attribution.
//
// Route to the article:
//   artists.mbid (or an `ar:<mbid>` id)
//     -> MusicBrainz artist url-rels (shared MbClient, 1 req/s)
//     -> Wikidata QID (or Wikidata search by P434 = mbid)
//     -> enwiki sitelink
//     -> Wikipedia lead section (plain text, refs/templates stripped, <= 1200 chars)
// Artists without an mbid fall back to Wikipedia title/search, and a candidate is
// only accepted when its categories (or Wikidata P31/P106) say musician/band.
//
// Results — including "nothing found" — are cached in `artist_info` for 60 days.
// The Commons image is downloaded once into <dataDir>/artists/<safe id>.jpg.
// Text is always quoted from Wikipedia; nothing here is generated. Lyrics are
// never fetched or stored.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Sourced } from '@liner/shared';
import type { Db } from '../db/index.js';
import type { Config } from '../config.js';
import {
  MbClient,
  sharedMbClient,
  type FetchLike,
  type MbClientOptions,
  type RateLimiter,
  type SleepFn,
  type NowFn,
} from '../match/mb.js';
import { CachedHttp, type HttpDeps } from './http.js';
import { pageTitleFromRelations } from './musicbrainz.js';
import { cleanText, namesMatch, normalizeTitle, truncateAtSentence, wikipediaUrl } from './text.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 60 * DAY_MS;
const MAX_BIO_CHARS = 1200;
const DEFAULT_IMAGE_WIDTH = 600;

const WP_API = 'https://en.wikipedia.org/w/api.php';
const WD_API = 'https://www.wikidata.org/w/api.php';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const ACCEPT_JSON = { accept: 'application/json' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- public shapes ----------

export interface ArtistImageCredit {
  author?: string;
  license?: string;
  /** Commons file description page (the attribution link shown by the UI). */
  url: string;
}

export interface ArtistInfo {
  bio?: Sourced<string>;
  /** Absolute path of the cached image on the server (not sent to clients). */
  imagePath?: string;
  imageCredit?: ArtistImageCredit;
}

export interface ArtistMetaDeps extends HttpDeps {
  /** How long artist info (including "nothing found") stays fresh. Default 60 days. */
  ttlMs?: number;
  /** Share the matcher's MusicBrainz client / limiter. */
  mbClient?: MbClient;
  mbLimiter?: RateLimiter;
  mbRateLimitMs?: number;
  /** Commons thumbnail width. Default 600. */
  imageWidth?: number;
  /**
   * Re-encode downloaded images to JPEG at `imageWidth` (Wikimedia rounds
   * requested widths up to standard buckets such as 960 px). Default true;
   * offline tests can disable the ffmpeg step.
   */
  resizeImages?: boolean;
  /** Injectable binary downloader; defaults to `fetch`. */
  fetchBinary?: FetchLike;
  sleep?: SleepFn;
  now?: NowFn;
}

export interface ArtistMeta {
  /**
   * Bio + cached image for an artist. Returns null only when the artist id is
   * unknown; known artists with nothing found resolve to `{}` (and are cached).
   */
  getArtistInfo(artistId: string, opts?: { refresh?: boolean }): Promise<ArtistInfo | null>;
}

export type CreateArtistMeta = (db: Db, cfg: Config, deps?: ArtistMetaDeps) => ArtistMeta;

// ---------- migration ----------

const migrationSql = readFileSync(new URL('../db/migrations-artistmeta.sql', import.meta.url), 'utf8');

/** Applied idempotently after schema.sql; safe to call many times. */
export function ensureArtistMetaSchema(db: Db): void {
  for (const statement of migrationSql.split(';')) {
    const sql = statement.trim();
    if (!sql) continue;
    try {
      db.exec(sql);
    } catch (err) {
      // SQLite has no ADD COLUMN IF NOT EXISTS; re-application is fine.
      if (!/duplicate column name/i.test(String(err))) throw err;
    }
  }
}

// ---------- URL builders (exported for the recording script / tests) ----------

export function mbArtistUrlRelationsUrl(mbid: string): string {
  return `https://musicbrainz.org/ws/2/artist/${encodeURIComponent(mbid)}?inc=url-rels&fmt=json`;
}

export function wikidataSearchByMbIdUrl(mbid: string): string {
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: `haswbstatement:P434=${mbid}`,
    srlimit: '3',
    format: 'json',
  });
  return `${WD_API}?${params.toString()}`;
}

export function wikidataEntityUrl(qid: string): string {
  const params = new URLSearchParams({
    action: 'wbgetentities',
    ids: qid,
    props: 'sitelinks|claims',
    sitefilter: 'enwiki',
    format: 'json',
  });
  return `${WD_API}?${params.toString()}`;
}

/** Query one or more article titles (pipe-separated) with categories + lead. */
export function wikipediaArtistPageUrl(titleOrTitles: string): string {
  const params = new URLSearchParams({
    action: 'query',
    titles: titleOrTitles,
    redirects: '1',
    prop: 'categories|extracts|pageprops',
    exintro: '1',
    explaintext: '1',
    cllimit: '50',
    format: 'json',
  });
  return `${WP_API}?${params.toString()}`;
}

export function wikipediaArtistTitlesUrl(name: string): string {
  return wikipediaArtistPageUrl([`${name} (band)`, `${name} (musician)`, name].join('|'));
}

export function wikipediaArtistSearchUrl(name: string): string {
  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: `${name} band musician`,
    gsrlimit: '10',
    prop: 'categories|extracts|pageprops',
    exintro: '1',
    explaintext: '1',
    cllimit: '50',
    redirects: '1',
    format: 'json',
  });
  return `${WP_API}?${params.toString()}`;
}

export function normalizeCommonsFile(fileName: string): string {
  return fileName.replace(/^File:/i, '').trim();
}

export function commonsImageInfoUrl(fileName: string, width = DEFAULT_IMAGE_WIDTH): string {
  const params = new URLSearchParams({
    action: 'query',
    titles: `File:${normalizeCommonsFile(fileName)}`,
    prop: 'imageinfo',
    iiprop: 'url|extmetadata',
    iiurlwidth: String(width),
    format: 'json',
  });
  return `${COMMONS_API}?${params.toString()}`;
}

// ---------- text helpers ----------

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
};

export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    const valid = (code: number): boolean => Number.isInteger(code) && code >= 0 && code <= 0x10ffff;
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return valid(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return valid(code) ? String.fromCodePoint(code) : whole;
    }
    return HTML_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Turn a Wikipedia lead extract (or a Commons metadata value) into plain text:
 * references, templates, links, HTML tags and entities removed. The extracts API
 * normally already returns plain text, so this is a defensive second pass.
 */
export function stripWikiMarkup(text: string): string {
  let out = text;
  out = out.replace(/<ref\b[^>]*\/>/gi, ' ');
  out = out.replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, ' ');
  out = out.replace(/<!--[\s\S]*?-->/g, ' ');
  out = out.replace(/<[^>]+>/g, ' ');
  out = out.replace(/\{\|[\s\S]*?\|\}/g, ' ');
  // Templates can nest once or twice; repeat until stable.
  for (let i = 0; i < 3; i++) {
    const next = out.replace(/\{\{[^{}]*\}\}/g, ' ');
    if (next === out) break;
    out = next;
  }
  out = out.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1');
  out = out.replace(/\[(?:https?:\/\/[^\s\]]+)(?:\s+([^\]]*))?\]/gi, '$1');
  out = out.replace(/\[(?:citation needed|clarification needed|note \d+|nb \d+)\]/gi, ' ');
  out = out.replace(/\[\d+\]/g, ' ');
  out = decodeHtmlEntities(out);
  out = out.replace(/[\[\]]/g, ' ');
  out = out.replace(/\{\{|\}\}/g, ' ');
  out = out.replace(/\s*\((?:listen|listen to it|sample|audio)\)\s*/gi, ' ');
  return cleanText(out);
}

function plainMetadataValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = stripWikiMarkup(value);
  return cleaned || undefined;
}

/** Absolute-sounding artist id -> value usable as a filename (`ar:a-b` -> `ar_a_b`). */
export function safeArtistFileId(artistId: string): string {
  return artistId.replace(/[^a-z0-9]/gi, '_');
}

export function sniffImageMime(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  const head = buf.subarray(0, 512).toString('utf8').trimStart();
  if (/^(<\?xml|<svg)/i.test(head)) return 'image/svg+xml';
  return 'image/jpeg';
}

/** True when the id/row carries a MusicBrainz artist id (`artists.mbid` or `ar:<uuid>`). */
export function artistMbid(artistId: string, mbid?: string | null): string | undefined {
  if (mbid && UUID.test(mbid)) return mbid;
  if (artistId.startsWith('ar:')) {
    const rest = artistId.slice(3);
    if (UUID.test(rest)) return rest;
  }
  return undefined;
}

/** Strip a trailing disambiguator: "Alice in Chains (band)" -> "Alice in Chains". */
export function artistTitleBase(title: string): string {
  return cleanText(title.replace(/\s*\([^()]*\)\s*$/, ''));
}

const NOT_ARTIST_PAGE =
  /\b(discography|albums?|songs?|singles?|film|novel|book|video game|soundtrack|tour|concert|award|category)\b/i;

const MUSICIAN_CATEGORY =
  /\b(musicians?|singers?|songwriters?|singer-songwriters?|rappers?|guitarists?|drummers?|bassists?|composers?|pianists?|vocalists?|instrumentalists?|musical groups?|rock groups?|music groups?|bands?|duos?|trios?|ensembles?|record producers?|disc jockeys?|djs?|conductors?|lyricists?)\b/i;

// Wikidata items meaning "this is a musical act / musician occupation".
const MUSIC_GROUP_TYPES = new Set([
  'Q215380', // musical group
  'Q5741069', // rock band
  'Q2088351', // musical ensemble
  'Q641066', // band
  'Q641067', // musical duo
]);
const MUSIC_OCCUPATIONS = new Set([
  'Q639669', // musician
  'Q177220', // singer
  'Q36834', // composer
  'Q855091', // guitarist
  'Q2252262', // rapper
  'Q488205', // singer-songwriter
  'Q158852', // conductor
  'Q753110', // songwriter
  'Q386854', // drummer
  'Q486748', // pianist
  'Q584301', // bassist
  'Q183945', // record producer
  'Q130024', // disc jockey
]);

// ---------- API response shapes ----------

interface UrlRelation {
  type?: string;
  'target-type'?: string;
  url?: { resource?: string };
}

interface MbArtistUrlRels {
  id?: string;
  name?: string;
  relations?: UrlRelation[];
}

interface WikiPage {
  title?: string;
  missing?: string;
  extract?: string;
  categories?: { title?: string }[];
  pageprops?: { wikibase_item?: string; disambiguation?: string };
}

interface WikiQueryResponse {
  query?: { pages?: Record<string, WikiPage | undefined> };
}

interface WikidataSearchResponse {
  query?: { search?: { title?: string }[] };
}

interface WikidataClaim {
  mainsnak?: { datavalue?: { value?: unknown } };
}

interface WikidataEntity {
  sitelinks?: { enwiki?: { title?: string } };
  claims?: Record<string, WikidataClaim[] | undefined>;
}

interface WikidataEntitiesResponse {
  entities?: Record<string, WikidataEntity | undefined>;
}

interface CommonsImageInfo {
  thumburl?: string;
  thumbwidth?: number;
  descriptionurl?: string;
  extmetadata?: Record<string, { value?: string } | undefined>;
}

interface CommonsResponse {
  query?: { pages?: Record<string, { imageinfo?: CommonsImageInfo[] } | undefined> };
}

interface WikiArtistPage {
  title: string;
  extract: string;
  categories: string[];
  wikibaseItem?: string;
}

interface WikidataEntityInfo {
  qid: string;
  title?: string;
  imageFile?: string;
  instanceOf: string[];
  occupations: string[];
}

interface BufferedImage {
  bytes: Buffer;
  contentType?: string;
}

async function safe<T>(p: () => Promise<T>): Promise<T | null> {
  try {
    return await p();
  } catch {
    return null;
  }
}

function claimValues(entity: WikidataEntity, prop: string): unknown[] {
  const claims = entity.claims?.[prop];
  if (!claims) return [];
  const out: unknown[] = [];
  for (const claim of claims) {
    const value = claim.mainsnak?.datavalue?.value;
    if (value !== undefined) out.push(value);
  }
  return out;
}

function claimIds(entity: WikidataEntity, prop: string): string[] {
  const out: string[] = [];
  for (const value of claimValues(entity, prop)) {
    if (typeof value === 'string') out.push(value);
    else if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
      out.push((value as { id: string }).id);
    }
  }
  return out;
}

// ---------- Wikidata ----------

async function searchWikidataByMbId(http: CachedHttp, mbid: string): Promise<string | undefined> {
  const data = await http.getJson<WikidataSearchResponse>(wikidataSearchByMbIdUrl(mbid), ACCEPT_JSON);
  const title = data?.query?.search?.[0]?.title;
  return title && /^Q\d+$/.test(title) ? title : undefined;
}

async function fetchWikidataEntity(http: CachedHttp, qid: string): Promise<WikidataEntityInfo | null> {
  const data = await http.getJson<WikidataEntitiesResponse>(wikidataEntityUrl(qid), ACCEPT_JSON);
  const entity = data?.entities?.[qid];
  if (!entity) return null;
  const image = claimValues(entity, 'P18').find((v): v is string => typeof v === 'string');
  const title = entity.sitelinks?.enwiki?.title;
  return {
    qid,
    ...(title ? { title } : {}),
    ...(image ? { imageFile: normalizeCommonsFile(image) } : {}),
    instanceOf: claimIds(entity, 'P31'),
    occupations: claimIds(entity, 'P106'),
  };
}

async function wikidataIsMusician(http: CachedHttp, qid: string): Promise<boolean> {
  const entity = await safe(() => fetchWikidataEntity(http, qid));
  if (!entity) return false;
  return (
    entity.instanceOf.some((id) => MUSIC_GROUP_TYPES.has(id)) ||
    entity.occupations.some((id) => MUSIC_OCCUPATIONS.has(id))
  );
}

// ---------- Wikipedia ----------

function toWikiArtistPage(raw: WikiPage): WikiArtistPage | null {
  const title = raw.title?.trim();
  if (!title || raw.missing !== undefined) return null;
  if (/\(disambiguation\)/i.test(title) || raw.pageprops?.disambiguation !== undefined) return null;
  if (NOT_ARTIST_PAGE.test(title)) return null;
  const extract = raw.extract?.trim();
  if (!extract) return null;
  return {
    title,
    extract,
    categories: (raw.categories ?? []).map((c) => c.title ?? '').filter(Boolean),
    ...(raw.pageprops?.wikibase_item ? { wikibaseItem: raw.pageprops.wikibase_item } : {}),
  };
}

function isMusicianCategory(categories: string[]): boolean {
  return MUSICIAN_CATEGORY.test(categories.join(' '));
}

function artistPageTitleMatches(name: string, title: string): boolean {
  const base = artistTitleBase(title);
  if (!base) return false;
  return normalizeTitle(base) === normalizeTitle(name) || namesMatch(name, base);
}

interface ArtistPageCandidate {
  page: WikiArtistPage;
  score: number;
  categoryHit: boolean;
}

function collectArtistPageCandidates(pages: WikiPage[], name: string): ArtistPageCandidate[] {
  const shown = new Map<string, ArtistPageCandidate>();
  for (const raw of pages) {
    const page = toWikiArtistPage(raw);
    if (!page) continue;
    if (shown.has(page.title)) continue;
    if (!artistPageTitleMatches(name, page.title)) continue;
    const categoryHit = isMusicianCategory(page.categories);
    const exact = normalizeTitle(artistTitleBase(page.title)) === normalizeTitle(name);
    const score = (exact ? 4 : 2.5) + (categoryHit ? 3 : 0) + Math.min(page.extract.length / 2000, 1);
    shown.set(page.title, { page, score, categoryHit });
  }
  return [...shown.values()].sort((a, b) => b.score - a.score);
}

/**
 * Accept only pages that are actually about a musician/band: categories first,
 * then Wikidata P31/P106. Name match is required in every case.
 */
async function pickArtistPage(
  http: CachedHttp,
  pages: WikiPage[],
  name: string,
): Promise<WikiArtistPage | null> {
  const candidates = collectArtistPageCandidates(pages, name);
  for (const candidate of candidates) {
    if (candidate.categoryHit) return candidate.page;
  }
  for (const candidate of candidates) {
    const qid = candidate.page.wikibaseItem;
    if (qid && (await wikidataIsMusician(http, qid))) return candidate.page;
  }
  return null;
}

async function fetchWikipediaPage(http: CachedHttp, title: string): Promise<WikiArtistPage | null> {
  const data = await http.getJson<WikiQueryResponse>(wikipediaArtistPageUrl(title), ACCEPT_JSON);
  for (const raw of Object.values(data?.query?.pages ?? {})) {
    if (!raw || raw.missing !== undefined) continue;
    const page = toWikiArtistPage(raw);
    if (page) return page;
  }
  return null;
}

function pagesOf(data: WikiQueryResponse | null): WikiPage[] {
  return Object.values(data?.query?.pages ?? {}).filter((p): p is WikiPage => p != null);
}

/** Wikipedia search fallback for artists without a usable MusicBrainz link. */
async function findArtistPage(http: CachedHttp, name: string): Promise<WikiArtistPage | null> {
  const direct = await http.getJson<WikiQueryResponse>(wikipediaArtistTitlesUrl(name), ACCEPT_JSON);
  const pickedDirect = await pickArtistPage(http, pagesOf(direct), name);
  if (pickedDirect) return pickedDirect;

  const search = await http.getJson<WikiQueryResponse>(wikipediaArtistSearchUrl(name), ACCEPT_JSON);
  return pickArtistPage(http, pagesOf(search), name);
}

// ---------- Commons ----------

interface CommonsImage {
  thumbUrl: string;
  descriptionUrl: string;
  author?: string;
  license?: string;
  licenseUrl?: string;
}

function commonsFilePageUrl(fileName: string): string {
  return `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(fileName.replace(/ /g, '_'))}`;
}

async function fetchCommonsImage(http: CachedHttp, fileName: string, width: number): Promise<CommonsImage | null> {
  const data = await http.getJson<CommonsResponse>(commonsImageInfoUrl(fileName, width), ACCEPT_JSON);
  for (const page of Object.values(data?.query?.pages ?? {})) {
    const info = page?.imageinfo?.[0];
    if (!info?.thumburl) continue;
    const meta = info.extmetadata ?? {};
    const author = plainMetadataValue(meta.Artist?.value) ?? plainMetadataValue(meta.Credit?.value);
    const license = plainMetadataValue(meta.LicenseShortName?.value);
    const licenseUrl = plainMetadataValue(meta.LicenseUrl?.value);
    return {
      thumbUrl: info.thumburl,
      descriptionUrl: info.descriptionurl ?? commonsFilePageUrl(fileName),
      ...(author ? { author } : {}),
      ...(license ? { license } : {}),
      ...(licenseUrl ? { licenseUrl } : {}),
    };
  }
  return null;
}

function isJpeg(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

function convertToJpeg(inputPath: string, width?: number): Promise<Buffer | null> {
  const out = `${inputPath}.converted.jpg`;
  const args = ['-v', 'error', '-y', '-i', inputPath];
  if (width) args.push('-vf', `scale='min(${width},iw)':-2:flags=lanczos`);
  args.push('-frames:v', '1', '-q:v', '3', out);
  return new Promise((resolve) => {
    execFile(
      'ffmpeg',
      args,
      { timeout: 20_000 },
      (err) => {
        try {
          if (err) resolve(null);
          else resolve(readFileSync(out));
        } catch {
          resolve(null);
        } finally {
          try {
            unlinkSync(out);
          } catch {
            /* nothing to remove */
          }
        }
      },
    );
  });
}

// ---------- stored rows ----------

interface ArtistRow {
  id: string;
  name: string;
  mbid: string | null;
}

interface ArtistInfoRow {
  bio_json: string | null;
  image_path: string | null;
  image_mime: string | null;
  image_credit_json: string | null;
  wikidata_id: string | null;
  wikipedia_title: string | null;
  found: number;
  fetched_at: number;
}

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function rowToInfo(row: ArtistInfoRow): ArtistInfo {
  const bio = parseJson<Sourced<string>>(row.bio_json);
  const credit = parseJson<ArtistImageCredit>(row.image_credit_json);
  const imagePath = row.image_path && existsSync(row.image_path) ? row.image_path : undefined;
  return {
    ...(bio ? { bio } : {}),
    ...(imagePath ? { imagePath } : {}),
    ...(credit ? { imageCredit: credit } : {}),
  };
}

interface FetchedInfo {
  info: ArtistInfo;
  wikidataId?: string;
  wikipediaTitle?: string;
}

// ---------- service ----------

export function createArtistMeta(db: Db, cfg: Config, deps: ArtistMetaDeps = {}): ArtistMeta {
  ensureArtistMetaSchema(db);

  const http = new CachedHttp(db, cfg, deps);
  const fetchImpl: FetchLike = deps.fetchBinary ?? deps.fetch ?? globalThis.fetch.bind(globalThis);
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const imageWidth = deps.imageWidth ?? DEFAULT_IMAGE_WIDTH;
  const resizeImages = deps.resizeImages ?? true;
  const inflight = new Map<string, Promise<ArtistInfo>>();

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

  const artistStmt = db.prepare('SELECT id, name, mbid FROM artists WHERE id = ?');
  const readStmt = db.prepare(
    `SELECT bio_json, image_path, image_mime, image_credit_json, wikidata_id, wikipedia_title, found, fetched_at
       FROM artist_info WHERE artist_id = ?`,
  );
  const writeStmt = db.prepare(
    `INSERT INTO artist_info
       (artist_id, bio_json, image_path, image_mime, image_credit_json, wikidata_id, wikipedia_title, found, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(artist_id) DO UPDATE SET
       bio_json = excluded.bio_json,
       image_path = excluded.image_path,
       image_mime = excluded.image_mime,
       image_credit_json = excluded.image_credit_json,
       wikidata_id = excluded.wikidata_id,
       wikipedia_title = excluded.wikipedia_title,
       found = excluded.found,
       fetched_at = excluded.fetched_at`,
  );
  const setArtistImageStmt = db.prepare('UPDATE artists SET image_path = ? WHERE id = ?');

  function artistRow(artistId: string): ArtistRow | null {
    return (artistStmt.get(artistId) as ArtistRow | undefined) ?? null;
  }

  function readStored(artistId: string): ArtistInfoRow | null {
    return (readStmt.get(artistId) as ArtistInfoRow | undefined) ?? null;
  }

  function store(artistId: string, fetched: FetchedInfo): void {
    const { info } = fetched;
    writeStmt.run(
      artistId,
      info.bio ? JSON.stringify(info.bio) : null,
      info.imagePath ?? null,
      info.imagePath ? sniffImageMime(readFileSync(info.imagePath)) : null,
      info.imageCredit ? JSON.stringify(info.imageCredit) : null,
      fetched.wikidataId ?? null,
      fetched.wikipediaTitle ?? null,
      info.bio || info.imagePath ? 1 : 0,
      now(),
    );
  }

  async function fetchBinary(url: string): Promise<BufferedImage | null> {
    try {
      const res = await fetchImpl(url, {
        headers: { 'user-agent': cfg.userAgent, accept: 'image/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0) return null;
      const contentType = res.headers.get('content-type') ?? undefined;
      return { bytes, ...(contentType ? { contentType } : {}) };
    } catch {
      return null;
    }
  }

  async function storeImage(
    artistId: string,
    rawFileName: string,
  ): Promise<{ path: string; credit: ArtistImageCredit } | null> {
    const fileName = normalizeCommonsFile(rawFileName);
    if (!fileName) return null;
    const meta = await safe(() => fetchCommonsImage(http, fileName, imageWidth));
    if (!meta) return null;

    const credit: ArtistImageCredit = {
      ...(meta.author ? { author: meta.author } : {}),
      ...(meta.license ? { license: meta.license } : {}),
      url: meta.descriptionUrl,
    };
    const dir = join(cfg.dataDir, 'artists');
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, `${safeArtistFileId(artistId)}.jpg`);

    const downloaded = await fetchBinary(meta.thumbUrl);
    if (!downloaded) {
      // A previous run may already have the bytes; keep them rather than
      // losing a working image because of one failed download.
      if (existsSync(dest)) return { path: dest, credit };
      return null;
    }

    let bytes = downloaded.bytes;
    // Wikimedia rounds requested widths up to standard buckets (e.g. 600 -> 960),
    // so re-encode to JPEG at ~imageWidth. Keep the original if ffmpeg is absent.
    if (resizeImages || !isJpeg(bytes)) {
      const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, bytes);
      const converted = await safe(() => convertToJpeg(tmp, resizeImages ? imageWidth : undefined));
      try {
        unlinkSync(tmp);
      } catch {
        /* nothing to remove */
      }
      if (converted) bytes = converted;
    }

    const tmpOut = `${dest}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmpOut, bytes);
    renameSync(tmpOut, dest);
    setArtistImageStmt.run(dest, artistId);
    return { path: dest, credit };
  }

  async function fetchFresh(row: ArtistRow): Promise<FetchedInfo> {
    try {
      const mbid = artistMbid(row.id, row.mbid);
      let qid: string | undefined;
      let wikiTitle: string | undefined;
      let imageFile: string | undefined;
      let entity: WikidataEntityInfo | null = null;

      if (mbid) {
        const rels = await safe(() => mb.getJson<MbArtistUrlRels>(mbArtistUrlRelationsUrl(mbid)));
        const links = pageTitleFromRelations(rels?.relations);
        wikiTitle = links.wikipedia;
        qid = links.wikidata;
        if (!qid) qid = await safe(() => searchWikidataByMbId(http, mbid)).then((v) => v ?? undefined);
        if (qid) {
          const resolvedQid = qid;
          entity = await safe(() => fetchWikidataEntity(http, resolvedQid));
          if (entity) {
            if (!wikiTitle) wikiTitle = entity.title;
            imageFile = entity.imageFile;
          }
        }
      }

      // The linked article is trusted when it exists; otherwise fall back to a
      // name search which demands a musician/band page.
      let page = wikiTitle ? await safe(() => fetchWikipediaPage(http, wikiTitle)) : null;
      if (!page || !page.extract) page = await safe(() => findArtistPage(http, row.name));
      if (!page) return { info: {}, ...(qid ? { wikidataId: qid } : {}) };

      if (!qid && page.wikibaseItem) {
        qid = page.wikibaseItem;
        entity = entity ?? (await safe(() => fetchWikidataEntity(http, qid!)));
        if (entity?.imageFile) imageFile = entity.imageFile;
      }
      if (!imageFile && qid) {
        entity = entity ?? (await safe(() => fetchWikidataEntity(http, qid)));
        if (entity?.imageFile) imageFile = entity.imageFile;
      }

      const bioValue = page.extract ? truncateAtSentence(stripWikiMarkup(page.extract), MAX_BIO_CHARS) : '';
      const bio: Sourced<string> | undefined =
        bioValue.length >= 40
          ? { value: bioValue, source: 'Wikipedia', url: wikipediaUrl(page.title) }
          : undefined;

      let imagePath: string | undefined;
      let imageCredit: ArtistImageCredit | undefined;
      if (imageFile) {
        const stored = await safe(() => storeImage(row.id, imageFile as string));
        if (stored) {
          imagePath = stored.path;
          imageCredit = stored.credit;
        }
      }

      return {
        info: {
          ...(bio ? { bio } : {}),
          ...(imagePath ? { imagePath } : {}),
          ...(imageCredit ? { imageCredit } : {}),
        },
        ...(qid ? { wikidataId: qid } : {}),
        wikipediaTitle: page.title,
      };
    } catch {
      return { info: {} };
    }
  }

  function fetchWithDedupe(row: ArtistRow): Promise<ArtistInfo> {
    const existing = inflight.get(row.id);
    if (existing) return existing;
    const promise = fetchFresh(row)
      .then((fetched) => {
        store(row.id, fetched);
        return fetched.info;
      })
      .finally(() => {
        inflight.delete(row.id);
      });
    inflight.set(row.id, promise);
    return promise;
  }

  return {
    async getArtistInfo(artistId, opts = {}) {
      const row = artistRow(artistId);
      if (!row) return null;

      if (!opts.refresh) {
        const stored = readStored(artistId);
        if (stored) {
          const imageMissing = stored.image_path != null && !existsSync(stored.image_path);
          if (!imageMissing && now() - stored.fetched_at < ttlMs) return rowToInfo(stored);
        }
      }
      return fetchWithDedupe(row);
    },
  };
}

// ---------- routes ----------

function publicArtistInfo(artistId: string, info: ArtistInfo): Record<string, unknown> {
  return {
    ...(info.bio ? { bio: info.bio } : {}),
    ...(info.imagePath ? { imageUrl: `/api/artist-image/${encodeURIComponent(artistId)}` } : {}),
    ...(info.imageCredit ? { imageCredit: info.imageCredit } : {}),
  };
}

/** Wire artist routes. The API prefix (`/api`) is added by the app. */
export function registerArtistMetaRoutes(app: FastifyInstance, artistMeta: ArtistMeta): void {
  app.get('/artists/:id/info', async (request, reply) => {
    const { id } = request.params as { id?: string };
    if (!id) return reply.code(400).send({ error: 'missing artist id' });
    const refresh = (request.query as { refresh?: string } | undefined)?.refresh;
    const info = await artistMeta.getArtistInfo(id, { refresh: refresh === '1' || refresh === 'true' });
    if (!info) return reply.code(404).send({ error: 'artist not found' });
    return publicArtistInfo(id, info);
  });

  app.get('/artist-image/:id', async (request, reply) => {
    const { id } = request.params as { id?: string };
    if (!id) return reply.code(400).send({ error: 'missing artist id' });
    const info = await artistMeta.getArtistInfo(id);
    if (!info?.imagePath || !existsSync(info.imagePath)) return reply.code(404).send({ error: 'no image' });
    const bytes = readFileSync(info.imagePath);
    reply.header('cache-control', 'public, max-age=86400');
    reply.type(sniffImageMime(bytes));
    return reply.send(bytes);
  });
}
