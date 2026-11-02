// Worker M — duplicate detection for the local library.
//
//   findDuplicates(db) -> { groups, trackGroups }
//
// Album groups: local albums that are the same release / the same music.
//   1. same non-empty MusicBrainz release group id, or
//   2. same normalized album artist + album title (edition/format suffixes,
//      the artist's own name and simple plurals folded) AND the shorter track
//      list is >= 70% covered by the other by normalized track title plus
//      duration within 3 s.
// Each group recommends a "best" version. Ranking: visible albums first, then
// the user's preferred_over choice, then lossless > lossy, bit depth, sample
// rate, bitrate, completeness (track count), cover, matched, confidence.
//
// Track groups: the same recording on different albums (compilations vs the
// album, or two rips). Two tracks are linked when
//   a. same non-empty mb_recording_id *and* compatible titles, or
//   b. same normalized primary artist + track title + duration within 3 s.
// (b is what finds remasters whose MusicBrainz ids differ; (a) bridges
// duration differences for a known recording. The title-compatibility guard
// on (a) matters in the live library: the matcher has produced colliding
// mb_recording_ids for different songs, e.g. Billy Joel's "Piano Man" and
// "Just the Way You Are".)
//
// User decisions live in album_prefs (db/migrations-dupes.sql, applied here).
// Hidden albums must be filtered by callers that list albums / search. Use
// albumNotHiddenSql(db, alias) — see the wiring note below.
//
// Main-session wiring (do not edit in this worker):
//   GET /library/duplicates, POST /albums/:id/hide, DELETE /albums/:id/hide:
//     import { registerDupesRoutes } from '../library/dupes.js';
//     registerDupesRoutes(r, db);           // inside buildApp's /api plugin
//
//   Hidden albums (server/src/api/library.ts):
//     import { albumNotHiddenSql } from '../library/dupes.js';
//     listAlbums(): after `ensureSpotifyLibrarySchema(db);`
//       const notHidden = albumNotHiddenSql(db, 'a');
//     listAlbums(): after `if (q.inLibrary !== false) where.push('a.in_library = 1');`
//       where.push(notHidden);
//     search(): after `ensureSpotifyLibrarySchema(db);`
//       const notHidden = albumNotHiddenSql(db, 'a');
//     search(): in the trackIds query, after `JOIN albums a ON a.id = t.album_id AND a.in_library = 1`
//       add `AND ${notHidden}`.
//     search(): the artists query's EXISTS may add the same predicate with alias 'x':
//       `AND ${albumNotHiddenSql(db, 'x')}` inside `FROM albums x WHERE ...`.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { hash16, normalizeName } from '../db/index.js';

const migrationSql = readFileSync(new URL('../db/migrations-dupes.sql', import.meta.url), 'utf8');
const schemaApplied = new WeakSet<Db>();

/** Idempotently create album_prefs. Safe to call as often as you like. */
export function ensureDupesSchema(db: Db): void {
  if (schemaApplied.has(db)) return;
  db.exec(migrationSql);
  schemaApplied.add(db);
}

// ------------------------------------------------------------------ types

export type DuplicateGroupKind = 'release-group' | 'same-title' | 'mixed';
export type DuplicateTrackMatch = 'recording' | 'title-duration' | 'mixed';

export interface DuplicateAlbumVersion {
  albumId: string;
  title: string;
  artist: string;
  artistId?: string;
  year?: number;
  /** Display string, e.g. "FLAC 24/96" or "MP3 320". */
  format?: string;
  folderPath?: string;
  folderName?: string;
  trackCount: number;
  discCount: number;
  lossless: boolean;
  bitDepth?: number;
  sampleRate?: number;
  bitrateKbps?: number;
  hasCover: boolean;
  /** Has a MusicBrainz release id (not just a guess). */
  matched: boolean;
  matchConfidence?: number;
  hidden: boolean;
  /** Album this one has been marked as preferred over (user decision). */
  preferredOver?: string;
  recommended: boolean;
}

export interface DuplicateGroup {
  /** Stable across scans (derived from the member album ids). */
  id: string;
  kind: DuplicateGroupKind;
  /** Title/artist of the recommended version (convenience for the UI). */
  title: string;
  artist: string;
  match: {
    releaseGroupIds: string[];
    /** Normalized album-title keys that actually linked members. */
    titleKeys: string[];
    /** Best title-based overlap in the group, 0..1 (absent = rg-only group). */
    trackOverlap?: number;
  };
  /** Best version first. */
  albums: DuplicateAlbumVersion[];
  bestAlbumId: string;
  /** Human-readable explanation of the pick. */
  reason: string;
}

