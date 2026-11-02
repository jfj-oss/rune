// Worker O — "rune radio".
//
//   createRadio(db, opts?) -> Radio
//   registerRadioRoutes(app, radio) adds:
//     POST /radio/start { from: 'track' | 'album' | 'artist', id, count? }
//     POST /radio/next  { trackIds, recentTrackIds, count? }
//
// Both routes return the picked track ids plus a human explanation for each
// pick ("same producer: Toby Wright", "Grunge, 1994") so the UI can show why
// the radio chose a song. All scoring is local: genres, artists, credits,
// era and (when the history module has created it) the `plays` table.
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import {
  DEFAULT_WEIGHTS,
  buildProfile,
  historyFor,
  isInterlude,
  loadLibrary,
  loadPlayStats,
  mulberry32,
  playable,
  sameArtist,
  scoreAgainst,
  similarity,
  singleProfile,
  weightedPick,
  type HistoryInfo,
  type PlayStat,
  type RadioLibrary,
  type RadioWeights,
  type ScoreDetail,
  type SeedProfile,
  type TrackInfo,
  type WeightedTrack,
} from './engine.js';

export {
  DEFAULT_WEIGHTS,
  loadLibrary,
  mulberry32,
  scoreAgainst,
  type RadioWeights,
  type ScoreDetail,
  type TrackInfo,
} from './engine.js';

export const DEFAULT_RADIO_COUNT = 20;
export const MAX_RADIO_COUNT = 100;

export type RadioFrom = 'track' | 'album' | 'artist';

export interface RadioSeed {
  /** The current queue / the tracks radio is continuing from. Ordered oldest → newest. */
  trackIds: string[];
  /** Everything already heard in this session. Never repeated. */
  recentTrackIds: string[];
}

export interface RadioPick {
  trackId: string;
  /** Plain-language reason for the UI. */
  reason: string;
}

export interface RadioCallOptions {
  /** Injected RNG (0..1). See mulberry32() for a deterministic one. */
  rng?: () => number;
  /** Convenience alternative to `rng`: a fresh mulberry32 is created per call. */
  randomSeed?: number;
  /** Injectable clock for the listening-history window (default Date.now). */
  now?: () => number;
  /** Per-call weight overrides (mainly for tuning/tests). */
  weights?: Partial<RadioWeights>;
}

export interface RadioOptions extends RadioCallOptions {
  /** Defaults applied when a call does not pass its own. */
  weights?: Partial<RadioWeights>;
}

export interface Radio {
  /** Continue a session from its seed tracks, avoiding everything in recentTrackIds. */
  next(seed: RadioSeed, count?: number, opts?: RadioCallOptions): string[];
  fromTrack(id: string, n?: number, opts?: RadioCallOptions): string[];
  fromAlbum(id: string, n?: number, opts?: RadioCallOptions): string[];
  fromArtist(id: string, n?: number, opts?: RadioCallOptions): string[];

  /** Same as the methods above but with the per-track reasons the routes return. */
  planNext(seed: RadioSeed, count?: number, opts?: RadioCallOptions): RadioPick[];
  planFromTrack(id: string, n?: number, opts?: RadioCallOptions): RadioPick[];
  planFromAlbum(id: string, n?: number, opts?: RadioCallOptions): RadioPick[];
  planFromArtist(id: string, n?: number, opts?: RadioCallOptions): RadioPick[];

  /** Used by the route to answer 404 for a missing seed. */
  seedExists(from: RadioFrom, id: string): boolean;
}

// ---------------------------------------------------------------- reason text

function creditReason(detail: ScoreDetail): string {
  const family = (detail.creditFamily ?? 'credit').toLowerCase();
  return `same ${family}: ${detail.creditName ?? 'shared credit'}`;
}

function genreReason(track: TrackInfo, detail: ScoreDetail, lib: RadioLibrary): string {
  const key = detail.genreKey;
  const display = key ? lib.genreDisplay.get(key) ?? key : '';
  if (display && track.year != null) return `${display}, ${track.year}`;
  if (display) return display;
  return track.year != null ? `${track.year}, same era` : 'from your library';
}

