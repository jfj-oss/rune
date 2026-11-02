// Homemade recommendation engine for "rune radio".
//
// Everything here is derived from the local database only: album genres, the
// artist graph (album artist + track_artists), album credits (producers,
// engineers, musicians) and album years, plus listening history when the
// `plays` table exists. No network, no external service.
//
// The engine is deliberately split from the route/API layer so tests can drive
// the scoring directly. All randomness goes through an injected `rng` so a
// session is reproducible from a seed.
import type { Db } from '../db/index.js';
import { normalizeName } from '../db/index.js';

// ---------------------------------------------------------------- weights

/**
 * Tunable weights. Similarity components are normalised to roughly 0..1;
 * credit can reach 1.5 so a shared producer can outrank a same-genre match.
 */
export interface RadioWeights {
  artist: number;
  credit: number;
  genre: number;
  era: number;
  /** How much of the score comes from the session's original seed vs the previous track. */
  seedBlend: number;
  prevBlend: number;
  /** Number of top-scoring candidates sampled from (keeps the radio from being a loop). */
  topK: number;
  /** Softmax temperature for sampling; lower = greedier. */
  temperature: number;
  /** History: negative score for a track played within `recentHours`. */
  recentHours: number;
  historyRecentPenalty: number;
  historyCompletionWeight: number;
  historySkipPenalty: number;
  /** Soft penalty per appearance of the same artist in the last 4 picks. */
  artistRepeatPenalty: number;
  /** Soft penalty per appearance of the same album in the last 6 picks. */
  albumRepeatPenalty: number;
}

export const DEFAULT_WEIGHTS: RadioWeights = {
  artist: 3.6,
  credit: 3.2,
  genre: 3.2,
  era: 1.1,
  seedBlend: 0.62,
  prevBlend: 0.38,
  topK: 10,
  temperature: 1.15,
  recentHours: 6,
  historyRecentPenalty: 15,
  historyCompletionWeight: 4,
  historySkipPenalty: 5,
  artistRepeatPenalty: 0.9,
  albumRepeatPenalty: 0.5,
};

const MIN_TRACK_MS = 60_000;
const INTERLUDE_RE = /\b(interlude|intro|outro|skit|prelude|reprise)\b/i;
/** Bonus-material titles that make for awkward radio even when they are songs. */
const FILLER_RE =
  /\b(instrumental|commentary|karaoke|a cappella|acappella|demo|outtake|rehearsal|alternate (mix|take|version)|early version|rough mix)\b|^track \d+$/i;

// ---------------------------------------------------------------- types

export interface CreditInfo {
  artistId: string;
  name: string;
  role: string;
  /** Coarse family used for scoring + reason text ("Producer", "Mixer", ...). */
  family: string;
  weight: number;
}

export interface TrackInfo {
  id: string;
  albumId: string;
  albumTitle: string;
  title: string;
  durationMs: number;
  /** Album artist. */
  artistId: string;
  artistName: string;
  trackArtistIds: string[];
  trackArtistNames: string[];
  year: number | null;
  /** Year used for era scoring; null for compilations / reissue-style years. */
  eraYear: number | null;
  /** Normalised album title+artist, folding deluxe/remaster editions together. */
  albumKey: string;
  /** Album genres, or the album artist's genres when the album has none. */
  genres: string[];
  /**
   * Trust in `genres` for scoring: 1 for an album's own tags, lower when they
   * were inferred from the artist or come from a compilation bucket.
   */
  genreConfidence: number;
  credits: CreditInfo[];
  /** Normalised "primary artist|title" used to collapse local/Spotify duplicates. */
  key: string;
}

export interface PlayStat {
  plays: number;
  completed: number;
  lastPlayedAt: number;
}

export interface RadioLibrary {
  tracks: TrackInfo[];
  byId: Map<string, TrackInfo>;
  genreIdf: Map<string, number>;
  genreDisplay: Map<string, string>;
  albumCount: number;
}

export interface SeedProfile {
  artists: Map<string, number>;
  credits: Map<string, number>;
  genres: Map<string, number>;
  years: Map<number, number>;
  /** Sum of idf*weight over the profile's genres; used to normalise genre score. */
  genreTotal: number;
}