export interface DuplicateTrack {
  trackId: string;
  albumId: string;
  albumTitle: string;
  title: string;
  artist: string;
  durationMs: number;
  disc: number;
  number: number;
  format?: string;
  sampleRate?: number;
  bitDepth?: number;
  bitrateKbps?: number;
  mbRecordingId?: string;
  /** The track's album is hidden. */
  hidden: boolean;
}

export interface DuplicateTrackGroup {
  id: string;
  match: DuplicateTrackMatch;
  title: string;
  artist: string;
  mbRecordingId?: string;
  albumIds: string[];
  /** Ordered by album title, disc, track number. */
  tracks: DuplicateTrack[];
  reason: string;
}

export interface DuplicateReport {
  groups: DuplicateGroup[];
  trackGroups: DuplicateTrackGroup[];
  albumsScanned: number;
  tracksScanned: number;
}

export interface AlbumPrefs {
  albumId: string;
  hidden: boolean;
  preferredOver?: string;
}

// -------------------------------------------------------------- prefs API

/** Hide an album from album lists and search. Preserves any preferred_over. */
export function hideAlbum(db: Db, albumId: string): AlbumPrefs {
  ensureDupesSchema(db);
  db.prepare(
    `INSERT INTO album_prefs (album_id, hidden) VALUES (?, 1)
     ON CONFLICT(album_id) DO UPDATE SET hidden = 1`,
  ).run(albumId);
  return getAlbumPrefs(db, albumId);
}

/** Undo hideAlbum. The row is kept so a preferred_over choice survives. */
export function unhideAlbum(db: Db, albumId: string): AlbumPrefs {
  ensureDupesSchema(db);
  db.prepare(
    `INSERT INTO album_prefs (album_id, hidden) VALUES (?, 0)
     ON CONFLICT(album_id) DO UPDATE SET hidden = 0`,
  ).run(albumId);
  return getAlbumPrefs(db, albumId);
}

/**
 * Record "albumId is the keeper; prefer it over overAlbumId" (null clears).
 * A recommendation honours this ahead of audio quality, as long as the album
 * is not hidden.
 */
export function setPreferredOver(db: Db, albumId: string, overAlbumId: string | null): AlbumPrefs {
  ensureDupesSchema(db);
  if (overAlbumId === albumId) throw new Error('an album cannot be preferred over itself');
  db.prepare(
    `INSERT INTO album_prefs (album_id, hidden, preferred_over) VALUES (?, 0, ?)
     ON CONFLICT(album_id) DO UPDATE SET preferred_over = excluded.preferred_over`,
  ).run(albumId, overAlbumId);
  return getAlbumPrefs(db, albumId);
}

export function getAlbumPrefs(db: Db, albumId: string): AlbumPrefs {
  ensureDupesSchema(db);
  const row = db
    .prepare('SELECT album_id, hidden, preferred_over FROM album_prefs WHERE album_id = ?')
    .get(albumId) as { album_id: string; hidden: number; preferred_over: string | null } | undefined;
  if (!row) return { albumId, hidden: false };
  return {
    albumId: row.album_id,
    hidden: row.hidden === 1,
    ...(row.preferred_over ? { preferredOver: row.preferred_over } : {}),
  };
}

/**
 * SQL predicate for the `albums` table (with the given alias) that excludes
 * hidden albums. Used by library listing/search. The migration is applied here
 * so the predicate is always valid; call once per query, not per row.
 */
export function albumNotHiddenSql(db: Db, alias = 'a'): string {
  ensureDupesSchema(db);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error(`invalid SQL alias: ${alias}`);
  return `NOT EXISTS (SELECT 1 FROM album_prefs h WHERE h.album_id = ${alias}.id AND h.hidden = 1)`;
}

/** Same predicate for the conventional alias `a`, for callers that can't pass a db. */
export const HIDDEN_ALBUM_SQL =
  'NOT EXISTS (SELECT 1 FROM album_prefs h WHERE h.album_id = a.id AND h.hidden = 1)';

// ---------------------------------------------------------- normalization

const DIACRITICS = /[̀-ͯ]/g;
const LOSSLESS_RE = /(flac|alac|aiff?|pcm|\bwav\b|wavpack|\bape\b|\bdsd\b|\bdsf\b|\btta\b)/i;
const LOSSY_RE = /(mp3|aac|m4a|\bmp4\b|ogg|opus|vorbis|wma)/i;
const EDITION_NOISE_RE =
  /album version|ep version|single version|radio (?:edit|version)|album edit|remaster(?:ed)?|digital(?:ly)? remaster(?:ed)?|explicit|clean|bonus(?: track)?|deluxe|expanded|anniversary|mono|stereo/i;
const VERSION_MARKER_RE = /\b(live|demo|acoustic|remix|instrumental|karaoke|extended)\b/i;

function stripBrackets(s: string): string {
  return s.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
}

