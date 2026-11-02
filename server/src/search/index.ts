// Worker T — better search for rune.
//
//   const search = createSearch(db);
//   search.search('daft pnk discovery') -> { albums, artists, tracks, top }
//   search.reindex() / search.reindex(ids) / search.rebuildAll()
//   registerSearchRoutes(app, search) adds GET /search2?q=&source=&limit=
//
// Design
//  * search_docs holds every searchable entity with pre-folded fields (title,
//    artist, album, credits, genre) and a source signature.
//  * search_word (unicode61, prefix 2-4) gives exact/prefix recall.
//  * search_terms is a vocabulary used to correct a typo token before the word
//    query ("pnk" -> "punk", "pumpkns" -> "pumpkins"), keeping candidates small.
//  * search_tri (trigram) gives substring recall, including "acdc" against
//    "ac dc"; its hits are re-ranked in JS by edit distance in scoreDoc().
//  * Ranking is field/quality based (exact > prefix > substring > fuzzy; title >
//    artist > track title > credits > genre), plus a play-count boost when the
//    plays table exists.
//  * Maintenance never touches base tables: reindex(ids?) rewrites only the
//    affected docs; no-argument reindex() sweeps for changed/deleted rows.
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { AlbumSummary, ArtistRef, Track } from '@liner/shared';
import type { Db } from '../db/index.js';
import { ensureSpotifyLibrarySchema } from '../spotify/library-schema.js';
import { loadTrack } from '../play/rows.js';
import { coverUrl, publicTrack } from '../api/library.js';
import {
  compact,
  editDistance,
  fold,
  ftsPhrase,
  ftsPrefix,
  maxEditDistance,
  trigrams,
  withoutThe,
} from './fold.js';

// ---------------------------------------------------------------- types

export type SearchKind = 'album' | 'artist' | 'track';

export interface SearchOptions {
  /** Per-section default (albums 12, artists 8, tracks 12). */
  limit?: number;
  albumLimit?: number;
  artistLimit?: number;
  trackLimit?: number;
  source?: 'local' | 'spotify' | 'all';
}

export type SearchTopResult =
  | { kind: 'album'; album: AlbumSummary }
  | { kind: 'artist'; artist: ArtistRef }
  | { kind: 'track'; track: Track };

/** Same shape as GET /api/search plus `top`. */
export interface SearchResponse {
  albums: AlbumSummary[];
  artists: ArtistRef[];
  tracks: Track[];
  top: SearchTopResult | null;
}

export interface SearchIdSet {
  albums?: string[];
  artists?: string[];
  tracks?: string[];
}

export interface ReindexResult {
  indexed: number;
  removed: number;
}

export interface Search {
  search(q: string, opts?: SearchOptions): SearchResponse;
  /** Rewrite docs for these ids and their dependants. Omit ids to sweep the
   *  library for rows whose signature changed (incremental on writes). */
  reindex(ids?: string[] | SearchIdSet): ReindexResult;
  /** Drop and rebuild every index row (one transaction). */
  rebuildAll(): ReindexResult;
}

// ---------------------------------------------------------------- schema

const migrationSql = readFileSync(new URL('../db/migrations-search.sql', import.meta.url), 'utf8');
// Strip -- comments before splitting: prose in the migration contains semicolons.
const migrationStatements = migrationSql
  .replace(/--[^\n]*/g, '')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);
const schemaApplied = new WeakSet<Db>();

/** Idempotently create the search schema. Safe to call many times. */
export function ensureSearchSchema(db: Db): void {
  ensureSpotifyLibrarySchema(db);
  if (schemaApplied.has(db)) return;
  for (const sql of migrationStatements) db.exec(sql);
  schemaApplied.add(db);
}

// ---------------------------------------------------------------- doc model

interface Doc {
  kind: SearchKind;
  refId: string;
  albumId: string | null;
  source: 'local' | 'spotify';
  title: string;
  artist: string;
  album: string;
  credits: string;
  genre: string;
  sig: string;
}

interface DocRow {
  kind: SearchKind;
  ref_id: string;
  album_id: string | null;
  source: string;
  title: string;
  artist: string;
  album: string;
  credits: string;
  genre: string;
  sig: string;
}

interface AlbumRow {
  id: string;
  title: string;
  source: string;
  artist_id: string;
  artist_name: string | null;
  genres: string;
}

interface TrackRow {
  id: string;
  album_id: string;
  title: string;
  album_source: string;
  album_title: string;
  album_artist_name: string | null;
  genres: string;
}

interface ArtistRow {
  id: string;
  name: string;
}

interface Scope {
  /** undefined = every eligible row; a Set restricts (possibly to nothing). */
  albumIds?: Set<string>;
  trackIds?: Set<string>;
  artistIds?: Set<string>;
}

function sourceOf(v: string): 'local' | 'spotify' {
  return v === 'spotify' ? 'spotify' : 'local';
}

function genresText(json: string | null | undefined): string {
  if (!json) return '';
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return '';
    return fold(v.filter((x): x is string => typeof x === 'string').join(' '));
  } catch {
    return '';
  }
}

/** Combined text written to both FTS tables. Compact forms make punctuation /
 *  space-insensitive matches ("acdc") available to the trigram index. */
