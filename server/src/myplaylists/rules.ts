// Smart-playlist rules: validation + live evaluation.
//
// Rules are stored as JSON on the playlists row and evaluated against tracks
// joined with their albums every time a smart playlist is read, so a rescan,
// play-history or metadata update is reflected immediately.
import type { Db } from '../db/index.js';
import { hasTable } from './schema.js';

export const SMART_FIELDS = [
  'genre',
  'artist',
  'year',
  'format',
  'added',
  'plays',
  'lastPlayed',
  'source',
] as const;

export type SmartField = (typeof SMART_FIELDS)[number];
export type SmartMatch = 'all' | 'any';

export interface SmartRule {
  field: SmartField;
  /** Normalised operator: eq|ne|contains|notContains|startsWith|endsWith|in|between|gt|gte|lt|lte|never|played. */
  op: string;
  value?: unknown;
}

export interface SmartSpec {
  rules: SmartRule[];
  match: SmartMatch;
  /** "field:asc" or "field:desc". */
  sort: string;
  limit?: number;
}

/** 400-class input error raised by the validators and surfaced by the routes. */
export class PlaylistInputError extends Error {}

const TEXT_FIELDS = new Set<SmartField>(['genre', 'artist', 'format', 'source']);
const NUMBER_FIELDS = new Set<SmartField>(['year', 'added', 'plays', 'lastPlayed']);
const TEXT_OPS = new Set(['eq', 'ne', 'contains', 'notContains', 'startsWith', 'endsWith', 'in']);
const NUMBER_OPS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'in']);
const LAST_PLAYED_OPS = new Set([...NUMBER_OPS, 'never', 'played']);

export const SORT_FIELDS = [
  'title',
  'artist',
  'album',
  'year',
  'added',
  'plays',
  'lastPlayed',
  'format',
  'source',
  'duration',
  'disc',
  'number',
] as const;
export type SortField = (typeof SORT_FIELDS)[number];

function normalizeOp(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/[\s_-]+/g, '');
  switch (s) {
    case '=':
    case '==':
    case 'eq':
    case 'is':
      return 'eq';
    case '!=':
    case '<>':
    case 'ne':
    case 'isnot':
      return 'ne';
    case '>':
    case 'gt':
      return 'gt';
    case '>=':
    case 'gte':
      return 'gte';
    case '<':
    case 'lt':
      return 'lt';
    case '<=':
    case 'lte':
      return 'lte';
    case 'contains':
    case 'includes':
      return 'contains';
    case 'notcontains':
    case 'excludes':
      return 'notContains';
    case 'startswith':
    case 'beginswith':
      return 'startsWith';
    case 'endswith':
      return 'endsWith';
    case 'in':
    case 'oneof':
      return 'in';
    case 'between':
      return 'between';
    case 'never':
    case 'notplayed':
      return 'never';
    case 'played':
    case 'ever':
      return 'played';
    default:
      return raw.trim();
  }
}

function toNumber(value: unknown, what: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  throw new PlaylistInputError(`${what} must be a number`);
}

/** Epoch ms from a number or an ISO date string (e.g. "1970-01-01"). */
function toTimestamp(value: unknown, what: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  throw new PlaylistInputError(`${what} must be epoch ms or an ISO date`);
}

function coerceScalar(field: SmartField, value: unknown): string | number | null {
  if (field === 'year') return toNumber(value, 'year value');
  if (field === 'plays') return toNumber(value, 'plays value');
  if (field === 'added') return toTimestamp(value, 'added value');
  if (field === 'lastPlayed') {
    if (value === null) return null;
    return toTimestamp(value, 'lastPlayed value');
  }
  if (typeof value !== 'string') throw new PlaylistInputError(`${field} value must be a string`);
  return value;
}