/**
 * Explain the strongest reason this track was chosen. The anchor detail is the
 * one that contributed most (seed profile or the previous track), so the text
 * always describes something the listener can hear in the queue.
 */
export function describePick(
  track: TrackInfo,
  detail: ScoreDetail,
  history: HistoryInfo,
  lib: RadioLibrary,
  w: RadioWeights,
): string {
  const components: { kind: 'artist' | 'credit' | 'genre' | 'era'; value: number }[] = [
    { kind: 'artist', value: w.artist * detail.artist },
    { kind: 'credit', value: w.credit * detail.credit },
    { kind: 'genre', value: w.genre * detail.genre },
    { kind: 'era', value: w.era * detail.era },
  ];
  let best = components[0]!;
  for (const c of components) if (c.value > best.value) best = c;

  // Same album artist: "more from X" reads better than listing an internal
  // production credit such as "same producer: Alice in Chains".
  if (detail.artistId === track.artistId && detail.artist >= 0.8) {
    return `more from ${track.artistName}`;
  }

  // History is only used as the headline when it clearly drove the pick
  // (e.g. a beloved track in a very small library).
  if (history.label && history.delta > 0 && history.delta >= best.value) return history.label;

  if (best.value < 0.03) return history.label ?? 'from your library';

  switch (best.kind) {
    case 'artist':
      if (detail.artistId && detail.artistId !== track.artistId) {
        return `features ${detail.artistName ?? track.artistName}`;
      }
      return `more from ${track.artistName}`;
    case 'credit':
      return creditReason(detail);
    case 'genre':
      return genreReason(track, detail, lib);
    case 'era':
    default:
      // A meaningful genre match reads better than "same era", and "Grunge,
      // 1994" already carries the year.
      if (detail.genre >= 0.12) return genreReason(track, detail, lib);
      return track.year != null ? `${track.year}, same era` : 'from your library';
  }
}

// ---------------------------------------------------------------- generation

interface Scored {
  track: TrackInfo;
  total: number;
  seed: ScoreDetail;
  prev?: ScoreDetail;
  history: HistoryInfo;
}

interface GenerateInput {
  lib: RadioLibrary;
  plays: Map<string, PlayStat>;
  seedProfile: SeedProfile;
  /** Tracks already in the queue (excluded from the result). */
  excludeIds: Set<string>;
  /** Normalised artist|title keys already heard (collapses local/Spotify duplicates). */
  excludeKeys: Set<string>;
  /** Tail of the existing session, used for the album cap / artist adjacency. */
  contextTracks: TrackInfo[];
  count: number;
  rng: () => number;
  nowMs: number;
  weights: RadioWeights;
}

