// Library scanner: walks library roots, reads tags with music-metadata, groups
// files into albums (including disc subfolders, tag-split folders and single-FILE
// cue sheets), and upserts artists/albums/tracks plus search FTS rows.
//
// Incremental: scan_files caches the parsed metadata keyed by path+mtime+size, so
// unchanged files are not parsed again. Only albums whose computed state changed
// are written and re-indexed.

import { promises as fsp, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseFile } from 'music-metadata';
import type { IAudioMetadata } from 'music-metadata';
import type { ScanProgress } from '@liner/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { ids, normalizeName } from '../db/index.js';
import type { CreateScanner, Scanner } from '../modules.js';
import { decodeCue, parseCue, type CueSheet } from './cue.js';
import { cleanFolderName, cleanTrackTitle, formatDisplay } from './names.js';
import { beginScan, endScan } from './state.js';

const AUDIO_EXTENSIONS = new Set(['.flac', '.mp3', '.m4a', '.ogg', '.opus', '.wav', '.aiff', '.aif']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);
const COVER_CACHE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];
const META_VERSION = 3; // 2: ffprobe fallback
const COVER_DIR_NAME = 'covers';
const ARTWORK_DIR_RE = /^(?:artwork|art ?work|cover ?art|covers|scans|images)$/i;
/** "CD1", "Disc 2", "CD 2 - Bonus", "Disc 1 - Original Album". */
const DISC_DIR_RE = /^(?:cd|disc|disk)\s*[-_.]?\s*(\d+)\b/i;

export interface ScanStats extends ScanProgress {
  /** Audio files that were new or whose mtime/size changed (reparsed). */
  changedFiles: number;
  /** Albums whose stored rows/FTS were rewritten. */
  changedAlbums: number;
  /** Files present in the previous scan cache but gone now. */
  vanishedFiles: number;
  deletedTracks: number;
  deletedAlbums: number;
  /** Albums whose tracks come from a single-FILE cue sheet. */
  cueAlbums: number;
  elapsedMs: number;
}

export interface ScannerWithStats extends Scanner {
  scan(onProgress?: (p: ScanProgress) => void): Promise<ScanStats>;
}

// ---------------------------------------------------------------- metadata

interface ParsedMeta {
  title?: string;
  artists: string[];
  albumartist?: string;
  album?: string;
  year?: number;
  date?: string;
  trackNo?: number;
  discNo?: number;
  genre: string[];
  label?: string;
  durationMs: number;
  codec?: string;
  container?: string;
  lossless?: boolean;
  sampleRate?: number;
  bitDepth?: number;
  bitrateKbps?: number;
  hasPicture: boolean;
  pictureMime?: string;
  error?: boolean;
}

const EMPTY_META: ParsedMeta = { artists: [], genre: [], durationMs: 0, hasPicture: false };

function asString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s.length > 0 ? s : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function yearFromDate(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const m = date.match(/(?:19|20)\d{2}/);
  return m ? Number(m[0]) : undefined;
}

