// Listening-statistics response types (worker X). Server-local: the shared
// contracts do not have a stats section yet, so these live here rather than in
// shared/src/index.ts (which workers must not edit).
import type { Id } from '@liner/shared';

/** Rolling windows measured backwards from "now". `all` = no lower bound. */
export type StatsPeriod = '7d' | '30d' | '365d' | 'all';

/** One local-timezone calendar day. `date` is YYYY-MM-DD in the server's TZ. */
export interface DayStat {
  date: string;
  /** Listened time attributed to plays started that day. */
  ms: number;
}

export interface TopAlbumStat {
  albumId: Id;
  title: string;
  /** Primary album artist, null if the album row vanished from the library. */
  artist: string | null;
  plays: number;
  totalMs: number;
  /** Only present on album/artist detail responses. */
  lastPlayedAt?: number;
}

export interface TopArtistStat {
  artistId: Id;
  name: string;
  plays: number;
  totalMs: number;
  albumCount: number;
}

export interface TopTrackStat {
  trackId: Id;
  title: string;
  albumId: Id;
  albumTitle: string | null;
  /** Album artist (tracks carry no direct artist rows in these stats). */
  artist: string | null;
  plays: number;
  totalMs: number;
  lastPlayedAt: number;
}

export interface TopGenreStat {
  genre: string;
  plays: number;
  totalMs: number;
}

/** An artist whose very first counted play falls inside the period. */
export interface NewDiscovery {
  artistId: Id;
  name: string;
  firstPlayedAt: number;
  plays: number;
}

/**
 * Share of listening time (percent, 0..100, one decimal) by source quality.
 * Lossless = flac/wav/alac/aiff. Hi-res = lossless with >16 bit or >48 kHz.
 * Plays with no track row (removed/Spotify) count toward the denominator but
 * are never lossless.
 */
export interface FormatShare {
  lossless: number;
  hiRes: number;
}

export interface StatsSummary {
  period: StatsPeriod;
  /** Inclusive lower bound (epoch ms), or null for `all`. */
  from: number | null;
  /** Upper bound used for period math (epoch ms, the request's `now`). */
  to: number;
  totalMs: number;
  plays: number;
  distinctAlbums: number;
  distinctArtists: number;
  topAlbums: TopAlbumStat[];
  topArtists: TopArtistStat[];
  topTracks: TopTrackStat[];
  topGenres: TopGenreStat[];
  /** Listened ms per local hour, index 0..23. */
  byHour: number[];
  /** Listened ms per local weekday, index 0 = Sunday .. 6 = Saturday. */
  byWeekday: number[];
  /** Sparse list of local days with at least one play, oldest first. */
  byDay: DayStat[];
  newDiscoveries: NewDiscovery[];
  formats: FormatShare;
}

export interface AlbumStats {
  albumId: Id;
  title: string;
  artist: { id: Id; name: string } | null;
  /** Inclusive lower bound (epoch ms), or null for `all`. */
  from: number | null;
  to: number;
  plays: number;
  totalMs: number;
  firstPlayedAt: number | null;
  lastPlayedAt: number | null;
  byDay: DayStat[];
  topTracks: TopTrackStat[];
}

export interface ArtistStats {
  artistId: Id;
  name: string;
  from: number | null;
  to: number;
  plays: number;
  totalMs: number;
  firstPlayedAt: number | null;
  lastPlayedAt: number | null;
  byDay: DayStat[];
  topAlbums: TopAlbumStat[];
  topTracks: TopTrackStat[];
}