function generate(input: GenerateInput): RadioPick[] {
  const { lib, plays, seedProfile, excludeIds, excludeKeys, count, rng, nowMs, weights } = input;
  const usedIds = new Set(excludeIds);
  const usedKeys = new Set(excludeKeys);
  const picks: { track: TrackInfo; reason: string }[] = [];
  // Album ids in the last N picks (including the pre-existing session tail).
  let albumHistory: string[] = input.contextTracks.map((t) => t.albumKey);
  let prevTrack: TrackInfo | undefined = input.contextTracks[input.contextTracks.length - 1];
  let prevProfile: SeedProfile | undefined = prevTrack ? singleProfile(prevTrack, lib) : undefined;

  // Candidates that could ever be played. The pool is library-sized (≈10k) so
  // rebuilding it per pick is fine and keeps the code simple.
  const pool = lib.tracks.filter(
    (t) => playable(t) && !usedIds.has(t.id) && !usedKeys.has(t.key),
  );

  while (picks.length < count) {
    const tail = [...input.contextTracks, ...picks.map((p) => p.track)];
    const artistTail = tail.slice(-4);
    const albumTail = tail.slice(-6);
    const scored: Scored[] = [];
    for (const track of pool) {
      if (usedIds.has(track.id) || usedKeys.has(track.key)) continue;
      const seed = scoreAgainst(track, seedProfile, lib);
      const prev = prevProfile ? scoreAgainst(track, prevProfile, lib) : undefined;
      const sim = prev
        ? weights.seedBlend * similarity(seed, weights) + weights.prevBlend * similarity(prev, weights)
        : similarity(seed, weights);
      const history = historyFor(plays.get(track.id), nowMs, weights);
      // Softly discourage a fourth consecutive Daft Punk album side even when
      // the hard adjacency rule does not apply.
      let repetition = 0;
      for (const t of artistTail) if (sameArtist(track, t)) repetition -= weights.artistRepeatPenalty;
      for (const t of albumTail) if (t.albumKey === track.albumKey) repetition -= weights.albumRepeatPenalty;
      scored.push({ track, total: sim + history.delta + repetition, seed, prev, history });
    }
    if (scored.length === 0) break;

    const albumCountInWindow = (albumId: string): number => {
      let n = 0;
      // 9 previous entries + the candidate = the "any 10" window.
      for (let i = Math.max(0, albumHistory.length - 9); i < albumHistory.length; i++) {
        if (albumHistory[i] === albumId) n++;
      }
      return n;
    };

    const withinAlbumCap = (s: Scored): boolean => albumCountInWindow(s.track.albumKey) < 2;
    const notSameAlbumAsPrev = (s: Scored): boolean => !prevTrack || s.track.albumKey !== prevTrack.albumKey;
    const notSameArtistAsPrev = (s: Scored): boolean => !prevTrack || !sameArtist(s.track, prevTrack);
    // A track must share *something* musical with the session's seed. Era
    // alone ("both albums are from 2014") is not a reason to play a random
    // soundtrack cue, and a single broad genre ("electronic") is not enough
    // either. The gate deliberately ignores the previous pick: otherwise one
    // album's funky B-side lets the session drift into unrelated music.
    // Era-only candidates are used only once the related pool is exhausted.
    const strongDetail = (d: ScoreDetail): boolean =>
      d.artist >= 0.2 || d.credit >= 0.25 || d.genre >= 0.2;
    const related = (s: Scored): boolean => strongDetail(s.seed);

    const strict = (s: Scored): boolean =>
      withinAlbumCap(s) && notSameAlbumAsPrev(s) && notSameArtistAsPrev(s);
    const anyRelated = scored.some(related);
    let pool2 = scored.filter((s) => strict(s) && related(s));
    // Relax "different album from the previous track", keeping the related gate.
    if (pool2.length === 0) pool2 = scored.filter((s) => withinAlbumCap(s) && notSameArtistAsPrev(s) && related(s));
    // If the seed has related music in the library, never water the session
    // down with unrelated tracks just to hit the requested count — stop early
    // instead. Unrelated fallback is only for seeds with no usable signal.
    if (pool2.length === 0) {
      if (anyRelated) break;
      pool2 = scored.filter(strict);
      if (pool2.length === 0) pool2 = scored.filter((s) => withinAlbumCap(s) && notSameArtistAsPrev(s));
    }
    if (pool2.length === 0) break;

    pool2.sort((a, b) => b.total - a.total || a.track.id.localeCompare(b.track.id));
    const chosen = weightedPick(pool2, rng, weights);
    if (!chosen) break;

    // Attribute the reason to the previous track only when it explains the
    // pick with something stronger than "same era"; otherwise explain it via
    // the session seed.
    const usePrev =
      chosen.prev !== undefined &&
      strongDetail(chosen.prev) &&
      weights.prevBlend * similarity(chosen.prev, weights) >
        weights.seedBlend * similarity(chosen.seed, weights);
    const detail = usePrev && chosen.prev ? chosen.prev : chosen.seed;
    const reason = describePick(chosen.track, detail, chosen.history, lib, weights);

    usedIds.add(chosen.track.id);
    usedKeys.add(chosen.track.key);
    picks.push({ track: chosen.track, reason });
    albumHistory.push(chosen.track.albumKey);
    if (albumHistory.length > 32) albumHistory = albumHistory.slice(-32);
    prevTrack = chosen.track;
    prevProfile = singleProfile(chosen.track, lib);
  }

  return picks.map((p) => ({ trackId: p.track.id, reason: p.reason }));
}