export interface ScoreDetail {
  artist: number;
  credit: number;
  genre: number;
  era: number;
  /** Best matching artist (candidate or profile). */
  artistId?: string;
  artistName?: string;
  genreKey?: string;
  creditName?: string;
  creditRole?: string;
  creditFamily?: string;
  /** Candidate's year, when era matched. */
  year?: number;
}

export interface HistoryInfo {
  delta: number;
  label?: string;
}

// ---------------------------------------------------------------- normalisation

function normalizeGenreKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Title-case a genre for display, keeping short acronyms and "R&B" intact. */
export function genreDisplay(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word.replace(/[^\s/&-]+/g, (part) => {
        if (/^[A-Z]{2,4}$/.test(part)) return part;
        return part
          .split('&')
          .map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : p))
          .join('&');
      }),
    )
    .join(' ');
}

/**
 * Umbrella genres shared by thousands of unrelated albums. They still count
 * for display queries, but as a radio signal "Pop" or "Dance" says almost
 * nothing — a K-pop OST and a Daft Punk B-side both tick "Dance". Genres that
 * actually cluster a scene (Grunge, House, Neo Soul, French House) stay.
 */
const BROAD_GENRES = new Set([
  'pop',
  'rock',
  'electronic',
  'dance',
  'alternative',
  'indie',
  'other',
  'soundtrack',
  'music',
  'unknown',
  'pop/rock',
  'pop rock',
]);

export function isSpecificGenre(key: string): boolean {
  return !BROAD_GENRES.has(key);
}

/** Parse albums.genres (JSON array, sometimes one entry with ";" separators). */
export function parseGenres(json: string | null): string[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    parsed = json;
  }
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== 'string') continue;
    for (const part of item.split(/[;,]/)) {
      const key = normalizeGenreKey(part);
      if (key && !seen.has(key)) {
        seen.add(key);
        out.push(key);
      }
    }
  }
  return out;
}

/** Strip parenthetical/bracket suffixes and " - Remastered" tails for dedupe. */
function baseTitle(title: string): string {
  return title
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+-\s+.*$/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function trackKey(artistName: string, title: string): string {
  return `${normalizeName(artistName)}|${normalizeName(baseTitle(title))}`;
}

/** Album titles whose `year` is a reissue/compilation date, not the music's era. */
const COMPILATION_RE =
  /\b(greatest hits|best of|the best|very best|essential|collection|anthology|compilation|complete|singles|hits|ultimate|definitive)\b/i;

function albumKeyFor(albumTitle: string, artistName: string): string {
  return `${normalizeName(artistName)}|${normalizeName(baseTitle(albumTitle))}`;
}

function genreConfidenceFor(
  albumTitle: string,
  artistName: string,
  hasAlbumGenres: boolean,
): number {
  if (!hasAlbumGenres) return 0.5;
  if (normalizeName(artistName) === 'various artists' || COMPILATION_RE.test(albumTitle)) return 0.55;
  return 1;
}

function eraYearFor(albumTitle: string, artistName: string, year: number | null): number | null {
  if (year == null || year <= 0) return null;
  if (normalizeName(artistName) === 'various artists') return null;
  if (COMPILATION_RE.test(albumTitle)) return null;
  return year;
}

// ---------------------------------------------------------------- credits

interface RoleInfo {
  family: string;
  weight: number;
}

/** Map a free-form MusicBrainz credit role to a coarse family + weight. */
export function roleInfo(role: string): RoleInfo {
  const r = role.toLowerCase();
  if (/executive producer/.test(r)) return { family: 'Executive Producer', weight: 0.9 };
  if (/producer/.test(r)) return { family: 'Producer', weight: 1.0 };
  if (/\bmix(ing)?\b|re-?mix/.test(r)) return { family: 'Mixer', weight: 0.8 };
  if (/engineer|mastering/.test(r)) return { family: 'Engineer', weight: 0.65 };
  if (/compos|songwrit|writer|lyricist/.test(r)) return { family: 'Composer', weight: 0.6 };
  if (/vocal|choir|rap\b/.test(r)) return { family: 'Vocalist', weight: 0.4 };
  if (
    /guitar|bass|drum|percussion|piano|keyboard|synth|organ|violin|cello|viola|trumpet|sax|clarinet|flute|harmonica|strings|tambourine|handclap|mellotron|accordion|woodwind|harp|banjo|mandolin|sitar|turntable|programming/i.test(
      r,
    )
  ) {
    return { family: role.trim(), weight: 0.3 };
  }
  return { family: role.trim() || 'Credit', weight: 0.2 };
}

// ---------------------------------------------------------------- library load

function hasTable(db: Db, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { ok: number } | undefined;
  return row !== undefined;
}

interface RawCredit {
  albumId: string;
  artistId: string;
  name: string;
  role: string;
  trackIds: string[] | null; // null = whole album
}

function parseTrackIds(json: string | null): string[] | null {
  if (json == null) return null;
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return null;
  }
}