/** Split tag arrays on ";" only: never on "&", "and" or commas (keeps band names). */
function splitArtistValues(values: readonly (string | undefined | null)[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    for (const part of value.split(';')) {
      const name = part.trim();
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

function metaFromMetadata(meta: IAudioMetadata): ParsedMeta {
  const c = meta.common;
  const artists =
    c.artists && c.artists.length > 0
      ? splitArtistValues(c.artists)
      : splitArtistValues([c.artist]);

  const pictures = c.picture ?? [];
  const bitrate = meta.format.bitrate;
  return {
    ...(asString(c.title) ? { title: asString(c.title) } : {}),
    artists,
    ...(asString(c.albumartist) ? { albumartist: asString(c.albumartist) } : {}),
    ...(asString(c.album) ? { album: asString(c.album) } : {}),
    ...(asNumber(c.year) ?? yearFromDate(c.date)
      ? { year: asNumber(c.year) ?? yearFromDate(c.date) }
      : {}),
    ...(asString(c.date) ? { date: asString(c.date) } : {}),
    ...(asNumber(c.track?.no) ? { trackNo: asNumber(c.track?.no) } : {}),
    ...(asNumber(c.disk?.no) ? { discNo: asNumber(c.disk?.no) } : {}),
    genre: (c.genre ?? []).map((g) => g.trim()).filter(Boolean),
    ...(asString(c.label?.[0]) ? { label: asString(c.label?.[0]) } : {}),
    durationMs: Math.max(0, Math.round((meta.format.duration ?? 0) * 1000)),
    ...(asString(meta.format.codec) ? { codec: asString(meta.format.codec) } : {}),
    ...(asString(meta.format.container) ? { container: asString(meta.format.container) } : {}),
    ...(typeof meta.format.lossless === 'boolean' ? { lossless: meta.format.lossless } : {}),
    ...(asNumber(meta.format.sampleRate) ? { sampleRate: asNumber(meta.format.sampleRate) } : {}),
    ...(asNumber(meta.format.bitsPerSample) ? { bitDepth: asNumber(meta.format.bitsPerSample) } : {}),
    ...(asNumber(bitrate) ? { bitrateKbps: Math.round(asNumber(bitrate)! / 1000) } : {}),
    hasPicture: pictures.length > 0,
    ...(pictures[0] && asString(pictures[0].format) ? { pictureMime: asString(pictures[0].format) } : {}),
  };
}

function normalizeCachedMeta(raw: unknown): ParsedMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== META_VERSION) return null;
  return {
    title: asString(r.title),
    artists: Array.isArray(r.artists) ? r.artists.filter((v): v is string => typeof v === 'string') : [],
    albumartist: asString(r.albumartist),
    album: asString(r.album),
    year: asNumber(r.year),
    date: asString(r.date),
    trackNo: asNumber(r.trackNo),
    discNo: asNumber(r.discNo),
    genre: Array.isArray(r.genre) ? r.genre.filter((v): v is string => typeof v === 'string') : [],
    label: asString(r.label),
    durationMs: asNumber(r.durationMs) ?? 0,
    codec: asString(r.codec),
    container: asString(r.container),
    lossless: typeof r.lossless === 'boolean' ? r.lossless : undefined,
    sampleRate: asNumber(r.sampleRate),
    bitDepth: asNumber(r.bitDepth),
    bitrateKbps: asNumber(r.bitrateKbps),
    hasPicture: r.hasPicture === true,
    pictureMime: asString(r.pictureMime),
    error: r.error === true,
  };
}

async function parseAudioFile(path: string): Promise<{ meta: ParsedMeta; parseError: boolean }> {
  try {
    const meta = metaFromMetadata(await parseFile(path, { duration: true }));
    if (meta.durationMs > 0) return { meta, parseError: false };
    // Parsed tags but no duration/format: fill technical fields from ffprobe.
    const probed = await probeWithFfprobe(path);
    if (!probed) return { meta, parseError: false };
    return {
      meta: {
        ...probed,
        ...Object.fromEntries(Object.entries(meta).filter(([k, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0) && !['durationMs', 'codec', 'container', 'lossless', 'sampleRate', 'bitDepth', 'bitrateKbps'].includes(k))),
      } as ParsedMeta,
      parseError: false,
    };
  } catch (e) {
    if (process.env.LINER_SCAN_DEBUG) console.error('parse failed', path, (e as Error).message);
    // music-metadata rejects some slightly malformed files that ffmpeg plays fine
    // (66 in the real library). Fall back to ffprobe before giving up.
    const probed = await probeWithFfprobe(path);
    if (probed) return { meta: probed, parseError: false };
    return { meta: { ...EMPTY_META, error: true }, parseError: true };
  }
}

async function probeWithFfprobe(path: string): Promise<ParsedMeta | null> {
  const { execFile } = await import('node:child_process');
  const out = await new Promise<string | null>((resolve) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_format', '-show_streams', '-select_streams', 'a:0', '-of', 'json', path],
      { maxBuffer: 8 * 1024 * 1024, timeout: 20_000 },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
  if (!out) return null;
  try {
    const j = JSON.parse(out) as {
      format?: { duration?: string; bit_rate?: string; format_name?: string; tags?: Record<string, string> };
      streams?: { codec_name?: string; sample_rate?: string; bits_per_raw_sample?: string; bits_per_sample?: number; tags?: Record<string, string> }[];
    };
    const st = j.streams?.[0];
    const duration = Number(j.format?.duration);
    if (!st || !Number.isFinite(duration) || duration <= 0) return null;
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...st.tags, ...j.format?.tags })) tags[k.toLowerCase()] = v;
    const num = (s?: string) => {
      const n = parseInt(s ?? '', 10);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    const artist = tags.artist?.trim();
    const codec = st.codec_name;
    const bitDepth = num(st.bits_per_raw_sample) ?? (st.bits_per_sample || undefined);
    const bitrate = num(j.format?.bit_rate);
    return {
      ...EMPTY_META,
      title: tags.title?.trim() || undefined,
      artists: artist ? [artist] : [],
      albumartist: (tags.album_artist ?? tags.albumartist)?.trim() || undefined,
      album: tags.album?.trim() || undefined,
      year: num(tags.date?.slice(0, 4) ?? tags.year),
      date: tags.date,
      trackNo: num(tags.track?.split('/')[0]),
      discNo: num(tags.disc?.split('/')[0]),
      genre: tags.genre ? [tags.genre.trim()] : [],
      label: tags.label ?? tags.publisher,
      durationMs: Math.round(duration * 1000),
      codec: codec === 'mp3' ? 'MPEG 1 Layer 3' : codec === 'flac' ? 'FLAC' : codec,
      container: codec === 'flac' ? 'FLAC' : codec === 'mp3' ? 'MPEG' : j.format?.format_name,
      lossless: codec === 'flac' || codec === 'alac' || codec?.startsWith('pcm') ? true : codec ? false : undefined,
      sampleRate: num(st.sample_rate),
      bitDepth: codec === 'flac' || codec?.startsWith('pcm') ? bitDepth : undefined,
      bitrateKbps: bitrate ? Math.round(bitrate / 1000) : undefined,
      error: false,
    };
  } catch {
    return null;
  }
}

async function readEmbeddedPicture(
  path: string,
): Promise<{ data: Uint8Array; mime: string } | null> {
  try {
    const meta = await parseFile(path, { duration: false });
    const pic = meta.common.picture?.[0];
    if (!pic || pic.data.length === 0) return null;
    return { data: pic.data, mime: pic.format };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- walk

interface WalkResult {
  audio: string[];
  cueByDir: Map<string, string[]>;
  imagesByDir: Map<string, string[]>;
  errors: number;
}

async function walkRoots(roots: string[]): Promise<WalkResult> {
  const result: WalkResult = { audio: [], cueByDir: new Map(), imagesByDir: new Map(), errors: 0 };

  const push = (map: Map<string, string[]>, dir: string, file: string): void => {
    const list = map.get(dir);
    if (list) list.push(file);
    else map.set(dir, [file]);
  };

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      result.errors++;
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (AUDIO_EXTENSIONS.has(ext)) result.audio.push(path);
      else if (ext === '.cue') push(result.cueByDir, dir, path);
      else if (IMAGE_EXTENSIONS.has(ext)) push(result.imagesByDir, dir, path);
    }
  }

  for (const root of roots) await walk(root);
  return result;
}

// ---------------------------------------------------------------- grouping

interface FileRecord {
  path: string;
  dir: string;
  albumFolder: string;
  discFolder?: number;
  meta: ParsedMeta;
  mtime: number;
  mtimeMs: number;
  size: number;
  cue?: CueSheet;
  cueTracks?: CueTrackLike[];
}

interface CueTrackLike {
  number: number;
  title?: string;
  performer?: string;
  index01Ms?: number;
}

interface AlbumGroup {
  folder: string;
  groupKey?: string;
  records: FileRecord[];
}

function normalizeGroupKey(albumTag: string): string {
  return albumTag.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** The album tag a record contributes for splitting; cue title is a fallback. */
function albumTagOf(rec: FileRecord): string {
  const tag = rec.meta.album?.trim();
  if (tag) return tag;
  const cueTitle = rec.cue?.title?.trim();
  return cueTitle ?? '';
}

// ---------------------------------------------------------------- tag merge
//
// Real libraries write the same album into one folder with slightly different
// tags: six files say "X" while one says "Chicago X"; another file may say
// "14:59" while the rest say "14:59 (Deluxe Edition)". Splitting those into
// separate albums loses the album (and any match fixed on it), so tag groups
// inside one folder are merged when:
//
//   - their titles are equal after punctuation/case normalisation ("14:59" = "14 59"),
//   - one title is a word-aligned suffix of the other ("X" vs "Chicago X"),
//   - they differ only by edition/disc noise ("[Deluxe]", "(Disc 1)", "Remastered"),
//   - or one group is a single track and the folder's majority group has the
//     same album artist and year.
//
// Title rules additionally require compatible album artist/year (a missing tag
// on one side is allowed; a conflict blocks the merge) so a folder holding two
// clearly different releases by different artists still splits. The surviving
// album keeps the majority group's key, hence its id, so matched data survives.
//
// "Substring" is deliberately implemented as a *suffix* match: "X" is a suffix
// of "Chicago X", whereas a prefix (say "Grace" vs "Grace Around the World")
// is usually a genuinely different release and must keep splitting.

const EDITION_NOISE_WORD =
  "(?:deluxe|expanded|special|limited|collector'?s?|legacy|anniversary|remaster(?:ed)?|reissue|bonus|edition|version|disc|cd|disk)";
/** Bracketed content that is pure release/edition noise, e.g. "(Deluxe Edition)", "[Disc 2]", "(2013 Remaster)". */
const EDITION_PAREN_INNER_RE = new RegExp(
  `(?:^|\\s)${EDITION_NOISE_WORD}(?:\\s|$)|\\b(?:19|20)\\d{2}\\b`,
  'i',
);
const TRAILING_EDITION_RE = new RegExp(
  `(?:\\s*[-–]\\s*|\\s+)(?:(?:19|20)\\d{2}\\s+)?${EDITION_NOISE_WORD}(?:\\s+${EDITION_NOISE_WORD})*\\s*$`,
  'i',
);

/** Drop edition/disc/remaster noise so reissue names compare equal. */
function stripEditionNoise(title: string): string {
  let s = title.replace(/[\[(]([^)\]]*)[)\]]/g, (match, inner: string) =>
    EDITION_PAREN_INNER_RE.test(inner) ? ' ' : match,
  );
  for (let i = 0; i < 3; i++) {
    const next = s.replace(TRAILING_EDITION_RE, '');
    if (next === s) break;
    s = next;
  }
  return s;
}

