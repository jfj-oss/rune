// Wire + internal types for the Discover (new songs / song radio) feature.
import type { Track } from '@liner/shared';

/** Album fields the web needs; deliberately smaller than AlbumSummary. */
export interface DiscoverAlbum {
  id: string;
  title: string;
  coverUrl?: string;
}

/** A Spotify track the user does not own yet, ready to play/queue/playlist. */
export interface DiscoverItem {
  track: Track;
  album: DiscoverAlbum;
  /** Human sentence shown under the row ("Similar to …", "… is similar to …"). */
  reason: string;
  spotifyTrackId: string;
  /** Internal: lets the exclusion check use MB identity without another lookup. */
  recordingMbid?: string;
}

export interface DiscoverSeed {
  trackId: string;
  title: string;
  artist: string;
  artistId?: string;
  /** MB recording id when known (local library / ISRC resolution). */
  recordingMbid?: string;
  /** MusicBrainz artist id used for ListenBrainz lookups. */
  artistMbid?: string;
}

export interface FeedGroup {
  title: string;
  seed?: { id: string; name: string };
  items: DiscoverItem[];
}

export type DiscoverStatus = 'ok' | 'empty' | 'unavailable' | 'rate_limited';

export interface SimilarResponse {
  status: DiscoverStatus;
  seed: DiscoverSeed | null;
  items: DiscoverItem[];
  cached: boolean;
  generatedAt: number;
  /** Present for rate_limited (epoch ms). */
  blockedUntil?: number;
  /** User-facing explanation, e.g. "Spotify is rate-limiting rune — try again after 14:05". */
  message?: string;
}

export interface FeedResponse {
  status: DiscoverStatus;
  groups: FeedGroup[];
  cached: boolean;
  generatedAt: number;
  blockedUntil?: number;
  message?: string;
  /** Non-fatal note, e.g. cached results shown while Spotify is rate limited. */
  notice?: string;
}

export interface DismissResponse {
  ok: true;
}

// ---------- ListenBrainz Labs responses ----------

export interface LbSimilarArtist {
  artist_mbid: string;
  name?: string;
  artist_name?: string;
  comment?: string;
  type?: string | null;
  score?: number;
}

export interface LbSimilarRecording {
  recording_mbid: string;
  recording_name: string;
  artist_credit_name?: string;
  artist_credit_mbids?: string[] | null;
  release_name?: string;
  release_mbid?: string;
  score?: number;
}

// ---------- MusicBrainz extras ----------

export interface MbIsrcResponse {
  isrc?: string;
  recordings?: { id: string; title?: string; 'first-release-date'?: string }[];
}

export interface MbArtistSearchResponse {
  artists?: { id: string; name?: string; score?: number; disambiguation?: string }[];
}

export interface MbRecordingSearchResponse {
  recordings?: {
    id: string;
    title?: string;
    score?: number;
    'artist-credit'?: { name: string; joinphrase?: string }[];
  }[];
}

// ---------- internal candidate model ----------

/** A possible recommendation before it is mapped/verified on Spotify. */
export interface RawCandidate {
  kind: 'recording' | 'top-track';
  title: string;
  artist: string;
  /** Present for LB similar-recording candidates. */
  recordingMbid?: string;
  /** Present for top-track candidates (already a Spotify object). */
  spotifyTrack?: import('../spotify/api.js').SpotifyTrack;
  score: number;
  reason: string;
}
