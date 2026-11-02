// Worker B — MusicBrainz matching + Cover Art Archive.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/index.js';
import type { Config } from '../config.js';
import type { Matcher } from '../modules.js';
import type { MbRelease, MbSearchRelease } from './mb.js';
import {
  MbClient,
  artistCreditName,
  searchItemTrackCount,
  sharedMbClient,
  yearFromDate,
  type FetchLike,
  type NowFn,
  type RateLimiter,
  type SleepFn,
} from './mb.js';
import {
  isPlaceholderTitle,
  isSoundtrackAlbum,
  normalizeTitle,
  preliminaryScore,
  scoreRelease,
  trackCountCompatible,
  type LocalAlbumForMatch,
  type LocalTrackForMatch,
} from './scoring.js';
import { countQueries, releaseQueries, titleVariants, type ReleaseQuery } from './query.js';
import {
  applyRelease,
  getAlbumRow,
  getAlbumTracks,
  type LocalAlbumRow,
  type LocalTrackRow,
} from './apply.js';

export { MbClient, MbHttpError, RateLimiter, escapeLucene } from './mb.js';
export { collectCredits, rolesForRelation } from './credits.js';
export {
  normalizeTitle,
  isPlaceholderTitle,
  titleSimilarity,
  artistSimilarity,
  scoreRelease,
  preliminaryScore,
  titleCase,
  isGenericArtist,
  isSoundtrackTitle,
} from './scoring.js';
export { releaseQueries, titleVariants, artistVariants, querySafe } from './query.js';
export { applyRelease } from './apply.js';

/** Below this best-candidate score the album is left unmatched (manual fix offered). */
export const MIN_APPLY_CONFIDENCE = 0.6;