/** Snapshot the parts of the library radio needs. Cheap enough for a 10k-track DB. */
export function loadLibrary(db: Db): RadioLibrary {
  const artistRows = db.prepare('SELECT id, name FROM artists').all() as { id: string; name: string }[];
  const artistNames = new Map(artistRows.map((r) => [r.id, r.name]));

  const albumRows = db
    .prepare('SELECT id, artist_id, year, genres FROM albums')
    .all() as { id: string; artist_id: string; year: number | null; genres: string | null }[];

  const albumArtist = new Map<string, string>();
  const albumYear = new Map<string, number | null>();
  const albumGenres = new Map<string, string[]>();
  const artistGenres = new Map<string, Set<string>>();
  const genreDisplayMap = new Map<string, string>();

  for (const row of albumRows) {
    albumArtist.set(row.id, row.artist_id);
    albumYear.set(row.id, row.year != null && row.year > 0 ? row.year : null);
    const genres = parseGenres(row.genres);
    albumGenres.set(row.id, genres);
    let set = artistGenres.get(row.artist_id);
    if (!set) {
      set = new Set();
      artistGenres.set(row.artist_id, set);
    }
    for (const g of genres) set.add(g);
  }

  // Genre idf over albums so a shared "Grunge" means more than a shared "Rock".
  const genreFreq = new Map<string, number>();
  for (const genres of albumGenres.values()) {
    for (const g of genres) genreFreq.set(g, (genreFreq.get(g) ?? 0) + 1);
  }
  const albumCount = albumRows.length;
  const genreIdf = new Map<string, number>();
  for (const [g, n] of genreFreq) {
    genreIdf.set(g, Math.log(1 + albumCount / (1 + n)));
    if (!genreDisplayMap.has(g)) genreDisplayMap.set(g, genreDisplay(g));
  }

  const taRows = db
    .prepare(
      `SELECT ta.track_id AS trackId, ta.artist_id AS artistId, ar.name AS name
         FROM track_artists ta LEFT JOIN artists ar ON ar.id = ta.artist_id
        ORDER BY ta.track_id, ta.position`,
    )
    .all() as { trackId: string; artistId: string; name: string | null }[];
  const trackArtists = new Map<string, { id: string; name: string }[]>();
  for (const row of taRows) {
    let list = trackArtists.get(row.trackId);
    if (!list) {
      list = [];
      trackArtists.set(row.trackId, list);
    }
    list.push({ id: row.artistId, name: row.name ?? artistNames.get(row.artistId) ?? 'Unknown Artist' });
  }

  const creditRows = db
    .prepare(
      `SELECT c.album_id AS albumId, c.artist_id AS artistId, ar.name AS name,
              c.role AS role, c.track_ids AS trackIds
         FROM credits c LEFT JOIN artists ar ON ar.id = c.artist_id`,
    )
    .all() as { albumId: string; artistId: string; name: string | null; role: string; trackIds: string | null }[];
  const rawCredits: RawCredit[] = creditRows.map((r) => ({
    albumId: r.albumId,
    artistId: r.artistId,
    name: r.name ?? artistNames.get(r.artistId) ?? 'Unknown Artist',
    role: r.role,
    trackIds: parseTrackIds(r.trackIds),
  }));
  const creditsByAlbum = new Map<string, RawCredit[]>();
  for (const c of rawCredits) {
    let list = creditsByAlbum.get(c.albumId);
    if (!list) {
      list = [];
      creditsByAlbum.set(c.albumId, list);
    }
    list.push(c);
  }

  const trackRows = db
    .prepare(
      `SELECT t.id AS id, t.album_id AS albumId, t.title AS title, t.duration_ms AS durationMs,
              a.title AS albumTitle, a.artist_id AS artistId, a.year AS year, a.genres AS genres,
              ar.name AS artistName
         FROM tracks t
         JOIN albums a ON a.id = t.album_id
         LEFT JOIN artists ar ON ar.id = a.artist_id`,
    )
    .all() as {
    id: string;
    albumId: string;
    title: string;
    durationMs: number | null;
    albumTitle: string;
    artistId: string;
    year: number | null;
    genres: string | null;
    artistName: string | null;
  }[];

  const tracks: TrackInfo[] = [];
  for (const row of trackRows) {
    const albumGen = (albumGenres.get(row.albumId) ?? []).filter(isSpecificGenre);
    const fallback = artistGenres.get(row.artistId);
    const genres =
      albumGen.length > 0
        ? albumGen
        : fallback
          ? [...fallback].filter(isSpecificGenre)
          : [];
    const rawTa = trackArtists.get(row.id) ?? [];
    const artistName = row.artistName ?? artistNames.get(row.artistId) ?? 'Unknown Artist';
    const primaryArtistName = rawTa[0]?.name ?? artistName;

    const credits: CreditInfo[] = [];
    for (const c of creditsByAlbum.get(row.albumId) ?? []) {
      if (c.trackIds !== null && !c.trackIds.includes(row.id)) continue;
      const info = roleInfo(c.role);
      credits.push({
        artistId: c.artistId,
        name: c.name,
        role: c.role,
        family: info.family,
        weight: info.weight,
      });
    }

    const year = row.year != null && row.year > 0 ? row.year : albumYear.get(row.albumId) ?? null;
    tracks.push({
      id: row.id,
      albumId: row.albumId,
      albumTitle: row.albumTitle,
      title: row.title,
      durationMs: row.durationMs ?? 0,
      artistId: row.artistId,
      artistName,
      trackArtistIds: rawTa.map((a) => a.id),
      trackArtistNames: rawTa.map((a) => a.name),
      year,
      eraYear: eraYearFor(row.albumTitle, artistName, year),
      albumKey: albumKeyFor(row.albumTitle, artistName),
      genres,
      genreConfidence: genreConfidenceFor(row.albumTitle, artistName, albumGen.length > 0),
      credits,
      key: trackKey(primaryArtistName, row.title),
    });
  }

  return {
    tracks,
    byId: new Map(tracks.map((t) => [t.id, t])),
    genreIdf,
    genreDisplay: genreDisplayMap,
    albumCount,
  };
}