function docText(d: Doc): string {
  return [
    d.title,
    d.artist,
    d.album,
    d.credits,
    d.genre,
    compact(d.title),
    compact(d.artist),
    compact(d.credits),
    compact(d.genre),
  ]
    .filter(Boolean)
    .join(' ');
}

function chunk<T>(items: T[], size = 400): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(',');
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

// ---------------------------------------------------------------- build docs

/** Build (but do not write) docs for the given scope. Rows are only eligible
 *  when their album is in the user's library (in_library = 1), matching search(). */
function buildDocs(db: Db, scope: Scope = {}): Doc[] {
  const docs: Doc[] = [];
  const albumRows: AlbumRow[] = [];
  const trackRows: TrackRow[] = [];
  const artists: ArtistRow[] = [];

  // ---- albums in the library
  const albumBase = `
    SELECT a.id, a.title, a.source, a.artist_id, a.genres, ar.name AS artist_name
    FROM albums a LEFT JOIN artists ar ON ar.id = a.artist_id
    WHERE a.in_library = 1`;
  if (scope.albumIds === undefined) {
    albumRows.push(...(db.prepare(albumBase).all() as AlbumRow[]));
  } else {
    for (const part of chunk([...scope.albumIds])) {
      if (part.length === 0) continue;
      albumRows.push(
        ...(db.prepare(`${albumBase} AND a.id IN (${placeholders(part.length)})`).all(...part) as AlbumRow[]),
      );
    }
  }

  // ---- tracks, constrained by explicit ids and/or album ids
  const trackBase = `
    SELECT t.id, t.album_id, t.title, a.source AS album_source, a.title AS album_title,
           ar.name AS album_artist_name, a.genres
    FROM tracks t
    JOIN albums a ON a.id = t.album_id
    LEFT JOIN artists ar ON ar.id = a.artist_id
    WHERE a.in_library = 1`;
  const seenTracks = new Set<string>();
  const addTracks = (rows: TrackRow[]): void => {
    for (const r of rows) {
      if (seenTracks.has(r.id)) continue;
      seenTracks.add(r.id);
      trackRows.push(r);
    }
  };
  if (scope.trackIds !== undefined) {
    for (const part of chunk([...scope.trackIds])) {
      if (part.length === 0) continue;
      addTracks(
        db.prepare(`${trackBase} AND t.id IN (${placeholders(part.length)})`).all(...part) as TrackRow[],
      );
    }
  }
  if (scope.albumIds !== undefined) {
    for (const part of chunk([...scope.albumIds])) {
      if (part.length === 0) continue;
      addTracks(
        db.prepare(`${trackBase} AND t.album_id IN (${placeholders(part.length)})`).all(...part) as TrackRow[],
      );
    }
  }
  if (scope.trackIds === undefined && scope.albumIds === undefined) {
    addTracks(db.prepare(trackBase).all() as TrackRow[]);
  }

  // ---- artist docs (only artists that own a library album)
  const ownArtist = (ids: string[]): ArtistRow[] => {
    const out: ArtistRow[] = [];
    for (const part of chunk([...new Set(ids)])) {
      if (!part.length) continue;
      out.push(
        ...(db
          .prepare(
            `SELECT ar.id, ar.name FROM artists ar
             WHERE ar.id IN (${placeholders(part.length)})
               AND EXISTS (SELECT 1 FROM albums a WHERE a.artist_id = ar.id AND a.in_library = 1)`,
          )
          .all(...part) as ArtistRow[]),
      );
    }
    return out;
  };
  if (scope.artistIds === undefined && scope.albumIds === undefined) {
    artists.push(
      ...(db
        .prepare(
          `SELECT DISTINCT ar.id, ar.name FROM artists ar
           JOIN albums a ON a.artist_id = ar.id AND a.in_library = 1`,
        )
        .all() as ArtistRow[]),
    );
  } else {
    const ids = new Set<string>(scope.artistIds ?? []);
    for (const a of albumRows) ids.add(a.artist_id);
    artists.push(...ownArtist([...ids]));
  }

  // ---- credits and track artists (scoped by the rows above)
  const credits = new Map<string, string>();
  const creditBase = `
    SELECT album_id, group_concat(name, ' ') AS names FROM (
      SELECT DISTINCT c.album_id AS album_id, ar.name AS name
      FROM credits c JOIN artists ar ON ar.id = c.artist_id`;
  const readCredits = (sql: string, args: string[]): void => {
    for (const r of db.prepare(sql).all(...args) as { album_id: string; names: string }[]) {
      credits.set(r.album_id, r.names);
    }
  };
  if (scope.albumIds === undefined) {
    readCredits(`${creditBase}) GROUP BY album_id`, []);
  } else {
    for (const part of chunk([...scope.albumIds])) {
      if (!part.length) continue;
      readCredits(
        `${creditBase} WHERE c.album_id IN (${placeholders(part.length)}) ) GROUP BY album_id`,
        part,
      );
    }
  }

  const trackArtists = new Map<string, string>();
  const taBase = `
    SELECT track_id, group_concat(name, ' ') AS names FROM (
      SELECT DISTINCT ta.track_id AS track_id, ar.name AS name
      FROM track_artists ta JOIN artists ar ON ar.id = ta.artist_id`;
  const readTrackArtists = (sql: string, args: string[]): void => {
    for (const r of db.prepare(sql).all(...args) as { track_id: string; names: string }[]) {
      trackArtists.set(r.track_id, r.names);
    }
  };
  if (scope.trackIds === undefined && scope.albumIds === undefined) {
    readTrackArtists(`${taBase}) GROUP BY track_id`, []);
  } else {
    const ids = new Set<string>();
    for (const id of scope.trackIds ?? []) ids.add(id);
    for (const t of trackRows) ids.add(t.id);
    for (const part of chunk([...ids])) {
      if (!part.length) continue;
      readTrackArtists(
        `${taBase} WHERE ta.track_id IN (${placeholders(part.length)}) ) GROUP BY track_id`,
        part,
      );
    }
  }

  // ---- assemble
  for (const a of albumRows) {
    const credit = credits.get(a.id) ?? '';
    docs.push({
      kind: 'album',
      refId: a.id,
      albumId: a.id,
      source: sourceOf(a.source),
      title: fold(a.title),
      artist: fold(a.artist_name ?? ''),
      album: '',
      credits: fold(credit),
      genre: genresText(a.genres),
      sig: JSON.stringify(['a1', a.title, a.source, a.artist_name ?? '', a.genres ?? '', credit]),
    });
  }
  for (const t of trackRows) {
    const credit = credits.get(t.album_id) ?? '';
    const performers = trackArtists.get(t.id) ?? '';
    const artist = performers || t.album_artist_name || '';
    docs.push({
      kind: 'track',
      refId: t.id,
      albumId: t.album_id,
      source: sourceOf(t.album_source),
      title: fold(t.title),
      artist: fold(artist),
      album: fold(t.album_title),
      credits: fold(credit),
      genre: genresText(t.genres),
      sig: JSON.stringify(['t1', t.title, t.album_source, t.album_id, t.album_title, artist, t.genres ?? '', credit]),
    });
  }
  for (const a of artists) {
    docs.push({
      kind: 'artist',
      refId: a.id,
      albumId: null,
      source: 'local',
      title: fold(a.name),
      artist: '',
      album: '',
      credits: '',
      genre: '',
      sig: JSON.stringify(['r1', a.name]),
    });
  }
  return docs;
}

