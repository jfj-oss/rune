// Song radio + Discover feed.
//
// Pipeline: seed → ListenBrainz similar recordings + similar artists → Spotify
// search/top-tracks → verify → drop anything owned or dismissed → store the
// Spotify rows (in_library = 0) → return Track-like items.
// Every remote response is cached; radio 12h, feed 6h, mappings 7d.
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { normalizeName } from '../db/index.js';
import { hasTable } from '../myplaylists/schema.js';
import { sharedMbClient, type MbClient } from '../match/mb.js';
import type { SpotifyApi, SpotifyTrack } from '../spotify/api.js';
import { ensureSpotifyLibrarySchema } from '../spotify/library-schema.js';
import { isSpotifyId, spotifyIdOf } from '../spotify/map.js';
import { DiscoverBlockedError, SpotifyDiscoverBudget, type SleepFn, type DiscoverBudgetOptions } from './budget.js';
import { isDismissed, isOwned, loadOwned, type OwnedIndex } from './exclusions.js';
import { SpotifyGateway } from './gateway.js';
import { LastFm } from './lastfm.js';
import { ListenBrainz } from './listenbrainz.js';
import { DiscoverMb } from './mb.js';
import { titleMatches } from './match.js';
import { DiscoverCache, TTL, ensureDiscoverSchema } from './schema.js';
import { storeSpotifyTracks } from './store.js';
import type {
  DiscoverItem,
  DiscoverSeed,
  FeedGroup,
  FeedResponse,
  RawCandidate,
  SimilarResponse,
} from './types.js';

export interface DiscoverSpotify {
  api: SpotifyApi;
  auth?: { status(): { connected: boolean } };
}

export interface DiscoverServiceOptions {
  now?: () => number;
  sleep?: SleepFn;
  /** Injected ListenBrainz fetch (tests / self-check fixtures). */
  fetch?: typeof fetch;
  mb?: MbClient;
  budget?: DiscoverBudgetOptions;
  onWarn?: (msg: string, err?: unknown) => void;
  /** One info line, e.g. when a background refresh is deferred by the daily budget. */
  onInfo?: (msg: string) => void;
  /** How long the owned-index load is reused (default 30s). */
  ownedTtlMs?: number;
  /** Spotify searches spent mapping LB recordings per radio (default 10). */
  radioMappings?: number;
  /** Run the 6h feed refresh in the background when serving stale cache. */
  backgroundRefresh?: boolean;
  /** Randomness for the Refresh button's reshuffle (tests pass a seeded one). */
  random?: () => number;
}

export class DiscoverNotFoundError extends Error {
  constructor(message = 'Track not found') {
    super(message);
    this.name = 'DiscoverNotFoundError';
  }
}

export interface DebugCandidate {
  kind: 'recording' | 'artist';
  title: string;
  artist: string;
  score: number;
  recordingMbid?: string;
  artistMbid?: string;
  reason: string;
}

export interface DebugCandidates {
  seed: DiscoverSeed;
  /** ListenBrainz-only candidate list, with the reason the radio would show. */
  candidates: DebugCandidate[];
}

export interface DiscoverModule {
  similar(trackId: string, opts?: { limit?: number }): Promise<SimilarResponse>;
  feed(opts?: { limit?: number; refresh?: boolean }): Promise<FeedResponse>;
  dismiss(trackId: string): Promise<void>;
  /** LB candidates for a seed, no Spotify calls. Used by the offline self-check. */
  debugCandidates(trackId: string): Promise<DebugCandidates>;
  budget: SpotifyDiscoverBudget;
}

interface SeedRow {
  id: string;
  title: string;
  source: string;
  spotify_uri: string | null;
  mb_recording_id: string | null;
  track_artist_id: string | null;
  track_artist_name: string | null;
  track_artist_mbid: string | null;
  album_artist_id: string | null;
  album_artist_name: string | null;
  album_artist_mbid: string | null;
}

interface CandidateWithTrack {
  track: SpotifyTrack;
  recordingMbid?: string;
  /** The LB title/credit, used for the title+artist ownership check too. */
  rawTitle: string;
  rawArtist: string;
  score: number;
  reason: string;
}

interface BuiltFeedGroup {
  title: string;
  seed?: { id: string; name: string };
  entries: CandidateWithTrack[];
}

const CACHE_RADIO = 'radio:v1:';
const CACHE_FEED = 'feed:v2'; // v2: wider feed (8 seed artists × 4 similar)
const MAX_RADIO = 50;
const MAX_FEED = 100;
/** Your most-played / most-owned artists the feed starts from, and similar artists tried per seed. */
const FEED_SEEDS = 8;
const FEED_RELATED = 4;

