// Types for the internet-radio module (worker Y).
//
// The wire shape is radio-browser.info's station object; the public shape is what
// our API and the queue use. Ids are 'rs:' + the radio-browser stationuuid (the
// shared Track id form for a radio stream).

/** One station as returned by https://api.radio-browser.info/json/stations/... */
export interface RadioBrowserStation {
  stationuuid: string;
  name: string;
  url: string;
  url_resolved?: string;
  homepage?: string;
  favicon?: string;
  tags?: string;
  country?: string;
  countrycode?: string;
  state?: string;
  language?: string;
  languagecodes?: string;
  codec?: string;
  bitrate?: number;
  votes?: number;
  clickcount?: number;
  clicktrend?: number;
  hls?: number;
  lastcheckok?: number;
  geo_lat?: number | null;
  geo_long?: number | null;
  [key: string]: unknown;
}

/** A station as our API and queue expose it. */
export interface RadioStation {
  id: string; // 'rs:<uuid>'
  stationuuid: string;
  name: string;
  url: string;
  urlResolved?: string;
  /** Local cached-logo route (/api/radio/:id/logo) when a favicon is known. */
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

export type RadioSort = 'votes' | 'clickcount' | 'name' | 'bitrate';

export interface RadioSearchParams {
  q?: string;
  tag?: string;
  country?: string;
  language?: string;
  /** Default 'votes' (descending). */
  sort?: RadioSort;
  limit?: number;
  offset?: number;
}

export interface RadioSearchResult {
  items: RadioStation[];
  total: number;
}

/** Body accepted by POST /radio/favourites. */
export interface AddFavouriteInput {
  id?: string;
  stationuuid?: string;
  station?: Partial<RadioBrowserStation> & { stationuuid?: string; id?: string };
}

export function stationId(uuid: string): string {
  return uuid.startsWith('rs:') ? uuid : `rs:${uuid}`;
}

/** Accepts both 'rs:<uuid>' and a bare stationuuid. */
export function stationUuid(id: string): string {
  return id.startsWith('rs:') ? id.slice(3) : id;
}