// ---------------------------------------------------------------- ranking

const WEIGHTS: Record<
  SearchKind,
  { title: number; artist: number; album: number; credits: number; genre: number }
> = {
  album: { title: 1.0, artist: 0.92, album: 0, credits: 0.45, genre: 0.22 },
  artist: { title: 1.0, artist: 0, album: 0, credits: 0.25, genre: 0 },
  track: { title: 0.72, artist: 0.65, album: 0.55, credits: 0.35, genre: 0.15 },
};

interface Field {
  key: 'title' | 'artist' | 'album' | 'credits' | 'genre';
  weight: number;
  tokens: string[];
  compact: string;
  text: string;
}

function fieldsOf(doc: DocRow): Field[] {
  const w = WEIGHTS[doc.kind];
  const raw: [Field['key'], string][] = [
    ['title', doc.title],
    ['artist', doc.artist],
    ['album', doc.album],
    ['credits', doc.credits],
    ['genre', doc.genre],
  ];
  const out: Field[] = [];
  for (const [key, text] of raw) {
    if (!text || w[key] <= 0) continue;
    out.push({
      key,
      weight: w[key],
      tokens: text.split(' ').filter(Boolean),
      compact: compact(text),
      text,
    });
  }
  return out;
}

/** Best match quality of one query token in one field: exact 1, token prefix
 *  0.85, substring of the compact field 0.7, fuzzy similarity*0.55. */
function matchQuality(token: string, field: Field): number {
  const list = field.tokens;
  for (let i = 0; i < list.length; i++) if (list[i] === token) return 1;
  if (token.length >= 2) {
    for (let i = 0; i < list.length; i++) if (list[i]!.startsWith(token)) return 0.85;
  }
  if (token.length >= 3 && field.compact.includes(token)) return 0.7;
  const max = maxEditDistance(token.length);
  let best = 0;
  for (let i = 0; i < list.length; i++) {
    const t = list[i]!;
    if (Math.abs(t.length - token.length) > max) continue;
    const d = editDistance(token, t, max);
    if (d <= max) {
      const sim = 1 - d / Math.max(token.length, t.length);
      if (sim > best) best = sim;
    }
  }
  return best >= 0.6 ? best * 0.55 : 0;
}

function phraseHit(fieldText: string, qFolded: string): 'exact' | 'prefix' | 'phrase' | null {
  if (!fieldText) return null;
  if (fieldText === qFolded || withoutThe(fieldText) === withoutThe(qFolded)) return 'exact';
  if (fieldText.startsWith(`${qFolded} `)) return 'prefix';
  if (` ${fieldText} `.includes(` ${qFolded} `)) return 'phrase';
  return null;
}

interface Scored {
  doc: DocRow;
  score: number;
}

