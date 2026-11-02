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
  /** Local folder, used to derive search variants (cleanFolderName). */
  folderPath?: string | null;
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
// The duration fingerprint carries more weight than a raw track-count match:
// editions with bonus/extra tracks still line up one-for-one on durations.
const W_TITLE = 0.33;
const W_ARTIST = 0.22;
const W_COUNT = 0.12;
const W_DURATION = 0.24;
const W_YEAR = 0.07;

/** Number of local tracks → strong fingerprint evidence; below this, scale it down. */
const FINGERPRINT_FULL_EVIDENCE = 4;
/** One side may have up to this fraction more tracks (bonus tracks / one disc of a set). */
const SUBSET_EXTRA_RATIO = 0.6;

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

  // Soundtrack/score qualifiers ("Halo: Reach (Original Soundtrack)",
  // "Love Is The Devil Original Soundtrack") do not distinguish releases.
  const soundtrack =
    '(?:original\\s+(?:game\\s+|motion\\s+picture\\s+|tv\\s+)?soundtrack|original\\s+score|official\\s+soundtrack|soundtrack|ost)';
  s = s.replace(new RegExp(`[\\(\\[\\{][^\\)\\]\\}]*${soundtrack}[^\\)\\]\\}]*[\\)\\]\\}]`, 'g'), ' ');
  s = s.replace(new RegExp(`\\s*[-–—:]\\s*${soundtrack}\\s*$`, 'g'), ' ');
  s = s.replace(new RegExp(`\\s+${soundtrack}\\s*$`, 'g'), ' ');
  // Disc markers ("Disc 1 - X", "[CD2]", "CD 1 (1965-1972)") describe a
  // physical split, not the release title; a one-disc local rip must still
  // compare with the full multi-disc release.
  s = s.replace(/\b(?:cd|disc|disk)\s*(?:\d+|one|two|three|four|five|six)\b/g, ' ');
  // Duplicate-download markers such as "Homework (1)".
  s = s.replace(/[\(\[]\s*\d{1,2}\s*[\)\]]/g, ' ');

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

function countSimilarity(localCount: number, mbCount: number, coverage?: number): number {
  if (localCount <= 0 || mbCount <= 0) return 0.5;
  if (localCount === mbCount) return 1;
  const minCount = Math.min(localCount, mbCount);
  const extraRatio = Math.abs(localCount - mbCount) / Math.max(localCount, mbCount);
  // Bonus tracks on either side (local deluxe rip vs standard MB release, or a
  // one-disc local rip vs the full multi-disc release): the smaller side is
  // contained in the larger one. Never grant this for a tiny fragment.
  if (minCount >= FINGERPRINT_FULL_EVIDENCE && extraRatio <= SUBSET_EXTRA_RATIO) {
    if (coverage === undefined || coverage >= 0.8) return 0.85;
  }
  return Math.max(0, 1 - Math.abs(localCount - mbCount) / Math.max(localCount, mbCount));
}

/** Ordered track lengths (ms, 0 = unknown) for the duration fingerprint. */
function localDurations(local: LocalTrackForMatch[]): number[] {
  return [...local]
    .sort((a, b) => a.disc - b.disc || a.number - b.number)
    .map((t) => t.durationMs);
}

function releaseDurations(release: MbRelease): number[] {
  return flattenReleaseTracks(release)
    .map((f) => ({
      medium: f.medium,
      position: f.position,
      length: f.track.length ?? f.recording?.length ?? null,
    }))
    .sort((a, b) => a.medium - b.medium || a.position - b.position)
    .map((f) => f.length ?? 0);
}

/**
 * Longest common subsequence of track lengths, matched within tolerance.
 * Robust to bonus tracks, missing tracks and a local album that contains only
 * one disc of a multi-disc release: the order of the shared tracks is kept.
 */
function durationLcs(a: number[], b: number[]): number {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1]!;
    for (let j = 1; j <= m; j++) {
      const bj = b[j - 1]!;
      const matches = ai > 0 && bj > 0 && Math.abs(ai - bj) <= DURATION_TOLERANCE_MS;
      cur[j] = matches ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
    cur.fill(0);
  }
  return prev[m]!;
}

interface Alignment {
  /** 0..1 duration fingerprint agreement (coverage of the smaller side). */
  duration: number;
  /** Fraction of the smaller side's tracks found in the larger side. */
  coverage: number;
  localCount: number;
  mbCount: number;
}