export function validateSmartRule(input: unknown, index: number): SmartRule {
  if (!input || typeof input !== 'object') {
    throw new PlaylistInputError(`rules[${index}] must be an object`);
  }
  const raw = input as { field?: unknown; op?: unknown; value?: unknown };
  if (typeof raw.field !== 'string' || !(SMART_FIELDS as readonly string[]).includes(raw.field)) {
    throw new PlaylistInputError(
      `rules[${index}].field must be one of ${SMART_FIELDS.join(', ')}`,
    );
  }
  const field = raw.field as SmartField;
  if (typeof raw.op !== 'string' || raw.op.trim() === '') {
    throw new PlaylistInputError(`rules[${index}].op must be a string`);
  }
  const op = normalizeOp(raw.op);
  const allowed =
    field === 'lastPlayed'
      ? LAST_PLAYED_OPS
      : NUMBER_FIELDS.has(field)
        ? NUMBER_OPS
        : TEXT_OPS;
  if (!allowed.has(op)) {
    throw new PlaylistInputError(`rules[${index}].op "${raw.op}" is not valid for ${field}`);
  }

  if (op === 'never' || op === 'played') return { field, op };

  const value = raw.value;
  if (op === 'between') {
    if (!Array.isArray(value) || value.length !== 2) {
      throw new PlaylistInputError(`rules[${index}].value must be [min, max] for between`);
    }
    const [lo, hi] = value as unknown[];
    return { field, op, value: [coerceScalar(field, lo), coerceScalar(field, hi)] };
  }
  if (op === 'in') {
    if (!Array.isArray(value) || value.length === 0) {
      throw new PlaylistInputError(`rules[${index}].value must be a non-empty array for in`);
    }
    return { field, op, value: value.map((v) => coerceScalar(field, v)) };
  }
  return { field, op, value: coerceScalar(field, value) };
}

export function validateSmartSpec(input: unknown): SmartSpec {
  if (!input || typeof input !== 'object') throw new PlaylistInputError('body required');
  const body = input as {
    rules?: unknown;
    match?: unknown;
    sort?: unknown;
    limit?: unknown;
  };
  if (!Array.isArray(body.rules)) throw new PlaylistInputError('rules must be an array');
  const rules = body.rules.map((r, i) => validateSmartRule(r, i));
  const match: SmartMatch =
    body.match === undefined || body.match === null
      ? 'all'
      : body.match === 'all' || body.match === 'any'
        ? body.match
        : (() => {
            throw new PlaylistInputError("match must be 'all' or 'any'");
          })();
  const sort = parseSort(body.sort);
  const limit = parseLimit(body.limit);
  return { rules, match, sort, ...(limit !== undefined ? { limit } : {}) };
}

export function parseSort(input: unknown): string {
  if (input === undefined || input === null || input === '') return 'artist:asc';
  let field: string;
  let dir: 'asc' | 'desc' = 'asc';
  if (typeof input === 'string') {
    let s = input.trim();
    if (s.startsWith('-')) {
      dir = 'desc';
      s = s.slice(1);
    }
    const parts = s.split(/[:\s]+/).filter(Boolean);
    field = parts[0] ?? '';
    if (parts[1] === 'desc') dir = 'desc';
    else if (parts[1] === 'asc') dir = 'asc';
    else if (parts[1] !== undefined) {
      throw new PlaylistInputError(`sort direction must be asc or desc`);
    }
  } else if (typeof input === 'object') {
    const obj = input as { field?: unknown; dir?: unknown; direction?: unknown };
    if (typeof obj.field !== 'string') throw new PlaylistInputError('sort.field must be a string');
    field = obj.field;
    const d = obj.dir ?? obj.direction;
    if (d !== undefined) {
      if (d !== 'asc' && d !== 'desc') throw new PlaylistInputError(`sort direction must be asc or desc`);
      dir = d;
    }
  } else {
    throw new PlaylistInputError('sort must be a string');
  }
  if (!(SORT_FIELDS as readonly string[]).includes(field)) {
    throw new PlaylistInputError(`sort field must be one of ${SORT_FIELDS.join(', ')}`);
  }
  return `${field}:${dir}`;
}

export function parseLimit(input: unknown): number | undefined {
  if (input === undefined || input === null) return undefined;
  const n = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new PlaylistInputError('limit must be a positive integer');
  }
  return Math.min(n, 10_000);
}

// ---------------------------------------------------------------- evaluation

interface Candidate {
  id: string;
  source: string;
  title: string;
  albumId: string;
  albumTitle: string;
  albumArtist: string | null;
  year: number | null;
  genres: string[];
  albumFormat: string | null;
  trackFormat: string | null;
  addedAt: number;
  durationMs: number;
  disc: number;
  number: number;
  artistNames: string[];
  artistIds: string[];
  plays: number;
  lastPlayedAt: number | null;
}

interface CandidateRow {
  id: string;
  source: string;
  title: string;
  disc: number;
  number: number;
  duration_ms: number;
  track_format: string | null;
  album_id: string;
  album_title: string;
  year: number | null;
  genres: string | null;
  album_format: string | null;
  added_at: number;
  album_artist_name: string | null;
}

