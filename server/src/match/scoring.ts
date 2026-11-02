// Candidate scoring for MusicBrainz release matching (all scores 0..1).
import { normalizeName } from '../db/index.js';
import {
  artistCreditName,
  flattenReleaseTracks,
  releaseTrackCount,
  searchItemTrackCount,
  yearFromDate,
  type MbRelease,
  type MbSearchRelease,
} from './mb.js';

export interface LocalTrackForMatch {
  id: string;
  title: string;
  disc: number;
  number: number;
  durationMs: number;
}

export interface LocalAlbumForMatch {
  title: string;
  artist: string;
  year?: number | null;
  format?: string | null;
  tracks: LocalTrackForMatch[];
}

export interface ScoreBreakdown {
  title: number;
  artist: number;
  trackCount: number;
  duration: number;
  year: number;
  formatBonus: number;
  score: number;
}

const DURATION_TOLERANCE_MS = 3000;

/** Titles that carry no useful information (missing tags / scanner placeholders). */
const PLACEHOLDER_TITLE = /^(unknown|unknown album|untitled|untitled album|no title|track \d+)$/i;

export function isPlaceholderTitle(title: string): boolean {
  const t = title.trim();
  return t.length === 0 || PLACEHOLDER_TITLE.test(t);
}

// Weights sum to 0.98; the format match is a small additive bonus (max 0.02).
const W_TITLE = 0.35;
const W_ARTIST = 0.25;
const W_COUNT = 0.15;
const W_DURATION = 0.15;
const W_YEAR = 0.08;

/**
 * Normalise an album title for comparison: case/diacritics/punctuation folded and
 * edition suffixes such as "(Deluxe Edition)", "[Remastered 2011]" or
 * " - Remastered" removed.
 */
export function normalizeTitle(title: string): string {
  let s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

  const editionWords =
    'deluxe|remaster(?:ed)?|expanded|anniversary|special|bonus|collector|limited|edition|reissue|mono|stereo|explicit|clean|remix';
  // Remove any bracket group that mentions an edition keyword.
  s = s.replace(new RegExp(`[\\(\\[\\{][^\\)\\]\\}]*\\b(?:${editionWords})\\b[^\\)\\]\\}]*[\\)\\]\\}]`, 'g'), ' ');
  // Remove trailing " - Remastered", " - Deluxe Edition", etc.
  s = s.replace(new RegExp(`\\s*[-–—]\\s*(?:${editionWords})\\b.*$`, 'g'), ' ');
  // Drop a trailing edition phrase without brackets: "Discovery Remastered".
  s = s.replace(new RegExp(`\\s+\\b(?:${editionWords})\\b\\s*$`, 'g'), ' ');
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return s;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Keep memory bounded for pathological titles.
  if (a.length > 300 || b.length > 300) return Math.max(a.length, b.length);
  let prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1);
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Similarity of two already-normalised strings, 0..1. */
export function normalizedSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ratio = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  const jaccard = union > 0 ? inter / union : 0;
  // One title contained in the other (e.g. "Jar of Flies" vs "Jar of Flies EP")
  // is a strong but not exact signal.
  const containment = a.includes(b) || b.includes(a) ? 0.85 : 0;
  return Math.max(ratio, jaccard, containment);
}

export function titleSimilarity(a: string, b: string): number {
  return normalizedSimilarity(normalizeTitle(a), normalizeTitle(b));
}

export function artistSimilarity(localArtist: string, mbArtist: string): number {
  const local = normalizeName(localArtist);
  if (!local || !normalizeName(mbArtist)) return 0.5; // neutral when a side is unknown
  const mb = normalizeName(mbArtist);
  return normalizedSimilarity(local, mb);
}

/** Compare a local artist name against every artist in an MB artist credit. */
export function artistCreditSimilarity(localArtist: string, credit: Parameters<typeof artistCreditName>[0]): number {
  const names = (credit ?? []).map((c) => c.name).filter(Boolean);
  const whole = artistCreditName(credit);
  if (!localArtist.trim() || names.length === 0) return 0.5;
  let best = artistSimilarity(localArtist, whole);
  for (const name of names) best = Math.max(best, artistSimilarity(localArtist, name));
  return best;
}

function countSimilarity(localCount: number, mbCount: number): number {
  if (localCount <= 0 || mbCount <= 0) return 0.5;
  if (localCount === mbCount) return 1;
  return Math.max(0, 1 - Math.abs(localCount - mbCount) / Math.max(localCount, mbCount));
}

function durationAgreement(local: LocalTrackForMatch[], release: MbRelease): number {
  const flat = flattenReleaseTracks(release).map((f) => ({
    medium: f.medium,
    position: f.position,
    length: f.track.length ?? f.recording?.length ?? null,
  }));
  if (local.length === 0 || flat.length === 0) return 0.5;

  const sortedLocal = [...local].sort((a, b) => a.disc - b.disc || a.number - b.number);
  const sortedMb = [...flat].sort((a, b) => a.medium - b.medium || a.position - b.position);
  const n = Math.min(sortedLocal.length, sortedMb.length);
  let comparable = 0;
  let agree = 0;
  for (let i = 0; i < n; i++) {
    const l = sortedLocal[i]!;
    const m = sortedMb[i]!;
    if (m.length == null || m.length <= 0 || l.durationMs <= 0) continue;
    comparable++;
    if (Math.abs(m.length - l.durationMs) <= DURATION_TOLERANCE_MS) agree++;
  }
  if (comparable === 0) return 0.5;
  return agree / comparable;
}

