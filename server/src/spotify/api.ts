// Spotify Web API client. No network in tests: pass `fetch` + `getToken`.
import { HttpError, defaultSleep, type FetchLike } from './fetch.js';

// ---------- Response shapes (subset of the documented Web API objects) ----------

export interface SpotifyImage {
  url: string;
  height?: number | null;
  width?: number | null;
}

const ARTIST_ALBUMS_PAGE = 10;

export interface SpotifyArtist {
  id: string;
  name: string;
  images?: SpotifyImage[];
  genres?: string[];
  followers?: { total: number };
  popularity?: number;
  uri?: string;
}

export interface SpotifyAlbum {
  id: string;
  name: string;
  album_type?: string;
  artists: SpotifyArtist[];
  images?: SpotifyImage[];
  release_date?: string;
  release_date_precision?: 'year' | 'month' | 'day';
  total_tracks?: number;
  label?: string;
  genres?: string[];
  uri?: string;
  tracks?: SpotifyPaging<SpotifyTrack>;
}

export interface SpotifyTrack {
  id: string | null;
  name: string;
  artists: SpotifyArtist[];
  album?: SpotifyAlbum;
  disc_number: number;
  track_number: number;
  duration_ms: number;
  uri: string;
  explicit?: boolean;
  is_local?: boolean;
  /** Spotify objects include `type`; episodes are skipped by the library sync. */
  type?: string;
}

export interface SpotifyPaging<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  next: string | null;
  href?: string;
}

export interface SpotifySavedAlbum {
  added_at: string;
  album: SpotifyAlbum | null;
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  description?: string | null;
  images?: SpotifyImage[];
  owner?: { id: string; display_name?: string | null };
  tracks?: { total: number };
  /** Newer API shape for the same thing (see normalizePlaylist). */
  items?: { total: number };
  snapshot_id?: string;
  uri?: string;
}

/** One entry of GET /playlists/:id/tracks (a track, an episode, or a local file). */
export interface SpotifyPlaylistTrack {
  added_at: string;
  is_local?: boolean;
  track: SpotifyTrack | null;
}

/** One entry of GET /me/tracks ("Liked Songs"). */
export interface SpotifySavedTrack {
  added_at: string;
  track: SpotifyTrack | null;
}

export interface SpotifyPlayHistory {
  track: SpotifyTrack;
  played_at: string;
  context?: { type: string; uri: string } | null;
}

export interface SpotifyDevice {
  id: string | null;
  is_active: boolean;
  is_private_session: boolean;
  is_restricted: boolean;
  name: string;
  type: string;
  volume_percent: number | null;
}

export interface SpotifyPlaybackState {
  device?: SpotifyDevice;
  repeat_state: 'off' | 'track' | 'context';
  shuffle_state: boolean;
  timestamp?: number;
  progress_ms: number | null;
  is_playing: boolean;
  item: SpotifyTrack | null;
  currently_playing_type?: string;
}

export interface SpotifyQueue {
  currently_playing: SpotifyTrack | null;
  queue: SpotifyTrack[];
}

export interface SpotifySearchResult {
  albums?: SpotifyPaging<SpotifyAlbum>;
  artists?: SpotifyPaging<SpotifyArtist>;
  tracks?: SpotifyPaging<SpotifyTrack>;
}

export interface SpotifyUser {
  id: string;
  display_name?: string | null;
  product?: string;
  email?: string;
}

export interface SpotifyPlayBody {
  uris?: string[];
  context_uri?: string;
  offset?: { position?: number; uri?: string };
  position_ms?: number;
}

export interface SpotifyApiOptions {
  /** Injected for tests. Defaults to global fetch. */
  fetch?: FetchLike;
  /** Returns a bearer token. `force` asks for a refresh even if not near expiry. */
  getToken: (force?: boolean) => Promise<string>;
  /** Defaults to https://api.spotify.com/v1 */
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  /** 429 retries per request (default 2). */
  maxRateLimitRetries?: number;
  /** Retry-After values larger than this are surfaced instead of blocking (default 60s). */
  maxRetryAfterMs?: number;
}

export class SpotifyApi {
  private readonly fetchImpl: FetchLike;
  private readonly getToken: (force?: boolean) => Promise<string>;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRateLimitRetries: number;
  private readonly maxRetryAfterMs: number;

  constructor(opts: SpotifyApiOptions) {
    this.fetchImpl = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.getToken = opts.getToken;
    this.baseUrl = (opts.baseUrl ?? 'https://api.spotify.com/v1').replace(/\/$/, '');
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxRateLimitRetries = opts.maxRateLimitRetries ?? 2;
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? 60_000;
  }

