// Spotify catalogue search for GET /api/search, merged after the local results.
// Identical queries are cached for 60 s server-side (the client also debounces).
import type { AlbumSummary, ArtistRef, Track } from '@liner/shared';
import { normalizeName } from '../db/index.js';
import type { SpotifySearchResult } from './api.js';
import { mapAlbumSummary, mapArtistRef, mapTrack } from './map.js';

export interface SearchResults {
  albums: AlbumSummary[];
  artists: ArtistRef[];
  tracks: Track[];
}

export interface SpotifySearchApi {
  search(
    q: string,
    opts?: { types?: string[]; limit?: number; market?: string },
  ): Promise<SpotifySearchResult>;
}

export interface SpotifyCatalogOptions {
  ttlMs?: number;
  now?: () => number;
  /** Results per type (Spotify's `limit` is per type). */
  limit?: number;
  /** Soft cap on cached queries; oldest entries are dropped. */
  maxEntries?: number;
}

interface CacheEntry {
  expiresAt: number;
  value: Promise<SearchResults>;
}

const EMPTY: SearchResults = { albums: [], artists: [], tracks: [] };

export class SpotifyCatalog {
  private readonly api: SpotifySearchApi;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly limit: number;
  private readonly maxEntries: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(api: SpotifySearchApi, opts: SpotifyCatalogOptions = {}) {
    this.api = api;
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.limit = opts.limit ?? 8;
    this.maxEntries = opts.maxEntries ?? 250;
  }

  search(q: string): Promise<SearchResults> {
    const query = q.trim();
    if (!query) return Promise.resolve(EMPTY);
    const key = query.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > this.now()) return hit.value;

    const value = this.fetch(query);
    this.cache.set(key, { expiresAt: this.now() + this.ttlMs, value });
    // Don't cache failures: the next request should retry.
    value.catch(() => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key);
    });
    this.prune();
    return value;
  }

  /** Exposed for tests / diagnostics. */
  clearCache(): void {
    this.cache.clear();
  }

  private async fetch(q: string): Promise<SearchResults> {
    const res = await this.api.search(q, {
      types: ['album', 'artist', 'track'],
      limit: this.limit,
    });
    const at = this.now();
    return {
      albums: (res.albums?.items ?? []).map((a) => mapAlbumSummary(a, { addedAt: at })),
      artists: (res.artists?.items ?? []).map(mapArtistRef),
      tracks: (res.tracks?.items ?? [])
        .filter((t) => !!t.id && !t.is_local && t.type !== 'episode')
        .map((t) => mapTrack(t)),
    };
  }

  private prune(): void {
    if (this.cache.size <= this.maxEntries) return;
    for (const key of this.cache.keys()) {
      if (this.cache.size <= this.maxEntries) break;
      this.cache.delete(key);
    }
  }
}

/**
 * Local results stay first; Spotify catalogue results follow, with duplicates
 * removed (album/track ids, and artists by normalized name so a saved local
 * artist and its Spotify counterpart don't show twice).
 */
export function mergeSearchResults(local: SearchResults, catalog: SearchResults): SearchResults {
  const albumIds = new Set(local.albums.map((a) => a.id));
  const albums = [...local.albums];
  for (const album of catalog.albums) {
    if (albumIds.has(album.id)) continue;
    albumIds.add(album.id);
    albums.push(album);
  }

  const artistIds = new Set(local.artists.map((a) => a.id));
  const artistNames = new Set(local.artists.map((a) => normalizeName(a.name)));
  const artists = [...local.artists];
  for (const artist of catalog.artists) {
    if (artistIds.has(artist.id)) continue;
    if (artistNames.has(normalizeName(artist.name))) continue;
    artistIds.add(artist.id);
    artistNames.add(normalizeName(artist.name));
    artists.push(artist);
  }

  const trackIds = new Set(local.tracks.map((t) => t.id));
  const tracks = [...local.tracks];
  for (const track of catalog.tracks) {
    if (trackIds.has(track.id)) continue;
    trackIds.add(track.id);
    tracks.push(track);
  }

  return { albums, artists, tracks };
}