function words(s: string): string[] {
  return s
    .normalize('NFKD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Fold trivial plurals so "Essentials" and "Essential" meet. */
function foldWord(w: string): string {
  if (w.endsWith('ss') || w.endsWith('us') || w.endsWith('is')) return w;
  if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2); // sketches -> sketch
  if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1); // essentials -> essential
  return w;
}

/**
 * Album-title key for duplicate matching. Bracketed edition/format suffixes are
 * dropped, the artist's own name is removed from the title ("The Essential
 * Billy Joel" -> "essential"), a leading "the" is dropped and simple plurals
 * are folded. Falls back to the plain normalized title when that would empty it.
 */
export function albumTitleKey(title: string, artistName?: string | null): string {
  const base = stripBrackets(title);
  let tokens = words(base);
  if (artistName) {
    const artistTokens = new Set(words(normalizeName(artistName)));
    if (artistTokens.size > 0) {
      const kept = tokens.filter((t) => !artistTokens.has(t));
      if (kept.length > 0) tokens = kept;
    }
  }
  if (tokens[0] === 'the') tokens = tokens.slice(1);
  if (tokens.length === 0) tokens = words(stripBrackets(title));
  return tokens.map(foldWord).join(' ');
}

/**
 * Track-title key for duplicate matching. Bracketed edition markers
 * ("(Album Version)", "(Remastered 2011)") are dropped; meaningful ones such
 * as "(Live)" or "(Demo)" are kept.
 */
export function trackTitleKey(title: string): string {
  const cleaned = title.replace(/\([^)]*\)|\[[^\]]*\]/g, (m) => (EDITION_NOISE_RE.test(m) ? ' ' : m));
  const key = words(cleaned).join(' ');
  return key || words(title).join(' ');
}

/**
 * Split a track title into its base song name and the *meaningful* version
 * markers in brackets. Everything in brackets is removed from the base (so
 * parenthetical subtitles don't break matching), but markers such as "(Live)"
 * or "(Extended)" must agree: a studio take is not the same recording as its
 * live take even when the matcher gave them the same MBID.
 */
function titleParts(title: string): { base: string; markers: string } {
  const brackets = title.match(/\([^)]*\)|\[[^\]]*\]/g) ?? [];
  const markers = new Set<string>();
  for (const bracket of brackets) {
    if (EDITION_NOISE_RE.test(bracket)) continue;
    const marker = bracket.match(VERSION_MARKER_RE);
    if (marker?.[1]) markers.add(marker[1].toLowerCase());
  }
  return { base: words(stripBrackets(title)).join(' '), markers: [...markers].sort().join(' ') };
}

/** Same base title and the same version markers (live/demo/…)? */
function titlesCompatible(a: string, b: string): boolean {
  const pa = titleParts(a);
  const pb = titleParts(b);
  return !!pa.base && pa.base === pb.base && pa.markers === pb.markers;
}

// ------------------------------------------------------------- quality

interface ParsedQuality {
  lossless?: boolean;
  bitDepth?: number;
  sampleRate?: number;
  bitrateKbps?: number;
}

function parseQualityText(text: string | null | undefined): ParsedQuality {
  if (!text) return {};
  const q: ParsedQuality = {};
  if (LOSSLESS_RE.test(text)) q.lossless = true;
  else if (LOSSY_RE.test(text)) q.lossless = false;

  // "24/96", "16/44.1"
  const ds = text.match(/\b(16|24|32)\s*\/\s*(\d{2,3}(?:\.\d+)?)\b/);
  if (ds) {
    q.bitDepth = Number(ds[1]);
    q.sampleRate = Math.round(Number(ds[2]) * 1000);
  }
  if (q.bitDepth == null) {
    const bd = text.match(/\b(16|24|32)\s*(?:-|\s)?bit\b/i);
    if (bd) q.bitDepth = Number(bd[1]);
  }
  if (q.sampleRate == null) {
    const sr = text.match(/\b(\d{2,3}(?:\.\d+)?)\s*khz\b/i);
    if (sr) q.sampleRate = Math.round(Number(sr[1]) * 1000);
  }
  const br = text.match(/\b(\d{2,4})\s*kbps\b/i);
  if (br) q.bitrateKbps = Number(br[1]);
  return q;
}

function maxDefined(current: number | undefined, next: number | null | undefined): number | undefined {
  if (next == null || !Number.isFinite(next) || next <= 0) return current;
  return Math.max(current ?? 0, next);
}

function rateLabel(rate: number | undefined): string {
  if (!rate) return '?';
  return `${Number((rate / 1000).toFixed(1))} kHz`;
}

// ------------------------------------------------------------------ rows