export interface RematchOptions {
  /** Stop after this many albums (useful for long, resumable self-checks). */
  limit?: number;
  /** Stop after this much wall-clock time; unprocessed albums stay queued. */
  maxMs?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface RematchStats {
  attempted: number;
  /** Previously unmatched albums that are now matched. */
  matched: number;
  /** Previously weak matches whose confidence improved. */
  improved: number;
  /** Queued albums not attempted because `limit`/`maxMs` stopped the pass. */
  remaining: number;
}

export interface MatchOptions {
  /** Injectable fetch for fully offline tests / fixture replay. */
  fetch?: FetchLike;
  sleep?: SleepFn;
  now?: NowFn;
  rateLimitMs?: number;
  cacheTtlMs?: number;
  maxRetries?: number;
  limiter?: RateLimiter;
  /** Disable cover-art downloads (recording script / offline tests). */
  downloadCovers?: boolean;
}

function roundScore(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function toLocalForMatch(album: LocalAlbumRow, tracks: LocalTrackRow[]): LocalAlbumForMatch {
  return {
    title: album.title,
    artist: album.artist_name ?? '',
    year: album.year,
    format: album.format,
    folderPath: album.folder_path,
    tracks: tracks.map(
      (t): LocalTrackForMatch => ({
        id: t.id,
        title: t.title,
        disc: t.disc,
        number: t.number,
        durationMs: t.duration_ms,
      }),
    ),
  };
}

function usableTitle(local: LocalAlbumForMatch): string | undefined {
  const title = local.title.trim();
  return isPlaceholderTitle(title) ? undefined : title;
}

/** Local tags too vague to drive a title search; also search by track titles. */
function tagsAreWeak(local: LocalAlbumForMatch): boolean {
  const title = local.title.trim();
  const artist = local.artist.trim();
  if (!title || !artist) return true;
  if (isPlaceholderTitle(title)) return true;
  if (/^(unknown|unknown artist|\[unknown\])$/i.test(artist)) return true;
  return false;
}

interface RankedCandidate {
  item: MbSearchRelease;
  preliminary: number;
}

export function createMatcher(db: Db, cfg: Config, options: MatchOptions = {}): Matcher {
  const fetchImpl: FetchLike = options.fetch ?? globalThis.fetch.bind(globalThis);
  const clientOpts = {
    userAgent: cfg.userAgent,
    db,
    fetch: fetchImpl,
    sleep: options.sleep,
    now: options.now,
    rateLimitMs: options.rateLimitMs ?? 1000,
    cacheTtlMs: options.cacheTtlMs,
    maxRetries: options.maxRetries,
    limiter: options.limiter,
  };
  // Production shares one client/limiter with artist meta and album meta. Any
  // injected behaviour (fixtures, fake clock) gets its own client.
  const custom =
    options.fetch != null ||
    options.sleep != null ||
    options.now != null ||
    options.limiter != null ||
    options.rateLimitMs != null ||
    options.cacheTtlMs != null ||
    options.maxRetries != null;
  const client = custom ? new MbClient(clientOpts) : sharedMbClient(db, clientOpts);
  const downloadCovers = options.downloadCovers ?? true;

  async function searchCandidates(local: LocalAlbumForMatch): Promise<MbSearchRelease[]> {
    const merged = new Map<string, MbSearchRelease>();

    const absorb = (items: MbSearchRelease[]): void => {
      for (const item of items) if (!merged.has(item.id)) merged.set(item.id, item);
    };

    /**
     * A search hit that already looks right: no need to try more variants.
     * Requires the exact track count (not merely a bonus-track subset): a
     * deluxe local rip should still trigger the `tracks:N` query that finds
     * the matching deluxe edition instead of settling for the standard one.
     */
    const localCount = local.tracks.length;
    const hasStrongCandidate = (): boolean => {
      for (const item of merged.values()) {
        const mbCount = searchItemTrackCount(item);
        const exactCount = localCount <= 0 || mbCount <= 0 || mbCount === localCount;
        if (!exactCount) continue;
        if (!trackCountCompatible(localCount, mbCount)) continue;
        if (preliminaryScore(local, item) >= 0.82) return true;
      }
      return false;
    };

    const runQuery = async (query: ReleaseQuery, limit: number): Promise<void> => {
      try {
        absorb(
          await client.searchRelease(query.title, query.artist ?? '', limit, query.trackCount),
        );
      } catch {
        // Offline replay may not have this URL; treat as no results.
      }
    };

    // Primary query is byte-identical to the old matcher (raw tags), then the
    // progressively cleaner variants (edition suffixes, disc prefixes, folder
    // name, punctuation folds, title repeated with the artist).
    for (const query of releaseQueries(local)) {
      if (hasStrongCandidate()) break;
      await runQuery(query, 15);
    }

    // No edition of the right size yet: ask MusicBrainz to filter by track
    // count (finds a deluxe/anniversary edition outside the top relevance hits).
    if (!hasStrongCandidate()) {
      for (const query of countQueries(local)) {
        if (hasStrongCandidate()) break;
        await runQuery(query, 10);
      }
    }

    // Weak tags: also search by the first few local track titles.
    if (!hasStrongCandidate() && tagsAreWeak(local) && local.tracks.length > 0) {
      try {
        const titles = local.tracks.slice(0, 3).map((t) => t.title);
        absorb(
          await client.searchReleaseByTracks(titles, {
            artist: local.artist.trim() || undefined,
            releaseTitle: usableTitle(local),
            limit: 15,
          }),
        );
      } catch {
        // ignore
      }
    }

    // Last resort: search the release *group* (survives edition differences),
    // then browse its releases and rank them by track count/durations.
    if (!hasStrongCandidate()) {
      const groupTitle = normalizeTitle(titleVariants(local)[0] ?? local.title) || local.title;
      const groupArtist = isSoundtrackAlbum(local) ? undefined : local.artist.trim() || undefined;
      try {
        const groups = await client.searchReleaseGroups(groupTitle, 5, groupArtist);
        for (const group of groups.slice(0, 3)) {
          try {
            absorb(await client.browseReleaseGroup(group.id, 100));
          } catch {
            // ignore individual group failures
          }
          if (hasStrongCandidate()) break;
        }
      } catch {
        // no group search available offline
      }
    }

    return [...merged.values()];
  }

  function rank(items: MbSearchRelease[], local: LocalAlbumForMatch): RankedCandidate[] {
    return items
      .map((item) => ({ item, preliminary: preliminaryScore(local, item) }))
      .sort((a, b) => b.preliminary - a.preliminary);
  }

  async function findBest(local: LocalAlbumForMatch): Promise<{ release: MbRelease; confidence: number } | null> {
    // Fetch a few more full releases than before: edition variants (deluxe,
    // bonus-track, box-set disc) often sit just below the top relevance hits,
    // and the full score is what chooses between them.
    const ranked = rank(await searchCandidates(local), local).slice(0, 6);
    let best: { release: MbRelease; confidence: number } | null = null;
    for (const candidate of ranked) {
      let release: MbRelease;
      try {
        release = await client.getRelease(candidate.item.id);
      } catch {
        continue;
      }
      const { score } = scoreRelease(local, release);
      if (!best || score > best.confidence) best = { release, confidence: score };
    }
    return best;
  }

  async function fetchImage(url: string): Promise<Buffer | null> {
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': cfg.userAgent, Accept: 'image/*' },
      });
      if (!res.ok) return null;
      const contentType = res.headers.get('content-type') ?? '';
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length === 0) return null;
      if (contentType.startsWith('image/') || contentType.startsWith('application/octet-stream')) return buffer;
      return null;
    } catch {
      return null;
    }
  }

  async function maybeDownloadCover(albumId: string, release: MbRelease): Promise<string | null> {
    if (!downloadCovers) return null;
    const album = getAlbumRow(db, albumId);
    if (!album || album.cover_path) return null;

    const urls = [`https://coverartarchive.org/release/${encodeURIComponent(release.id)}/front-500`];
    const groupId = release['release-group']?.id;
    if (groupId) urls.push(`https://coverartarchive.org/release-group/${encodeURIComponent(groupId)}/front-500`);

    const dir = join(cfg.dataDir, 'covers');
    const target = join(dir, `${albumId}.jpg`);
    for (const url of urls) {
      const image = await fetchImage(url);
      if (!image) continue;
      try {
        mkdirSync(dir, { recursive: true });
        const temp = `${target}.tmp`;
        writeFileSync(temp, image);
        renameSync(temp, target);
        db.prepare('UPDATE albums SET cover_path = ? WHERE id = ? AND cover_path IS NULL').run(target, albumId);
        return target;
      } catch {
        // try the next URL
      }
    }
    return null;
  }

  /**
   * Match one album. `force` re-runs an album that already has a (weak) match;
   * the new match is only applied when it scores better. Locked albums are
   * never touched, forced or not.
   */
  async function matchAlbum(albumId: string, opts: { force?: boolean } = {}): Promise<boolean> {
    const album = getAlbumRow(db, albumId);
    if (!album) return false;
    if (album.source !== 'local') return false;
    if (album.match_locked === 1) return false;
    if (album.mb_release_id && !opts.force) return false;

    const local = toLocalForMatch(album, getAlbumTracks(db, albumId));
    const best = await findBest(local);
    if (!best || best.confidence < MIN_APPLY_CONFIDENCE) return false;

    // Re-matching must never make a stored match worse.
    if (album.mb_release_id && best.confidence <= (album.match_confidence ?? 0) + 0.005) return false;

    const confidence = roundScore(best.confidence);
    applyRelease(db, albumId, best.release, confidence);
    await maybeDownloadCover(albumId, best.release);
    return true;
  }


  return {
    async matchPending(onProgress?: (done: number, total: number) => void): Promise<void> {
      const rows = db
        .prepare(
          `SELECT id FROM albums
            WHERE source = 'local' AND mb_release_id IS NULL AND match_locked = 0
            ORDER BY added_at, id`,
        )
        .all() as { id: string }[];

      const total = rows.length;
      onProgress?.(0, total);
      let done = 0;
      for (const row of rows) {
        try {
          await matchAlbum(row.id);
        } catch {
          // One bad album must not stop the batch.
        }
        done++;
        onProgress?.(done, total);
      }
    },

    /**
     * Retry albums that matched below `threshold` (or did not match at all).
     * Uses the normal HTTP cache, so repeated runs are cheap; locked albums are
     * never touched. Each album is only re-applied when the new score improves.
     */
    async rematchWeak(threshold = 0.8, options: RematchOptions = {}): Promise<RematchStats> {
      const rows = db
        .prepare(
          `SELECT id, mb_release_id, match_confidence FROM albums
            WHERE source = 'local' AND match_locked = 0
              AND (mb_release_id IS NULL OR match_confidence IS NULL OR match_confidence < ?)
            ORDER BY CASE WHEN mb_release_id IS NULL THEN 0 ELSE 1 END,
                     match_confidence, added_at, id`,
        )
        .all(threshold) as { id: string; mb_release_id: string | null; match_confidence: number | null }[];

      const started = Date.now();
      const total = rows.length;
      let attempted = 0;
      let matched = 0;
      let improved = 0;
      options.onProgress?.(0, total);

      for (const row of rows) {
        if (options.limit != null && attempted >= options.limit) break;
        if (options.maxMs != null && Date.now() - started >= options.maxMs) break;
        try {
          if (await matchAlbum(row.id, { force: true })) {
            if (row.mb_release_id) improved++;
            else matched++;
          }
        } catch {
          // One bad album must not stop the batch.
        }
        attempted++;
        options.onProgress?.(attempted, total);
      }

      return { attempted, matched, improved, remaining: Math.max(0, total - attempted) };
    },

    async setRelease(albumId: string, mbReleaseId: string): Promise<void> {
      const album = getAlbumRow(db, albumId);
      if (!album) throw new Error(`album not found: ${albumId}`);
      // Throws on unknown release id (404).
      const release = await client.getRelease(mbReleaseId);
      const local = toLocalForMatch(album, getAlbumTracks(db, albumId));
      const confidence = roundScore(scoreRelease(local, release).score);
      applyRelease(db, albumId, release, confidence);
      db.prepare('UPDATE albums SET match_locked = 1 WHERE id = ?').run(albumId);
      await maybeDownloadCover(albumId, release);
    },

    async candidates(albumId: string) {
      const album = getAlbumRow(db, albumId);
      if (!album) throw new Error(`album not found: ${albumId}`);
      const local = toLocalForMatch(album, getAlbumTracks(db, albumId));
      const ranked = rank(await searchCandidates(local), local).slice(0, 15);

      // Lazily fetch the top 3 for a full score; the rest keep the cheap score.
      const fullScores = new Map<string, number>();
      for (const candidate of ranked.slice(0, 3)) {
        try {
          const release = await client.getRelease(candidate.item.id);
          fullScores.set(candidate.item.id, roundScore(scoreRelease(local, release).score));
        } catch {
          // keep preliminary score
        }
      }

      return ranked
        .map((candidate) => ({
          mbReleaseId: candidate.item.id,
          title: candidate.item.title,
          artist: artistCreditName(candidate.item['artist-credit']),
          year: yearFromDate(candidate.item.date) ?? yearFromDate(candidate.item['release-group']?.['first-release-date']),
          tracks: searchItemTrackCount(candidate.item),
          country: candidate.item.country,
          score: fullScores.get(candidate.item.id) ?? roundScore(candidate.preliminary),
        }))
        .sort((a, b) => b.score - a.score);
    },
  };
}