function alignTracks(local: LocalTrackForMatch[], release: MbRelease): Alignment {
  const a = localDurations(local).filter((d) => d > 0);
  const b = releaseDurations(release).filter((d) => d > 0);
  const localCount = local.length;
  const mbCount = releaseTrackCount(release);
  if (a.length === 0 || b.length === 0) {
    return { duration: 0.5, coverage: 0.5, localCount, mbCount };
  }
  const minCount = Math.min(a.length, b.length);
  const lcs = durationLcs(a, b);
  const coverage = minCount > 0 ? lcs / minCount : 0;
  // One matching track is weak evidence: scale the score by how many tracks
  // actually participated (a single track can never reach full duration score).
  const evidence = Math.min(1, minCount / FINGERPRINT_FULL_EVIDENCE);
  return { duration: coverage * evidence, coverage, localCount, mbCount };
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

const GENERIC_ARTIST_RE =
  /^(?:various artists?|v\.?\s*a\.?|original soundtrack|original score|soundtrack|ost|unknown artist|unknown|\[unknown\])$/i;
const SOUNDTRACK_HINT_RE =
  /\b(?:original\s+(?:game\s+|motion\s+picture\s+|tv\s+)?soundtrack|original\s+score|official\s+soundtrack|soundtrack|ost)\b/i;

/** "Various Artists", "Original Soundtrack", blank: the artist tag is not a real name. */
export function isGenericArtist(name: string): boolean {
  return GENERIC_ARTIST_RE.test(name.trim());
}

export function isSoundtrackTitle(title: string): boolean {
  return SOUNDTRACK_HINT_RE.test(title);
}

/**
 * Soundtrack albums are often tagged with the game/film name, a generic
 * "Original Soundtrack", or a localized artist name that never matches the
 * composer credited by MusicBrainz. Treat the artist as neutral evidence then.
 */
export function isSoundtrackAlbum(local: Pick<LocalAlbumForMatch, 'title' | 'artist'>): boolean {
  return isSoundtrackTitle(local.title) || isSoundtrackTitle(local.artist) || isGenericArtist(local.artist);
}

export function scoreRelease(local: LocalAlbumForMatch, release: MbRelease): ScoreBreakdown {
  // A placeholder album title carries no signal; fall back to the local track
  // titles (which is also what the weak-tag search used to find candidates).
  const title = isPlaceholderTitle(local.title)
    ? trackTitleAgreement(local.tracks, release)
    : titleSimilarity(local.title, release.title);
  let artist = artistCreditSimilarity(local.artist, release['artist-credit']);
  if (isSoundtrackAlbum(local)) artist = Math.max(artist, 0.5);
  const alignment = alignTracks(local.tracks, release);
  const trackCount = countSimilarity(alignment.localCount, alignment.mbCount, alignment.coverage);
  const duration = alignment.duration;
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
  let artist = artistCreditSimilarity(local.artist, item['artist-credit']);
  if (isSoundtrackAlbum(local)) artist = Math.max(artist, 0.5);
  const count = countSimilarity(local.tracks.length, searchItemTrackCount(item));
  const year = yearCloseness(local.year, yearFromDate(item.date) ?? yearFromDate(item['release-group']?.['first-release-date']));
  return Math.min(
    1,
    Math.max(0, 0.45 * relevance + 0.25 * title + 0.15 * artist + 0.1 * count + 0.05 * year),
  );
}

/**
 * True when a search hit's track count looks like the local album: exact, or a
 * bonus-track/one-disc subset (never a tiny fragment).
 */
export function trackCountCompatible(localCount: number, mbCount: number): boolean {
  if (localCount <= 0 || mbCount <= 0) return true;
  if (localCount === mbCount) return true;
  const minCount = Math.min(localCount, mbCount);
  return (
    minCount >= FINGERPRINT_FULL_EVIDENCE &&
    Math.abs(localCount - mbCount) / Math.max(localCount, mbCount) <= SUBSET_EXTRA_RATIO
  );
}

export function titleCase(value: string): string {
  // Keep short all-caps words as given (AOR, EBM, UK); capitalize after space, -, /, (.
  return value
    .split(/(\s+)/)
    .map((w) => (/^[A-Z&]{2,4}$/.test(w) ? w : w.toLowerCase().replace(/(^|[\-/(])(\p{L})/gu, (_m, p: string, c: string) => p + c.toUpperCase())))
    .join('')
    .replace(/\bR&b\b/g, 'R&B')
    .replace(/\bDj\b/g, 'DJ')
    .replace(/\bUk\b/g, 'UK')
    .replace(/\bUs\b/g, 'US')
    .replace(/^Aor$/, 'AOR');
}