interface AlbumRow {
  id: string;
  title: string;
  artist_id: string | null;
  artist_name: string | null;
  year: number | null;
  format: string | null;
  folder_path: string | null;
  cover_path: string | null;
  mb_release_id: string | null;
  mb_release_group_id: string | null;
  match_confidence: number | null;
  added_at: number;
  hidden: number;
  preferred_over: string | null;
}

interface TrackRow {
  id: string;
  album_id: string;
  title: string;
  disc: number;
  number: number;
  duration_ms: number;
  format: string | null;
  sample_rate: number | null;
  bit_depth: number | null;
  bitrate_kbps: number | null;
  mb_recording_id: string | null;
  album_title: string;
  album_artist: string | null;
  album_hidden: number;
  track_artist: string | null;
}

function loadAlbumRows(db: Db): AlbumRow[] {
  return db
    .prepare(
      `SELECT a.id, a.title, a.artist_id, ar.name AS artist_name, a.year, a.format,
              a.folder_path, a.cover_path, a.mb_release_id, a.mb_release_group_id,
              a.match_confidence, a.added_at,
              coalesce(p.hidden, 0) AS hidden, p.preferred_over
         FROM albums a
         LEFT JOIN artists ar ON ar.id = a.artist_id
         LEFT JOIN album_prefs p ON p.album_id = a.id
        WHERE a.source = 'local'
        ORDER BY a.id`,
    )
    .all() as AlbumRow[];
}

function loadTrackRows(db: Db): TrackRow[] {
  return db
    .prepare(
      `SELECT t.id, t.album_id, t.title, t.disc, t.number, t.duration_ms, t.format,
              t.sample_rate, t.bit_depth, t.bitrate_kbps, t.mb_recording_id,
              a.title AS album_title, ar.name AS album_artist,
              coalesce(p.hidden, 0) AS album_hidden,
              (SELECT ar2.name FROM track_artists ta JOIN artists ar2 ON ar2.id = ta.artist_id
                WHERE ta.track_id = t.id ORDER BY ta.position LIMIT 1) AS track_artist
         FROM tracks t
         JOIN albums a ON a.id = t.album_id
         LEFT JOIN artists ar ON ar.id = a.artist_id
         LEFT JOIN album_prefs p ON p.album_id = a.id
        WHERE a.source = 'local'
        ORDER BY t.album_id, t.disc, t.number, t.id`,
    )
    .all() as TrackRow[];
}

function trackArtist(t: TrackRow): string {
  return t.track_artist ?? t.album_artist ?? '';
}

function buildVersion(row: AlbumRow, tracks: TrackRow[]): DuplicateAlbumVersion {
  const parsed = parseQualityText(row.format);
  let bitDepth = parsed.bitDepth;
  let sampleRate = parsed.sampleRate;
  let bitrateKbps = parsed.bitrateKbps;
  let lossless = parsed.lossless;
  let losslessTracks = 0;
  let lossyTracks = 0;

  for (const t of tracks) {
    bitDepth = maxDefined(bitDepth, t.bit_depth);
    sampleRate = maxDefined(sampleRate, t.sample_rate);
    bitrateKbps = maxDefined(bitrateKbps, t.bitrate_kbps);
    const kind = parseQualityText(t.format).lossless;
    if (kind === true) losslessTracks += 1;
    else if (kind === false) lossyTracks += 1;
  }
  if (lossless === undefined) {
    lossless = losslessTracks > 0 && losslessTracks >= Math.max(1, lossyTracks);
  }

  const discs = new Set(tracks.map((t) => t.disc));
  const format = row.format?.trim() || undefined;
  const matched = !!row.mb_release_id && row.mb_release_id.trim() !== '';
  return {
    albumId: row.id,
    title: row.title,
    artist: row.artist_name ?? 'Unknown Artist',
    ...(row.artist_id ? { artistId: row.artist_id } : {}),
    ...(row.year ? { year: row.year } : {}),
    ...(format ? { format } : {}),
    ...(row.folder_path ? { folderPath: row.folder_path, folderName: basename(row.folder_path) } : {}),
    trackCount: tracks.length,
    discCount: discs.size,
    lossless: lossless === true,
    ...(bitDepth != null ? { bitDepth } : {}),
    ...(sampleRate != null ? { sampleRate } : {}),
    ...(bitrateKbps != null ? { bitrateKbps } : {}),
    hasCover: !!row.cover_path && row.cover_path.trim() !== '',
    matched,
    ...(row.match_confidence != null ? { matchConfidence: row.match_confidence } : {}),
    hidden: row.hidden === 1,
    ...(row.preferred_over ? { preferredOver: row.preferred_over } : {}),
    recommended: false,
  };
}

