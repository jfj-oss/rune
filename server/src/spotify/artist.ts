// On-demand Spotify artist pages (GET /api/artists/ar:sp:<id>): the artist plus their
// discography from the Spotify catalogue. Nothing is stored; results are cached in memory.
import type { AlbumSummary } from '@liner/shared';
import type { SpotifyAlbum, SpotifyArtist } from './api.js';
import { largestImage, mapAlbumSummary } from './map.js';

export interface ArtistFetchApi {
  artist(id: string): Promise<SpotifyArtist>;
  allArtistAlbums(id: string, includeGroups?: string, maxPages?: number): Promise<SpotifyAlbum[]>;
}

export interface SpotifyArtistPage {
  name: string;
  imageUrl?: string;
  genres: string[];
  /** Albums first (newest first), then singles and EPs. */
  albums: AlbumSummary[];
}

const TTL_MS = 6 * 60 * 60_000;

export function spotifyArtistIdOf(artistId: string): string | null {
  return artistId.startsWith('ar:sp:') ? artistId.slice(6) : null;
}

export class SpotifyArtistPages {
  private cache = new Map<string, { at: number; value: Promise<SpotifyArtistPage> }>();
  constructor(private api: ArtistFetchApi, private now: () => number = Date.now) {}

  get(artistId: string): Promise<SpotifyArtistPage> | null {
    const id = spotifyArtistIdOf(artistId);
    if (!id) return null;
    const hit = this.cache.get(id);
    if (hit && this.now() - hit.at < TTL_MS) return hit.value;
    const value = this.load(id);
    this.cache.set(id, { at: this.now(), value });
    value.catch(() => this.cache.delete(id)); // never cache a failure
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value as string);
    return value;
  }

  private artists = new Map<string, { at: number; value: Promise<SpotifyArtist> }>();

  /** One /artists/{id} call per artist per TTL, shared by the page and the avatar image. */
  private artist(id: string): Promise<SpotifyArtist> {
    const hit = this.artists.get(id);
    if (hit && this.now() - hit.at < TTL_MS) return hit.value;
    const value = this.api.artist(id);
    this.artists.set(id, { at: this.now(), value });
    value.catch(() => this.artists.delete(id));
    if (this.artists.size > 2000) this.artists.delete(this.artists.keys().next().value as string);
    return value;
  }

  /** Spotify's picture of the artist (largest), or null. */
  async image(artistId: string): Promise<string | null> {
    const id = spotifyArtistIdOf(artistId);
    if (!id) return null;
    return largestImage((await this.artist(id)).images) ?? null;
  }

  private async load(id: string): Promise<SpotifyArtistPage> {
    // 10 per page: up to 30 albums + 10 singles/EPs = at most 5 calls, then cached.
    const [artist, albums, singles] = await Promise.all([
      this.artist(id),
      this.api.allArtistAlbums(id, 'album', 3),
      this.api.allArtistAlbums(id, 'single', 1).catch(() => [] as SpotifyAlbum[]),
    ]);
    const seen = new Set<string>();
    const list: AlbumSummary[] = [];
    for (const a of [...albums, ...singles]) {
      if (!a?.id || seen.has(a.id)) continue;
      seen.add(a.id);
      list.push(mapAlbumSummary(a, { addedAt: 0 }));
    }
    const image = largestImage(artist.images);
    return { name: artist.name, ...(image ? { imageUrl: image } : {}), genres: artist.genres ?? [], albums: list };
  }
}