function scoreDoc(doc: DocRow, qTokens: string[], qFolded: string, plays: number): Scored | null {
  const fields = fieldsOf(doc);
  if (fields.length === 0) return null;
  let score = 0;
  const matchedTokens = new Set<number>();
  let titleMatched = 0;
  let title: Field | undefined;
  let artist: Field | undefined;
  for (const f of fields) {
    if (f.key === 'title') title = f;
    if (f.key === 'artist') artist = f;
    let sum = 0;
    let matched = 0;
    for (let i = 0; i < qTokens.length; i++) {
      const q = matchQuality(qTokens[i]!, f);
      if (q > 0) {
        sum += q;
        matched++;
        matchedTokens.add(i);
      }
    }
    if (matched === 0) continue;
    score += f.weight * (sum / qTokens.length) * (matched / qTokens.length);
    if (f.key === 'title') titleMatched = matched;
  }
  const coverage = matchedTokens.size / qTokens.length;
  // Every query token must match somewhere (the old FTS query ANDed words too).
  // The fuzzy candidate funnel is deliberately wider than this, so partial
  // matches would otherwise drown the real results in noise.
  if (coverage < 1) return null;
  score *= 0.6 + 0.4 * coverage;
  if (qTokens.length > 1 && coverage === 1) score *= 1.15;

  const titleWeight = WEIGHTS[doc.kind].title;
  const tHit = title ? phraseHit(title.text, qFolded) : null;
  if (tHit === 'exact') score += 4 * titleWeight;
  else if (tHit === 'prefix') score += 2 * titleWeight;
  else if (tHit === 'phrase') score += 1 * titleWeight;
  if (artist) {
    const aHit = phraseHit(artist.text, qFolded);
    if (aHit === 'exact') score += 2;
    else if (aHit === 'prefix') score += 1;
  }
  if (title && qTokens.length > 1 && titleMatched === qTokens.length) score *= 1.25;
  if (plays > 0) score *= 1 + 0.12 * Math.log1p(plays);
  return { doc, score };
}

// ---------------------------------------------------------------- createSearch

const DOC_COLUMNS =
  'kind, ref_id, album_id, source, title, artist, album, credits, genre, sig';

