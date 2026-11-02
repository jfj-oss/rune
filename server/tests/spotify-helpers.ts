// Shared offline fixtures/helpers for the Spotify tests. Not a test file itself.
import type { Config } from '../src/config.js';
import type {
  SpotifyAlbum,
  SpotifyArtist,
  SpotifyDevice,
  SpotifyPaging,
  SpotifyPlaybackState,
  SpotifyTrack,
} from '../src/spotify/api.js';
import type { FetchInit, FetchLike, FetchResponse } from '../src/spotify/fetch.js';

export const TEST_CONFIG: Config = {
  libraryRoots: [],
  dataDir: '/tmp/liner-spotify-tests',
  port: 4545,
  audioDevice: 'none',
  userAgent: 'liner-tests',
  spotifyClientId: 'client-abc',
};

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): FetchResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        const key = name.toLowerCase();
        for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === key) return v;
        return null;
      },
    },
    async json() {
      return JSON.parse(text);
    },
    async text() {
      return text;
    },
  };
}

export interface FetchCall {
  url: URL;
  init?: FetchInit;
}

export function fakeFetch(
  handler: (url: URL, init?: FetchInit) => FetchResponse | Promise<FetchResponse>,
): { fetch: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, init });
    return handler(parsed, init);
  };
  return { fetch: fetchImpl, calls };
}

export function formBody(init: FetchInit | undefined): URLSearchParams {
  return new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
}

export function paging<T>(
  items: T[],
  opts: { next?: string | null; total?: number; offset?: number; limit?: number } = {},
): SpotifyPaging<T> {
  return {
    items,
    total: opts.total ?? items.length,
    offset: opts.offset ?? 0,
    limit: opts.limit ?? 50,
    next: opts.next ?? null,
  };
}

// ---------- fixtures shaped like documented Spotify responses ----------

export const BEATLES: SpotifyArtist = {
  id: 'beatles-sp',
  name: 'The Beatles',
  images: [
    { url: 'http://img.example/beatles-64.jpg', width: 64, height: 64 },
    { url: 'http://img.example/beatles-640.jpg', width: 640, height: 640 },
  ],
};

export const ABBEY_COVER = 'http://img.example/abbey-640.jpg';

export function sampleTrack(id = 't1', number = 1, name = 'Come Together'): SpotifyTrack {
  return {
    id,
    name,
    artists: [BEATLES],
    album: {
      id: 'abbey',
      name: 'Abbey Road',
      artists: [BEATLES],
      images: [{ url: ABBEY_COVER, width: 640, height: 640 }],
      release_date: '1969-09-26',
    },
    disc_number: 1,
    track_number: number,
    duration_ms: 259000 + number,
    uri: `spotify:track:${id}`,
  };
}

export function sampleAlbum(overrides: Partial<SpotifyAlbum> = {}): SpotifyAlbum {
  const tracks = [sampleTrack('t1', 1, 'Come Together'), sampleTrack('t2', 2, 'Something')];
  return {
    id: 'abbey',
    name: 'Abbey Road',
    album_type: 'album',
    artists: [BEATLES],
    images: [
      { url: 'http://img.example/abbey-64.jpg', width: 64, height: 64 },
      { url: ABBEY_COVER, width: 640, height: 640 },
    ],
    release_date: '1969-09-26',
    label: 'Apple',
    genres: ['rock'],
    total_tracks: tracks.length,
    tracks: paging(tracks),
    ...overrides,
  };
}

export const SIM_DEVICE: SpotifyDevice = {
  id: 'dev1',
  is_active: true,
  is_private_session: false,
  is_restricted: false,
  name: 'Sim Phone',
  type: 'Smartphone',
  volume_percent: 42,
};

export function playbackState(
  item: SpotifyTrack | null,
  overrides: Partial<SpotifyPlaybackState> = {},
): SpotifyPlaybackState {
  return {
    device: SIM_DEVICE,
    repeat_state: 'off',
    shuffle_state: false,
    progress_ms: 12_345,
    is_playing: true,
    item,
    ...overrides,
  };
}
