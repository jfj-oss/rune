// MusicBrainz artist relations for people pages.
//
// For every person whose artist row is a MusicBrainz artist (`ar:<uuid>`), one
// WS/2 lookup with `inc=artist-rels` says whether they are a person and which
// band(s) they are a member of ("member of Alice in Chains"). The parsed result
// is cached in `people_rels` so a page view never hits the network twice for the
// same artist within the TTL.
//
// Requests go through the shared `MbClient` (one 1 req/s limiter + one HTTP cache
// per database) exactly like the matcher and artist metadata; tests inject a fake
// `fetch`, so they never touch the network.
import type { Db } from '../db/index.js';
import {
  MbClient,
  sharedMbClient,
  type FetchLike,
  type MbRelation,
  type NowFn,
  type RateLimiter,
  type SleepFn,
} from '../match/mb.js';
import { ensurePeopleSchema } from './schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RELATIONS_TTL_MS = 60 * DAY_MS;
export const DEFAULT_USER_AGENT = 'Liner/0.1 ( personal music player, self-hosted )';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YEAR_ATTRIBUTE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;

/** WS/2 relation fields we use for `member of band` (mb.ts keeps the generic shape). */
interface MbArtistRelation extends MbRelation {
  begin?: string | null;
  end?: string | null;
  ended?: boolean;
}

interface MbArtistWithRelations {
  id?: string;
  name?: string;
  'sort-name'?: string;
  /** "Person", "Group", "Orchestra", "Choir", "Character", "Other" */
  type?: string | null;
  relations?: MbArtistRelation[];
}

export interface PersonRelation {
  /** Canonical local artist id (`ar:<uuid>`). */
  id: string;
  name: string;
  /** Band-member attributes that are not dates, e.g. "guitar", "lead vocals". */
  roles?: string[];
  begin?: number;
  end?: number;
}

export interface MbRelations {
  /** MusicBrainz artist type as returned by WS/2 ("Person", "Group", ...). */
  type?: string;
  isPerson: boolean;
  /** Bands this artist is a member of (direction: forward on a person lookup). */
  memberOf: PersonRelation[];
  /** People who are members of this artist (direction: backward on a band lookup). */
  members: PersonRelation[];
}

export interface PeopleRelationsDeps {
  userAgent?: string;
  mbClient?: MbClient;
  fetch?: FetchLike;
  sleep?: SleepFn;
  now?: NowFn;
  limiter?: RateLimiter;
  rateLimitMs?: number;
  /** How long a cached lookup (including a failed one) stays fresh. Default 60 days. */
  ttlMs?: number;
  /** false = never call MusicBrainz; pages get no `musicbrainz` block. */
  enabled?: boolean;
}

export interface PeopleRelations {
  /**
   * Cached relations for an artist. Resolves undefined for non-MB artists,
   * disabled lookups and cached failures.
   */
  get(artistId: string, mbid?: string | null): Promise<MbRelations | undefined>;
}

export function mbArtistRelationsUrl(mbid: string): string {
  return `https://musicbrainz.org/ws/2/artist/${encodeURIComponent(mbid)}?inc=artist-rels&fmt=json`;
}

/** Use `artists.mbid` when valid, else the `ar:<uuid>` id. */
export function personMbid(artistId: string, mbid?: string | null): string | undefined {
  if (mbid && UUID.test(mbid)) return mbid;
  if (artistId.startsWith('ar:')) {
    const rest = artistId.slice(3);
    if (UUID.test(rest)) return rest;
  }
  return undefined;
}

function yearOf(value: string | null | undefined): number | undefined {
  const m = /^(\d{4})/.exec(value?.trim() ?? '');
  return m ? Number(m[1]) : undefined;
}

function mergeRelation(list: PersonRelation[], incoming: PersonRelation): void {
  const existing = list.find((entry) => entry.id === incoming.id);
  if (!existing) {
    list.push(incoming);
    return;
  }
  // The same band can appear several times (e.g. left and rejoined): union roles
  // and keep the earliest begin / latest end.
  if (incoming.roles) {
    existing.roles = [...new Set([...(existing.roles ?? []), ...incoming.roles])];
  }
  if (incoming.begin != null && (existing.begin == null || incoming.begin < existing.begin)) {
    existing.begin = incoming.begin;
  }
  if (incoming.end != null && (existing.end == null || incoming.end > existing.end)) {
    existing.end = incoming.end;
  }
}

function linkFromRelation(relation: MbArtistRelation): PersonRelation | undefined {
  const artist = relation.artist;
  if (!artist?.id) return undefined;

  const attributes = (relation.attributes ?? []).map((a) => a.trim()).filter(Boolean);
  const yearAttributes = attributes.filter((a) => YEAR_ATTRIBUTE.test(a));
  const roles = attributes.filter((a) => !YEAR_ATTRIBUTE.test(a));
  const begin = yearOf(relation.begin) ?? yearOf(yearAttributes[0]);
  const end = yearOf(relation.end) ?? yearOf(yearAttributes[1]);

  return {
    id: `ar:${artist.id}`,
    name: artist.name,
    ...(roles.length > 0 ? { roles } : {}),
    ...(begin != null ? { begin } : {}),
    ...(end != null ? { end } : {}),
  };
}

