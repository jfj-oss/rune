// Wire types for the listen features (rune radio, internet radio, peaks, loudness).
// Kept out of @liner/shared because the main session owns that contract.

export type RadioFrom = 'track' | 'album' | 'artist';

/** One pick from POST /radio/start or /radio/next. */
export interface RadioPick {
  trackId: string;
  /** Plain-language reason ("same producer: Toby Wright", "Grunge, 1994"). */
  reason: string;
}

export interface RadioStartResult {
  trackIds: string[];
  picks: RadioPick[];
}

export interface RadioSearchParams {
  q?: string;
  tag?: string;
  country?: string;
  language?: string;
  sort?: 'votes' | 'clickcount' | 'name' | 'bitrate';
  limit?: number;
  offset?: number;
}

/** A station as GET /radio/stations and /radio/favourites expose it. */
export interface RadioStation {
  id: string; // 'rs:<uuid>'
  stationuuid: string;
  name: string;
  url: string;
  urlResolved?: string;
  /** Local cached-logo route (/api/radio/:id/logo). */
  logoUrl?: string;
  favicon?: string;
  homepage?: string;
  tags: string[];
  country?: string;
  countrycode?: string;
  state?: string;
  language?: string;
  codec?: string;
  bitrate: number;
  votes: number;
  clickcount: number;
  clicktrend: number;
  hls: boolean;
  favourite: boolean;
  lastCheckOk?: boolean;
}

export interface RadioSearchResult {
  items: RadioStation[];
  total: number;
}

export type NormalizeMode = 'off' | 'track' | 'album';

export interface PeaksResult {
  buckets: number;
  data: number[];
}

/** True for a live internet-radio queue entry ('rs:<uuid>'). */
export function isLiveTrack(track: { id?: string } | null | undefined): boolean {
  return !!track?.id && track.id.startsWith('rs:');
}