export function createSearch(db: Db): Search {
  ensureSearchSchema(db);

  const delDoc = db.prepare('DELETE FROM search_docs WHERE kind = ? AND ref_id = ?');
  const delWord = db.prepare('DELETE FROM search_word WHERE kind = ? AND ref_id = ?');
  const delTri = db.prepare('DELETE FROM search_tri WHERE kind = ? AND ref_id = ?');
  const getSig = db.prepare('SELECT sig FROM search_docs WHERE kind = ? AND ref_id = ?');
  const insDoc = db.prepare(
    `INSERT INTO search_docs (kind, ref_id, album_id, source, title, artist, album, credits, genre, sig)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insWord = db.prepare('INSERT INTO search_word (kind, ref_id, text) VALUES (?, ?, ?)');
  const insTri = db.prepare('INSERT INTO search_tri (kind, ref_id, text) VALUES (?, ?, ?)');
  const insTerm = db.prepare('INSERT OR IGNORE INTO search_terms (term) VALUES (?)');
  const exactTerm = db.prepare('SELECT 1 FROM search_terms WHERE term = ? LIMIT 1');
  const vocabRange = db.prepare(
    `SELECT term FROM search_terms
     WHERE term >= ? AND term < ? AND length(term) BETWEEN ? AND ?
     LIMIT 2000`,
  );

  const termCache = new Map<string, string[]>();

  function addTerms(d: Doc): void {
    for (const raw of [d.title, d.artist, d.album, d.credits, d.genre]) {
      if (!raw) continue;
      const seen = new Set<string>();
      for (const t of raw.split(' ')) {
        if (!t || t.length > 40 || seen.has(t)) continue;
        seen.add(t);
        insTerm.run(t);
        termCache.delete(t);
      }
    }
  }

  function deleteDoc(kind: SearchKind, refId: string): boolean {
    const r = delDoc.run(kind, refId);
    if (r.changes === 0) return false;
    delWord.run(kind, refId);
    delTri.run(kind, refId);
    return true;
  }

  function writeDoc(d: Doc, force = false): boolean {
    if (!force) {
      const row = getSig.get(d.kind, d.refId) as { sig: string } | undefined;
      if (row && row.sig === d.sig) return false;
    }
    deleteDoc(d.kind, d.refId);
    insDoc.run(d.kind, d.refId, d.albumId, d.source, d.title, d.artist, d.album, d.credits, d.genre, d.sig);
    const text = docText(d);
    insWord.run(d.kind, d.refId, text);
    insTri.run(d.kind, d.refId, text);
    addTerms(d);
    return true;
  }

  /** Write docs and delete any previously indexed doc inside the scope that the
   *  builder no longer produced (deleted / no longer in the library). */
  function applyDocs(docs: Doc[], scope: Scope): ReindexResult {
    const built = new Set(docs.map((d) => `${d.kind}\u0000${d.refId}`));
    let indexed = 0;
    let removed = 0;
    const tx = db.transaction(() => {
      for (const d of docs) if (writeDoc(d)) indexed++;
      const wipe = (kind: SearchKind, ids: Set<string> | undefined): void => {
        for (const id of ids ?? []) {
          if (!built.has(`${kind}\u0000${id}`) && deleteDoc(kind, id)) removed++;
        }
      };
      // A deleted album cascades its base track rows but not our track docs.
      for (const id of scope.albumIds ?? []) {
        if (built.has(`album\u0000${id}`)) continue;
        const orphans = db
          .prepare("SELECT ref_id FROM search_docs WHERE kind = 'track' AND album_id = ?")
          .all(id) as { ref_id: string }[];
        for (const o of orphans) if (deleteDoc('track', o.ref_id)) removed++;
      }
      wipe('album', scope.albumIds);
      wipe('track', scope.trackIds);
      wipe('artist', scope.artistIds);
    });
    tx();
    return { indexed, removed };
  }

  function sweep(): ReindexResult {
    const docs = buildDocs(db, {});
    const keep = new Set(docs.map((d) => `${d.kind}\u0000${d.refId}`));
    let indexed = 0;
    let removed = 0;
    const existing = db.prepare('SELECT kind, ref_id FROM search_docs').all() as {
      kind: SearchKind;
      ref_id: string;
    }[];
    const tx = db.transaction(() => {
      for (const d of docs) if (writeDoc(d)) indexed++;
      for (const row of existing) {
        if (keep.has(`${row.kind}\u0000${row.ref_id}`)) continue;
        if (deleteDoc(row.kind, row.ref_id)) removed++;
      }
    });
    tx();
    return { indexed, removed };
  }

  function rebuildAll(): ReindexResult {
    let indexed = 0;
    const tx = db.transaction(() => {
      db.exec('DELETE FROM search_docs');
      db.exec('DELETE FROM search_word');
      db.exec('DELETE FROM search_tri');
      db.exec('DELETE FROM search_terms');
      termCache.clear();
      for (const d of buildDocs(db, {})) {
        writeDoc(d, true);
        indexed++;
      }
    });
    tx();
    return { indexed, removed: 0 };
  }

  /** Expand caller ids into an album-centric scope: album docs embed artist and
   *  credit names, track docs embed album/credit names, so a change to any of
   *  those entities touches whole albums. */
  function expand(ids?: string[] | SearchIdSet): Scope | null {
    if (!ids) return null;
    const albumIds = new Set<string>();
    const trackIds = new Set<string>();
    const artistIds = new Set<string>();

    const handleAlbum = (id: string): void => {
      albumIds.add(id);
      for (const t of db.prepare('SELECT id FROM tracks WHERE album_id = ?').all(id) as { id: string }[]) {
        trackIds.add(t.id);
      }
      for (const r of db
        .prepare(
          `SELECT DISTINCT ar.id FROM artists ar
           WHERE ar.id = (SELECT artist_id FROM albums WHERE id = ?)
              OR ar.id IN (SELECT artist_id FROM credits WHERE album_id = ?)
              OR ar.id IN (
                SELECT ta.artist_id FROM track_artists ta
                JOIN tracks t ON t.id = ta.track_id WHERE t.album_id = ?)`,
        )
        .all(id, id, id) as { id: string }[]) {
        artistIds.add(r.id);
      }
    };
    const handleTrack = (id: string): void => {
      trackIds.add(id);
      const row = db.prepare('SELECT album_id FROM tracks WHERE id = ?').get(id) as
        | { album_id: string }
        | undefined;
      if (row) handleAlbum(row.album_id);
      for (const r of db.prepare('SELECT artist_id FROM track_artists WHERE track_id = ?').all(id) as {
        artist_id: string;
      }[]) {
        artistIds.add(r.artist_id);
      }
    };
    const handleArtist = (id: string): void => {
      artistIds.add(id);
      for (const r of db
        .prepare(
          `SELECT DISTINCT a.id FROM albums a
           WHERE a.artist_id = ?
              OR a.id IN (SELECT album_id FROM credits WHERE artist_id = ?)
              OR a.id IN (
                SELECT t.album_id FROM track_artists ta
                JOIN tracks t ON t.id = ta.track_id WHERE ta.artist_id = ?)`,
        )
        .all(id, id, id) as { id: string }[]) {
        handleAlbum(r.id);
      }
    };

    if (Array.isArray(ids)) {
      for (const id of ids) {
        if (db.prepare('SELECT 1 FROM albums WHERE id = ?').get(id)) handleAlbum(id);
        else if (db.prepare('SELECT 1 FROM tracks WHERE id = ?').get(id)) handleTrack(id);
        else if (db.prepare('SELECT 1 FROM artists WHERE id = ?').get(id)) handleArtist(id);
        else {
          // Unknown id (deleted row): a doc may still exist under any kind.
          albumIds.add(id);
          trackIds.add(id);
          artistIds.add(id);
        }
      }
    } else {
      for (const id of ids.albums ?? []) handleAlbum(id);
      for (const id of ids.tracks ?? []) handleTrack(id);
      for (const id of ids.artists ?? []) handleArtist(id);
    }
    return { albumIds, trackIds, artistIds };
  }

  function reindex(ids?: string[] | SearchIdSet): ReindexResult {
    const scope = expand(ids);
    if (!scope) return sweep();
    return applyDocs(buildDocs(db, scope), scope);
  }

  // startup: full rebuild only when there is nothing indexed yet
  const docsCount = (db.prepare('SELECT count(*) AS n FROM search_docs').get() as { n: number }).n;
  if (docsCount === 0) rebuildAll();

  // ---- query plumbing

  const wordSearch = db.prepare(
    'SELECT kind, ref_id FROM search_word WHERE search_word MATCH ? ORDER BY rank LIMIT ?',
  );
  const triSearch = db.prepare(
    'SELECT kind, ref_id FROM search_tri WHERE search_tri MATCH ? ORDER BY rank LIMIT ?',
  );
  const hasOwnAlbum = db.prepare(
    'SELECT 1 FROM albums WHERE artist_id = ? AND in_library = 1 LIMIT 1',
  );
  const playsExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'plays'");

  function runIn(sqlTemplate: string, ids: string[]): { id: string; n: number }[] {
    const out: { id: string; n: number }[] = [];
    for (const part of chunk(ids)) {
      if (!part.length) continue;
      const sql = sqlTemplate.replace('%IDS%', placeholders(part.length));
      out.push(...(db.prepare(sql).all(...part) as { id: string; n: number }[]));
    }
    return out;
  }

  function playCounts(rows: DocRow[]): Map<string, number> {
    const counts = new Map<string, number>();
    if (!playsExists.get()) return counts;
    const albums = rows.filter((r) => r.kind === 'album').map((r) => r.ref_id);
    const tracks = rows.filter((r) => r.kind === 'track').map((r) => r.ref_id);
    const artists = rows.filter((r) => r.kind === 'artist').map((r) => r.ref_id);
    for (const r of runIn(
      'SELECT album_id AS id, count(*) AS n FROM plays WHERE album_id IN (%IDS%) GROUP BY album_id',
      albums,
    )) {
      counts.set(`album\u0000${r.id}`, r.n);
    }
    for (const r of runIn(
      'SELECT track_id AS id, count(*) AS n FROM plays WHERE track_id IN (%IDS%) GROUP BY track_id',
      tracks,
    )) {
      counts.set(`track\u0000${r.id}`, r.n);
    }
    for (const r of runIn(
      `SELECT a.artist_id AS id, count(*) AS n FROM plays p
       JOIN albums a ON a.id = p.album_id
       WHERE a.artist_id IN (%IDS%) GROUP BY a.artist_id`,
      artists,
    )) {
      counts.set(`artist\u0000${r.id}`, r.n);
    }
    return counts;
  }

  function docsByRefs(refs: { kind: SearchKind; ref_id: string }[]): DocRow[] {
    const ids = [...new Set(refs.map((r) => r.ref_id))];
    const out: DocRow[] = [];
    for (const part of chunk(ids)) {
      if (!part.length) continue;
      out.push(
        ...(db
          .prepare(`SELECT ${DOC_COLUMNS} FROM search_docs WHERE ref_id IN (${placeholders(part.length)})`)
          .all(...part) as DocRow[]),
      );
    }
    return out;
  }

  function docsByIds(ids: string[]): DocRow[] {
    return docsByRefs(ids.map((id) => ({ kind: 'album', ref_id: id })));
  }

  /** Token typo correction candidates (original first), backed by the vocab. */
  function alternatives(token: string): string[] {
    const cached = termCache.get(token);
    if (cached) return cached;
    let out: string[];
    if (exactTerm.get(token)) {
      out = [token];
    } else {
      const max = maxEditDistance(token.length);
      const anchorLen =
        token.length <= 4 ? 1 : Math.max(2, Math.min(4, token.length - max * 2));
      const anchor = token.slice(0, anchorLen);
      const upper = `${anchor}\u{10FFFF}`;
      const rows = vocabRange.all(
        anchor,
        upper,
        token.length - max,
        token.length + max,
      ) as { term: string }[];
      const scored: { term: string; d: number }[] = [];
      for (const r of rows) {
        const d = editDistance(token, r.term, max);
        if (d <= max) scored.push({ term: r.term, d });
      }
      scored.sort(
        (a, b) => a.d - b.d || a.term.length - b.term.length || (a.term < b.term ? -1 : 1),
      );
      out = [token];
      for (const s of scored) {
        if (out.length >= 3) break;
        if (!out.includes(s.term)) out.push(s.term);
      }
    }
    if (termCache.size > 10_000) termCache.clear();
    termCache.set(token, out);
    return out;
  }

  function candidates(qTokens: string[]): { kind: SearchKind; ref_id: string }[] {
    const out = new Map<string, { kind: SearchKind; ref_id: string }>();
    const add = (rows: { kind: SearchKind; ref_id: string }[]): void => {
      for (const r of rows) out.set(`${r.kind}\u0000${r.ref_id}`, r);
    };
    const trySearch = (
      stmt: typeof wordSearch,
      expr: string | null,
      limit: number,
    ): { kind: SearchKind; ref_id: string }[] => {
      if (!expr) return [];
      try {
        return stmt.all(expr, limit) as { kind: SearchKind; ref_id: string }[];
      } catch {
        return [];
      }
    };

    // 1. corrected prefix query: every query token, with typo alternatives
    const groups = qTokens.map((t) => {
      const alts = alternatives(t).map(ftsPrefix);
      return `(${alts.join(' OR ')})`;
    });
    const wordHits = trySearch(wordSearch, groups.join(' AND '), 400);
    add(wordHits);

    // 2. trigram recall (substring / first-character typos). AND when every
    //    token has grams; the OR fallback rescues one badly-typed token.
    const clauses = qTokens
      .filter((t) => t.length >= 3)
      .map((t) => `(${trigrams(t).slice(0, 24).map(ftsPhrase).join(' OR ')})`)
      .filter((c) => c !== '()');
    if (clauses.length > 0) {
      const triHits = trySearch(triSearch, clauses.join(' AND '), 300);
      add(triHits);
      if (wordHits.length < 60 || triHits.length < 20) {
        add(trySearch(triSearch, clauses.join(' OR '), 200));
      }
    }
    return [...out.values()];
  }

  // ---- result assembly

  function albumItems(ids: string[]): Map<string, AlbumSummary> {
    const map = new Map<string, AlbumSummary>();
    for (const part of chunk(ids)) {
      if (!part.length) continue;
      const rows = db
        .prepare(
          `SELECT a.id, a.source, a.title, a.artist_id, ar.name AS artist_name, a.year,
                  a.format, a.cover_path, a.added_at
           FROM albums a LEFT JOIN artists ar ON ar.id = a.artist_id
           WHERE a.id IN (${placeholders(part.length)})`,
        )
        .all(...part) as {
        id: string;
        source: string;
        title: string;
        artist_id: string;
        artist_name: string | null;
        year: number | null;
        format: string | null;
        cover_path: string | null;
        added_at: number;
      }[];
      for (const r of rows) {
        map.set(r.id, {
          id: r.id,
          source: sourceOf(r.source),
          title: r.title,
          artist: { id: r.artist_id, name: r.artist_name ?? 'Unknown Artist' },
          ...(r.year ? { year: r.year } : {}),
          ...(r.cover_path ? { coverUrl: coverUrl(r.id) } : {}),
          ...(r.format ? { format: r.format } : {}),
          addedAt: r.added_at,
        });
      }
    }
    return map;
  }

  function artistItems(ids: string[]): Map<string, ArtistRef> {
    const map = new Map<string, ArtistRef>();
    for (const part of chunk(ids)) {
      if (!part.length) continue;
      for (const r of db
        .prepare(`SELECT id, name FROM artists WHERE id IN (${placeholders(part.length)})`)
        .all(...part) as { id: string; name: string }[]) {
        map.set(r.id, { id: r.id, name: r.name });
      }
    }
    return map;
  }

  function trackItems(ids: string[]): Map<string, Track> {
    const map = new Map<string, Track>();
    for (const id of ids) {
      const t = loadTrack(db, id);
      if (t) map.set(id, publicTrack(t));
    }
    return map;
  }

  function search(q: string, opts: SearchOptions = {}): SearchResponse {
    const empty: SearchResponse = { albums: [], artists: [], tracks: [], top: null };
    const qFolded = fold(q);
    const qTokens = qFolded ? qFolded.split(' ') : [];
    if (qTokens.length === 0) return empty;

    const limit = clamp(opts.limit ?? 12, 1, 50);
    const albumLimit = clamp(opts.albumLimit ?? limit, 1, 50);
    const artistLimit = clamp(opts.artistLimit ?? Math.min(limit, 20), 1, 50);
    const trackLimit = clamp(opts.trackLimit ?? limit, 1, 50);
    const source = opts.source && opts.source !== 'all' ? opts.source : null;

    const refs = candidates(qTokens);
    if (refs.length === 0) return empty;
    const docs = docsByRefs(refs);
    if (docs.length === 0) return empty;
    const plays = playCounts(docs);
    const scored: Scored[] = [];
    for (const doc of docs) {
      const s = scoreDoc(doc, qTokens, qFolded, plays.get(`${doc.kind}\u0000${doc.ref_id}`) ?? 0);
      if (s) scored.push(s);
    }
    if (scored.length === 0) return empty;

    // Albums rank on their own doc plus a fraction of matching track docs, so
    // searching a track name still offers its album.
    const directAlbum = new Map<string, number>();
    const trackAlbumBoost = new Map<string, number>();
    const albumDocs = new Map<string, DocRow>();
    const trackRanked: Scored[] = [];
    const artistRanked: Scored[] = [];
    for (const s of scored) {
      const { doc } = s;
      if (source && doc.kind !== 'artist' && doc.source !== source) continue;
      if (doc.kind === 'album') {
        directAlbum.set(doc.ref_id, Math.max(directAlbum.get(doc.ref_id) ?? 0, s.score));
        albumDocs.set(doc.ref_id, doc);
      } else if (doc.kind === 'track') {
        trackRanked.push(s);
        if (doc.album_id) {
          // max, not sum: a deluxe album with ten versions of the same track
          // should not outrank the track itself in the top-result pick.
          trackAlbumBoost.set(
            doc.album_id,
            Math.max(trackAlbumBoost.get(doc.album_id) ?? 0, s.score * 0.45),
          );
        }
      } else {
        // Artists only surface when they own a library album, like the old route.
        if (hasOwnAlbum.get(doc.ref_id)) artistRanked.push(s);
      }
    }
    const missingAlbums = [...trackAlbumBoost.keys()].filter((id) => !albumDocs.has(id));
    for (const doc of docsByIds(missingAlbums)) {
      if (source && doc.source !== source) continue;
      albumDocs.set(doc.ref_id, doc);
    }

    const albumRanked: Scored[] = [];
    for (const [id, direct] of directAlbum) {
      const doc = albumDocs.get(id);
      if (!doc) continue;
      albumRanked.push({ doc, score: direct + (trackAlbumBoost.get(id) ?? 0) });
    }
    for (const [id, boost] of trackAlbumBoost) {
      if (directAlbum.has(id)) continue;
      const doc = albumDocs.get(id);
      if (doc) albumRanked.push({ doc, score: boost });
    }
    const byScore = (a: Scored, b: Scored): number =>
      b.score - a.score || (a.doc.ref_id < b.doc.ref_id ? -1 : a.doc.ref_id > b.doc.ref_id ? 1 : 0);
    albumRanked.sort(byScore);
    artistRanked.sort(byScore);
    trackRanked.sort(byScore);

    const topAlbums = albumRanked.slice(0, albumLimit);
    const topArtists = artistRanked.slice(0, artistLimit);
    const topTracks = trackRanked.slice(0, trackLimit);

    const albums = albumItems(topAlbums.map((s) => s.doc.ref_id));
    const artists = artistItems(topArtists.map((s) => s.doc.ref_id));
    const tracks = trackItems(topTracks.map((s) => s.doc.ref_id));

    // top result: exact artist name, then exact album title, then best score
    const qNoThe = withoutThe(qFolded);
    const qCompact = compact(qFolded);
    const exactArtist = artistRanked.find(
      (s) => withoutThe(s.doc.title) === qNoThe || compact(s.doc.title) === qCompact,
    );
    const exactAlbum = albumRanked.find(
      (s) => withoutThe(s.doc.title) === qNoThe || compact(s.doc.title) === qCompact,
    );
    let top: SearchTopResult | null = null;
    if (exactArtist) {
      const artist = artists.get(exactArtist.doc.ref_id) ?? artistItems([exactArtist.doc.ref_id]).get(exactArtist.doc.ref_id);
      if (artist) top = { kind: 'artist', artist };
    }
    if (!top && exactAlbum) {
      const album = albums.get(exactAlbum.doc.ref_id) ?? albumItems([exactAlbum.doc.ref_id]).get(exactAlbum.doc.ref_id);
      if (album) top = { kind: 'album', album };
    }
    if (!top) {
      const bestAlbum = albumRanked[0];
      const bestArtist = artistRanked[0];
      const bestTrack = trackRanked[0];
      const candidatesTop: { score: number; make: () => SearchTopResult | null }[] = [];
      if (bestAlbum) {
        candidatesTop.push({
          score: bestAlbum.score,
          make: () => {
            const album = albums.get(bestAlbum.doc.ref_id) ?? albumItems([bestAlbum.doc.ref_id]).get(bestAlbum.doc.ref_id);
            return album ? { kind: 'album', album } : null;
          },
        });
      }
      if (bestArtist) {
        candidatesTop.push({
          score: bestArtist.score,
          make: () => {
            const artist =
              artists.get(bestArtist.doc.ref_id) ?? artistItems([bestArtist.doc.ref_id]).get(bestArtist.doc.ref_id);
            return artist ? { kind: 'artist', artist } : null;
          },
        });
      }
      if (bestTrack) {
        candidatesTop.push({
          score: bestTrack.score * 0.9,
          make: () => {
            const track =
              tracks.get(bestTrack.doc.ref_id) ?? trackItems([bestTrack.doc.ref_id]).get(bestTrack.doc.ref_id);
            return track ? { kind: 'track', track } : null;
          },
        });
      }
      candidatesTop.sort((a, b) => b.score - a.score);
      for (const c of candidatesTop) {
        top = c.make();
        if (top) break;
      }
    }

    return {
      albums: topAlbums.map((s) => albums.get(s.doc.ref_id)).filter((x): x is AlbumSummary => !!x),
      artists: topArtists.map((s) => artists.get(s.doc.ref_id)).filter((x): x is ArtistRef => !!x),
      tracks: topTracks.map((s) => tracks.get(s.doc.ref_id)).filter((x): x is Track => !!x),
      top,
    };
  }

  return { search, reindex, rebuildAll };
}

/** GET /search2?q=&source=&limit= — same body as /api/search plus `top`. */
export function registerSearchRoutes(app: FastifyInstance, search: Search): void {
  app.get<{ Querystring: { q?: string; source?: string; limit?: string } }>('/search2', async (req) => {
    const q = (req.query.q ?? '').trim();
    if (!q) return { albums: [], artists: [], tracks: [], top: null } satisfies SearchResponse;
    const src = req.query.source;
    const source = src === 'local' || src === 'spotify' ? src : 'all';
    const rawLimit = req.query.limit ? Number(req.query.limit) : undefined;
    const limit = rawLimit !== undefined && Number.isFinite(rawLimit) ? rawLimit : undefined;
    return search.search(q, { source, limit });
  });
}