/**
 * Normalise a WS/2 artist lookup into the shape people pages render.
 *
 * "member of band" relations are directional: on a person lookup (forward) the
 * target is the band, on a band lookup (backward) the target is the member.
 */
export function parseArtistRelations(data: MbArtistWithRelations | undefined): MbRelations {
  const out: MbRelations = {
    ...(data?.type ? { type: data.type } : {}),
    isPerson: data?.type === 'Person',
    memberOf: [],
    members: [],
  };
  for (const relation of data?.relations ?? []) {
    if (relation.type?.toLowerCase() !== 'member of band') continue;
    if (relation['target-type'] && relation['target-type'] !== 'artist') continue;
    const link = linkFromRelation(relation);
    if (!link) continue;
    mergeRelation(relation.direction === 'backward' ? out.members : out.memberOf, link);
  }
  const byName = (a: PersonRelation, b: PersonRelation): number =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  out.memberOf.sort(byName);
  out.members.sort(byName);
  return out;
}

interface RelationsRow {
  mbid: string | null;
  data_json: string;
  found: number;
  fetched_at: number;
}

function parseStored(raw: string): MbRelations | undefined {
  try {
    const value = JSON.parse(raw) as Partial<MbRelations> | null;
    if (!value || typeof value !== 'object') return undefined;
    return {
      ...(typeof value.type === 'string' ? { type: value.type } : {}),
      isPerson: value.isPerson === true,
      memberOf: Array.isArray(value.memberOf) ? value.memberOf : [],
      members: Array.isArray(value.members) ? value.members : [],
    };
  } catch {
    return undefined;
  }
}

/**
 * Create the MB relations cache for one database. In production the shared
 * client is reused, so people lookups share the matcher/meta 1 req/s limiter.
 */
export function createPeopleRelations(db: Db, deps: PeopleRelationsDeps = {}): PeopleRelations {
  ensurePeopleSchema(db);

  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? DEFAULT_RELATIONS_TTL_MS;
  const enabled = deps.enabled !== false;

  const mbOpts = {
    userAgent: deps.userAgent ?? DEFAULT_USER_AGENT,
    db,
    fetch: deps.fetch,
    sleep: deps.sleep,
    now: deps.now,
    rateLimitMs: deps.rateLimitMs ?? 1000,
    limiter: deps.limiter,
  };
  const injected =
    deps.mbClient != null ||
    deps.fetch != null ||
    deps.sleep != null ||
    deps.now != null ||
    deps.limiter != null ||
    deps.rateLimitMs != null;
  const mb = deps.mbClient ?? (injected ? new MbClient(mbOpts) : sharedMbClient(db, mbOpts));

  const readStmt = db.prepare(
    'SELECT mbid, data_json, found, fetched_at FROM people_rels WHERE artist_id = ?',
  );
  const writeStmt = db.prepare(
    `INSERT INTO people_rels (artist_id, mbid, data_json, found, fetched_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(artist_id) DO UPDATE SET
       mbid = excluded.mbid,
       data_json = excluded.data_json,
       found = excluded.found,
       fetched_at = excluded.fetched_at`,
  );

  const inflight = new Map<string, Promise<MbRelations | undefined>>();

  /** `hit` distinguishes a fresh cached failure from "never looked up". */
  function readCached(artistId: string, mbid: string): { hit: true; value?: MbRelations } | { hit: false } {
    const row = readStmt.get(artistId) as RelationsRow | undefined;
    if (!row) return { hit: false };
    if (row.mbid !== mbid || now() - row.fetched_at >= ttlMs) return { hit: false };
    if (!row.found) return { hit: true };
    const value = parseStored(row.data_json);
    return value ? { hit: true, value } : { hit: true };
  }

  async function fetchFresh(artistId: string, mbid: string): Promise<MbRelations | undefined> {
    try {
      const data = await mb.getJson<MbArtistWithRelations>(mbArtistRelationsUrl(mbid));
      const relations = parseArtistRelations(data);
      const found = Boolean(data && (data.id || data.name));
      writeStmt.run(artistId, mbid, JSON.stringify(relations), found ? 1 : 0, now());
      return found ? relations : undefined;
    } catch {
      // Cache the failure (row found = 0) so a broken network does not retry on
      // every page view; the next lookup after the TTL tries again.
      const empty: MbRelations = { isPerson: false, memberOf: [], members: [] };
      try {
        writeStmt.run(artistId, mbid, JSON.stringify(empty), 0, now());
      } catch {
        // A closed/readonly db must never break page rendering.
      }
      return undefined;
    }
  }

  return {
    async get(artistId, mbid) {
      if (!enabled) return undefined;
      const resolved = personMbid(artistId, mbid);
      if (!resolved) return undefined;

      const cached = readCached(artistId, resolved);
      if (cached.hit) return cached.value;

      const existing = inflight.get(artistId);
      if (existing) return existing;
      const promise = fetchFresh(artistId, resolved).finally(() => inflight.delete(artistId));
      inflight.set(artistId, promise);
      return promise;
    },
  };
}