function parseGenres(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === 'string') : [];
  } catch {
    return [];
  }
}

function loadCandidates(db: Db): Candidate[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.source, t.title, t.disc, t.number, t.duration_ms,
              t.format AS track_format, t.album_id,
              a.title AS album_title, a.year, a.genres, a.format AS album_format,
              a.added_at, ar.name AS album_artist_name
         FROM tracks t
         JOIN albums a ON a.id = t.album_id
         LEFT JOIN artists ar ON ar.id = a.artist_id`,
    )
    .all() as CandidateRow[];

  const artists = new Map<string, { names: string[]; ids: string[] }>();
  for (const row of db
    .prepare(
      `SELECT ta.track_id, ar.id AS artist_id, ar.name
         FROM track_artists ta JOIN artists ar ON ar.id = ta.artist_id
        ORDER BY ta.track_id, ta.position`,
    )
    .all() as { track_id: string; artist_id: string; name: string }[]) {
    let entry = artists.get(row.track_id);
    if (!entry) {
      entry = { names: [], ids: [] };
      artists.set(row.track_id, entry);
    }
    entry.names.push(row.name);
    entry.ids.push(row.artist_id);
  }

  const playStats = new Map<string, { plays: number; lastPlayedAt: number | null }>();
  if (hasTable(db, 'plays')) {
    for (const row of db
      .prepare(
        `SELECT track_id, COUNT(*) AS plays, MAX(started_at) AS last_played_at
           FROM plays GROUP BY track_id`,
      )
      .all() as { track_id: string; plays: number; last_played_at: number | null }[]) {
      playStats.set(row.track_id, { plays: row.plays, lastPlayedAt: row.last_played_at ?? null });
    }
  }

  return rows.map((row) => {
    const performer = artists.get(row.id);
    const stats = playStats.get(row.id);
    return {
      id: row.id,
      source: row.source === 'spotify' ? 'spotify' : 'local',
      title: row.title,
      albumId: row.album_id,
      albumTitle: row.album_title,
      albumArtist: row.album_artist_name,
      year: row.year ?? null,
      genres: parseGenres(row.genres),
      albumFormat: row.album_format,
      trackFormat: row.track_format,
      addedAt: row.added_at,
      durationMs: row.duration_ms,
      disc: row.disc,
      number: row.number,
      artistNames: performer?.names.length ? performer.names : row.album_artist_name ? [row.album_artist_name] : [],
      artistIds: performer?.ids.length ? performer.ids : [],
      plays: stats?.plays ?? 0,
      lastPlayedAt: stats?.lastPlayedAt ?? null,
    };
  });
}

function lower(value: unknown): string {
  return String(value ?? '').toLowerCase();
}

function textValues(c: Candidate, field: SmartField): string[] {
  switch (field) {
    case 'genre':
      return c.genres;
    case 'artist':
      return c.artistNames.length
        ? c.artistNames
        : c.albumArtist
          ? [c.albumArtist]
          : [];
    case 'format':
      return [c.albumFormat ?? c.trackFormat ?? ''];
    case 'source':
      return [c.source];
    default:
      return [];
  }
}

function matchesText(c: Candidate, rule: SmartRule): boolean {
  const actual = textValues(c, rule.field).filter((v) => v !== '');
  const values = Array.isArray(rule.value) ? rule.value : [rule.value];
  const wanted = values.map(lower);
  const op = rule.op;

  // Artist rules may target a stable id ("ar:...") instead of a display name.
  if (rule.field === 'artist' && typeof rule.value === 'string' && rule.value.startsWith('ar:')) {
    if (op === 'eq') return c.artistIds.includes(rule.value);
    if (op === 'ne') return !c.artistIds.includes(rule.value);
    if (op === 'in') return values.some((v) => typeof v === 'string' && c.artistIds.includes(v));
    return false;
  }

  switch (op) {
    case 'eq':
      return actual.some((v) => wanted.includes(lower(v)));
    case 'ne':
      return !actual.some((v) => wanted.includes(lower(v)));
    case 'contains':
      return actual.some((v) => wanted.some((w) => lower(v).includes(w)));
    case 'notContains':
      return !actual.some((v) => wanted.some((w) => lower(v).includes(w)));
    case 'startsWith':
      return actual.some((v) => wanted.some((w) => lower(v).startsWith(w)));
    case 'endsWith':
      return actual.some((v) => wanted.some((w) => lower(v).endsWith(w)));
    case 'in':
      return actual.some((v) => wanted.includes(lower(v)));
    default:
      return false;
  }
}

function numericValue(c: Candidate, field: SmartField): number | null {
  switch (field) {
    case 'year':
      return c.year;
    case 'added':
      return c.addedAt;
    case 'plays':
      return c.plays;
    case 'lastPlayed':
      return c.lastPlayedAt;
    default:
      return null;
  }
}

function matchesNumber(c: Candidate, rule: SmartRule): boolean {
  if (rule.op === 'never') return c.lastPlayedAt === null;
  if (rule.op === 'played') return c.lastPlayedAt !== null;

  const actual = numericValue(c, rule.field);
  if (rule.op === 'in') {
    if (actual === null) return false;
    const values = Array.isArray(rule.value) ? rule.value : [];
    return values.some((v) => typeof v === 'number' && v === actual);
  }
  if (rule.op === 'between') {
    if (actual === null) return false;
    const pair = Array.isArray(rule.value) ? rule.value : [];
    const lo = pair[0];
    const hi = pair[1];
    if (typeof lo !== 'number' || typeof hi !== 'number') return false;
    return actual >= lo && actual <= hi;
  }
  if (rule.op === 'eq' || rule.op === 'ne') {
    if (rule.value === null) {
      if (rule.field !== 'lastPlayed') return false;
      return rule.op === 'eq' ? actual === null : actual !== null;
    }
    if (actual === null) return false;
    const wanted = typeof rule.value === 'number' ? rule.value : NaN;
    return rule.op === 'eq' ? actual === wanted : actual !== wanted;
  }
  if (actual === null || typeof rule.value !== 'number') return false;
  switch (rule.op) {
    case 'gt':
      return actual > rule.value;
    case 'gte':
      return actual >= rule.value;
    case 'lt':
      return actual < rule.value;
    case 'lte':
      return actual <= rule.value;
    default:
      return false;
  }
}

export function ruleMatches(c: Candidate, rule: SmartRule): boolean {
  return TEXT_FIELDS.has(rule.field) ? matchesText(c, rule) : matchesNumber(c, rule);
}

function sortValue(c: Candidate, field: SortField): string | number {
  switch (field) {
    case 'title':
      return lower(c.title);
    case 'artist':
      return lower(c.artistNames[0] ?? c.albumArtist ?? '');
    case 'album':
      return lower(c.albumTitle);
    case 'year':
      return c.year ?? -1;
    case 'added':
      return c.addedAt;
    case 'plays':
      return c.plays;
    case 'lastPlayed':
      return c.lastPlayedAt ?? 0;
    case 'format':
      return lower(c.albumFormat ?? c.trackFormat ?? '');
    case 'source':
      return c.source;
    case 'duration':
      return c.durationMs;
    case 'disc':
      return c.disc;
    case 'number':
      return c.number;
  }
}

function compare(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function sortCandidates(rows: Candidate[], sort: string): Candidate[] {
  const [fieldRaw = 'artist', dirRaw = 'asc'] = sort.split(':');
  const field = (SORT_FIELDS as readonly string[]).includes(fieldRaw)
    ? (fieldRaw as SortField)
    : 'artist';
  const sign = dirRaw === 'desc' ? -1 : 1;
  return rows.slice().sort((a, b) => {
    const primary = compare(sortValue(a, field), sortValue(b, field)) * sign;
    if (primary !== 0) return primary;
    // Deterministic tie-breakers keep live evaluation stable between requests.
    return (
      compare(lower(a.albumTitle), lower(b.albumTitle)) ||
      a.disc - b.disc ||
      a.number - b.number ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
  });
}

/** Evaluate a smart spec against the whole track table, live. */
export function evaluateSmartSpec(db: Db, spec: SmartSpec): string[] {
  let rows = loadCandidates(db);
  if (spec.rules.length > 0) {
    rows = rows.filter((c) =>
      spec.match === 'any'
        ? spec.rules.some((rule) => ruleMatches(c, rule))
        : spec.rules.every((rule) => ruleMatches(c, rule)),
    );
  }
  rows = sortCandidates(rows, spec.sort);
  if (spec.limit !== undefined) rows = rows.slice(0, spec.limit);
  return rows.map((c) => c.id);
}
