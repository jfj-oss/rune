// Worker U — "people" pages: every producer, engineer, session musician and
// composer in the `credits` table becomes browsable.
//
//   GET /people/:artistId       one person: role breakdown, albums they made,
//                               albums they played on, collaborators.
//   GET /people?role=&q=        browse people (a "Producers" page) with album counts.
//   GET /albums/:id/connections albums sharing credited people, and who links them.
//
// Read-only. File paths are never selected. The MusicBrainz relation lookup is
// injected (see relations.ts) so tests stay offline and the app reuses the shared
// 1 req/s MB client.
import type { FastifyInstance } from 'fastify';
import type { AlbumSummary, ArtistRef, Id } from '@liner/shared';
import type { Db } from '../db/index.js';
import {
  createPeopleRelations,
  type MbRelations,
  type PeopleRelations,
  type PeopleRelationsDeps,
} from './relations.js';
import { ensurePeopleSchema } from './schema.js';

export type { MbRelations, PersonRelation, PeopleRelations } from './relations.js';
export { ensurePeopleSchema } from './schema.js';

// ---------- response shapes ----------

export interface PersonRoleCount {
  role: string;
  /** Distinct albums on which this role is credited. */
  count: number;
}

export interface PersonCreditAlbum {
  album: AlbumSummary;
  /** Roles on this album (whole-album and track-level merged). */
  roles: string[];
  /** Track-level credits only; absent when every role covers the whole album. */
  tracks?: { id: Id; title: string }[];
}

export interface PersonCollaborator {
  artist: ArtistRef;
  /** Distinct albums both people are credited on. */
  sharedAlbums: number;
}

export interface PersonPage {
  id: Id;
  name: string;
  roles: PersonRoleCount[];
  /** Albums where this person is the album artist. */
  asArtist: AlbumSummary[];
  /** Albums where this person appears in the credits, chronological. */
  credits: PersonCreditAlbum[];
  /** People sharing the most credited albums with this person (max 12). */
  collaborators: PersonCollaborator[];
  /** Present for MusicBrainz artists when the relation lookup is enabled. */
  musicbrainz?: MbRelations;
}

export interface PersonSummary {
  id: Id;
  name: string;
  /** Distinct albums this person is credited on. */
  albumCount: number;
  /** Every role they are credited with (alphabetical). */
  roles: string[];
}

export interface AlbumConnectionPerson {
  artist: ArtistRef;
  /** Roles this person has on the connected album. */
  roles: string[];
}

export interface AlbumConnection {
  album: AlbumSummary;
  /** Credited people shared with the source album. */
  people: AlbumConnectionPerson[];
}

export interface AlbumConnections {
  albumId: Id;
  connections: AlbumConnection[];
}

export type PeopleOptions = PeopleRelationsDeps;

/** Fastify's default parser yields an array for repeated keys (`?q=a&q=b`). */
type Query = Record<string, string | string[] | undefined>;

// ---------- shared query helpers ----------

function queryValue(q: Query, key: string): string | undefined {
  const v = q[key];
  return Array.isArray(v) ? v[0] : v;
}