// ---------------------------------------------------------------- radio object

function clampCount(n: number | undefined, fallback: number): number {
  if (n === undefined || !Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_RADIO_COUNT);
}

function uniqueIds(ids: string[] | undefined): string[] {
  if (!Array.isArray(ids)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function createRadio(db: Db, options: RadioOptions = {}): Radio {
  const trackExistsStmt = db.prepare('SELECT 1 AS ok FROM tracks WHERE id = ?');
  const albumExistsStmt = db.prepare('SELECT 1 AS ok FROM albums WHERE id = ?');
  const artistExistsStmt = db.prepare('SELECT 1 AS ok FROM artists WHERE id = ?');

  const callSettings = (opts: RadioCallOptions | undefined) => {
    const weights: RadioWeights = {
      ...DEFAULT_WEIGHTS,
      ...options.weights,
      ...opts?.weights,
    };
    let rng: () => number;
    if (opts?.rng) rng = opts.rng;
    else if (opts?.randomSeed != null) rng = mulberry32(opts.randomSeed);
    else if (options.rng) rng = options.rng;
    else if (options.randomSeed != null) rng = mulberry32(options.randomSeed);
    else rng = Math.random;
    const now = opts?.now ?? options.now ?? Date.now;
    return { weights, rng, now };
  };

  /** Profile for the seed tracks; the newest tracks of a long queue weigh more. */
  function seedEntries(tracks: TrackInfo[], recency: boolean): WeightedTrack[] {
    if (!recency || tracks.length <= 1) return tracks.map((track) => ({ track, weight: 1 }));
    return tracks.map((track, i) => {
      const distance = tracks.length - 1 - i;
      return { track, weight: Math.max(0.15, Math.pow(0.75, distance)) };
    });
  }

  function run(
    lib: RadioLibrary,
    entries: WeightedTrack[],
    excludeTracks: TrackInfo[],
    contextTracks: TrackInfo[],
    n: number | undefined,
    opts: RadioCallOptions | undefined,
  ): RadioPick[] {
    const { weights, rng, now } = callSettings(opts);
    const count = clampCount(n, DEFAULT_RADIO_COUNT);
    if (entries.length === 0) return [];
    const seedProfile = buildProfile(entries, lib);
    const excludeIds = new Set(excludeTracks.map((t) => t.id));
    const excludeKeys = new Set(excludeTracks.map((t) => t.key));
    const plays = loadPlayStats(db);
    return generate({
      lib,
      plays,
      seedProfile,
      excludeIds,
      excludeKeys,
      contextTracks,
      count,
      rng,
      nowMs: now(),
      weights,
    });
  }

  function planNext(seed: RadioSeed, count?: number, opts?: RadioCallOptions): RadioPick[] {
    const lib = loadLibrary(db);
    const seedIds = uniqueIds(seed?.trackIds).slice(-24);
    const recentIds = uniqueIds(seed?.recentTrackIds);
    const seedTracks = seedIds
      .map((id) => lib.byId.get(id))
      .filter((t): t is TrackInfo => t !== undefined);
    if (seedTracks.length === 0) return [];
    const recentTracks = recentIds
      .map((id) => lib.byId.get(id))
      .filter((t): t is TrackInfo => t !== undefined);
    // Never replay anything in the seed queue or session.
    const exclude = [...seedTracks, ...recentTracks];
    const context = [...recentTracks, ...seedTracks].slice(-9);
    return run(lib, seedEntries(seedTracks, true), exclude, context, count, opts);
  }

  function planFromTrack(id: string, n?: number, opts?: RadioCallOptions): RadioPick[] {
    const lib = loadLibrary(db);
    const seed = lib.byId.get(id);
    if (!seed) return [];
    return run(lib, seedEntries([seed], false), [seed], [], n, opts);
  }

  function planFromAlbum(id: string, n?: number, opts?: RadioCallOptions): RadioPick[] {
    const lib = loadLibrary(db);
    const albumTracks = lib.tracks.filter((t) => t.albumId === id);
    if (albumTracks.length === 0) return [];
    // Exclude every edition/duplicate press of this album, not just this id.
    const keys = new Set(albumTracks.map((t) => t.albumKey));
    const exclude = lib.tracks.filter((t) => keys.has(t.albumKey));
    return run(lib, seedEntries(albumTracks, false), exclude, [], n, opts);
  }

  function planFromArtist(id: string, n?: number, opts?: RadioCallOptions): RadioPick[] {
    const lib = loadLibrary(db);
    const artistTracks = lib.tracks.filter(
      (t) => t.artistId === id || t.trackArtistIds.includes(id),
    );
    if (artistTracks.length === 0) return [];
    // Artist radio may (and should) keep playing the artist, so seed tracks are
    // not excluded; the variety rules keep it from becoming endless album sides.
    return run(lib, seedEntries(artistTracks, false), [], [], n, opts);
  }

  return {
    next: (seed, count, opts) => planNext(seed, count, opts).map((p) => p.trackId),
    fromTrack: (id, n, opts) => planFromTrack(id, n, opts).map((p) => p.trackId),
    fromAlbum: (id, n, opts) => planFromAlbum(id, n, opts).map((p) => p.trackId),
    fromArtist: (id, n, opts) => planFromArtist(id, n, opts).map((p) => p.trackId),
    planNext,
    planFromTrack,
    planFromAlbum,
    planFromArtist,
    seedExists(from, id) {
      if (typeof id !== 'string' || !id) return false;
      if (from === 'track') return trackExistsStmt.get(id) !== undefined;
      if (from === 'album') return albumExistsStmt.get(id) !== undefined;
      if (from === 'artist') return artistExistsStmt.get(id) !== undefined;
      return false;
    },
  };
}

// ---------------------------------------------------------------- routes

function parseCount(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  return clampCount(n, DEFAULT_RADIO_COUNT);
}

function bodyObject(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

/** Mount the radio routes (no /api prefix; the caller adds it). */
export function registerRadioRoutes(app: FastifyInstance, radio: Radio): void {
  app.post<{ Body: unknown }>('/radio/start', async (request, reply) => {
    const body = bodyObject(request.body);
    const from = body.from;
    if (from !== 'track' && from !== 'album' && from !== 'artist') {
      return reply.code(400).send({ error: "from must be 'track', 'album' or 'artist'" });
    }
    const id = body.id;
    if (typeof id !== 'string' || id.length === 0) {
      return reply.code(400).send({ error: 'id required' });
    }
    const count = parseCount(body.count);
    if (count === null) return reply.code(400).send({ error: 'count must be a number' });
    if (!radio.seedExists(from, id)) return reply.code(404).send({ error: 'not found' });

    const picks =
      from === 'track'
        ? radio.planFromTrack(id, count)
        : from === 'album'
          ? radio.planFromAlbum(id, count)
          : radio.planFromArtist(id, count);
    return { trackIds: picks.map((p) => p.trackId), picks };
  });

  app.post<{ Body: unknown }>('/radio/next', async (request, reply) => {
    const body = bodyObject(request.body);
    const rawTrackIds = body.trackIds;
    const rawRecent = body.recentTrackIds;
    if (!Array.isArray(rawTrackIds) || rawTrackIds.some((x) => typeof x !== 'string')) {
      return reply.code(400).send({ error: 'trackIds must be an array of track ids' });
    }
    if (rawRecent !== undefined && (!Array.isArray(rawRecent) || rawRecent.some((x) => typeof x !== 'string'))) {
      return reply.code(400).send({ error: 'recentTrackIds must be an array of track ids' });
    }
    const count = parseCount(body.count);
    if (count === null) return reply.code(400).send({ error: 'count must be a number' });

    const picks = radio.planNext(
      {
        trackIds: rawTrackIds as string[],
        recentTrackIds: (rawRecent as string[] | undefined) ?? [],
      },
      count,
    );
    return { trackIds: picks.map((p) => p.trackId), picks };
  });
}

// Re-exported for tests / the self-check script.
export { isInterlude, playable, sameArtist };