/** Case/diacritic/punctuation-insensitive tokens for title comparison. */
function titleTokens(title: string): string[] {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function isTokenSuffix(short: readonly string[], long: readonly string[]): boolean {
  if (short.length === 0 || short.length >= long.length) return false;
  const offset = long.length - short.length;
  return short.every((token, i) => token === long[offset + i]);
}

function titlesSimilar(a: string, b: string): boolean {
  const at = titleTokens(stripEditionNoise(a));
  const bt = titleTokens(stripEditionNoise(b));
  if (at.length === 0 || bt.length === 0) return false;
  if (at.join(' ') === bt.join(' ')) return true;
  return at.length < bt.length ? isTokenSuffix(at, bt) : isTokenSuffix(bt, at);
}

function titlesEqual(a: string, b: string): boolean {
  const at = titleTokens(stripEditionNoise(a));
  const bt = titleTokens(stripEditionNoise(b));
  return at.length > 0 && at.join(' ') === bt.join(' ');
}

interface TagGroup {
  key: string;
  records: FileRecord[];
}

/** Album artist used only for merge compatibility; falls back to a lone artist tag. */
function tagGroupArtist(records: readonly FileRecord[]): string | undefined {
  const values: string[] = [];
  for (const rec of records) {
    const value = rec.meta.albumartist ?? (rec.meta.artists.length === 1 ? rec.meta.artists[0] : undefined);
    if (value?.trim()) values.push(value);
  }
  const mode = modeOf(values);
  return mode ? normalizeName(mode) : undefined;
}

function tagGroupYear(records: readonly FileRecord[]): number | undefined {
  return modeOfNumbers(
    records
      .map((r) => r.meta.year)
      .filter((y): y is number => typeof y === 'number'),
  );
}

function artistsCompatible(a: readonly FileRecord[], b: readonly FileRecord[]): boolean {
  const left = tagGroupArtist(a);
  const right = tagGroupArtist(b);
  return left === undefined || right === undefined || left === right;
}

function yearsCompatible(a: readonly FileRecord[], b: readonly FileRecord[]): boolean {
  const left = tagGroupYear(a);
  const right = tagGroupYear(b);
  return left === undefined || right === undefined || left === right;
}

function artistAndYearMatch(a: readonly FileRecord[], b: readonly FileRecord[]): boolean {
  const leftArtist = tagGroupArtist(a);
  const rightArtist = tagGroupArtist(b);
  const leftYear = tagGroupYear(a);
  const rightYear = tagGroupYear(b);
  return (
    leftArtist !== undefined &&
    rightArtist !== undefined &&
    leftArtist === rightArtist &&
    leftYear !== undefined &&
    rightYear !== undefined &&
    leftYear === rightYear
  );
}

/** Most records wins; equal sizes prefer the longer (more complete) title. */
function pickMajority(groups: readonly TagGroup[]): TagGroup {
  let best = groups[0]!;
  for (const group of groups.slice(1)) {
    if (
      group.records.length > best.records.length ||
      (group.records.length === best.records.length && group.key.length > best.key.length)
    ) {
      best = group;
    }
  }
  return best;
}

function shouldMergeTagGroups(a: TagGroup, b: TagGroup, majority: TagGroup): boolean {
  // A lone stray track joins the folder's majority album when artist and year
  // agree, even if its album tag is unrelated: it is almost always a bonus or
  // duplicate file whose tag was edited by hand.
  const single = a.records.length === 1 ? a : b.records.length === 1 ? b : undefined;
  const other = single === a ? b : a;
  if (
    single &&
    other === majority &&
    other.records.length >= 2 &&
    artistAndYearMatch(single.records, other.records)
  ) {
    return true;
  }

  // Title-based rules must not bridge two releases with conflicting metadata.
  if (!artistsCompatible(a.records, b.records) || !yearsCompatible(a.records, b.records)) {
    return false;
  }
  return titlesSimilar(a.key, b.key);
}

/** Merge similar tag groups in one folder, keeping the majority group's key. */
function mergeTagGroups(folder: string, tagged: Map<string, FileRecord[]>): AlbumGroup[] {
  const groups: TagGroup[] = [...tagged].map(([key, records]) => ({ key, records }));
  const majority = pickMajority(groups);

  const parent = groups.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[i] !== root) {
      const next = parent[i]!;
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const union = (i: number, j: number): void => {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[b] = a;
  };

  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      if (shouldMergeTagGroups(groups[i]!, groups[j]!, majority)) union(i, j);
    }
  }

  const components = new Map<number, TagGroup[]>();
  for (let i = 0; i < groups.length; i++) {
    const root = find(i);
    const list = components.get(root);
    if (list) list.push(groups[i]!);
    else components.set(root, [groups[i]!]);
  }

  const out: AlbumGroup[] = [];
  for (const component of components.values()) {
    if (component.length === 1) {
      const only = component[0]!;
      out.push({ folder, groupKey: only.key, records: only.records });
      continue;
    }
    const survivor = pickMajority(component);
    const records = component.flatMap((g) => g.records);
    records.sort((a, b) => a.path.localeCompare(b.path));
    out.push({ folder, groupKey: survivor.key, records });
  }
  return out;
}

/** Title tag of an album group (mode of its file tags, falling back to its key). */
function groupTitleTag(group: AlbumGroup): string | undefined {
  return modeOf(group.records.map(albumTagOf).filter(Boolean)) ?? group.groupKey;
}

function normalizedTrackTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const tokens = titleTokens(stripEditionNoise(title));
  return tokens.length > 0 ? tokens.join(' ') : undefined;
}

/**
 * True when this record is a copy of one of the target album's tracks: same
 * disc, number and title (edition words ignored). Used to only merge a stray
 * one-track folder into a real album when it really is a duplicate file.
 */
function isDuplicateOfAlbumTrack(rec: FileRecord, target: readonly FileRecord[]): boolean {
  const title = normalizedTrackTitle(rec.meta.title);
  const number = rec.meta.trackNo;
  if (!title || !number) return false;
  const disc = rec.meta.discNo ?? 1;
  return target.some(
    (other) =>
      other.meta.trackNo === number &&
      (other.meta.discNo ?? 1) === disc &&
      normalizedTrackTitle(other.meta.title) === title,
  );
}

/**
 * Some libraries store one track of an album in its own folder (a stray
 * download, or a single whose file still carries the album tag). When that
 * folder holds exactly one file, and exactly one other single-album folder has
 * the same title/album artist/year and already contains the same track, fold
 * the stray file into that album. The album's own folder (and id) survives.
 *
 * This is deliberately strict: the target must be unambiguous, both years must
 * be tagged, and the file must duplicate a track that is already there. A
 * genuinely separate one-track release has no matching track and stays split.
 */
function mergeStraySingleFolders(groups: AlbumGroup[]): AlbumGroup[] {
  const groupsPerFolder = new Map<string, number>();
  for (const group of groups) {
    groupsPerFolder.set(group.folder, (groupsPerFolder.get(group.folder) ?? 0) + 1);
  }
  const aloneInFolder = (group: AlbumGroup): boolean => groupsPerFolder.get(group.folder) === 1;

  const majors = groups.filter((g) => g.records.length >= 2 && aloneInFolder(g));
  const removed = new Set<AlbumGroup>();

  for (const single of groups) {
    if (single.records.length !== 1 || !aloneInFolder(single)) continue;
    const rec = single.records[0]!;
    if (!albumTagOf(rec)) continue; // no tag to compare: leave it alone

    const title = groupTitleTag(single);
    const artist = tagGroupArtist(single.records);
    const year = tagGroupYear(single.records);
    if (!title || !artist || year === undefined) continue;

    const candidates = majors.filter((major) => {
      if (removed.has(major)) return false;
      const majorTitle = groupTitleTag(major);
      if (!majorTitle || !titlesEqual(title, majorTitle)) return false;
      if (tagGroupArtist(major.records) !== artist) return false;
      if (tagGroupYear(major.records) !== year) return false;
      return isDuplicateOfAlbumTrack(rec, major.records);
    });
    if (candidates.length !== 1) continue;

    const target = candidates[0]!;
    target.records.push(rec);
    target.records.sort((a, b) => a.path.localeCompare(b.path));
    removed.add(single);
  }

  return groups.filter((group) => !removed.has(group));
}

function resolveAlbumFolder(
  dir: string,
  roots: Set<string>,
): { folder: string; discFolder?: number } {
  if (!roots.has(dir)) {
    const m = basename(dir).match(DISC_DIR_RE);
    if (m) {
      const parent = dirname(dir);
      if (parent !== dir && !roots.has(parent) && !DISC_DIR_RE.test(basename(parent))) {
        return { folder: parent, discFolder: Number(m[1]) };
      }
    }
  }
  return { folder: dir };
}

