// Mock Discover feed + song radio for ?mock=1.
//
// The pool is the fictional "Spotify catalogue" albums: they appear in search
// but are not saved to the library, which is exactly what Discover should show.
// ?mockRateLimit=1 renders the Spotify rate-limit state (sticky for the session).
import type { DiscoverItem, DiscoverSeed, FeedGroup, FeedResponse, SimilarResponse } from '../lib/discover';
import { rateLimitMessage } from '../lib/discover';
import { ALBUMS, CATALOG_IDS } from './data';

const wait = <T>(v: T, ms = 160): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms));
const BLOCK_MS = 45 * 60_000;

const dismissed = new Set<string>();

function isRateLimited(): boolean {
  try {
    const q = new URLSearchParams(location.search).get('mockRateLimit');
    if (q === '1') sessionStorage.setItem('rune.discoverRateLimit', '1');
    if (q === '0') sessionStorage.removeItem('rune.discoverRateLimit');
    return sessionStorage.getItem('rune.discoverRateLimit') === '1';
  } catch {
    return false;
  }
}

const catalog = ALBUMS.filter((a) => CATALOG_IDS.has(a.id));
const pool: DiscoverItem[] = catalog.flatMap((a) =>
  a.tracks.map((track) => ({
    track,
    album: { id: a.id, title: a.title, ...(a.coverUrl ? { coverUrl: a.coverUrl } : {}) },
    reason: '',
    spotifyTrackId: track.id.replace(/^sp:/, ''),
  })),
);

const seedTracks = ALBUMS.flatMap((a) => a.tracks.map((track) => ({ track, album: a })));

function findSeed(trackId: string): DiscoverSeed | null {
  const hit = seedTracks.find((x) => x.track.id === trackId);
  if (!hit) return null;
  return {
    trackId: hit.track.id,
    title: hit.track.title,
    artist: hit.track.artists[0]?.name ?? '',
    ...(hit.track.artists[0] ? { artistId: hit.track.artists[0].id } : {}),
  };
}

function normalized(id: string): string {
  return id.startsWith('sp:') ? id : `sp:${id}`;
}

function available(): DiscoverItem[] {
  return pool.filter((item) => !dismissed.has(normalized(item.track.id)));
}

function withReason(items: DiscoverItem[], seedTitle: string): DiscoverItem[] {
  return items.map((item) => ({ ...item, reason: `Similar to “${seedTitle}”` }));
}

function rateLimitedSimilar(seed: DiscoverSeed | null): SimilarResponse {
  const blockedUntil = Date.now() + BLOCK_MS;
  return {
    status: 'rate_limited',
    seed,
    items: [],
    cached: false,
    generatedAt: Date.now(),
    blockedUntil,
    message: rateLimitMessage(blockedUntil),
  };
}

function rateLimitedFeed(): FeedResponse {
  const blockedUntil = Date.now() + BLOCK_MS;
  return {
    status: 'rate_limited',
    groups: [],
    cached: false,
    generatedAt: Date.now(),
    blockedUntil,
    message: rateLimitMessage(blockedUntil),
  };
}

function seedGroup(name: string, items: DiscoverItem[], used: Set<string>): FeedGroup | null {
  const picked: DiscoverItem[] = [];
  for (const item of items) {
    const id = normalized(item.track.id);
    if (used.has(id)) continue;
    used.add(id);
    picked.push({
      ...item,
      reason:
        item.track.artists[0]?.name === name
          ? `More from ${name}`
          : `${item.track.artists[0]?.name ?? 'Another artist'} is similar to ${name}`,
    });
    if (picked.length >= 6) break;
  }
  return picked.length ? { title: `Because you listen to ${name}`, seed: { id: name, name }, items: picked } : null;
}

export const mockDiscover = {
  async similar(trackId: string, limit: number): Promise<SimilarResponse> {
    await wait(undefined, 340);
    const seed = findSeed(trackId);
    if (isRateLimited()) return rateLimitedSimilar(seed);
    const all = available().filter((item) => item.track.id !== trackId);
    const first = all[0];
    if (!first) {
      return { status: 'empty', seed, items: [], cached: false, generatedAt: Date.now() };
    }
    const artist = seed?.artist ?? '';
    const same = artist ? all.filter((i) => i.track.artists[0]?.name === artist) : [];
    const rest = all.filter((i) => i.track.artists[0]?.name !== artist);
    const items = withReason([...same, ...rest].slice(0, limit), seed?.title ?? first.track.title);
    return { status: 'ok', seed, items, cached: false, generatedAt: Date.now() };
  },

  async feed(limit: number, refresh: boolean): Promise<FeedResponse> {
    await wait(undefined, refresh ? 620 : 260);
    if (isRateLimited()) return rateLimitedFeed();
    const used = new Set<string>();
    const groups: FeedGroup[] = [];
    let remaining = limit;
    for (const name of ['Aster Vale', 'Lena Wirth', 'Paper Satellites']) {
      if (remaining <= 0) break;
      const same = available().filter((i) => i.track.artists[0]?.name === name);
      const others = available().filter((i) => i.track.artists[0]?.name !== name);
      const group = seedGroup(name, [...same, ...others].slice(0, remaining), used);
      if (group) {
        groups.push(group);
        remaining -= group.items.length;
      }
    }
    return {
      status: groups.length ? 'ok' : 'empty',
      groups,
      cached: !refresh,
      generatedAt: Date.now(),
    };
  },

  async dismiss(trackId: string): Promise<void> {
    dismissed.add(normalized(trackId.trim()));
    await wait(undefined, 90);
  },
};