function hasColumn(db: Db, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

/** Spotify-library worker adds albums.in_library; honour it only when present. */
function libraryFilter(db: Db): string {
  return hasColumn(db, 'albums', 'in_library') ? ' AND a.in_library = 1' : '';
}

export function coverUrl(albumId: string): string {
  return `/api/cover/${encodeURIComponent(albumId)}?size=600`;
}

interface AlbumRow {
  id: string;
  source: string;
  title: string;
  artist_id: string;
  artist_name: string | null;
  year: number | null;
  format: string | null;
  cover_path: string | null;
  added_at: number;
}

const ALBUM_COLUMNS = `
  a.id AS id, a.source AS source, a.title AS title, a.artist_id AS artist_id,
  ar.name AS artist_name, a.year AS year, a.format AS format,
  a.cover_path AS cover_path, a.added_at AS added_at`;

function albumSummary(row: AlbumRow): AlbumSummary {
  return {
    id: row.id,
    source: row.source === 'spotify' ? 'spotify' : 'local',
    title: row.title,
    artist: { id: row.artist_id, name: row.artist_name ?? 'Unknown Artist' },
    ...(row.year ? { year: row.year } : {}),
    ...(row.cover_path ? { coverUrl: coverUrl(row.id) } : {}),
    ...(row.format ? { format: row.format } : {}),
    addedAt: row.added_at,
  };
}

function parseTrackIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Escape LIKE metacharacters so a user's `%`/`_` stay literal. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ---------- one person ----------

interface CreditRow extends AlbumRow {
  album_id: string;
  role: string;
  track_ids: string | null;
}

interface CreditGroup {
  row: AlbumRow;
  roles: string[];
  roleSeen: Set<string>;
  trackIds: string[];
  trackSeen: Set<string>;
}

/**
 * A person's page. `relations` is optional: without it (or with MusicBrainz
 * disabled) the response has no `musicbrainz` block.
 */
export async function getPersonPage(
  db: Db,
  artistId: string,
  relations?: PeopleRelations,
): Promise<PersonPage | undefined> {
  const artist = db
    .prepare('SELECT id, name, mbid FROM artists WHERE id = ?')
    .get(artistId) as { id: string; name: string; mbid: string | null } | undefined;
  if (!artist) return undefined;

  const filter = libraryFilter(db);

  // Role breakdown: how many distinct albums carry each role.
  const roles = db
    .prepare(
      `SELECT c.role AS role, count(DISTINCT c.album_id) AS n
       FROM credits c JOIN albums a ON a.id = c.album_id
       WHERE c.artist_id = ?${filter}
       GROUP BY c.role
       ORDER BY n DESC, c.role COLLATE NOCASE`,
    )
    .all(artistId) as { role: string; n: number }[];

  // Albums they made as album artist.
  const asArtist = (
    db
      .prepare(
        `SELECT ${ALBUM_COLUMNS}
         FROM albums a LEFT JOIN artists ar ON ar.id = a.artist_id
         WHERE a.artist_id = ?${filter}
         ORDER BY (a.year IS NULL), a.year, a.title COLLATE NOCASE, a.id`,
      )
      .all(artistId) as AlbumRow[]
  ).map(albumSummary);

  // Albums they are credited on, grouped by album. One row per (album, role).
  const creditRows = db
    .prepare(
      `SELECT ${ALBUM_COLUMNS}, c.album_id AS album_id, c.role AS role, c.track_ids AS track_ids
       FROM credits c
       JOIN albums a ON a.id = c.album_id
       LEFT JOIN artists ar ON ar.id = a.artist_id
       WHERE c.artist_id = ?${filter}
       ORDER BY (a.year IS NULL), a.year, a.title COLLATE NOCASE, a.id, c.role COLLATE NOCASE`,
    )
    .all(artistId) as CreditRow[];

  const groups = new Map<string, CreditGroup>();
  for (const row of creditRows) {
    let group = groups.get(row.album_id);
    if (!group) {
      group = {
        row: {
          id: row.id,
          source: row.source,
          title: row.title,
          artist_id: row.artist_id,
          artist_name: row.artist_name,
          year: row.year,
          format: row.format,
          cover_path: row.cover_path,
          added_at: row.added_at,
        },
        roles: [],
        roleSeen: new Set(),
        trackIds: [],
        trackSeen: new Set(),
      };
      groups.set(row.album_id, group);
    }
    if (!group.roleSeen.has(row.role)) {
      group.roleSeen.add(row.role);
      group.roles.push(row.role);
    }
    for (const trackId of parseTrackIds(row.track_ids)) {
      if (!group.trackSeen.has(trackId)) {
        group.trackSeen.add(trackId);
        group.trackIds.push(trackId);
      }
    }
  }

  const tracksByAlbum = trackTitlesByAlbum(db, groups);

  const credits: PersonCreditAlbum[] = [...groups.values()].map((group) => {
    const tracks = tracksByAlbum.get(group.row.id);
    return {
      album: albumSummary(group.row),
      roles: group.roles,
      ...(tracks && tracks.length > 0 ? { tracks } : {}),
    };
  });

  // People sharing the most albums in the credits.
  const collaborators = (
    db
      .prepare(
        `SELECT c2.artist_id AS id, ar.name AS name, count(DISTINCT c2.album_id) AS sharedAlbums
         FROM credits c1
         JOIN albums a ON a.id = c1.album_id${filter}
         JOIN credits c2 ON c2.album_id = c1.album_id AND c2.artist_id <> c1.artist_id
         JOIN artists ar ON ar.id = c2.artist_id
         WHERE c1.artist_id = ?
         GROUP BY c2.artist_id, ar.name
         ORDER BY sharedAlbums DESC, ar.name COLLATE NOCASE
         LIMIT 12`,
      )
      .all(artistId) as { id: string; name: string; sharedAlbums: number }[]
  ).map((row) => ({ artist: { id: row.id, name: row.name }, sharedAlbums: row.sharedAlbums }));

  const musicbrainz = relations ? await relations.get(artist.id, artist.mbid) : undefined;

  return {
    id: artist.id,
    name: artist.name,
    roles: roles.map((row) => ({ role: row.role, count: row.n })),
    asArtist,
    credits,
    collaborators,
    ...(musicbrainz ? { musicbrainz } : {}),
  };
}

/** Titles for every track-level credit, once per album, in disc/track order. */
function trackTitlesByAlbum(
  db: Db,
  groups: Map<string, CreditGroup>,
): Map<string, { id: string; title: string }[]> {
  const allIds = [...new Set([...groups.values()].flatMap((g) => g.trackIds))];
  const out = new Map<string, { id: string; title: string }[]>();
  if (allIds.length === 0) return out;

  const placeholders = allIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, album_id, title FROM tracks
       WHERE id IN (${placeholders})
       ORDER BY disc, number, id`,
    )
    .all(...allIds) as { id: string; album_id: string; title: string }[];

  for (const row of rows) {
    const group = groups.get(row.album_id);
    // Defensive: only show a track that belongs to the album being grouped.
    if (!group || !group.trackSeen.has(row.id)) continue;
    let list = out.get(row.album_id);
    if (!list) {
      list = [];
      out.set(row.album_id, list);
    }
    list.push({ id: row.id, title: row.title });
  }
  return out;
}

// ---------- browse people ----------

export interface PeopleQuery {
  /** Exact role, case-insensitive, e.g. "Producer". */
  role?: string;
  /** Name substring. */
  q?: string;
}

/** Everyone credited at least once, with album counts (for the People/Producers pages). */
export function listPeople(db: Db, query: PeopleQuery = {}): PersonSummary[] {
  const where = ['1 = 1'];
  const args: unknown[] = [];

  const role = query.role?.trim();
  if (role) {
    where.push('lower(trim(c.role)) = lower(trim(?))');
    args.push(role);
  }
  const text = query.q?.trim();
  if (text) {
    where.push("ar.name LIKE ? ESCAPE '\\'");
    args.push(`%${escapeLike(text)}%`);
  }

  const rows = db
    .prepare(
      `SELECT ar.id AS id, ar.name AS name, c.album_id AS album_id, c.role AS role
       FROM credits c
       JOIN artists ar ON ar.id = c.artist_id
       JOIN albums a ON a.id = c.album_id${libraryFilter(db)}
       WHERE ${where.join(' AND ')}
       ORDER BY ar.name COLLATE NOCASE, c.role COLLATE NOCASE`,
    )
    .all(...args) as { id: string; name: string; album_id: string; role: string }[];

  const people = new Map<string, { id: string; name: string; albums: Set<string>; roles: Set<string> }>();
  for (const row of rows) {
    let person = people.get(row.id);
    if (!person) {
      person = { id: row.id, name: row.name, albums: new Set(), roles: new Set() };
      people.set(row.id, person);
    }
    person.albums.add(row.album_id);
    person.roles.add(row.role);
  }

  return [...people.values()]
    .map((person) => ({
      id: person.id,
      name: person.name,
      albumCount: person.albums.size,
      roles: [...person.roles],
    }))
    .sort(
      (a, b) =>
        b.albumCount - a.albumCount || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
}

// ---------- album → album connections ----------

interface ConnectionRow extends AlbumRow {
  album_id: string;
  person_id: string;
  role: string;
}

interface ConnectionGroup {
  row: AlbumRow;
  people: Map<string, { name: string; roles: Set<string> }>;
}

/**
 * Other library albums sharing at least one credited person with this album,
 * plus the shared people (with their roles on the connected album). Sorted by
 * most shared people first, then chronologically.
 */
export function getAlbumConnections(db: Db, albumId: string): AlbumConnections | undefined {
  const album = db.prepare('SELECT id FROM albums WHERE id = ?').get(albumId) as { id: string } | undefined;
  if (!album) return undefined;

  const sourcePeople = db
    .prepare(
      `SELECT c.artist_id AS id, ar.name AS name
       FROM credits c JOIN artists ar ON ar.id = c.artist_id
       WHERE c.album_id = ?`,
    )
    .all(albumId) as { id: string; name: string }[];

  const peopleById = new Map(sourcePeople.map((p) => [p.id, p.name]));
  if (peopleById.size === 0) return { albumId, connections: [] };

  const ids = [...peopleById.keys()];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT ${ALBUM_COLUMNS}, c.album_id AS album_id, c.artist_id AS person_id, c.role AS role
       FROM credits c
       JOIN albums a ON a.id = c.album_id
       LEFT JOIN artists ar ON ar.id = a.artist_id
       WHERE c.artist_id IN (${placeholders}) AND c.album_id <> ?${libraryFilter(db)}
       ORDER BY a.id, c.artist_id, c.role COLLATE NOCASE`,
    )
    .all(...ids, albumId) as ConnectionRow[];

  const groups = new Map<string, ConnectionGroup>();
  for (const row of rows) {
    let group = groups.get(row.album_id);
    if (!group) {
      group = {
        row: {
          id: row.id,
          source: row.source,
          title: row.title,
          artist_id: row.artist_id,
          artist_name: row.artist_name,
          year: row.year,
          format: row.format,
          cover_path: row.cover_path,
          added_at: row.added_at,
        },
        people: new Map(),
      };
      groups.set(row.album_id, group);
    }
    let person = group.people.get(row.person_id);
    if (!person) {
      person = { name: peopleById.get(row.person_id) ?? 'Unknown Artist', roles: new Set() };
      group.people.set(row.person_id, person);
    }
    person.roles.add(row.role);
  }

  const yearKey = (year: number | null): number => year ?? Number.MAX_SAFE_INTEGER;
  const connections = [...groups.values()]
    .sort(
      (a, b) =>
        b.people.size - a.people.size ||
        yearKey(a.row.year) - yearKey(b.row.year) ||
        a.row.title.localeCompare(b.row.title, undefined, { sensitivity: 'base' }),
    )
    .map((group) => ({
      album: albumSummary(group.row),
      people: [...group.people.entries()]
        .map(([id, person]) => ({
          artist: { id, name: person.name },
          roles: [...person.roles],
        }))
        .sort((a, b) =>
          a.artist.name.localeCompare(b.artist.name, undefined, { sensitivity: 'base' }),
        ),
    }));

  return { albumId, connections };
}

// ---------- routes ----------

/**
 * Mount people routes. The caller adds the `/api` prefix.
 *
 * The third argument is optional injection for tests/offline self-checks; the
 * main server calls `registerPeopleRoutes(r, db)` and shares the MB client.
 */
export function registerPeopleRoutes(app: FastifyInstance, db: Db, deps: PeopleOptions = {}): void {
  ensurePeopleSchema(db);
  const relations = createPeopleRelations(db, deps);

  app.get<{ Querystring: Query }>('/people', async (req) => {
    const q = req.query ?? {};
    return listPeople(db, { role: queryValue(q, 'role'), q: queryValue(q, 'q') });
  });

  app.get<{ Params: { artistId: string } }>('/people/:artistId', async (req, reply) => {
    const page = await getPersonPage(db, req.params.artistId, relations);
    return page ?? reply.code(404).send({ error: 'not found' });
  });

  app.get<{ Params: { id: string } }>('/albums/:id/connections', async (req, reply) => {
    const connections = getAlbumConnections(db, req.params.id);
    return connections ?? reply.code(404).send({ error: 'not found' });
  });
}