function groupAlbums(records: FileRecord[]): AlbumGroup[] {
  const byFolder = new Map<string, FileRecord[]>();
  for (const rec of records) {
    const list = byFolder.get(rec.albumFolder);
    if (list) list.push(rec);
    else byFolder.set(rec.albumFolder, [rec]);
  }

  const groups: AlbumGroup[] = [];
  for (const [folder, recs] of byFolder) {
    recs.sort((a, b) => a.path.localeCompare(b.path));

    // Disc subfolders mean "one release with several discs" — never split by tag.
    const hasDiscSubfolder = recs.some((r) => r.dir !== folder);
    if (hasDiscSubfolder) {
      groups.push({ folder, records: recs });
      continue;
    }

    const tagged = new Map<string, FileRecord[]>();
    const untagged: FileRecord[] = [];
    for (const rec of recs) {
      const tag = albumTagOf(rec);
      if (!tag) {
        untagged.push(rec);
        continue;
      }
      const key = normalizeGroupKey(tag);
      const list = tagged.get(key);
      if (list) list.push(rec);
      else tagged.set(key, [rec]);
    }

    if (tagged.size <= 1) {
      groups.push({ folder, records: recs });
      continue;
    }

    // Assign files without an album tag to the largest tagged group.
    if (untagged.length > 0) {
      let largest: FileRecord[] | undefined;
      for (const list of tagged.values()) {
        if (!largest || list.length > largest.length) largest = list;
      }
      largest!.push(...untagged);
    }
    for (const list of tagged.values()) list.sort((a, b) => a.path.localeCompare(b.path));
    groups.push(...mergeTagGroups(folder, tagged));
  }

  // Only after per-folder merging: fold a stray one-track folder into the one
  // unambiguous album folder it duplicates (e.g. Sugar Ray's "14:59" single
  // file living beside the full album).
  const merged = mergeStraySingleFolders(groups);
  groups.length = 0;
  groups.push(...merged);

  groups.sort((a, b) =>
    a.folder === b.folder
      ? (a.groupKey ?? '').localeCompare(b.groupKey ?? '')
      : a.folder.localeCompare(b.folder),
  );
  return groups;
}

// ---------------------------------------------------------------- album model

type TrackFormatKind = 'flac' | 'mp3' | 'other';

interface TrackSpec {
  id: string;
  title: string;
  artistNames: string[];
  disc: number;
  number: number;
  durationMs: number;
  path: string;
  cueStartMs?: number;
  cueEndMs?: number;
  formatKind?: TrackFormatKind;
  formatDisplay?: string;
  sampleRate?: number;
  bitDepth?: number;
  bitrateKbps?: number;
  mtime: number;
  size: number;
}

interface AlbumModel {
  id: string;
  title: string;
  artistName: string;
  artistId: string;
  year?: number;
  releaseDate?: string;
  label?: string;
  genres: string[];
  format?: string;
  folderPath: string;
  coverPath?: string;
  addedAt: number;
  tracks: TrackSpec[];
  isCueAlbum: boolean;
}

function formatKindOf(path: string, meta: ParsedMeta): TrackFormatKind {
  const ext = extname(path).toLowerCase();
  const codec = (meta.codec ?? '').toLowerCase();
  const container = (meta.container ?? '').toLowerCase();
  if (ext === '.flac' || codec.includes('flac') || container.includes('flac')) return 'flac';
  if (ext === '.mp3' || codec.includes('mpeg') || codec.includes('mp3')) return 'mp3';
  return 'other';
}

function displayFor(path: string, meta: ParsedMeta): string {
  return formatDisplay({
    kind: formatKindOf(path, meta),
    codec: meta.codec,
    container: meta.container,
    sampleRate: meta.sampleRate,
    bitDepth: meta.bitDepth,
    bitrateKbps: meta.bitrateKbps,
  });
}

