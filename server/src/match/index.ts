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
  preliminaryScore,
  scoreRelease,
  type LocalAlbumForMatch,
  type LocalTrackForMatch,
} from './scoring.js';
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
} from './scoring.js';
export { applyRelease } from './apply.js';

/** Below this best-candidate score the album is left unmatched (manual fix offered). */
export const MIN_APPLY_CONFIDENCE = 0.6;

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

    // Primary: release title + album artist (Lucene-escaped).
    try {
      const primary = await client.searchRelease(local.title, local.artist, 15);
      for (const item of primary) if (!merged.has(item.id)) merged.set(item.id, item);
    } catch {
      // Offline replay may not have this URL; treat as no results.
    }

    // Weak tags: also search by the first few local track titles.
    if (tagsAreWeak(local) && local.tracks.length > 0) {
      try {
        const titles = local.tracks.slice(0, 3).map((t) => t.title);
        const fallback = await client.searchReleaseByTracks(titles, {
          artist: local.artist.trim() || undefined,
          releaseTitle: usableTitle(local),
          limit: 15,
        });
        for (const item of fallback) if (!merged.has(item.id)) merged.set(item.id, item);
      } catch {
        // ignore
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
    const ranked = rank(await searchCandidates(local), local).slice(0, 3);
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

  async function matchAlbum(albumId: string): Promise<boolean> {
    const album = getAlbumRow(db, albumId);
    if (!album) return false;
    if (album.source !== 'local') return false;
    if (album.match_locked === 1) return false;
    if (album.mb_release_id) return false;

    const local = toLocalForMatch(album, getAlbumTracks(db, albumId));
    const best = await findBest(local);
    if (!best || best.confidence < MIN_APPLY_CONFIDENCE) return false;

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