  // ---------- transport ----------

  /** Authenticated request with one refresh+retry on 401 and Retry-After handling on 429. */
  async request<T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
    const headers: Record<string, string> = { ...init.headers };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    let token = await this.getToken(false);
    let authRetried = false;
    let rateLimitRetries = 0;

    for (;;) {
      const res = await this.fetchImpl(this.baseUrl + path, {
        method: init.method ?? 'GET',
        headers: { ...headers, Authorization: `Bearer ${token}` },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });

      if (res.status === 401 && !authRetried) {
        authRetried = true;
        token = await this.getToken(true);
        continue;
      }

      if (res.status === 429 && rateLimitRetries < this.maxRateLimitRetries) {
        const header = res.headers.get('retry-after');
        const seconds = header === null ? 1 : Number(header);
        const retryAfterMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : 1000;
        if (retryAfterMs > this.maxRetryAfterMs) {
          throw new HttpError(`Spotify rate limited; retry after ${retryAfterMs}ms`, 429, await safeText(res), retryAfterMs);
        }
        rateLimitRetries++;
        await this.sleep(retryAfterMs);
        continue;
      }

      if (!res.ok) {
        throw new HttpError(`Spotify API ${res.status} for ${init.method ?? 'GET'} ${path}`, res.status, await safeText(res));
      }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      if (!text) return undefined as T;
      // Player endpoints (play/pause/transfer…) now answer 200 with a short opaque
      // token instead of an empty body or JSON — treat anything non-JSON as "no body".
      try {
        return JSON.parse(text) as T;
      } catch {
        return undefined as T;
      }
    }
  }

  private query(path: string, params: Record<string, string | number | boolean | undefined>): string {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) search.set(k, String(v));
    }
    const qs = search.toString();
    return qs ? `${path}?${qs}` : path;
  }

  private async pagedAll<T>(
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
  ): Promise<T[]> {
    const out: T[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.request<SpotifyPaging<T>>(
        this.query(path, { ...params, limit: 50, offset }),
      );
      out.push(...page.items);
      offset += page.items.length;
      if (!page.next || page.items.length === 0) break;
    }
    return out;
  }

  // ---------- catalogue ----------

  search(q: string, opts: { types?: string[]; limit?: number; market?: string } = {}): Promise<SpotifySearchResult> {
    return this.request<SpotifySearchResult>(
      this.query('/search', {
        q,
        type: (opts.types ?? ['album', 'artist', 'track']).join(','),
        limit: clamp(opts.limit ?? 20, 1, 50),
        market: opts.market,
      }),
    );
  }

  album(id: string): Promise<SpotifyAlbum> {
    return this.request<SpotifyAlbum>(`/albums/${encodeURIComponent(id)}`);
  }

  albumTracks(id: string, opts: { offset?: number; limit?: number } = {}): Promise<SpotifyPaging<SpotifyTrack>> {
    return this.request<SpotifyPaging<SpotifyTrack>>(
      this.query(`/albums/${encodeURIComponent(id)}/tracks`, {
        // Spotify caps this endpoint at 10 per page for development-mode apps (400 "Invalid limit" above).
        limit: clamp(opts.limit ?? ARTIST_ALBUMS_PAGE, 1, ARTIST_ALBUMS_PAGE),
        offset: opts.offset ?? 0,
      }),
    );
  }

  allAlbumTracks(id: string): Promise<SpotifyTrack[]> {
    return this.pagedAll<SpotifyTrack>(`/albums/${encodeURIComponent(id)}/tracks`);
  }

  artist(id: string): Promise<SpotifyArtist> {
    return this.request<SpotifyArtist>(`/artists/${encodeURIComponent(id)}`);
  }

  artistAlbums(id: string, opts: { offset?: number; limit?: number; includeGroups?: string } = {}): Promise<SpotifyPaging<SpotifyAlbum>> {
    return this.request<SpotifyPaging<SpotifyAlbum>>(
      this.query(`/artists/${encodeURIComponent(id)}/albums`, {
        include_groups: opts.includeGroups ?? 'album,single',
        // Spotify caps this endpoint at 10 per page for development-mode apps (400 "Invalid limit" above).
        limit: clamp(opts.limit ?? ARTIST_ALBUMS_PAGE, 1, ARTIST_ALBUMS_PAGE),
        offset: opts.offset ?? 0,
      }),
    );
  }

  async allArtistAlbums(id: string, includeGroups = 'album,single', maxPages = 5): Promise<SpotifyAlbum[]> {
    const out: SpotifyAlbum[] = [];
    for (let page = 0; page < maxPages; page++) {
      const res = await this.artistAlbums(id, { includeGroups, offset: out.length });
      out.push(...res.items);
      if (!res.next || res.items.length === 0) break;
    }
    return out;
  }

  /** All saved albums, following pagination. */
  savedAlbums(opts: { offset?: number; limit?: number } = {}): Promise<SpotifyPaging<SpotifySavedAlbum>> {
    return this.request<SpotifyPaging<SpotifySavedAlbum>>(
      this.query('/me/albums', { limit: clamp(opts.limit ?? 50, 1, 50), offset: opts.offset ?? 0 }),
    );
  }

  async allSavedAlbums(): Promise<SpotifySavedAlbum[]> {
    const out: SpotifySavedAlbum[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.savedAlbums({ offset });
      out.push(...page.items);
      offset += page.items.length;
      if (!page.next || page.items.length === 0) break;
    }
    return out;
  }

  /** PUT /me/albums — save albums to the user's library (max 50 ids per call). */
  saveAlbums(ids: string[]): Promise<void> {
    return this.request<void>('/me/albums', { method: 'PUT', body: { ids: ids.slice(0, 50) } });
  }

  /** DELETE /me/albums — remove albums from the user's library (max 50 ids per call). */
  removeSavedAlbums(ids: string[]): Promise<void> {
    return this.request<void>('/me/albums', { method: 'DELETE', body: { ids: ids.slice(0, 50) } });
  }

  /** All liked songs (GET /me/tracks), following pagination. */
  savedTracks(opts: { offset?: number; limit?: number } = {}): Promise<SpotifyPaging<SpotifySavedTrack>> {
    return this.request<SpotifyPaging<SpotifySavedTrack>>(
      this.query('/me/tracks', { limit: clamp(opts.limit ?? 50, 1, 50), offset: opts.offset ?? 0 }),
    );
  }

  async allSavedTracks(): Promise<SpotifySavedTrack[]> {
    const out: SpotifySavedTrack[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.savedTracks({ offset });
      out.push(...page.items);
      offset += page.items.length;
      if (!page.next || page.items.length === 0) break;
    }
    return out;
  }

  playlist(id: string): Promise<SpotifyPlaylist> {
    return this.request<SpotifyPlaylist>(`/playlists/${encodeURIComponent(id)}`);
  }

  // Spotify moved playlist contents from /playlists/:id/tracks (now 403) to
  // /playlists/:id/items, and each entry's song from `track` to `item`.
  async playlistTracks(id: string, opts: { offset?: number; limit?: number } = {}): Promise<SpotifyPaging<SpotifyPlaylistTrack>> {
    const page = await this.request<SpotifyPaging<SpotifyPlaylistTrack>>(
      this.query(`/playlists/${encodeURIComponent(id)}/items`, {
        // Spotify caps this endpoint at 10 per page for development-mode apps (400 "Invalid limit" above).
        limit: clamp(opts.limit ?? ARTIST_ALBUMS_PAGE, 1, ARTIST_ALBUMS_PAGE),
        offset: opts.offset ?? 0,
      }),
    );
    return { ...page, items: page.items.map(normalizePlaylistEntry) };
  }

  async allPlaylistTracks(id: string): Promise<SpotifyPlaylistTrack[]> {
    const items = await this.pagedAll<SpotifyPlaylistTrack>(`/playlists/${encodeURIComponent(id)}/items`);
    return items.map(normalizePlaylistEntry);
  }

  playlists(opts: { offset?: number; limit?: number } = {}): Promise<SpotifyPaging<SpotifyPlaylist>> {
    return this.request<SpotifyPaging<SpotifyPlaylist>>(
      this.query('/me/playlists', { limit: clamp(opts.limit ?? 50, 1, 50), offset: opts.offset ?? 0 }),
    );
  }

  async allPlaylists(): Promise<SpotifyPlaylist[]> {
    const out: SpotifyPlaylist[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.playlists({ offset });
      out.push(...page.items.map(normalizePlaylist));
      offset += page.items.length;
      if (!page.next || page.items.length === 0) break;
    }
    return out;
  }

  recentlyPlayed(limit = 50): Promise<SpotifyPaging<SpotifyPlayHistory>> {
    return this.request<SpotifyPaging<SpotifyPlayHistory>>(
      this.query('/me/player/recently-played', { limit: clamp(limit, 1, 50) }),
    );
  }

  /**
   * Several tracks by id. Spotify refuses the batch endpoint (`/tracks?ids=`, 403) for
   * development-mode apps since 2026, so after a 403 this looks tracks up one by one,
   * at most `maxSingles` of them (the rest are simply left out).
   */
  async tracks(ids: string[], opts: { maxSingles?: number } = {}): Promise<SpotifyTrack[]> {
    const out: SpotifyTrack[] = [];
    if (!this.batchTracksRefused) {
      try {
        for (const chunk of chunks(ids, 50)) {
          const res = await this.request<{ tracks: (SpotifyTrack | null)[] }>(this.query('/tracks', { ids: chunk.join(',') }));
          for (const t of res.tracks) if (t) out.push(t);
        }
        return out;
      } catch (err) {
        if ((err as { status?: number }).status !== 403) throw err;
        this.batchTracksRefused = true;
      }
    }
    for (const id of ids.slice(0, opts.maxSingles ?? 20)) {
      try {
        out.push(await this.request<SpotifyTrack>(`/tracks/${encodeURIComponent(id)}`));
      } catch (err) {
        if ((err as { status?: number }).status === 429) throw err;
        /* unknown / unavailable track: skip it */
      }
    }
    return out;
  }
  private batchTracksRefused = false;

  /** One track by id (GET /tracks/{id}), for callers that must not use the batch endpoint. */
  track(id: string): Promise<SpotifyTrack> {
    return this.request<SpotifyTrack>(`/tracks/${encodeURIComponent(id)}`);
  }

  me(): Promise<SpotifyUser> {
    return this.request<SpotifyUser>('/me');
  }

  // ---------- playback (Connect) ----------

  async devices(): Promise<SpotifyDevice[]> {
    const res = await this.request<{ devices: SpotifyDevice[] }>('/me/player/devices');
    return res.devices ?? [];
  }

  currentPlayback(): Promise<SpotifyPlaybackState | null> {
    return this.request<SpotifyPlaybackState | null>('/me/player');
  }

  queue(): Promise<SpotifyQueue> {
    return this.request<SpotifyQueue>('/me/player/queue');
  }

  transfer(deviceId: string, play = false): Promise<void> {
    return this.request<void>('/me/player', { method: 'PUT', body: { device_ids: [deviceId], play } });
  }

  play(body: SpotifyPlayBody = {}, deviceId?: string): Promise<void> {
    return this.request<void>(this.query('/me/player/play', { device_id: deviceId }), { method: 'PUT', body });
  }

  pause(deviceId?: string): Promise<void> {
    return this.request<void>(this.query('/me/player/pause', { device_id: deviceId }), { method: 'PUT' });
  }

  next(deviceId?: string): Promise<void> {
    return this.request<void>(this.query('/me/player/next', { device_id: deviceId }), { method: 'POST' });
  }

  previous(deviceId?: string): Promise<void> {
    return this.request<void>(this.query('/me/player/previous', { device_id: deviceId }), { method: 'POST' });
  }

  seek(positionMs: number, deviceId?: string): Promise<void> {
    return this.request<void>(
      this.query('/me/player/seek', { position_ms: Math.max(0, Math.round(positionMs)), device_id: deviceId }),
      { method: 'PUT' },
    );
  }

  setVolume(percent: number, deviceId?: string): Promise<void> {
    return this.request<void>(
      this.query('/me/player/volume', { volume_percent: clamp(Math.round(percent), 0, 100), device_id: deviceId }),
      { method: 'PUT' },
    );
  }

  setShuffle(on: boolean, deviceId?: string): Promise<void> {
    return this.request<void>(this.query('/me/player/shuffle', { state: on, device_id: deviceId }), { method: 'PUT' });
  }

  setRepeat(mode: 'off' | 'track' | 'context', deviceId?: string): Promise<void> {
    return this.request<void>(this.query('/me/player/repeat', { state: mode, device_id: deviceId }), { method: 'PUT' });
  }

  enqueue(uri: string, deviceId?: string): Promise<void> {
    return this.request<void>(this.query('/me/player/queue', { uri, device_id: deviceId }), { method: 'POST' });
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

async function safeText(res: FetchResponseLike): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

type FetchResponseLike = { text(): Promise<string> };

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}


/** Old and new playlist entry shapes → `{ track }`. */
export function normalizePlaylistEntry(e: SpotifyPlaylistTrack): SpotifyPlaylistTrack {
  const raw = e as SpotifyPlaylistTrack & { item?: SpotifyPlaylistTrack['track'] };
  if (raw.track === undefined && raw.item !== undefined) return { ...raw, track: raw.item };
  return e;
}

/** Old and new playlist object shapes → `tracks.total` always present. */
export function normalizePlaylist(p: SpotifyPlaylist): SpotifyPlaylist {
  if (!p.tracks && p.items) return { ...p, tracks: { total: p.items.total } };
  return p;
}