function trackNumberFromName(fileName: string): number | undefined {
  const stem = fileName.replace(/\.[^.]+$/, '');
  const m = stem.match(/^\s*(\d{1,3})\b/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function modeOf(values: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) {
    const v = value.trim();
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== undefined && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function modeOfNumbers(values: readonly number[]): number | undefined {
  const counts = new Map<number, number>();
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: number | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== undefined && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function trackArtistsFor(
  rec: FileRecord,
  folderArtist: string | undefined,
  cuePerformer: string | undefined,
  cueTrack?: CueTrackLike,
): string[] {
  // tags -> cue -> folder/file name
  if (cueTrack?.performer) return [cueTrack.performer];
  if (rec.meta.artists.length > 0) return rec.meta.artists;
  if (cuePerformer) return [cuePerformer];
  if (folderArtist) return [folderArtist];
  return ['Unknown Artist'];
}

function makeTrackSpecs(
  group: AlbumGroup,
  folderArtist: string | undefined,
  cueSheets: CueSheet[],
): TrackSpec[] {
  const specs: TrackSpec[] = [];
  const cuePerformer = modeOf(cueSheets.map((s) => s.performer ?? '').filter(Boolean));

  for (const rec of group.records) {
    const meta = rec.meta;
    const kind = formatKindOf(rec.path, meta);
    const display = displayFor(rec.path, meta);
    const common = {
      path: rec.path,
      mtime: rec.mtime,
      size: rec.size,
      formatKind: kind,
      formatDisplay: display,
      ...(meta.sampleRate ? { sampleRate: meta.sampleRate } : {}),
      ...(meta.bitDepth ? { bitDepth: meta.bitDepth } : {}),
      ...(meta.bitrateKbps ? { bitrateKbps: meta.bitrateKbps } : {}),
    };

    if (rec.cue && rec.cueTracks && rec.cueTracks.length > 0) {
      const sheet = rec.cue;
      const disc = sheet.discNumber ?? rec.discFolder ?? meta.discNo ?? 1;
      const ordered = [...rec.cueTracks].sort(
        (a, b) => (a.index01Ms ?? 0) - (b.index01Ms ?? 0) || a.number - b.number,
      );
      for (let i = 0; i < ordered.length; i++) {
        const cueTrack = ordered[i]!;
        const start = cueTrack.index01Ms ?? 0;
        const nextStart = ordered[i + 1]?.index01Ms;
        const end =
          nextStart !== undefined && nextStart > start
            ? nextStart
            : nextStart === undefined
              ? Math.max(meta.durationMs, start)
              : start;
        const title =
          cueTrack.title?.trim() ||
          (ordered.length === 1 ? meta.title?.trim() : undefined) ||
          cleanTrackTitle(basename(rec.path));
        specs.push({
          ...common,
          id: ids.localTrack(rec.path, cueTrack.number),
          title,
          artistNames: trackArtistsFor(rec, folderArtist, cuePerformer, cueTrack),
          disc,
          number: cueTrack.number,
          durationMs: Math.max(0, end - start),
          cueStartMs: start,
          cueEndMs: end,
        });
      }
      continue;
    }

    const number = meta.trackNo ?? trackNumberFromName(basename(rec.path)) ?? 0;
    specs.push({
      ...common,
      id: ids.localTrack(rec.path),
      title: meta.title?.trim() || cleanTrackTitle(basename(rec.path)),
      artistNames: trackArtistsFor(rec, folderArtist, cuePerformer),
      disc: rec.discFolder ?? meta.discNo ?? 1,
      number,
      durationMs: Math.max(0, meta.durationMs),
    });
  }

  // Fill missing track numbers with the first free number on that disc.
  const used = new Set(specs.filter((t) => t.number > 0).map((t) => `${t.disc}:${t.number}`));
  for (const spec of specs) {
    if (spec.number > 0) continue;
    let n = 1;
    while (used.has(`${spec.disc}:${n}`)) n++;
    spec.number = n;
    used.add(`${spec.disc}:${n}`);
  }

  specs.sort(
    (a, b) =>
      a.disc - b.disc ||
      a.number - b.number ||
      a.path.localeCompare(b.path) ||
      a.id.localeCompare(b.id),
  );

  // Two different names can normalise to the same artist id; keep one per id so
  // the on-disk track_artists rows and the change signature agree.
  for (const spec of specs) {
    const seen = new Set<string>();
    spec.artistNames = spec.artistNames.filter((name) => {
      const id = ids.artistByName(name);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (spec.artistNames.length === 0) spec.artistNames = ['Unknown Artist'];
  }
  return specs;
}

function computeAlbumArtist(
  records: FileRecord[],
  tracks: TrackSpec[],
  cueSheets: CueSheet[],
  folderArtist: string | undefined,
): string {
  const tag = modeOf(records.map((r) => r.meta.albumartist ?? '').filter(Boolean));
  if (tag) return tag;

  const primaries = tracks
    .map((t) => t.artistNames[0])
    .filter((n): n is string => Boolean(n) && n !== 'Unknown Artist');
  const counts = new Map<string, number>();
  for (const name of primaries) counts.set(name, (counts.get(name) ?? 0) + 1);
  const distinct = counts.size;
  const max = Math.max(0, ...counts.values());
  if (primaries.length > 0 && distinct >= 3 && max / primaries.length < 0.5) {
    return 'Various Artists';
  }
  if (distinct > 0) {
    return modeOf(primaries) ?? primaries[0]!;
  }
  return (
    modeOf(cueSheets.map((s) => s.performer ?? '').filter(Boolean)) ??
    folderArtist ??
    'Unknown Artist'
  );
}

function albumFormat(tracks: TrackSpec[]): string | undefined {
  const displays = tracks.map((t) => t.formatDisplay ?? '').filter(Boolean);
  if (displays.length === 0) return undefined;
  return modeOf(displays);
}

// ---------------------------------------------------------------- cover art

function coverCacheExt(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'img';
}

function looksLikeCoverName(file: string): number | undefined {
  const stem = basename(file).replace(/\.[^.]+$/, '').toLowerCase();
  if (stem === 'cover') return 0;
  if (stem === 'folder') return 1;
  if (stem === 'front') return 2;
  return undefined;
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await fsp.stat(path)).size;
  } catch {
    return 0;
  }
}

async function chooseFolderImage(
  albumFolder: string,
  records: FileRecord[],
  imagesByDir: Map<string, string[]>,
): Promise<string | undefined> {
  const dirs = new Set<string>([albumFolder]);
  for (const rec of records) dirs.add(rec.dir);
  // A common layout is Album/Artwork/cover.jpg.
  for (const [dir, images] of imagesByDir) {
    if (images.length > 0 && ARTWORK_DIR_RE.test(basename(dir)) && dirname(dir) === albumFolder) {
      dirs.add(dir);
    }
  }

  const candidates: { path: string; priority: number; size: number }[] = [];
  for (const dir of dirs) {
    const images = imagesByDir.get(dir);
    if (!images) continue;
    for (const image of images) {
      candidates.push({
        path: image,
        priority: looksLikeCoverName(image) ?? 9,
        size: await fileSize(image),
      });
    }
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => a.priority - b.priority || b.size - a.size || a.path.localeCompare(b.path));
  return candidates[0]!.path;
}

async function findCachedCover(
  dataDir: string,
  albumId: string,
): Promise<string | undefined> {
  const dir = join(dataDir, COVER_DIR_NAME);
  for (const ext of COVER_CACHE_EXTENSIONS) {
    const path = join(dir, `${albumId}.${ext}`);
    if (existsSync(path)) return path;
  }
  return undefined;
}

async function ensureCover(
  albumId: string,
  albumFolder: string,
  records: FileRecord[],
  imagesByDir: Map<string, string[]>,
  dataDir: string,
  existingCoverPath: string | undefined,
): Promise<string | undefined> {
  const folderImage = await chooseFolderImage(albumFolder, records, imagesByDir);
  if (folderImage) return folderImage;

  // Reuse a previously extracted embedded cover; only rewritten into dataDir.
  if (existingCoverPath && existingCoverPath.startsWith(join(dataDir, COVER_DIR_NAME) + '/')) {
    if (existsSync(existingCoverPath)) return existingCoverPath;
  }
  const cached = await findCachedCover(dataDir, albumId);
  if (cached) return cached;

  const withPicture = records.find((r) => r.meta.hasPicture);
  if (!withPicture) return undefined;

  const picture = await readEmbeddedPicture(withPicture.path);
  if (!picture) return undefined;

  const dir = join(dataDir, COVER_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${albumId}.${coverCacheExt(picture.mime)}`);
  await fsp.writeFile(path, picture.data);
  return path;
}

// ---------------------------------------------------------------- models

/** Album folders nested in a pack often omit the artist/year; inherit from a parent. */
function findAncestorArtist(folder: string, roots: Set<string>): string | undefined {
  let current = folder;
  for (let depth = 0; depth < 8; depth++) {
    const cleaned = cleanFolderName(basename(current));
    if (cleaned.artist) return cleaned.artist;
    if (roots.has(current)) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

function findAncestorYear(folder: string, roots: Set<string>): number | undefined {
  let current = folder;
  for (let depth = 0; depth < 8; depth++) {
    const cleaned = cleanFolderName(basename(current));
    if (cleaned.year) return cleaned.year;
    if (roots.has(current)) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

async function buildAlbumModel(
  group: AlbumGroup,
  imagesByDir: Map<string, string[]>,
  dataDir: string,
  existingCoverPath: string | undefined,
  roots: Set<string>,
): Promise<AlbumModel> {
  const folderName = basename(group.folder);
  const cleaned = cleanFolderName(folderName);
  const folderArtist = cleaned.artist ?? findAncestorArtist(group.folder, roots);

  const cueSheets: CueSheet[] = [];
  for (const rec of group.records) if (rec.cue && !cueSheets.includes(rec.cue)) cueSheets.push(rec.cue);

  const tracks = makeTrackSpecs(group, folderArtist, cueSheets);
  const tagTitle = modeOf(group.records.map((r) => r.meta.album ?? '').filter(Boolean));
  const cueTitle = modeOf(cueSheets.map((s) => s.title ?? '').filter(Boolean));
  const title = tagTitle ?? cueTitle ?? cleaned.album ?? folderName;
  const artistName = computeAlbumArtist(group.records, tracks, cueSheets, folderArtist);
  const artistId = ids.artistByName(artistName);

  const tagYear = modeOfNumbers(
    group.records.map((r) => r.meta.year).filter((y): y is number => typeof y === 'number'),
  );
  const cueYear = modeOfNumbers(
    cueSheets
      .map((s) => (s.date ? yearFromDate(s.date) : undefined))
      .filter((y): y is number => typeof y === 'number'),
  );
  const year = tagYear ?? cueYear ?? cleaned.year ?? findAncestorYear(group.folder, roots);

  const releaseDate = modeOf(
    group.records
      .map((r) => r.meta.date ?? '')
      .filter((d) => /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(d)),
  );

  const genres = [...new Set(group.records.flatMap((r) => r.meta.genre))].sort((a, b) =>
    a.localeCompare(b),
  );
  const label = modeOf(group.records.map((r) => r.meta.label ?? '').filter(Boolean));

  const id = ids.localAlbum(group.folder, group.groupKey);
  const format = albumFormat(tracks);
  const coverPath = await ensureCover(
    id,
    group.folder,
    group.records,
    imagesByDir,
    dataDir,
    existingCoverPath,
  );

  return {
    id,
    title,
    artistName,
    artistId,
    ...(year !== undefined ? { year } : {}),
    ...(releaseDate ? { releaseDate } : {}),
    ...(label ? { label } : {}),
    genres,
    ...(format ? { format } : {}),
    folderPath: group.folder,
    ...(coverPath ? { coverPath } : {}),
    addedAt: Math.min(...group.records.map((r) => Math.round(r.mtimeMs))),
    tracks,
    isCueAlbum: group.records.some((r) => r.cue !== undefined),
  };
}

// ---------------------------------------------------------------- existing state / writes

interface ExistingAlbum {
  title: string;
  artistId: string;
  year?: number;
  releaseDate?: string;
  label?: string;
  genres: string[];
  format?: string;
  folderPath?: string;
  coverPath?: string;
  addedAt: number;
  tracks: {
    id: string;
    title: string;
    artistIds: string[];
    disc: number;
    number: number;
    durationMs: number;
    path?: string;
    cueStartMs?: number;
    cueEndMs?: number;
    format?: string;
    sampleRate?: number;
    bitDepth?: number;
    bitrateKbps?: number;
    mtime?: number;
    size?: number;
  }[];
}

function rowNumber(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function loadExistingAlbum(db: Db, id: string): ExistingAlbum | undefined {
  const row = db.prepare('SELECT * FROM albums WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return undefined;

  const trackRows = db
    .prepare(
      `SELECT id, title, disc, number, duration_ms, path, cue_start_ms, cue_end_ms, format,
              sample_rate, bit_depth, bitrate_kbps, file_mtime, file_size
         FROM tracks WHERE album_id = ?`,
    )
    .all(id) as Record<string, unknown>[];

  const artistRows = db
    .prepare(
      `SELECT ta.track_id, ta.artist_id
         FROM track_artists ta JOIN tracks t ON t.id = ta.track_id
        WHERE t.album_id = ?
        ORDER BY ta.position`,
    )
    .all(id) as { track_id: string; artist_id: string }[];

  const artistsByTrack = new Map<string, string[]>();
  for (const ar of artistRows) {
    const list = artistsByTrack.get(ar.track_id);
    if (list) list.push(ar.artist_id);
    else artistsByTrack.set(ar.track_id, [ar.artist_id]);
  }

  let genres: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(row.genres ?? '[]'));
    if (Array.isArray(parsed)) genres = parsed.filter((g): g is string => typeof g === 'string');
  } catch {
    genres = [];
  }

  return {
    title: String(row.title ?? ''),
    artistId: String(row.artist_id ?? ''),
    year: rowNumber(row.year),
    releaseDate: row.release_date == null ? undefined : String(row.release_date),
    label: row.label == null ? undefined : String(row.label),
    genres,
    format: row.format == null ? undefined : String(row.format),
    folderPath: row.folder_path == null ? undefined : String(row.folder_path),
    coverPath: row.cover_path == null ? undefined : String(row.cover_path),
    addedAt: Number(row.added_at ?? 0),
    tracks: trackRows.map((t) => ({
      id: String(t.id),
      title: String(t.title ?? ''),
      artistIds: artistsByTrack.get(String(t.id)) ?? [],
      disc: Number(t.disc ?? 1),
      number: Number(t.number ?? 0),
      durationMs: Number(t.duration_ms ?? 0),
      path: t.path == null ? undefined : String(t.path),
      cueStartMs: rowNumber(t.cue_start_ms),
      cueEndMs: rowNumber(t.cue_end_ms),
      format: t.format == null ? undefined : String(t.format),
      sampleRate: rowNumber(t.sample_rate),
      bitDepth: rowNumber(t.bit_depth),
      bitrateKbps: rowNumber(t.bitrate_kbps),
      mtime: rowNumber(t.file_mtime),
      size: rowNumber(t.file_size),
    })),
  };
}

function signature(album: AlbumModel, coverPathOverride?: string): string {
  const tracks = [...album.tracks]
    .map((t) => ({
      id: t.id,
      title: t.title,
      artistIds: t.artistNames.map((n) => ids.artistByName(n)),
      disc: t.disc,
      number: t.number,
      durationMs: t.durationMs,
      path: t.path,
      cueStartMs: t.cueStartMs ?? null,
      cueEndMs: t.cueEndMs ?? null,
      format: t.formatKind ?? null,
      sampleRate: t.sampleRate ?? null,
      bitDepth: t.bitDepth ?? null,
      bitrateKbps: t.bitrateKbps ?? null,
      mtime: t.mtime,
      size: t.size,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({
    title: album.title,
    artistId: album.artistId,
    year: album.year ?? null,
    releaseDate: album.releaseDate ?? null,
    label: album.label ?? null,
    genres: [...album.genres].sort(),
    format: album.format ?? null,
    folderPath: album.folderPath,
    coverPath: coverPathOverride ?? album.coverPath ?? null,
    addedAt: album.addedAt,
    tracks,
  });
}

function existingSignature(existing: ExistingAlbum, coverPathOverride?: string): string {
  const tracks = [...existing.tracks]
    .map((t) => ({
      id: t.id,
      title: t.title,
      artistIds: t.artistIds,
      disc: t.disc,
      number: t.number,
      durationMs: t.durationMs,
      path: t.path ?? null,
      cueStartMs: t.cueStartMs ?? null,
      cueEndMs: t.cueEndMs ?? null,
      format: t.format ?? null,
      sampleRate: t.sampleRate ?? null,
      bitDepth: t.bitDepth ?? null,
      bitrateKbps: t.bitrateKbps ?? null,
      mtime: t.mtime ?? null,
      size: t.size ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({
    title: existing.title,
    artistId: existing.artistId,
    year: existing.year ?? null,
    releaseDate: existing.releaseDate ?? null,
    label: existing.label ?? null,
    genres: [...existing.genres].sort(),
    format: existing.format ?? null,
    folderPath: existing.folderPath ?? null,
    coverPath: coverPathOverride ?? existing.coverPath ?? null,
    addedAt: existing.addedAt,
    tracks,
  });
}

// ---------------------------------------------------------------- scanner

export function createScanner(db: Db, cfg: Config): ScannerWithStats {
  // The scanner owns scan_files; apply its migration after schema.sql has run.
  const migration = readFileSync(new URL('../db/migrations-scan.sql', import.meta.url), 'utf8');
  db.exec(migration);

  const coversDir = join(cfg.dataDir, COVER_DIR_NAME);

  const stmtInsertArtist = db.prepare('INSERT OR IGNORE INTO artists (id, name) VALUES (?, ?)');
  const stmtUpsertAlbum = db.prepare(`
    INSERT INTO albums
      (id, source, title, artist_id, year, release_date, label, genres, format,
       folder_path, cover_path, added_at)
    VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      artist_id = excluded.artist_id,
      year = excluded.year,
      release_date = excluded.release_date,
      label = excluded.label,
      genres = excluded.genres,
      format = excluded.format,
      folder_path = excluded.folder_path,
      cover_path = COALESCE(excluded.cover_path, albums.cover_path),
      added_at = excluded.added_at
  `);
  const stmtUpsertTrack = db.prepare(`
    INSERT INTO tracks
      (id, album_id, source, title, disc, number, duration_ms, path,
       cue_start_ms, cue_end_ms, format, sample_rate, bit_depth, bitrate_kbps,
       file_mtime, file_size)
    VALUES (?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      album_id = excluded.album_id,
      title = excluded.title,
      disc = excluded.disc,
      number = excluded.number,
      duration_ms = excluded.duration_ms,
      path = excluded.path,
      cue_start_ms = excluded.cue_start_ms,
      cue_end_ms = excluded.cue_end_ms,
      format = excluded.format,
      sample_rate = excluded.sample_rate,
      bit_depth = excluded.bit_depth,
      bitrate_kbps = excluded.bitrate_kbps,
      file_mtime = excluded.file_mtime,
      file_size = excluded.file_size
  `);
  const stmtDeleteTrackArtists = db.prepare(
    'DELETE FROM track_artists WHERE track_id IN (SELECT id FROM tracks WHERE album_id = ?)',
  );
  const stmtInsertTrackArtist = db.prepare(
    'INSERT OR IGNORE INTO track_artists (track_id, artist_id, position) VALUES (?, ?, ?)',
  );
  const stmtDeleteFts = db.prepare('DELETE FROM search_fts WHERE kind = ? AND ref_id = ?');
  const stmtInsertFts = db.prepare(
    'INSERT INTO search_fts (kind, ref_id, text) VALUES (?, ?, ?)',
  );
  const stmtTrackIdsInAlbum = db.prepare('SELECT id FROM tracks WHERE album_id = ?');
  const stmtGetScanSig = db.prepare('SELECT sig FROM scan_albums WHERE album_id = ?');
  const stmtSetScanSig = db.prepare(
    'INSERT INTO scan_albums (album_id, sig) VALUES (?, ?) ON CONFLICT(album_id) DO UPDATE SET sig = excluded.sig',
  );
  const stmtIsMatched = db.prepare('SELECT mb_release_id FROM albums WHERE id = ?');
  // Matched albums: the matcher owns title/artist/date/label/genres and track artists.
  const stmtUpdateMatchedAlbum = db.prepare(`
    UPDATE albums SET format = ?, folder_path = ?, cover_path = COALESCE(?, cover_path), added_at = ?
    WHERE id = ?`);
  const stmtTrackExists = db.prepare('SELECT 1 FROM tracks WHERE id = ?');
  const stmtDeleteTrack = db.prepare('DELETE FROM tracks WHERE id = ?');

  const writeAlbum = db.transaction((album: AlbumModel): number => {
    let removedTracks = 0;
    const coverToWrite = album.coverPath ?? null;

    // Artists first (album artist + every track artist).
    stmtInsertArtist.run(album.artistId, album.artistName);
    for (const track of album.tracks) {
      for (const name of track.artistNames) {
        stmtInsertArtist.run(ids.artistByName(name), name);
      }
    }

    const matched = !!(stmtIsMatched.get(album.id) as { mb_release_id: string | null } | undefined)?.mb_release_id;
    const preexisting = new Set<string>();
    if (matched) {
      for (const t of album.tracks) if (stmtTrackExists.get(t.id)) preexisting.add(t.id);
      stmtUpdateMatchedAlbum.run(album.format ?? null, album.folderPath, coverToWrite, album.addedAt, album.id);
    } else stmtUpsertAlbum.run(
      album.id,
      album.title,
      album.artistId,
      album.year ?? null,
      album.releaseDate ?? null,
      album.label ?? null,
      JSON.stringify([...album.genres].sort()),
      album.format ?? null,
      album.folderPath,
      coverToWrite,
      album.addedAt,
    );

    const expected = new Set<string>();
    for (const track of album.tracks) {
      expected.add(track.id);
      stmtUpsertTrack.run(
        track.id,
        album.id,
        track.title,
        track.disc,
        track.number,
        track.durationMs,
        track.path,
        track.cueStartMs ?? null,
        track.cueEndMs ?? null,
        track.formatKind ?? null,
        track.sampleRate ?? null,
        track.bitDepth ?? null,
        track.bitrateKbps ?? null,
        track.mtime,
        track.size,
      );
    }
    // Cue edits can remove tracks from an album; drop them here.
    for (const row of stmtTrackIdsInAlbum.all(album.id) as { id: string }[]) {
      if (!expected.has(row.id)) {
        stmtDeleteTrack.run(row.id);
        removedTracks++;
      }
    }

    if (!matched) stmtDeleteTrackArtists.run(album.id);
    for (const track of album.tracks) {
      if (matched && preexisting.has(track.id)) continue; // keep matcher's track artists
      const seen = new Set<string>();
      let position = 0;
      for (const name of track.artistNames) {
        const artistId = ids.artistByName(name);
        if (seen.has(artistId)) continue;
        seen.add(artistId);
        stmtInsertTrackArtist.run(track.id, artistId, position++);
      }
    }

    // Search index: rebuild rows for this album only.
    stmtDeleteFts.run('album', album.id);
    stmtInsertFts.run('album', album.id, `${album.title} ${album.artistName}`);
    const artistText = new Map<string, string>();
    for (const track of album.tracks) {
      stmtDeleteFts.run('track', track.id);
      stmtInsertFts.run('track', track.id, `${track.title} ${track.artistNames.join(' ')}`);
      for (const name of track.artistNames) artistText.set(ids.artistByName(name), name);
    }
    artistText.set(album.artistId, album.artistName);
    for (const [artistId, name] of artistText) {
      stmtDeleteFts.run('artist', artistId);
      stmtInsertFts.run('artist', artistId, name);
    }
    return removedTracks;
  });

  const runScan = async (onProgress?: (p: ScanProgress) => void): Promise<ScanStats> => {
      const startedAt = Date.now();
      mkdirSync(coversDir, { recursive: true });

      const roots = cfg.libraryRoots.map((r) => resolve(r));
      const rootSet = new Set(roots);

      const progress = (p: Partial<ScanProgress> & { running: boolean }): void => {
        onProgress?.({
          running: p.running,
          filesSeen: p.filesSeen ?? 0,
          albumsFound: p.albumsFound ?? 0,
          matched: 0,
          ...(p.currentPath ? { currentPath: p.currentPath } : {}),
          errors: p.errors ?? 0,
        });
      };

      let errors = 0;
      progress({ running: true, filesSeen: 0, albumsFound: 0, errors });

      // ---- 1. walk
      const walked = await walkRoots(roots);
      errors += walked.errors;
      const seenPaths = new Set(walked.audio);

      // ---- 2. parse audio (concurrent, cached by mtime+size)
      type CacheRow = { path: string; mtime: number; size: number; meta: string };
      const cacheRows = db
        .prepare('SELECT path, mtime, size, meta FROM scan_files')
        .all() as CacheRow[];
      const cache = new Map(cacheRows.map((r) => [r.path, r]));

      const records: FileRecord[] = [];
      let changedFiles = 0;
      let processed = 0;
      let filesSeen = 0;

      const processFile = async (path: string): Promise<void> => {
        let stat;
        try {
          stat = await fsp.stat(path);
        } catch {
          errors++;
          return;
        }
        const mtime = Math.round(stat.mtimeMs);
        const size = stat.size;
        const cached = cache.get(path);
        let meta: ParsedMeta;
        if (cached && cached.mtime === mtime && cached.size === size) {
          const parsed = normalizeCachedMeta(JSON.parse(cached.meta));
          if (parsed) {
            meta = parsed;
            if (parsed.error) errors++;
          } else {
            const result = await parseAudioFile(path);
            meta = result.meta;
            if (result.parseError) errors++;
            changedFiles++;
          }
        } else {
          const result = await parseAudioFile(path);
          meta = result.meta;
          if (result.parseError) errors++;
          changedFiles++;
        }

        const { folder, discFolder } = resolveAlbumFolder(dirname(path), rootSet);
        records.push({
          path,
          dir: dirname(path),
          albumFolder: folder,
          ...(discFolder !== undefined ? { discFolder } : {}),
          meta,
          mtime,
          mtimeMs: stat.mtimeMs,
          size,
        });

        processed++;
        filesSeen = processed;
        if (processed % 50 === 0 || processed === walked.audio.length) {
          progress({ running: true, filesSeen, albumsFound: 0, currentPath: path, errors });
        }
      };

      // Simple fixed-size worker pool (8 parse workers).
      {
        const limit = 8;
        let next = 0;
        const workers = Array.from(
          { length: Math.min(limit, walked.audio.length) },
          async (): Promise<void> => {
            for (;;) {
              const index = next++;
              const path = walked.audio[index];
              if (path === undefined) return;
              await processFile(path);
            }
          },
        );
        await Promise.all(workers);
      }

      // ---- 3. cue sheets (cheap; re-read every scan because they are tiny)
      const byDirAudio = new Map<string, FileRecord[]>();
      for (const rec of records) {
        const list = byDirAudio.get(rec.dir);
        if (list) list.push(rec);
        else byDirAudio.set(rec.dir, [rec]);
      }
      const claimed = new Set<string>();
      for (const [dir, cuePaths] of walked.cueByDir) {
        const audioInDir = byDirAudio.get(dir) ?? [];
        for (const cuePath of cuePaths.sort()) {
          let sheet: CueSheet;
          try {
            const buf = await fsp.readFile(cuePath);
            sheet = parseCue(decodeCue(buf));
          } catch {
            errors++;
            continue;
          }
          if (sheet.files.length !== 1) continue; // multi-FILE cues are ignored
          const onlyFile = sheet.files[0]!;
          const targetStem = basename(onlyFile.name).replace(/\.[^.]+$/, '').toLowerCase();
          const matches = audioInDir.filter(
            (rec) => basename(rec.path).replace(/\.[^.]+$/, '').toLowerCase() === targetStem,
          );
          if (matches.length !== 1) continue;
          const rec = matches[0]!;
          if (claimed.has(rec.path)) continue;
          const cueTracks = sheet.tracks.filter((t) => t.index01Ms !== undefined);
          if (cueTracks.length === 0) continue;
          claimed.add(rec.path);
          rec.cue = sheet;
          rec.cueTracks = cueTracks.map((t) => ({
            number: t.number,
            ...(t.title ? { title: t.title } : {}),
            ...(t.performer ? { performer: t.performer } : {}),
            ...(t.index01Ms !== undefined ? { index01Ms: t.index01Ms } : {}),
          }));
        }
      }

      // ---- 4. group and build album models
      // Unreadable files (damaged / zeroed) stay in the cache but never become tracks.
      const groups = groupAlbums(records.filter((r) => !r.meta.error));
      const models: AlbumModel[] = [];
      let cueAlbums = 0;
      const existingByAlbum = new Map<string, ExistingAlbum | undefined>();

      for (const group of groups) {
        const provisionalId = ids.localAlbum(group.folder, group.groupKey);
        const existing = loadExistingAlbum(db, provisionalId);
        existingByAlbum.set(provisionalId, existing);
        const model = await buildAlbumModel(
          group,
          walked.imagesByDir,
          cfg.dataDir,
          existing?.coverPath,
          rootSet,
        );
        if (model.isCueAlbum) cueAlbums++;
        models.push(model);
      }

      progress({
        running: true,
        filesSeen,
        albumsFound: models.length,
        currentPath: walked.audio[walked.audio.length - 1],
        errors,
      });

      // ---- 5. write changed albums only
      let changedAlbums = 0;
      let removedTracks = 0;
      const expectedTrackIds = new Set<string>();
      for (const model of models) {
        for (const track of model.tracks) expectedTrackIds.add(track.id);

        const existing = existingByAlbum.get(model.id);
        // If we found no local cover, keep a matcher-downloaded cover in place.
        if (!model.coverPath && existing?.coverPath) model.coverPath = existing.coverPath;
        const sig = signature(model);
        const stored = stmtGetScanSig.get(model.id) as { sig: string } | undefined;
        if (stored ? stored.sig === sig : existing && existingSignature(existing) === sig) {
          if (!stored) stmtSetScanSig.run(model.id, sig);
          continue;
        }

        removedTracks += writeAlbum(model);
        stmtSetScanSig.run(model.id, sig);
        changedAlbums++;
      }

      // ---- 6. delete vanished tracks/albums and stale cache rows
      db.exec('CREATE TEMP TABLE IF NOT EXISTS scan_expected_tracks (id TEXT PRIMARY KEY)');
      db.exec('DELETE FROM scan_expected_tracks');
      const insertExpected = db.prepare('INSERT OR IGNORE INTO scan_expected_tracks (id) VALUES (?)');
      const insertExpectedAll = db.transaction((trackIds: Iterable<string>) => {
        for (const id of trackIds) insertExpected.run(id);
      });
      insertExpectedAll(expectedTrackIds);

      const vanishedFiles = cacheRows.filter((r) => !seenPaths.has(r.path)).length;

      const deletedTracks =
        removedTracks +
        db
          .prepare(
            "DELETE FROM tracks WHERE source = 'local' AND id NOT IN (SELECT id FROM scan_expected_tracks)",
          )
          .run().changes;
      const deletedAlbums = db
        .prepare(
          "DELETE FROM albums WHERE source = 'local' AND id NOT IN (SELECT album_id FROM tracks)",
        )
        .run().changes;
      // A merged/split folder stops producing the losing album id. Drop its
      // stored signature too: otherwise, if that id ever comes back, the
      // scanner would compare against a stale signature and skip writing rows
      // that no longer exist in the albums table.
      db.exec('DELETE FROM scan_albums WHERE album_id NOT IN (SELECT id FROM albums)');

      db.exec('CREATE TEMP TABLE IF NOT EXISTS scan_seen_paths (path TEXT PRIMARY KEY)');
      db.exec('DELETE FROM scan_seen_paths');
      const insertSeen = db.prepare('INSERT OR IGNORE INTO scan_seen_paths (path) VALUES (?)');
      const insertSeenAll = db.transaction((paths: Iterable<string>) => {
        for (const path of paths) insertSeen.run(path);
      });
      insertSeenAll(seenPaths);
      db.exec('DELETE FROM scan_files WHERE path NOT IN (SELECT path FROM scan_seen_paths)');

      // Keep the cache in sync for new/changed files (unchanged rows are already there).
      const upsertCache = db.prepare(
        `INSERT INTO scan_files (path, mtime, size, meta) VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size, meta = excluded.meta`,
      );
      const saveCache = db.transaction((recs: FileRecord[]) => {
        for (const rec of recs) {
          const cached = cache.get(rec.path);
          if (cached && cached.mtime === rec.mtime && cached.size === rec.size) continue;
          upsertCache.run(
            rec.path,
            rec.mtime,
            rec.size,
            JSON.stringify({ v: META_VERSION, ...rec.meta }),
          );
        }
      });
      saveCache(records);

      // Remove FTS rows whose underlying rows are gone.
      db.exec(
        "DELETE FROM search_fts WHERE kind = 'album' AND ref_id NOT IN (SELECT id FROM albums)",
      );
      db.exec("DELETE FROM search_fts WHERE kind = 'track' AND ref_id NOT IN (SELECT id FROM tracks)");
      db.exec(
        "DELETE FROM search_fts WHERE kind = 'artist' AND ref_id NOT IN (SELECT id FROM artists)",
      );

      const stats: ScanStats = {
        running: false,
        filesSeen,
        albumsFound: models.length,
        matched: 0,
        errors,
        changedFiles,
        changedAlbums,
        vanishedFiles,
        deletedTracks,
        deletedAlbums,
        cueAlbums,
        elapsedMs: Date.now() - startedAt,
      };
      progress(stats);
      return stats;
  };

  return {
    async scan(onProgress?: (p: ScanProgress) => void): Promise<ScanStats> {
      // Background workers (loudness analysis) pause while this is set.
      beginScan();
      try {
        return await runScan(onProgress);
      } finally {
        endScan();
      }
    },
  };
}

// Ensure this stays assignable to the module contract in src/modules.ts.
const _createScannerContract: CreateScanner = createScanner;
void _createScannerContract;