/** Fraction of the shorter list matched by title + duration (±3 s). */
function overlapRatio(a: TrackRow[], b: TrackRow[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const small = a.length <= b.length ? a : b;
  const large = a.length <= b.length ? b : a;
  const buckets = new Map<string, TrackRow[]>();
  for (const t of large) {
    const key = trackTitleKey(t.title);
    const list = buckets.get(key);
    if (list) list.push(t);
    else buckets.set(key, [t]);
  }
  const used = new Set<TrackRow>();
  let matched = 0;
  for (const t of small) {
    const candidates = buckets.get(trackTitleKey(t.title));
    if (!candidates) continue;
    const hit = candidates.find(
      (u) => !used.has(u) && Math.abs(u.duration_ms - t.duration_ms) <= 3000,
    );
    if (hit) {
      used.add(hit);
      matched += 1;
    }
  }
  return matched / small.length;
}

// -------------------------------------------------------------- disjoint

class DisjointSet {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root] as number;
    let cur = x;
    while (this.parent[cur] !== cur) {
      const next = this.parent[cur] as number;
      this.parent[cur] = root;
      cur = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

// ------------------------------------------------------------- ranking

function versionQuality(a: DuplicateAlbumVersion, b: DuplicateAlbumVersion): number {
  if (a.lossless !== b.lossless) return a.lossless ? -1 : 1;
  const numeric: [number | undefined, number | undefined][] = [
    [a.bitDepth, b.bitDepth],
    [a.sampleRate, b.sampleRate],
    // Bitrate only distinguishes two lossy rips; for lossless it just reflects
    // how busy the music is, not quality (and would outrank completeness).
    ...(a.lossless ? [] : ([[a.bitrateKbps, b.bitrateKbps]] as [number | undefined, number | undefined][])),
    [a.trackCount, b.trackCount],
  ];
  for (const [x, y] of numeric) {
    const xv = x ?? 0;
    const yv = y ?? 0;
    if (xv !== yv) return yv - xv;
  }
  if (a.hasCover !== b.hasCover) return a.hasCover ? -1 : 1;
  if (a.matched !== b.matched) return a.matched ? -1 : 1;
  const ac = a.matchConfidence ?? 0;
  const bc = b.matchConfidence ?? 0;
  if (ac !== bc) return bc - ac;
  return a.albumId < b.albumId ? -1 : a.albumId > b.albumId ? 1 : 0;
}

function rankVersions(versions: DuplicateAlbumVersion[]): DuplicateAlbumVersion[] {
  const preference = new Map<string, number>();
  for (const v of versions) preference.set(v.albumId, 0);
  for (const v of versions) {
    const target = v.preferredOver;
    if (!target || target === v.albumId || !preference.has(target)) continue;
    preference.set(v.albumId, (preference.get(v.albumId) ?? 0) + 1);
    preference.set(target, (preference.get(target) ?? 0) - 1);
  }
  return [...versions].sort((a, b) => {
    if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
    const pa = preference.get(a.albumId) ?? 0;
    const pb = preference.get(b.albumId) ?? 0;
    if (pa !== pb) return pb - pa;
    return versionQuality(a, b);
  });
}

function versionSummary(v: DuplicateAlbumVersion): string {
  const bits = [`${v.format ?? 'unknown format'}, ${v.trackCount} track${v.trackCount === 1 ? '' : 's'}`];
  if (v.lossless && (v.bitDepth != null || v.sampleRate != null)) {
    bits.push(`${v.bitDepth ?? '?'}-bit/${rateLabel(v.sampleRate)}`);
  } else if (!v.lossless && v.bitrateKbps != null) {
    bits.push(`${v.bitrateKbps} kbps`);
  }
  if (v.hasCover) bits.push('cover');
  if (v.matched) bits.push('matched');
  if (v.hidden) bits.push('hidden');
  return bits.join(', ');
}

function recommendationReason(detection: string, albums: DuplicateAlbumVersion[]): string {
  const best = albums[0];
  if (!best) return detection;
  const parts = [`${detection}. Best: ${best.title} (${versionSummary(best)})`];
  const runner = albums[1];
  if (runner) {
    const edges: string[] = [];
    if (best.lossless !== runner.lossless) {
      edges.push(best.lossless ? 'lossless vs lossy' : 'lossy vs lossless');
    }
    if ((best.bitDepth ?? 0) > (runner.bitDepth ?? 0)) {
      edges.push(`${best.bitDepth}-bit vs ${runner.bitDepth ?? '?'}-bit`);
    }
    if ((best.sampleRate ?? 0) > (runner.sampleRate ?? 0)) {
      edges.push(`${rateLabel(best.sampleRate)} vs ${rateLabel(runner.sampleRate)}`);
    }
    if (
      !best.lossless &&
      (best.bitrateKbps ?? 0) > (runner.bitrateKbps ?? 0)
    ) {
      edges.push(`${best.bitrateKbps} kbps vs ${runner.bitrateKbps ?? '?'} kbps`);
    }
    if (best.trackCount > runner.trackCount) {
      edges.push(`${best.trackCount - runner.trackCount} more track${best.trackCount - runner.trackCount === 1 ? '' : 's'}`);
    }
    if (best.hasCover && !runner.hasCover) edges.push('has cover');
    if (best.matched && !runner.matched) edges.push('matched to MusicBrainz');
    if ((best.preferredOver === runner.albumId || runner.preferredOver === best.albumId)) {
      // rankVersions only puts the preferred side first; mention it explicitly.
      if (best.preferredOver === runner.albumId) edges.unshift('user preference');
    }
    parts.push(
      `; chosen over ${runner.title} (${versionSummary(runner)})` +
        (edges.length > 0 ? `: ${edges.join(', ')}` : ': tie on quality, stable order'),
    );
  }
  if (albums.every((a) => a.hidden)) parts.push('; all versions are hidden');
  return `${parts.join('')}.`;
}

// ------------------------------------------------------------- album groups

function groupAlbums(
  albumRows: AlbumRow[],
  tracksByAlbum: Map<string, TrackRow[]>,
): DuplicateGroup[] {
  if (albumRows.length === 0) return [];
  const versions = albumRows.map((row) => buildVersion(row, tracksByAlbum.get(row.id) ?? []));
  const indexById = new Map(albumRows.map((row, i) => [row.id, i]));
  const ds = new DisjointSet(albumRows.length);

  // 1. MusicBrainz release group.
  const rgBuckets = new Map<string, number[]>();
  albumRows.forEach((row, i) => {
    const rg = row.mb_release_group_id?.trim().toLowerCase();
    if (!rg) return;
    const list = rgBuckets.get(rg);
    if (list) list.push(i);
    else rgBuckets.set(rg, [i]);
  });
  for (const bucket of rgBuckets.values()) {
    for (let i = 1; i < bucket.length; i += 1) ds.union(bucket[0] as number, bucket[i] as number);
  }

  // 2. Same normalized artist + title and >= 70% track overlap.
  const titleBuckets = new Map<string, number[]>();
  albumRows.forEach((row, i) => {
    if ((tracksByAlbum.get(row.id) ?? []).length === 0) return;
    const titleKey = albumTitleKey(row.title, row.artist_name);
    if (!titleKey) return;
    const key = `${normalizeName(row.artist_name ?? '')}\u0000${titleKey}`;
    const list = titleBuckets.get(key);
    if (list) list.push(i);
    else titleBuckets.set(key, [i]);
  });

  interface TitlePair {
    a: number;
    b: number;
    key: string;
    overlap: number;
  }
  const titlePairs: TitlePair[] = [];
  for (const [key, bucket] of titleBuckets) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const ai = bucket[i] as number;
        const bj = bucket[j] as number;
        const overlap = overlapRatio(
          tracksByAlbum.get(albumRows[ai]!.id) ?? [],
          tracksByAlbum.get(albumRows[bj]!.id) ?? [],
        );
        if (overlap >= 0.7) {
          ds.union(ai, bj);
          titlePairs.push({ a: ai, b: bj, key: key.split('\u0000')[1] ?? '', overlap });
        }
      }
    }
  }

  const components = new Map<number, number[]>();
  albumRows.forEach((_row, i) => {
    const root = ds.find(i);
    const list = components.get(root);
    if (list) list.push(i);
    else components.set(root, [i]);
  });

  const groups: DuplicateGroup[] = [];
  for (const members of components.values()) {
    if (members.length < 2) continue;
    const memberSet = new Set(members);
    const memberRows = members.map((i) => albumRows[i]!);
    const memberVersions = members.map((i) => versions[i]!);
    const rgs = [
      ...new Set(
        memberRows
          .map((r) => r.mb_release_group_id?.trim().toLowerCase())
          .filter((rg): rg is string => !!rg),
      ),
    ];
    const pairs = titlePairs.filter(
      (p) =>
        memberSet.has(p.a) &&
        memberSet.has(p.b) &&
        ds.find(p.a) === ds.find(members[0] as number),
    );
    const titleKeys = [...new Set(pairs.map((p) => p.key).filter(Boolean))];
    const maxOverlap = pairs.length > 0 ? Math.max(...pairs.map((p) => p.overlap)) : undefined;
    const firstRg = memberRows[0]?.mb_release_group_id?.trim().toLowerCase();
    const commonRg =
      firstRg && memberRows.every((r) => r.mb_release_group_id?.trim().toLowerCase() === firstRg)
        ? firstRg
        : undefined;

    const kind: DuplicateGroupKind = commonRg
      ? 'release-group'
      : titleKeys.length > 0
        ? rgs.length > 0
          ? 'mixed'
          : 'same-title'
        : 'mixed';

    const ranked = rankVersions(memberVersions);
    ranked.forEach((v, i) => {
      v.recommended = i === 0;
    });
    const best = ranked[0];
    if (!best) continue;

    const overlapText =
      maxOverlap != null ? `${Math.round(maxOverlap * 100)}% track overlap` : undefined;
    const detection =
      kind === 'release-group'
        ? `Same MusicBrainz release group ${commonRg}`
        : kind === 'same-title'
          ? `Same normalized title "${titleKeys.join('" / "')}"` +
            (overlapText ? ` and ${overlapText}` : '')
          : `Linked by release group${rgs.length ? ` ${rgs.join(', ')}` : ''}` +
            (overlapText ? ` and ${overlapText}` : '');

    groups.push({
      id: 'dg:' + hash16(memberRows.map((r) => r.id).sort().join('|')),
      kind,
      title: best.title,
      artist: best.artist,
      match: {
        releaseGroupIds: rgs,
        titleKeys,
        ...(maxOverlap != null ? { trackOverlap: maxOverlap } : {}),
      },
      albums: ranked,
      bestAlbumId: best.albumId,
      reason: recommendationReason(detection, ranked),
    });
  }

  groups.sort(
    (a, b) =>
      a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' }) ||
      a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) ||
      a.id.localeCompare(b.id),
  );
  return groups;
}