export function createDiscover(
  db: Db,
  cfg: Config,
  spotify?: DiscoverSpotify,
  opts: DiscoverServiceOptions = {},
): DiscoverModule {
  ensureDiscoverSchema(db);
  ensureSpotifyLibrarySchema(db);
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  /** Weighted sample of `n` items without replacement (higher weight = likelier, never certain). */
  const sample = <T,>(items: T[], weight: (t: T, i: number) => number, n: number): T[] => {
    const pool = items.map((t, i) => ({ t, w: Math.max(0.0001, weight(t, i)) }));
    const out: T[] = [];
    while (out.length < n && pool.length) {
      let r = random() * pool.reduce((a, p) => a + p.w, 0);
      let k = 0;
      while (k < pool.length - 1 && (r -= pool[k]!.w) > 0) k++;
      out.push(pool.splice(k, 1)[0]!.t);
    }
    return out;
  };
  const cache = new DiscoverCache(db, now);
  const budget = new SpotifyDiscoverBudget(db, { ...opts.budget, now, sleep: opts.sleep });
  const gateway = spotify
    ? new SpotifyGateway(spotify.api, budget, cache, { now, onWarn: opts.onWarn })
    : undefined;
  const lb = new ListenBrainz({
    userAgent: cfg.userAgent,
    cache,
    fetch: opts.fetch,
    now,
    limit: 50,
    onWarn: opts.onWarn,
  });
  const mb = new DiscoverMb(opts.mb ?? sharedMbClient(db, { userAgent: cfg.userAgent, db }));
  const lastfm = cfg.lastfmApiKey
    ? new LastFm(cfg.lastfmApiKey, {
        cache,
        fetch: opts.fetch,
        userAgent: cfg.userAgent,
        onWarn: opts.onWarn,
      })
    : undefined;
  const radioMappings = Math.max(0, opts.radioMappings ?? 10);
  const ownedTtlMs = Math.max(0, opts.ownedTtlMs ?? 30_000);
  const backgroundRefresh = opts.backgroundRefresh ?? true;
  const log = opts.onWarn ?? (() => undefined);
  const info = opts.onInfo ?? (() => undefined);

  let owned: OwnedIndex | null = null;
  let ownedAt = 0;
  function ownedIndex(): OwnedIndex {
    const t = now();
    if (!owned || t - ownedAt > ownedTtlMs) {
      owned = loadOwned(db);
      ownedAt = t;
    }
    return owned;
  }

  function spotifyUsable(): boolean {
    if (!spotify) return false;
    try {
      return spotify.auth ? spotify.auth.status().connected : true;
    } catch {
      return true;
    }
  }

  // ---------- seeds ----------

  async function resolveSeed(trackId: string): Promise<DiscoverSeed> {
    const row = db
      .prepare(
        `SELECT t.id, t.title, t.source, t.spotify_uri, t.mb_recording_id,
                ar.id AS track_artist_id, ar.name AS track_artist_name, ar.mbid AS track_artist_mbid,
                aar.id AS album_artist_id, aar.name AS album_artist_name, aar.mbid AS album_artist_mbid
         FROM tracks t
         JOIN albums a ON a.id = t.album_id
         LEFT JOIN artists aar ON aar.id = a.artist_id
         LEFT JOIN track_artists ta ON ta.track_id = t.id AND ta.position = 0
         LEFT JOIN artists ar ON ar.id = ta.artist_id
         WHERE t.id = ?`,
      )
      .get(trackId) as SeedRow | undefined;

    let title: string;
    let artist: string;
    let artistId: string | undefined;
    let recordingMbid: string | undefined;
    let isrc: string | undefined;
    const spotifyId = isSpotifyId(trackId) ? spotifyIdOf(trackId) : spotifyIdFromUri(row?.spotify_uri);
    const isSpotifyTrack = !!spotifyId && (row?.source === 'spotify' || row === undefined);

    if (row) {
      title = row.title;
      artist = row.track_artist_name ?? row.album_artist_name ?? '';
      artistId = row.track_artist_id ?? row.album_artist_id ?? undefined;
      recordingMbid = row.mb_recording_id ?? undefined;
    } else if (spotifyId && gateway) {
      const info = await gateway.trackInfo(spotifyId);
      if (!info) throw new DiscoverNotFoundError(`Spotify track ${spotifyId} not found`);
      title = info.name;
      artist = info.artists?.[0]?.name ?? '';
      isrc = info.external_ids?.isrc;
    } else {
      throw new DiscoverNotFoundError();
    }

    if (!recordingMbid && gateway && isSpotifyTrack && spotifyId) {
      isrc ??= await gateway.trackIsrc(spotifyId);
      recordingMbid = await mb.recordingByIsrc(isrc);
    }
    if (!recordingMbid) recordingMbid = await mb.searchRecording(title, artist);

    let artistMbid = row?.track_artist_mbid ?? row?.album_artist_mbid ?? undefined;
    if (!artistMbid && artist) artistMbid = await mb.searchArtist(artist);

    const seed: DiscoverSeed = {
      trackId: row?.id ?? trackId,
      title,
      artist,
      ...(artistId ? { artistId } : {}),
      ...(recordingMbid ? { recordingMbid } : {}),
      ...(artistMbid ? { artistMbid } : {}),
    };
    return seed;
  }

  // ---------- filtering ----------

  function filterItems(items: DiscoverItem[], seedTrackId?: string): DiscoverItem[] {
    const index = ownedIndex();
    const seen = new Set<string>();
    const out: DiscoverItem[] = [];
    for (const item of items) {
      const id = item.track.id;
      if (seedTrackId && id === seedTrackId) continue;
      if (seen.has(id) || isDismissed(index, id)) continue;
      const artists = item.track.artists.map((a) => a.name);
      if (isOwned(index, { spotifyId: id, recordingMbid: item.recordingMbid, title: item.track.title, artists })) {
        continue;
      }
      seen.add(id);
      out.push(item);
    }
    return out;
  }

  function isCandidateOwned(index: OwnedIndex, candidate: CandidateWithTrack): boolean {
    const trackId = candidate.track.id;
    if (!trackId) return true;
    if (isDismissed(index, `sp:${trackId}`)) return true;
    const artists = (candidate.track.artists ?? []).map((a) => a.name);
    if (
      isOwned(index, {
        spotifyId: `sp:${trackId}`,
        recordingMbid: candidate.recordingMbid,
        title: candidate.track.name,
        artists,
      })
    ) {
      return true;
    }
    // Also compare the LB title/credit (Spotify may name it "… - Remastered").
    return isOwned(index, {
      title: candidate.rawTitle,
      artists: candidate.rawArtist ? [candidate.rawArtist] : artists,
    });
  }

  // ---------- radio ----------

  async function buildRadio(seed: DiscoverSeed, limit: number): Promise<DiscoverItem[]> {
    if (!gateway) return [];
    const [recordings, lbArtists] = await Promise.all([
      lb.similarRecordings(seed.recordingMbid, 50),
      lb.similarArtists(seed.artistMbid, 30),
    ]);
    // Last.fm is an optional fallback when ListenBrainz has no artist graph.
    const artists: { name?: string; score?: number }[] =
      lbArtists.length || !lastfm
        ? lbArtists
        : (await lastfm.similarArtists(seed.artist, 30)).map((a) => ({
            name: a.name,
            score: a.score,
          }));

    const candidates: RawCandidate[] = [];
    const maxRecordingScore = Math.max(1, ...recordings.map((r) => r.score ?? 0));
    for (const rec of recordings) {
      if (!rec.recording_mbid || !rec.recording_name) continue;
      candidates.push({
        kind: 'recording',
        title: rec.recording_name,
        artist: rec.artist_credit_name ?? '',
        recordingMbid: rec.recording_mbid,
        score: 1000 + ((rec.score ?? 0) / maxRecordingScore) * 100,
        reason: `Similar to “${seed.title}”`,
      });
    }

    const seedArtistKey = normalizeName(seed.artist);
    const related = artists
      .filter((a) => !!a.name && normalizeName(a.name) !== seedArtistKey)
      .slice(0, 4);
    const maxArtistScore = Math.max(1, ...related.map((a) => a.score ?? 0));
    for (const [i, rel] of related.entries()) {
      const name = rel.name;
      if (!name) continue;
      const found = await gateway.findArtist(name);
      if (!found) continue;
      const tracks = await gateway.topTracks(found, 10);
      tracks.forEach((track, index) => {
        candidates.push({
          kind: 'top-track',
          title: track.name,
          artist: track.artists?.[0]?.name ?? name,
          spotifyTrack: track,
          score: 900 + ((rel.score ?? 0) / maxArtistScore) * 100 - i * 20 - index * 3,
          reason: `${name} is similar to ${seed.artist}`,
        });
      });
    }

    // ListenBrainz had nothing: try Last.fm's track graph before falling back to
    // the seed artist's own top tracks.
    if (candidates.length === 0 && lastfm && seed.artist) {
      const similar = await lastfm.similarTracks(seed.artist, seed.title, 20);
      similar.forEach((row, i) => {
        candidates.push({
          kind: 'recording',
          title: row.title,
          artist: row.artist,
          ...(row.recordingMbid ? { recordingMbid: row.recordingMbid } : {}),
          score: 620 - i,
          reason: `Similar to “${seed.title}”`,
        });
      });
    }

    // No data at all (unknown recording + artist): still show more from the
    // seed artist, which is what "song radio" means to most people.
    if (candidates.length === 0 && seed.artist) {
      const own = await gateway.findArtist(seed.artist);
      if (own) {
        const tracks = await gateway.topTracks(own, 12);
        for (const track of tracks) {
          candidates.push({
            kind: 'top-track',
            title: track.name,
            artist: seed.artist,
            spotifyTrack: track,
            score: 700,
            reason: `More from ${seed.artist}`,
          });
        }
      }
    }

    // Map LB recordings in rank order; top-track candidates are already Spotify.
    const sorted = candidates.slice().sort((a, b) => b.score - a.score);
    const mapped: CandidateWithTrack[] = [];
    let searches = 0;
    for (const candidate of sorted) {
      if (candidate.spotifyTrack) {
        if (!candidate.spotifyTrack.id) continue;
        mapped.push({
          track: candidate.spotifyTrack,
          recordingMbid: candidate.recordingMbid,
          rawTitle: candidate.title,
          rawArtist: candidate.artist,
          score: candidate.score + 50, // exact LB recording match, slight edge
          reason: candidate.reason,
        });
        continue;
      }
      if (searches >= radioMappings) continue;
      searches++;
      const found = await gateway.findTrack(candidate.title, candidate.artist);
      if (!found) continue;
      mapped.push({
        track: found,
        recordingMbid: candidate.recordingMbid,
        rawTitle: candidate.title,
        rawArtist: candidate.artist,
        score: candidate.score,
        reason: candidate.reason,
      });
    }

    const index = ownedIndex();
    const chosen: CandidateWithTrack[] = [];
    const seenTracks = new Set<string>();
    const seenSongs = new Set<string>();
    const perArtist = new Map<string, number>();
    for (const candidate of mapped.sort((a, b) => b.score - a.score)) {
      const id = `sp:${candidate.track.id}`;
      if (id === seed.trackId || seenTracks.has(id)) continue;
      if (isCandidateOwned(index, candidate)) continue;
      const firstArtist = candidate.track.artists?.[0]?.name ?? candidate.rawArtist;
      const songKey = `${normalizeName(firstArtist)}\u0000${normalizeName(candidate.track.name)}`;
      if (seenSongs.has(songKey)) continue;
      const count = perArtist.get(normalizeName(firstArtist)) ?? 0;
      if (count >= 4) continue;
      seenTracks.add(id);
      seenSongs.add(songKey);
      perArtist.set(normalizeName(firstArtist), count + 1);
      chosen.push(candidate);
      if (chosen.length >= limit) break;
    }

    return persistCandidates(chosen);
  }

  function persistCandidates(candidates: CandidateWithTrack[]): DiscoverItem[] {
    if (candidates.length === 0) return [];
    const stored = storeSpotifyTracks(
      db,
      candidates.map((c) => c.track),
      { now },
    );
    const out: DiscoverItem[] = [];
    for (const candidate of candidates) {
      const row = stored.get(`sp:${candidate.track.id}`);
      if (!row) continue;
      out.push({
        track: row.track,
        album: row.album,
        reason: candidate.reason,
        spotifyTrackId: candidate.track.id!,
        ...(candidate.recordingMbid ? { recordingMbid: candidate.recordingMbid } : {}),
      });
    }
    return out;
  }

  async function similar(trackId: string, options: { limit?: number } = {}): Promise<SimilarResponse> {
    const limit = clamp(options.limit ?? 30, 1, MAX_RADIO);
    const key = CACHE_RADIO + trackId;
    const cached = cache.get<{ seed: DiscoverSeed; items: DiscoverItem[] }>(key, TTL.radio);
    if (cached) {
      const items = filterItems(cached.value.items, cached.value.seed.trackId).slice(0, limit);
      return {
        status: items.length ? 'ok' : 'empty',
        seed: cached.value.seed,
        items,
        cached: true,
        generatedAt: cached.fetchedAt,
      };
    }

    let seed: DiscoverSeed;
    try {
      seed = await resolveSeed(trackId);
    } catch (err) {
      if (err instanceof DiscoverNotFoundError) throw err;
      log('discover: seed resolution failed', err);
      return unavailableSimilar();
    }

    if (!spotifyUsable() || !gateway) {
      return {
        status: 'unavailable',
        seed,
        items: [],
        cached: false,
        generatedAt: now(),
        message: 'Spotify is not connected — connect it in Settings to find new songs.',
      };
    }

    try {
      const items = await buildRadio(seed, limit);
      cache.set(key, { seed, items });
      return {
        status: items.length ? 'ok' : 'empty',
        seed,
        items,
        cached: false,
        generatedAt: now(),
      };
    } catch (err) {
      if (err instanceof DiscoverBlockedError) {
        return {
          status: 'rate_limited',
          seed,
          items: [],
          cached: false,
          generatedAt: now(),
          blockedUntil: err.until,
          message: blockedMessage(err.until),
        };
      }
      log('discover: radio failed', err);
      return {
        status: 'unavailable',
        seed,
        items: [],
        cached: false,
        generatedAt: now(),
        message: 'Could not reach Spotify right now. Try again in a moment.',
      };
    }
  }

  function unavailableSimilar(): SimilarResponse {
    return {
      status: 'unavailable',
      seed: null,
      items: [],
      cached: false,
      generatedAt: now(),
      message: 'Could not work out what this song is. Try another track.',
    };
  }

  // ---------- feed ----------

  async function pickSeeds(limit: number, vary = false): Promise<{ id: string; name: string; mbid?: string }[]> {
    const weights = new Map<string, number>();
    const add = (artistId: string, weight: number) => {
      if (!artistId) return;
      weights.set(artistId, (weights.get(artistId) ?? 0) + weight);
    };

    if (hasTable(db, 'plays')) {
      const rows = db
        .prepare(
          `SELECT ta.artist_id AS id, count(*) AS n FROM plays p
           JOIN track_artists ta ON ta.track_id = p.track_id AND ta.position = 0
           GROUP BY ta.artist_id`,
        )
        .all() as { id: string; n: number }[];
      for (const row of rows) add(row.id, Math.min(row.n, 200) * 8);
    }

    if (hasTable(db, 'playlist_tracks')) {
      const playlist = db
        .prepare(
          `SELECT ta.artist_id AS id, count(DISTINCT pt.playlist_id) AS n
           FROM playlist_tracks pt
           JOIN track_artists ta ON ta.track_id = pt.track_id AND ta.position = 0
           WHERE pt.playlist_id != 'pl:sp:liked'
           GROUP BY ta.artist_id`,
        )
        .all() as { id: string; n: number }[];
      for (const row of playlist) add(row.id, Math.min(row.n, 50) * 4);

      const liked = db
        .prepare(
          `SELECT ta.artist_id AS id, count(*) AS n
           FROM playlist_tracks pt
           JOIN track_artists ta ON ta.track_id = pt.track_id AND ta.position = 0
           WHERE pt.playlist_id = 'pl:sp:liked'
           GROUP BY ta.artist_id`,
        )
        .all() as { id: string; n: number }[];
      for (const row of liked) add(row.id, Math.min(row.n, 40) * 0.6);
    }

    // Favourite artists of the local library (most owned tracks), a useful
    // signal when there are very few plays or playlists (as in a fresh DB).
    const library = db
      .prepare(
        `SELECT ar.id AS id, count(t.id) AS n
         FROM tracks t JOIN albums a ON a.id = t.album_id
         JOIN artists ar ON ar.id = a.artist_id
         WHERE t.source = 'local'
         GROUP BY ar.id`,
      )
      .all() as { id: string; n: number }[];
    for (const row of library) add(row.id, Math.min(row.n, 40) * 0.3);

    let ranked = [...weights.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.max(limit * 2, 8));
    // Refresh: draw the seeds from a wider pool of your artists, favouring the ones you play most
    if (vary) {
      const pool = [...weights.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.max(limit * 4, 24));
      ranked = sample(pool, ([, w]) => Math.sqrt(w), Math.max(limit * 2, 8));
    }
    if (ranked.length === 0) {
      // Empty database: use the most recently added local album artist.
      const fallback = db
        .prepare(
          `SELECT ar.id, ar.name FROM albums a JOIN artists ar ON ar.id = a.artist_id
           WHERE a.in_library = 1 ORDER BY a.added_at DESC LIMIT ?`,
        )
        .all(limit) as { id: string; name: string }[];
      return fallback.map((r) => ({ id: r.id, name: r.name }));
    }

    const ids = ranked.map(([id]) => id);
    const placeholders = ids.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id, name, mbid FROM artists WHERE id IN (${placeholders})`)
      .all(...ids) as { id: string; name: string; mbid: string | null }[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const seeds: { id: string; name: string; mbid?: string }[] = [];
    for (const [id] of ranked) {
      const row = byId.get(id);
      if (!row) continue;
      let mbid = row.mbid ?? undefined;
      if (!mbid) mbid = await mb.searchArtist(row.name);
      seeds.push({ id: row.id, name: row.name, ...(mbid ? { mbid } : {}) });
      if (seeds.length >= limit) break;
    }
    return seeds;
  }

  async function buildFeed(limit: number, vary?: { avoid: Set<string> }): Promise<FeedGroup[]> {
    if (!gateway) return [];
    const seeds = await pickSeeds(FEED_SEEDS, !!vary);
    const perGroup = clamp(Math.ceil(limit / Math.max(1, seeds.length)) + 2, 6, 15);
    const index = ownedIndex();
    const usedPerArtist = new Map<string, number>();
    // Refresh skips the songs that were just on screen so the list really changes
    const usedTracks = new Set<string>(vary?.avoid ?? []);
    const usedSongs = new Set<string>();
    const built: BuiltFeedGroup[] = [];

    for (const seed of seeds) {
      const groupCandidates: CandidateWithTrack[] = [];
      let related: { name?: string; score?: number }[] = [];
      if (seed.mbid) related = await lb.similarArtists(seed.mbid, 30);
      if (related.length === 0 && lastfm) {
        related = (await lastfm.similarArtists(seed.name, 30)).map((a) => ({
          name: a.name,
          score: a.score,
        }));
      }
      related = related.filter((a) => !!a.name && normalizeName(a.name) !== normalizeName(seed.name));
      // Refresh: pick among the closest dozen similar artists instead of always the top four
      related = vary
        ? sample(related.slice(0, FEED_RELATED * 3), (_, i) => 1 / (1 + i * 0.25), FEED_RELATED)
        : related.slice(0, FEED_RELATED);
      if (related.length > 0) {
        const maxScore = Math.max(1, ...related.map((a) => a.score ?? 0));
        for (const [i, rel] of related.entries()) {
          const name = rel.name;
          if (!name) continue;
          const found = await gateway.findArtist(name);
          if (!found) continue;
          const tracks = await gateway.topTracks(found, 10);
          tracks.forEach((track, position) => {
            groupCandidates.push({
              track,
              rawTitle: track.name,
              rawArtist: track.artists?.[0]?.name ?? name,
              score: ((rel.score ?? 0) / maxScore) * 100 - i * 10 - position * 2,
              reason: `${name} is similar to ${seed.name}`,
            });
          });
        }
      }

      const picked: CandidateWithTrack[] = [];
      for (const candidate of groupCandidates.sort((a, b) => b.score - a.score)) {
        if (!candidate.track.id) continue;
        const id = `sp:${candidate.track.id}`;
        if (usedTracks.has(id) || isCandidateOwned(index, candidate)) continue;
        const firstArtist = candidate.track.artists?.[0]?.name ?? candidate.rawArtist;
        const artistKey = normalizeName(firstArtist);
        const songKey = `${artistKey}\u0000${normalizeName(candidate.track.name)}`;
        if (usedSongs.has(songKey)) continue;
        const count = usedPerArtist.get(artistKey) ?? 0;
        if (count >= 2) continue; // diversify: at most 2 songs per artist in the feed
        usedTracks.add(id);
        usedSongs.add(songKey);
        usedPerArtist.set(artistKey, count + 1);
        picked.push(candidate);
        if (picked.length >= perGroup) break;
      }

      // Top up (or keep a group alive when LB points nowhere / everything is
      // already owned) with popular songs from the seed artist itself.
      if (picked.length < perGroup) {
        const own = await gateway.findArtist(seed.name);
        if (own) {
          const tracks = await gateway.topTracks(own, 12);
          for (const track of tracks) {
            if (!track.id) continue;
            const id = `sp:${track.id}`;
            if (usedTracks.has(id)) continue;
            const candidate: CandidateWithTrack = {
              track,
              rawTitle: track.name,
              rawArtist: seed.name,
              score: 0,
              reason: `More from ${seed.name}`,
            };
            if (isCandidateOwned(index, candidate)) continue;
            const firstArtist = track.artists?.[0]?.name ?? seed.name;
            const artistKey = normalizeName(firstArtist);
            const songKey = `${artistKey}\u0000${normalizeName(track.name)}`;
            if (usedSongs.has(songKey) || (usedPerArtist.get(artistKey) ?? 0) >= 2) continue;
            usedTracks.add(id);
            usedSongs.add(songKey);
            usedPerArtist.set(artistKey, (usedPerArtist.get(artistKey) ?? 0) + 1);
            picked.push(candidate);
            if (picked.length >= perGroup) break;
          }
        }
      }

      if (picked.length > 0) built.push({ title: `Because you listen to ${seed.name}`, seed: { id: seed.id, name: seed.name }, entries: picked });
    }

    const all = built.flatMap((g) => g.entries);
    const stored = storeSpotifyTracks(db, all.map((e) => e.track), { now });
    const groups: FeedGroup[] = [];
    let remaining = limit;
    for (const group of built) {
      const items: DiscoverItem[] = [];
      for (const entry of group.entries) {
        if (remaining <= 0) break;
        const row = stored.get(`sp:${entry.track.id}`);
        if (!row) continue;
        items.push({
          track: row.track,
          album: row.album,
          reason: entry.reason,
          spotifyTrackId: entry.track.id!,
        });
        remaining--;
      }
      if (items.length > 0) groups.push({ title: group.title, ...(group.seed ? { seed: group.seed } : {}), items });
    }
    return groups;
  }

  function feedFromCache(value: { groups: FeedGroup[] }, fetchedAt: number, limit: number): FeedResponse {
    const groups: FeedGroup[] = [];
    let remaining = limit;
    for (const group of value.groups) {
      if (remaining <= 0) break;
      const items = filterItems(group.items).slice(0, remaining);
      if (items.length === 0) continue;
      remaining -= items.length;
      groups.push({ ...group, items });
    }
    return {
      status: groups.length ? 'ok' : 'empty',
      groups,
      cached: true,
      generatedAt: fetchedAt,
    };
  }

  let feedBuild: Promise<FeedGroup[]> | null = null;
  function ensureFeedBuild(limit: number, vary?: { avoid: Set<string> }): Promise<FeedGroup[]> {
    if (!feedBuild) {
      feedBuild = buildFeed(limit, vary).finally(() => {
        feedBuild = null;
      });
    }
    return feedBuild;
  }

  async function feed(options: { limit?: number; refresh?: boolean } = {}): Promise<FeedResponse> {
    const limit = clamp(options.limit ?? 50, 1, MAX_FEED);
    // Read without a TTL so stale data can be served while it refreshes.
    const cached = cache.get<{ groups: FeedGroup[] }>(CACHE_FEED, -1);
    const fresh = !!cached && now() - cached.fetchedAt <= TTL.feed;

    // "Refreshed at most every 6 hours": both a page load and the Refresh button
    // use the cached feed while it is fresh.
    if (fresh && cached && !options.refresh) return feedFromCache(cached.value, cached.fetchedAt, limit);

    if (!spotifyUsable() || !gateway) {
      if (cached) {
        return {
          ...feedFromCache(cached.value, cached.fetchedAt, limit),
          message: 'Spotify is not connected — showing saved recommendations.',
        };
      }
      return {
        status: 'unavailable',
        groups: [],
        cached: false,
        generatedAt: now(),
        message: 'Spotify is not connected — connect it in Settings to find new songs.',
      };
    }

    // Stale-while-revalidate: a normal page load gets the old feed instantly and
    // a background refresh runs; the explicit Refresh button waits for fresh data.
    if (cached && !options.refresh && backgroundRefresh) {
      // A background refresh is the first thing to defer when Spotify's daily budget is low.
      const level = spotify?.api.budgetLevel() ?? 'normal';
      if (level === 'low' || level === 'out') {
        info('spotify budget low: deferring discover feed refresh');
        return feedFromCache(cached.value, cached.fetchedAt, limit);
      }
      void ensureFeedBuild(limit)
        .then((groups) => cache.set(CACHE_FEED, { groups }))
        .catch((err) => log('discover: background feed refresh failed', err));
      return feedFromCache(cached.value, cached.fetchedAt, limit);
    }

    // The Refresh button builds a new mix, unless Spotify's daily budget is nearly spent
    let vary: { avoid: Set<string> } | undefined;
    if (options.refresh && cached) {
      const level = spotify?.api.budgetLevel() ?? 'normal';
      if (level === 'low' || level === 'out') {
        return {
          ...feedFromCache(cached.value, cached.fetchedAt, limit),
          notice: "Spotify's daily limit is nearly used up — showing the saved picks. Try Refresh again tomorrow.",
        };
      }
      vary = { avoid: new Set(cached.value.groups.flatMap((g) => g.items.map((i) => `sp:${i.spotifyTrackId}`))) };
    }

    try {
      const groups = await ensureFeedBuild(limit, vary);
      cache.set(CACHE_FEED, { groups });
      return {
        status: groups.length ? 'ok' : 'empty',
        groups,
        cached: false,
        generatedAt: now(),
      };
    } catch (err) {
      if (err instanceof DiscoverBlockedError) {
        if (cached) {
          return {
            ...feedFromCache(cached.value, cached.fetchedAt, limit),
            blockedUntil: err.until,
            notice: blockedMessage(err.until),
          };
        }
        return {
          status: 'rate_limited',
          groups: [],
          cached: false,
          generatedAt: now(),
          blockedUntil: err.until,
          message: blockedMessage(err.until),
        };
      }
      log('discover: feed failed', err);
      if (cached) {
        return {
          ...feedFromCache(cached.value, cached.fetchedAt, limit),
          notice: 'Could not refresh recommendations right now — showing saved ones.',
        };
      }
      return {
        status: 'unavailable',
        groups: [],
        cached: false,
        generatedAt: now(),
        message: 'Could not reach Spotify right now. Try again in a moment.',
      };
    }
  }

  // ---------- dismiss ----------

  function dismiss(trackId: string): Promise<void> {
    const raw = trackId.trim();
    if (!raw || raw.length > 200) throw new DiscoverNotFoundError('trackId required');
    const id = raw.startsWith('sp:') ? raw : /^[A-Za-z0-9]{22}$/.test(raw) ? `sp:${raw}` : raw;
    db.prepare(
      `INSERT INTO discover_dismissed (track_id, dismissed_at) VALUES (?, ?)
       ON CONFLICT(track_id) DO UPDATE SET dismissed_at = excluded.dismissed_at`,
    ).run(id, now());
    // The current process should stop showing it immediately (cache filtering
    // checks this set); force a reload on the next request.
    owned = null;
    ownedAt = 0;
    return Promise.resolve();
  }

  // ---------- debug (LB/MB only) ----------

  async function debugCandidates(trackId: string): Promise<DebugCandidates> {
    const seed = await resolveSeed(trackId);
    const [recordings, artists] = await Promise.all([
      lb.similarRecordings(seed.recordingMbid, 50),
      lb.similarArtists(seed.artistMbid, 30),
    ]);
    const candidates: DebugCandidate[] = [];
    for (const rec of recordings) {
      if (!rec.recording_mbid || !rec.recording_name) continue;
      candidates.push({
        kind: 'recording',
        title: rec.recording_name,
        artist: rec.artist_credit_name ?? '',
        score: rec.score ?? 0,
        recordingMbid: rec.recording_mbid,
        reason: `Similar to “${seed.title}”`,
      });
    }
    for (const artist of artists) {
      if (!artist.name) continue;
      candidates.push({
        kind: 'artist',
        title: artist.name,
        artist: seed.artist,
        score: artist.score ?? 0,
        artistMbid: artist.artist_mbid,
        reason: `${artist.name} is similar to ${seed.artist}`,
      });
    }
    return { seed, candidates };
  }

  return { similar, feed, dismiss, debugCandidates, budget };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(n) ? Math.round(n) : min));
}

export function blockedMessage(until: number): string {
  const when = new Date(until).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `Spotify is rate-limiting rune — try again after ${when}.`;
}

/** Accept `sp:<id>` ids as well as stored `spotify:track:<id>` URIs. */
function spotifyIdFromUri(uri: string | null | undefined): string | undefined {
  if (!uri) return undefined;
  if (uri.startsWith('spotify:track:')) return uri.slice('spotify:track:'.length) || undefined;
  if (isSpotifyId(uri)) return spotifyIdOf(uri) || undefined;
  return undefined;
}

/** Exported for the web test/type parity and future reuse. */
export function sameSong(title: string, candidateTitle: string): boolean {
  return titleMatches(title, candidateTitle);
}