/** Track-level play stats; empty when history has never been used. */
export function loadPlayStats(db: Db): Map<string, PlayStat> {
  const out = new Map<string, PlayStat>();
  if (!hasTable(db, 'plays')) return out;
  const rows = db
    .prepare(
      `SELECT track_id AS trackId, COUNT(*) AS plays,
              SUM(completed) AS completed, MAX(started_at) AS lastPlayedAt
         FROM plays GROUP BY track_id`,
    )
    .all() as { trackId: string; plays: number; completed: number | null; lastPlayedAt: number | null }[];
  for (const r of rows) {
    out.set(r.trackId, {
      plays: r.plays,
      completed: r.completed ?? 0,
      lastPlayedAt: r.lastPlayedAt ?? 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------- profile

function bump(map: Map<string, number>, key: string, by: number): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function normalizeWeights(map: Map<string, number>): void {
  let max = 0;
  for (const v of map.values()) if (v > max) max = v;
  if (max <= 0) return;
  for (const [k, v] of map) map.set(k, v / max);
}

export interface WeightedTrack {
  track: TrackInfo;
  weight: number;
}

export function buildProfile(entries: WeightedTrack[], lib: RadioLibrary): SeedProfile {
  const artists = new Map<string, number>();
  const credits = new Map<string, number>();
  const genres = new Map<string, number>();
  const years = new Map<number, number>();

  for (const { track, weight } of entries) {
    bump(artists, track.artistId, weight);
    track.trackArtistIds.forEach((id, i) => {
      if (id !== track.artistId) bump(artists, id, weight * (i === 0 ? 0.75 : 0.5));
    });
    for (const c of track.credits) {
      const prev = credits.get(c.artistId) ?? 0;
      credits.set(c.artistId, Math.max(prev, weight * c.weight));
    }
    for (const g of track.genres) bump(genres, g, weight);
    if (track.eraYear != null) years.set(track.eraYear, (years.get(track.eraYear) ?? 0) + weight);
  }

  normalizeWeights(artists);
  normalizeWeights(credits);

  let genreTotal = 0;
  for (const [g, w] of genres) {
    genreTotal += (lib.genreIdf.get(g) ?? Math.log(1 + Math.max(0, lib.albumCount))) * w;
  }

  return { artists, credits, genres, years, genreTotal };
}

export function singleProfile(track: TrackInfo, lib: RadioLibrary): SeedProfile {
  return buildProfile([{ track, weight: 1 }], lib);
}

// ---------------------------------------------------------------- scoring

function bestArtistMatch(
  cand: TrackInfo,
  profile: SeedProfile,
): { score: number; id?: string; name?: string } {
  let score = 0;
  let id: string | undefined;
  let name: string | undefined;
  const albumWeight = profile.artists.get(cand.artistId) ?? 0;
  if (albumWeight > score) {
    score = albumWeight;
    id = cand.artistId;
    name = cand.artistName;
  }
  cand.trackArtistIds.forEach((artistId, i) => {
    const w = (profile.artists.get(artistId) ?? 0) * (i === 0 ? 0.9 : 0.7);
    if (w > score) {
      score = w;
      id = artistId;
      name = cand.trackArtistNames[i] ?? cand.artistName;
    }
  });
  return { score: Math.min(1, score), id, name };
}

function bestCreditMatch(
  cand: TrackInfo,
  profile: SeedProfile,
): { score: number; name?: string; role?: string; family?: string } {
  // One contribution per credited person, keeping their strongest role.
  const byPerson = new Map<string, CreditInfo>();
  for (const c of cand.credits) {
    const prev = byPerson.get(c.artistId);
    if (!prev || c.weight > prev.weight) byPerson.set(c.artistId, c);
  }
  let sum = 0;
  let best = 0;
  let name: string | undefined;
  let role: string | undefined;
  let family: string | undefined;
  for (const c of byPerson.values()) {
    const seedWeight = profile.credits.get(c.artistId);
    if (!seedWeight) continue;
    const contribution = Math.sqrt(seedWeight * c.weight);
    sum += contribution;
    if (contribution > best) {
      best = contribution;
      name = c.name;
      role = c.role;
      family = c.family;
    }
  }
  return { score: Math.min(1.5, sum), name, role, family };
}

function bestGenreMatch(
  cand: TrackInfo,
  profile: SeedProfile,
  lib: RadioLibrary,
): { score: number; genre?: string } {
  if (profile.genreTotal <= 0 || cand.genres.length === 0) return { score: 0 };
  let sum = 0;
  let best = 0;
  let bestGenre: string | undefined;
  for (const g of cand.genres) {
    const profileWeight = profile.genres.get(g);
    if (!profileWeight) continue;
    const idf = lib.genreIdf.get(g) ?? 1;
    const value = idf * profileWeight;
    sum += value;
    if (value > best) {
      best = value;
      bestGenre = g;
    }
  }
  return {
    score: Math.min(1, (sum / profile.genreTotal) * cand.genreConfidence),
    genre: bestGenre,
  };
}

function bestYearMatch(
  cand: TrackInfo,
  profile: SeedProfile,
): { score: number; year?: number } {
  const candYear = cand.eraYear;
  if (candYear == null || profile.years.size === 0) return { score: 0 };
  let best = 0;
  for (const [year, weight] of profile.years) {
    const sim = Math.exp(-Math.abs(candYear - year) / 7) * Math.min(1, weight);
    if (sim > best) best = sim;
  }
  return { score: best, year: candYear };
}

export function scoreAgainst(
  cand: TrackInfo,
  profile: SeedProfile,
  lib: RadioLibrary,
): ScoreDetail {
  const artist = bestArtistMatch(cand, profile);
  const credit = bestCreditMatch(cand, profile);
  const genre = bestGenreMatch(cand, profile, lib);
  const era = bestYearMatch(cand, profile);
  return {
    artist: artist.score,
    credit: credit.score,
    genre: genre.score,
    era: era.score,
    ...(artist.id ? { artistId: artist.id, artistName: artist.name } : {}),
    ...(genre.genre ? { genreKey: genre.genre } : {}),
    ...(credit.name
      ? { creditName: credit.name, creditRole: credit.role, creditFamily: credit.family }
      : {}),
    ...(era.year != null ? { year: era.year } : {}),
  };
}

export function similarity(detail: ScoreDetail, w: RadioWeights): number {
  return (
    w.artist * detail.artist + w.credit * detail.credit + w.genre * detail.genre + w.era * detail.era
  );
}

export function historyFor(
  stat: PlayStat | undefined,
  nowMs: number,
  w: RadioWeights,
): HistoryInfo {
  if (!stat || stat.plays <= 0) return { delta: 0 };
  let delta = 0;
  const windowMs = Math.max(0, w.recentHours) * 3_600_000;
  const age = nowMs - stat.lastPlayedAt;
  if (windowMs > 0 && age >= 0 && age < windowMs) {
    // Anything heard in the last N hours is avoided; the closer it was, the stronger.
    delta -= 3 + w.historyRecentPenalty * (1 - age / windowMs);
  }
  const rate = stat.completed / stat.plays;
  delta += (rate - 0.5) * w.historyCompletionWeight * 2;
  if (stat.plays >= 2 && rate <= 0.25) delta -= w.historySkipPenalty;
  if (stat.plays >= 3 && rate >= 0.6) delta += 2;

  let label: string | undefined;
  if (windowMs > 0 && age >= 0 && age < windowMs) label = 'recently played';
  else if (stat.plays >= 3 && rate >= 0.6) label = 'a favourite of yours';
  else if (stat.plays >= 1) label = `played ${stat.plays}×`;
  return { delta, ...(label ? { label } : {}) };
}

// ---------------------------------------------------------------- variety helpers

export function isInterlude(track: TrackInfo): boolean {
  return INTERLUDE_RE.test(track.title) || FILLER_RE.test(track.title);
}

export function playable(track: TrackInfo): boolean {
  return track.durationMs >= MIN_TRACK_MS && !isInterlude(track);
}

/** Do two tracks share a performing artist in any role? */
export function sameArtist(a: TrackInfo, b: TrackInfo): boolean {
  if (a.artistId === b.artistId) return true;
  if (a.trackArtistIds.includes(b.artistId)) return true;
  if (b.trackArtistIds.includes(a.artistId)) return true;
  const other = new Set(b.trackArtistIds);
  return a.trackArtistIds.some((id) => other.has(id));
}

/**
 * Pick one of the top candidates with a softmax over their scores, so repeated
 * radio sessions feel varied while still following the score. Deterministic for
 * a given rng.
 */
export function weightedPick<T extends { total: number }>(
  sorted: T[],
  rng: () => number,
  w: RadioWeights,
): T | undefined {
  const top = sorted.slice(0, Math.max(1, w.topK));
  const first = top[0];
  if (!first) return undefined;
  const temperature = Math.max(0.05, w.temperature);
  const weights = top.map((s) => Math.exp((s.total - first.total) / temperature));
  let sum = 0;
  for (const x of weights) sum += x;
  if (sum <= 0) return first;
  let r = rng() * sum;
  for (let i = 0; i < top.length; i++) {
    r -= weights[i] ?? 0;
    if (r <= 0) return top[i];
  }
  return top[top.length - 1];
}

// ---------------------------------------------------------------- rng

/** Small deterministic PRNG (Mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