// ------------------------------------------------------------- track groups

function groupTracks(trackRows: TrackRow[]): DuplicateTrackGroup[] {
  if (trackRows.length === 0) return [];
  const ds = new DisjointSet(trackRows.length);

  // a. same title + primary artist + duration within 3 s
  const titleBuckets = new Map<string, number[]>();
  trackRows.forEach((t, i) => {
    const title = trackTitleKey(t.title);
    if (!title) return;
    const key = `${normalizeName(trackArtist(t))}\u0000${title}`;
    const list = titleBuckets.get(key);
    if (list) list.push(i);
    else titleBuckets.set(key, [i]);
  });
  for (const bucket of titleBuckets.values()) {
    if (bucket.length < 2) continue;
    const sorted = [...bucket].sort(
      (a, b) => (trackRows[a]?.duration_ms ?? 0) - (trackRows[b]?.duration_ms ?? 0),
    );
    for (let i = 0; i < sorted.length; i += 1) {
      const ai = sorted[i] as number;
      const durA = trackRows[ai]?.duration_ms ?? 0;
      for (let j = i + 1; j < sorted.length; j += 1) {
        const bj = sorted[j] as number;
        if ((trackRows[bj]?.duration_ms ?? 0) - durA > 3000) break;
        ds.union(ai, bj);
      }
    }
  }

  // b. same MusicBrainz recording id, when the titles plausibly name the same song
  const recordingBuckets = new Map<string, number[]>();
  trackRows.forEach((t, i) => {
    const mbid = t.mb_recording_id?.trim().toLowerCase();
    if (!mbid) return;
    const list = recordingBuckets.get(mbid);
    if (list) list.push(i);
    else recordingBuckets.set(mbid, [i]);
  });
  for (const bucket of recordingBuckets.values()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const ai = bucket[i] as number;
        const bj = bucket[j] as number;
        const ta = trackRows[ai];
        const tb = trackRows[bj];
        if (ta && tb && titlesCompatible(ta.title, tb.title)) ds.union(ai, bj);
      }
    }
  }

  const components = new Map<number, number[]>();
  trackRows.forEach((_t, i) => {
    const root = ds.find(i);
    const list = components.get(root);
    if (list) list.push(i);
    else components.set(root, [i]);
  });

  const groups: DuplicateTrackGroup[] = [];
  for (const members of components.values()) {
    if (members.length < 2) continue;
    const rows = members.map((i) => trackRows[i]!);
    const albumIds = [...new Set(rows.map((t) => t.album_id))];
    if (albumIds.length < 2) continue; // compilations vs albums, not repeats on one disc

    // Base titles (brackets removed) decide whether an MBID group is one song;
    // trackTitleKey (which keeps "(Live)") decides title+duration matches.
    const titleKeys = new Set(rows.map((t) => titleParts(t.title).base));
    const durationTitleKeys = new Set(rows.map((t) => trackTitleKey(t.title)));
    const artistKeys = new Set(rows.map((t) => normalizeName(trackArtist(t))));
    const mbids = new Set(
      rows
        .map((t) => t.mb_recording_id?.trim().toLowerCase())
        .filter((m): m is string => !!m),
    );
    const everyTrackHasMbid = rows.every((t) => !!t.mb_recording_id?.trim());
    const sharedMbid = everyTrackHasMbid && mbids.size === 1 ? [...mbids][0] : undefined;

    let match: DuplicateTrackMatch;
    if (sharedMbid && titleKeys.size === 1) match = 'recording';
    else if (
      artistKeys.size === 1 &&
      (durationTitleKeys.size === 1 || titleKeys.size === 1)
    ) {
      match = 'title-duration';
    } else match = 'mixed';

    const sortedRows = [...rows].sort(
      (a, b) =>
        a.album_title.localeCompare(b.album_title, undefined, { sensitivity: 'base' }) ||
        a.disc - b.disc ||
        a.number - b.number ||
        a.id.localeCompare(b.id),
    );
    const first = sortedRows[0];
    if (!first) continue;
    // Canonical display title: the shortest raw variant ("Song One", not
    // "Song One (Album Version)"), then stable order.
    const representative =
      [...sortedRows].sort(
        (a, b) =>
          a.title.length - b.title.length ||
          a.title.localeCompare(b.title) ||
          a.id.localeCompare(b.id),
      )[0] ?? first;
    const albumTitles = [...new Set(sortedRows.map((t) => t.album_title))];
    const durations = sortedRows.map((t) => t.duration_ms);
    const spread = Math.max(...durations) - Math.min(...durations);

    const detection =
      match === 'recording'
        ? `Same MusicBrainz recording ${sharedMbid}`
        : match === 'title-duration'
          ? `Same title "${representative.title}" by ${trackArtist(representative) || 'Unknown Artist'} with durations within ${Math.round(spread / 1000)} s of each other`
          : 'Linked by MusicBrainz recording id and title/duration';
    const reason =
      `${detection} across ${albumIds.length} albums ` +
      `(${albumTitles.slice(0, 3).join(' / ')}${albumTitles.length > 3 ? ' / …' : ''}).`;

    groups.push({
      id: 'dtg:' + hash16(rows.map((t) => t.id).sort().join('|')),
      match,
      title: representative.title,
      artist: trackArtist(representative) || 'Unknown Artist',
      ...(sharedMbid ? { mbRecordingId: sharedMbid } : {}),
      albumIds,
      tracks: sortedRows.map((t) => ({
        trackId: t.id,
        albumId: t.album_id,
        albumTitle: t.album_title,
        title: t.title,
        artist: trackArtist(t),
        durationMs: t.duration_ms,
        disc: t.disc,
        number: t.number,
        ...(t.format ? { format: t.format } : {}),
        ...(t.sample_rate != null ? { sampleRate: t.sample_rate } : {}),
        ...(t.bit_depth != null ? { bitDepth: t.bit_depth } : {}),
        ...(t.bitrate_kbps != null ? { bitrateKbps: t.bitrate_kbps } : {}),
        ...(t.mb_recording_id ? { mbRecordingId: t.mb_recording_id } : {}),
        hidden: t.album_hidden === 1,
      })),
      reason,
    });
  }

  groups.sort(
    (a, b) =>
      a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' }) ||
      a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) ||
      a.id.localeCompare(b.id),
  );
  return groups;
}

