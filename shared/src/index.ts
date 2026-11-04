// Shared contracts between server and web. Change these only in the main session —
// workers and the UI agent build against them.

export type Source = 'local' | 'spotify';

/** Stable ids: local = 'l:' + sha1 of normalized path(+cue index); spotify = 'sp:' + spotify id. */
export type Id = string;

export interface ArtistRef {
  id: Id;
  name: string;
}

export interface Credit {
  artist: ArtistRef;
  role: string; // "Producer", "Bass", "Composer", "Lead Vocals" ...
  trackIds?: Id[]; // absent = whole album
}

export interface Track {
  id: Id;
  albumId: Id;
  source: Source;
  title: string;
  artists: ArtistRef[];
  disc: number; // 1-based
  number: number; // 1-based within disc
  durationMs: number;
  /** local only */
  format?: 'flac' | 'mp3' | 'other';
  sampleRate?: number;
  bitDepth?: number;
  bitrateKbps?: number;
  /** local cue-sheet tracks point into one big file */
  cue?: { startMs: number; endMs: number };
  spotifyUri?: string;
}

export interface AlbumSummary {
  id: Id;
  source: Source;
  title: string;
  artist: ArtistRef; // primary/album artist
  year?: number;
  coverUrl?: string; // served by our API: /api/cover/:albumId?size=...
  format?: string; // "FLAC 24/96", "MP3 320", "Spotify"
  addedAt: number; // epoch ms
}

export interface Album extends AlbumSummary {
  tracks: Track[];
  genres: string[];
  label?: string;
  releaseDate?: string; // ISO yyyy[-mm[-dd]]
  credits: Credit[];
  musicbrainzReleaseId?: string;
  matchConfidence?: number; // 0..1, below 0.7 the UI offers "fix match"
  folderPath?: string; // local only
}

export interface Artist {
  id: Id;
  name: string;
  imageUrl?: string;
  bio?: Sourced<string>;
  albums: AlbumSummary[];
  appearsOn: AlbumSummary[];
  similar: ArtistRef[];
  musicbrainzArtistId?: string;
}

/** Every external text carries where it came from; UI must show the source link. */
export interface Sourced<T> {
  value: T;
  source: string; // "Wikipedia", "Genius", "Pitchfork", ...
  url: string;
}

export interface CriticScore {
  outlet: string; // "Metacritic", "Album of the Year", "Pitchfork"
  score: number; // native scale
  scale: number; // 100, 10, 5
  url: string;
  reviewCount?: number; // aggregates only
}

export interface CriticQuote {
  outlet: string;
  quote: string; // short excerpt, max ~300 chars
  url: string;
  author?: string;
}

export interface AlbumDetails {
  albumId: Id;
  /** Wikipedia "Critical reception" summary paragraph(s), quoted not generated */
  reception?: Sourced<string>;
  scores: CriticScore[];
  quotes: CriticQuote[];
  /** Background/recording history; artist's own words where available */
  background?: Sourced<string>;
  artistNotes: (Sourced<string> & { verifiedArtist: boolean; trackId?: Id })[];
  fetchedAt: number;
}

export interface LibraryQuery {
  q?: string;
  source?: Source | 'all';
  sort?: 'added' | 'artist' | 'title' | 'year';
  offset?: number;
  limit?: number;
}

export interface Page<T> {
  items: T[];
  total: number;
}

// ---------- Playback ----------

/** Where audio comes out. 'pc' = mpv on the server; 'browser' = this web client;
 *  'spotify:<deviceId>' = a Spotify Connect device (e.g. the phone's Spotify app). */
export type Zone = string;

export interface QueueItem {
  queueId: string;
  track: Track;
  album: Pick<AlbumSummary, 'id' | 'title' | 'coverUrl'>;
}

export interface PlayerState {
  zone: Zone;
  status: 'stopped' | 'playing' | 'paused' | 'loading';
  queue: QueueItem[];
  index: number; // -1 when empty
  positionMs: number;
  volume: number; // 0..100
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  /** signal path for the PC zone, e.g. ["FLAC 24/96", "mpv", "PipeWire 96 kHz", "bit-perfect"] */
  signalPath?: string[];
  /** ICY "now playing" metadata for live radio (PC zone; absent for normal tracks). */
  nowPlaying?: { title?: string; artist?: string; station?: string };
  updatedAt: number;
}

export type PlayerCommand =
  /** positionMs/paused: start mid-track (used when handing playback to another zone). */
  | { type: 'play'; trackIds: Id[]; startIndex?: number; positionMs?: number; paused?: boolean }
  | { type: 'enqueue'; trackIds: Id[]; next?: boolean }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'seek'; positionMs: number }
  | { type: 'jump'; index: number }
  | { type: 'remove'; queueId: string }
  /** Reorder the queue: the entry moves to `toIndex` (clamped to the queue ends). */
  | { type: 'move'; queueId: string; toIndex: number }
  /** Empty the queue and stop playback. */
  | { type: 'clear' }
  | { type: 'volume'; volume: number }
  | { type: 'shuffle'; on: boolean }
  | { type: 'repeat'; mode: PlayerState['repeat'] };

/** Websocket /api/ws messages server → client */
export type ServerEvent =
  /** `queueRev` fingerprints `state.queue`. Clients that connect with `/api/ws?slim=1` get the queue only
   *  when it changed; otherwise `state.queue` is absent on the wire and the client reuses its copy. */
  | { type: 'player'; state: PlayerState; queueRev?: string }
  | { type: 'scan'; progress: ScanProgress }
  | { type: 'library-changed' };

/** The track as Spotify's Web Playback SDK reports it (no rune ids yet). */
export interface SdkPlaybackTrack {
  /** Spotify's own id (not namespaced with 'sp:'). */
  id: string;
  uri: string;
  name: string;
  durationMs: number;
  artists: { name: string; uri: string }[];
  album: { name: string; uri: string; images: { url: string; width: number | null; height: number | null }[] };
}

/** Websocket /api/ws messages client → server */
export type ClientEvent =
  /** A tab says whether it is actually on screen. Hidden tabs do not count as watching. */
  | { type: 'presence'; visible: boolean }
  /** The browser's Web Playback SDK device reports its own state (local calls, no Web API quota). */
  | {
      type: 'sdk-state';
      deviceId: string;
      active: boolean;
      playing?: boolean;
      positionMs?: number;
      durationMs?: number;
      track?: SdkPlaybackTrack | null;
      shuffle?: boolean;
      repeat?: 0 | 1 | 2;
      /** 0..1 */
      volume?: number;
    };

export interface ScanProgress {
  running: boolean;
  filesSeen: number;
  albumsFound: number;
  matched: number;
  currentPath?: string;
  errors: number;
}

// ---------- Playlists (worker F) ----------
// Kept in their own file; re-exported only (no existing types changed).
export type { PlaylistDetail, PlaylistSummary, PlaylistTrack } from './playlists.js';

// ---------- Listening history ----------
export * from './history.js';