function yearCloseness(localYear: number | null | undefined, mbYear: number | undefined): number {
  if (!localYear || !mbYear) return 0.5;
  const diff = Math.abs(localYear - mbYear);
  return Math.max(0, 1 - diff / 10);
}

/**
 * Average title similarity of position-aligned local/MB tracks. Used in place of
 * the album-title score when the local album title is a placeholder, so a weak
 * tag search by track titles can still score the right release.
 */
function trackTitleAgreement(local: LocalTrackForMatch[], release: MbRelease): number {
  const flat = flattenReleaseTracks(release);
  if (local.length === 0 || flat.length === 0) return 0;
  const sortedLocal = [...local].sort((a, b) => a.disc - b.disc || a.number - b.number);
  const sortedMb = [...flat].sort((a, b) => a.medium - b.medium || a.position - b.position);
  const n = Math.min(sortedLocal.length, sortedMb.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += normalizedSimilarity(normalizeTitle(sortedLocal[i]!.title), normalizeTitle(sortedMb[i]!.track.title));
  }
  return sum / n;
}

type FormatKind = 'cd' | 'digital' | 'vinyl' | 'other';

function formatKind(format: string | null | undefined): FormatKind | undefined {
  if (!format) return undefined;
  const s = format.toLowerCase();
  if (/\bcd\b|compact disc|sacd/.test(s)) return 'cd';
  if (/digital|flac|mp3|aac|m4a|alac|wav|aiff|ogg|opus|24\/|16\/|\bdsd\b/.test(s)) return 'digital';
  if (/vinyl|\blp\b|12"|12in/.test(s)) return 'vinyl';
  return 'other';
}

function mediumFormatKind(release: MbRelease): FormatKind | undefined {
  const kinds = (release.media ?? []).map((m) => formatKind(m.format)).filter((k): k is FormatKind => k != null);
  if (kinds.length === 0) return undefined;
  return kinds[0];
}

/** Small bonus when the local medium kind agrees with the MB medium kind. */
function formatBonus(localFormat: string | null | undefined, release: MbRelease): number {
  const local = formatKind(localFormat);
  const mb = mediumFormatKind(release);
  if (!local || !mb || local === 'other' || mb === 'other') return 0;
  return local === mb ? 0.02 : 0;
}

export function scoreRelease(local: LocalAlbumForMatch, release: MbRelease): ScoreBreakdown {
  // A placeholder album title carries no signal; fall back to the local track
  // titles (which is also what the weak-tag search used to find candidates).
  const title = isPlaceholderTitle(local.title)
    ? trackTitleAgreement(local.tracks, release)
    : titleSimilarity(local.title, release.title);
  const artist = artistCreditSimilarity(local.artist, release['artist-credit']);
  const trackCount = countSimilarity(local.tracks.length, releaseTrackCount(release));
  const duration = durationAgreement(local.tracks, release);
  const year = yearCloseness(local.year, yearFromDate(release.date) ?? yearFromDate(release['release-group']?.['first-release-date']));
  const bonus = formatBonus(local.format, release);
  const base = W_TITLE * title + W_ARTIST * artist + W_COUNT * trackCount + W_DURATION * duration + W_YEAR * year;
  return { title, artist, trackCount, duration, year, formatBonus: bonus, score: Math.min(1, Math.max(0, base + bonus)) };
}

/**
 * Cheap ranking of search results before fetching full release documents. Uses
 * only the fields present in search results (MB relevance + title/artist/count/year).
 */
export function preliminaryScore(local: LocalAlbumForMatch, item: MbSearchRelease): number {
  const relevance = Math.min(1, Math.max(0, (item.score ?? 0) / 100));
  const title = isPlaceholderTitle(local.title) ? 0 : titleSimilarity(local.title, item.title);
  const artist = artistCreditSimilarity(local.artist, item['artist-credit']);
  const count = countSimilarity(local.tracks.length, searchItemTrackCount(item));
  const year = yearCloseness(local.year, yearFromDate(item.date) ?? yearFromDate(item['release-group']?.['first-release-date']));
  return Math.min(
    1,
    Math.max(0, 0.45 * relevance + 0.25 * title + 0.15 * artist + 0.1 * count + 0.05 * year),
  );
}

export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/(^|[\s\-/])(\p{L})/gu, (_m, prefix: string, ch: string) => prefix + ch.toUpperCase())
    .replace(/\bR&b\b/g, 'R&B')
    .replace(/\bDj\b/g, 'DJ')
    .replace(/\bUk\b/g, 'UK')
    .replace(/\bUs\b/g, 'US');
}