// ---------------------------------------------------------------- public

/** Detect duplicate local albums and duplicate tracks. Read-only. */
export function findDuplicates(db: Db): DuplicateReport {
  ensureDupesSchema(db);
  const albumRows = loadAlbumRows(db);
  const trackRows = loadTrackRows(db);
  const tracksByAlbum = new Map<string, TrackRow[]>();
  for (const t of trackRows) {
    const list = tracksByAlbum.get(t.album_id);
    if (list) list.push(t);
    else tracksByAlbum.set(t.album_id, [t]);
  }
  return {
    groups: groupAlbums(albumRows, tracksByAlbum),
    trackGroups: groupTracks(trackRows),
    albumsScanned: albumRows.length,
    tracksScanned: trackRows.length,
  };
}

// ------------------------------------------------------------------ routes

function albumExists(db: Db, albumId: string): boolean {
  return !!db.prepare('SELECT 1 AS ok FROM albums WHERE id = ?').get(albumId);
}

/** Mount the duplicate routes (no /api prefix — the caller adds it). */
export function registerDupesRoutes(app: FastifyInstance, db: Db): void {
  ensureDupesSchema(db);

  app.get('/library/duplicates', async () => findDuplicates(db));

  app.post<{ Params: { id: string } }>('/albums/:id/hide', async (req, reply) => {
    const albumId = req.params.id;
    if (!albumExists(db, albumId)) return reply.code(404).send({ error: 'unknown album' });
    return { albumId, hidden: true, prefs: hideAlbum(db, albumId) };
  });

  app.delete<{ Params: { id: string } }>('/albums/:id/hide', async (req, reply) => {
    const albumId = req.params.id;
    if (!albumExists(db, albumId)) return reply.code(404).send({ error: 'unknown album' });
    return { albumId, hidden: false, prefs: unhideAlbum(db, albumId) };
  });
}
