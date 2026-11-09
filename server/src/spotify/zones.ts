// Spotify Connect playback zones. Each Connect device exposed by the account
// becomes a PlaybackZone whose state is polled from /me/player. While a song is
// playing the next poll is scheduled just after that song ends, so a track change
// is still seen immediately without asking Spotify every few seconds.
import type { PlayerCommand, PlayerState, QueueItem, Track, Zone } from '@liner/shared';
import type { PlaybackZone } from '../modules.js';
import type {
  SpotifyBudgetLevel,
  SpotifyBudgetLogger,
  SpotifyDevice,
  SpotifyPlaybackState,
  SpotifyPlayBody,
  SpotifyQueue,
  SpotifyTrack,
} from './api.js';
import {
  albumSummaryFromTrack,
  mapTrack,
  spotifyTrackId,
} from './map.js';
import type { MprisPlaybackSource, MprisPlaybackState } from './mpris.js';

/** Subset of SpotifyApi used by zones (a fake is injected in tests). */
export interface SpotifyZoneApi {
  /** `fresh`: the picker just opened and wants the current list even if the short cache is still warm. */
  devices(fresh?: boolean): Promise<SpotifyDevice[]>;
  tracks(ids: string[], opts?: { maxSingles?: number }): Promise<SpotifyTrack[]>;
  /** One track by id (GET /tracks/{id}). Dev-mode apps may not use the batch endpoint. */
  track(id: string): Promise<SpotifyTrack>;
  /** The account's /me/player. `forDevice` names the zone asking, so a free source for that device can answer. */
  currentPlayback(forDevice?: string): Promise<SpotifyPlaybackState | null>;
  /** Will the next read for this device cost no Spotify request (MPRIS)? Then budget and breaker need not slow it. */
  readsFree?(deviceId: string): boolean;
  queue(): Promise<SpotifyQueue>;
  play(body: SpotifyPlayBody, deviceId?: string): Promise<void>;
  /** PUT /me/player: moves playback to a device and (play: true) wakes its app. Absent for older fakes. */
  transfer?(deviceId: string, play?: boolean): Promise<void>;
  pause(deviceId?: string): Promise<void>;
  next(deviceId?: string): Promise<void>;
  previous(deviceId?: string): Promise<void>;
  seek(positionMs: number, deviceId?: string): Promise<void>;
  setVolume(percent: number, deviceId?: string): Promise<void>;
  setShuffle(on: boolean, deviceId?: string): Promise<void>;
  setRepeat(mode: 'off' | 'track' | 'context', deviceId?: string): Promise<void>;
  enqueue(uri: string, deviceId?: string): Promise<void>;
}

export interface ConnectZoneOptions {
  /** Whether at least one websocket client is visible. Undefined = always watched. */
  hasClients?: () => boolean;
  /**
   * Whether anyone views this zone (a visible tab shows or drives it). An unviewed zone makes no background reads: only
   * a command, or wake() once someone views it, reads it. Undefined = always viewed.
   */
  viewed?: (zone: Zone) => boolean;
  /** Whether a visible tab shows this zone: only then is its Spotify queue read. Undefined = whenever a client is visible. */
  shown?: (zone: Zone) => boolean;
  /** Rolling daily budget level; background polls slow down as it fills (default normal). */
  budgetLevel?: () => SpotifyBudgetLevel;
  /** Songs rune already has (title, artists, album, cover) by 'sp:' id: shown at once, no Spotify lookup. */
  knownTracks?: (ids: string[]) => QueueItem[];
  /** Spotify's circuit breaker: while this is in the future, the loop must not call Spotify. */
  blockedUntil?: () => number | null;
  now?: () => number;
  /** Latest playback report from a browser's Web Playback SDK (a free /me/player substitute). */
  localPlayback?: LocalPlaybackSource;
  /** This PC's Spotify app over MPRIS: a free /me/player substitute for its own device (phase 2). */
  mpris?: MprisPlaybackSource;
  /** Gets one line per play: what the first poll after it found (track ids only). */
  logger?: SpotifyBudgetLogger;
}

// ---------- local playback reports ----------

/** The track as the browser's Web Playback SDK reports it. */
export interface LocalPlaybackTrackReport {
  id: string;
  uri: string;
  name: string;
  durationMs: number;
  artists: { name: string; uri: string }[];
  album: { name: string; uri: string; images: { url: string; width: number | null; height: number | null }[] };
}

/** A validated report from the browser's Spotify device, stamped with the server receive time. */
export interface LocalPlaybackReport {
  deviceId: string;
  active: boolean;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  track: LocalPlaybackTrackReport | null;
  shuffle: boolean;
  repeat: 0 | 1 | 2;
  /** 0..1 */
  volume: number;
}

const MAX_MSG_STRING = 4000;
const TWENTY_FOUR_HOURS = 86_400_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
/** A bounded string; empty is allowed. */
function text(v: unknown, max = MAX_MSG_STRING): string | null {
  return typeof v === 'string' && v.length <= max ? v : null;
}
function requiredText(v: unknown, max = MAX_MSG_STRING): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}
function numberIn(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;
}

function parseImages(v: unknown): { url: string; width: number | null; height: number | null }[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 20) return null;
  const out: { url: string; width: number | null; height: number | null }[] = [];
  for (const raw of v) {
    if (!isRecord(raw)) return null;
    const url = requiredText(raw.url, 2000);
    if (url === null) return null;
    const width = raw.width === null || raw.width === undefined ? null : numberIn(raw.width, 0, 100_000);
    const height = raw.height === null || raw.height === undefined ? null : numberIn(raw.height, 0, 100_000);
    if ((raw.width !== null && raw.width !== undefined && width === null) || (raw.height !== null && raw.height !== undefined && height === null)) return null;
    out.push({ url, width, height });
  }
  return out;
}

function parseLocalTrack(v: unknown): LocalPlaybackTrackReport | null {
  if (!isRecord(v)) return null;
  const id = requiredText(v.id, 500);
  const uri = requiredText(v.uri, 2000);
  const name = text(v.name, 2000);
  const durationMs = numberIn(v.durationMs, 0, TWENTY_FOUR_HOURS);
  if (id === null || uri === null || name === null || durationMs === null) return null;
  if (!Array.isArray(v.artists) || v.artists.length > 100) return null;
  const artists: { name: string; uri: string }[] = [];
  for (const a of v.artists) {
    if (!isRecord(a)) return null;
    const an = text(a.name, 500);
    const au = text(a.uri, 2000);
    if (an === null || au === null) return null;
    artists.push({ name: an, uri: au });
  }
  if (!isRecord(v.album)) return null;
  const albumName = text(v.album.name, 2000);
  const albumUri = text(v.album.uri, 2000);
  const images = parseImages(v.album.images);
  if (albumName === null || albumUri === null || images === null) return null;
  return { id, uri, name, durationMs, artists, album: { name: albumName, uri: albumUri, images } };
}

/** Validate an untrusted `sdk-state` message; null when malformed (never trust the client). */
export function parseLocalPlaybackReport(raw: unknown): LocalPlaybackReport | null {
  if (!isRecord(raw)) return null;
  const deviceId = requiredText(raw.deviceId, 500);
  if (deviceId === null || typeof raw.active !== 'boolean') return null;
  if (!raw.active) {
    return {
      deviceId,
      active: false,
      playing: false,
      positionMs: 0,
      durationMs: 0,
      track: null,
      shuffle: false,
      repeat: 0,
      volume: 0,
    };
  }
  const playing = raw.playing;
  const shuffle = raw.shuffle;
  const repeat = raw.repeat;
  const positionMs = numberIn(raw.positionMs, 0, TWENTY_FOUR_HOURS);
  const durationMs = numberIn(raw.durationMs, 0, TWENTY_FOUR_HOURS);
  const volume = numberIn(raw.volume, 0, 1);
  const track = parseLocalTrack(raw.track);
  if (
    typeof playing !== 'boolean' ||
    typeof shuffle !== 'boolean' ||
    (repeat !== 0 && repeat !== 1 && repeat !== 2) ||
    positionMs === null ||
    durationMs === null ||
    volume === null ||
    track === null
  ) {
    return null;
  }
  return { deviceId, active: true, playing, positionMs, durationMs, track, shuffle, repeat, volume };
}

/** How long a local report is used as a synthetic /me/player answer. */
const LOCAL_REPORT_FRESH_MS = 20_000;
/** After a write command, wait for the device to report the change itself. */
const LOCAL_COMMAND_HOLD_MS = 4_000;
/** At most one wake in this window, however many reports arrive. */
const LOCAL_WAKE_DEBOUNCE_MS = 500;

/** The browser SDK's latest report plus the last command that went through the shared wrapper. */
export class LocalPlaybackSource {
  private latest: { report: LocalPlaybackReport; receivedAt: number } | null = null;
  private lastCommand: { at: number; deviceId?: string } | null = null;
  private wakeFn: () => void = () => {};
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private wakePending = false;

  constructor(private readonly now: () => number = Date.now) {}

  /** Zones call this from their constructor so a report can make them poll at once. */
  setWake(fn: () => void): void {
    this.wakeFn = fn;
  }

  /** Record a validated report, stamped with the server's clock. */
  accept(report: LocalPlaybackReport): void {
    if (!report.active) {
      // Playback moved off this device: forget the synthetic answer.
      if (!this.latest || this.latest.report.deviceId === report.deviceId) this.latest = null;
      return;
    }
    const prev = this.latest?.report ?? null;
    this.latest = { report, receivedAt: this.now() };
    if (wakeWorthy(prev, report)) this.scheduleWake();
  }

  /** A write went through the wrapper. A different device means playback is moving away. */
  noteCommand(deviceId: string | undefined): void {
    this.lastCommand = { at: this.now(), deviceId };
    if (deviceId && this.latest && this.latest.report.deviceId !== deviceId) this.latest = null;
  }

  /** The report only if it may replace a real GET /me/player right now. */
  usable(at: number): { report: LocalPlaybackReport; receivedAt: number } | null {
    const latest = this.latest;
    if (!latest || !latest.report.active) return null;
    if (at - latest.receivedAt >= LOCAL_REPORT_FRESH_MS) return null;
    const cmd = this.lastCommand;
    // A just-sent command wins unless the device already reported after it.
    if (cmd && at - cmd.at < LOCAL_COMMAND_HOLD_MS && latest.receivedAt <= cmd.at) return null;
    return latest;
  }

  private scheduleWake(): void {
    if (this.wakeTimer) {
      this.wakePending = true;
      return;
    }
    this.wakeFn();
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      if (this.wakePending) {
        this.wakePending = false;
        this.scheduleWake();
      }
    }, LOCAL_WAKE_DEBOUNCE_MS);
    this.wakeTimer.unref?.();
  }
}

function wakeWorthy(prev: LocalPlaybackReport | null, next: LocalPlaybackReport): boolean {
  if (!prev) return true;
  return (
    prev.track?.id !== next.track?.id ||
    prev.playing !== next.playing ||
    prev.shuffle !== next.shuffle ||
    prev.repeat !== next.repeat
  );
}

/** How long a just-played zone ignores /me/player still naming the previous device. */
const CLAIM_MS = 5000;
const SETTLE_TRIES = 4;
/** How long a just-set volume wins over /me/player still reporting the old one. */
const VOLUME_HOLD_MS = 4000;
/** How long a just-skipped-to song is shown while Spotify still reports the previous one. */
const TRACK_HOLD_MS = 4000;
const SETTLE_GAP_MS = 350;
/** An answer with nothing playing is believed only after it stood this long, over at least two reads. */
const EMPTY_CONFIRM_MS = 4000;
/** How soon the zone looks again after such an answer. */
const EMPTY_RECHECK_MS = 5000;
/**
 * After a command the UI wants confirmation at once: poll ~1 s and ~3 s after it,
 * then fall back to the track-aware schedule below.
 */
const FAST_FOLLOW_UP_FIRST_MS = 1000;
const FAST_FOLLOW_UP_SECOND_MS = 2000;
/**
 * How long a queued command waits for the one ahead of it. Spotify requests have no timeout of their own: without
 * this limit a single hung request would hold back every later command on the zone until rune restarts.
 */
const COMMAND_WAIT_MS = 10_000;
const STARTS_SOUND = new Set<PlayerCommand['type']>(['play', 'resume', 'next', 'prev', 'jump']);
/** Spotify's play call takes at most this many URIs: a longer list is sent as a window from the starting song. */
export const MAX_PLAY_URIS = 100;

/** The part of a list Spotify can take: up to MAX_PLAY_URIS songs from `start` on (as the web client windows them). */
export function playWindow<T>(list: T[], start: number): { list: T[]; start: number } {
  const at = Math.max(0, Math.min(start, list.length - 1));
  if (list.length <= MAX_PLAY_URIS) return { list, start: at };
  return { list: list.slice(at, at + MAX_PLAY_URIS), start: 0 };
}
/** How soon after a track hold or claim runs out the zone looks again. */
const HOLD_EXPIRY_SLACK_MS = 250;
/** Poll just after the playing song ends (duration - position + slack), capped. */
const WATCHED_PLAYING_MAX_MS = 30_000;
const UNWATCHED_PLAYING_MAX_MS = 60_000;
const WATCHED_PLAYING_SLACK_MS = 1_500;
const UNWATCHED_PLAYING_SLACK_MS = 5_000;
/** Used when /me/player does not include a duration. */
const WATCHED_PLAYING_UNKNOWN_MS = 15_000;
const UNWATCHED_PLAYING_UNKNOWN_MS = 30_000;
const WATCHED_IDLE_MS = 20_000;
const UNWATCHED_IDLE_MS = 300_000;
const MIN_BACKGROUND_POLL_MS = 1_500;
/** While Spotify's breaker is up nothing re-reads a zone: a song shown playing is shown paused this long after its time is up. */
const BLOCKED_STALE_SLACK_MS = 5_000;
/** The same for a song of unknown length, counted from the last read. */
const BLOCKED_STALE_UNKNOWN_MS = 600_000;
/** 'out' means at most one background poll every ten minutes. */
const OUT_BACKGROUND_POLL_MS = 600_000;
const BUDGET_DELAY_MULTIPLIER: Record<Exclude<SpotifyBudgetLevel, 'out'>, number> = {
  normal: 1,
  tight: 2,
  low: 4,
};
/**
 * How long a /me/player/queue answer stays good enough to reuse. The item id changing
 * (or a command / a connected client) forces a fresh read sooner.
 */
const QUEUE_STALE_MS = 300_000;
/** Metadata lookups for a just-started queue: the window around startIndex, in parallel. */
const STARTED_LOOKUPS = 8;
const STARTED_LOOKUP_CONCURRENCY = 3;

const EMPTY_ALBUM = { id: 'sp:unknown', title: '', coverUrl: undefined } as const;

export function emptyPlayerState(zone: Zone, now: () => number = Date.now): PlayerState {
  return {
    zone,
    status: 'stopped',
    queue: [],
    index: -1,
    positionMs: 0,
    volume: 0,
    shuffle: false,
    repeat: 'off',
    updatedAt: now(),
  };
}

function queueItemFromSpotify(sp: SpotifyTrack, position: number): QueueItem {
  // An answer built from MPRIS carries rune's own row for the song (titles, cover, artist links).
  const own = (sp as SpotifyTrack & { rune?: QueueItem }).rune;
  if (own) return { ...own, queueId: `spq:${position}:${own.track.id}` };
  const track = mapTrack(sp);
  return {
    queueId: `spq:${position}:${track.id}`,
    track,
    album: albumSummaryFromTrack(sp),
  };
}

function placeholderQueueItem(track: Track, position: number): QueueItem {
  return { queueId: `spq:${position}:${track.id}`, track, album: { ...EMPTY_ALBUM } };
}

function placeholderTrack(id: string): Track {
  return {
    id,
    albumId: 'sp:unknown',
    source: 'spotify',
    title: '',
    artists: [],
    disc: 1,
    number: 1,
    durationMs: 0,
    spotifyUri: `spotify:track:${id.startsWith('sp:') ? id.slice(3) : id}`,
  };
}

/** Pure /me/player (+queue) → PlayerState mapping. */
export function mapPlaybackState(
  zone: Zone,
  playback: SpotifyPlaybackState | null,
  spotifyQueue: SpotifyQueue | undefined,
  startedQueue: QueueItem[] = [],
  now: () => number = Date.now,
): PlayerState {
  if (!playback) return emptyPlayerState(zone, now);

  const items: QueueItem[] = [];
  const seen = new Set<string>();

  // What Spotify itself says about the playing / upcoming tracks: complete data that can
  // replace placeholders in the list we started (when the track lookup failed).
  const real = new Map<string, SpotifyTrack>();
  if (playback?.item?.id) real.set(spotifyTrackId(playback.item.id), playback.item);
  for (const sp of spotifyQueue?.queue ?? []) if (sp?.id && !real.has(spotifyTrackId(sp.id))) real.set(spotifyTrackId(sp.id), sp);

  for (const item of startedQueue) {
    if (seen.has(item.track.id)) continue;
    seen.add(item.track.id);
    const full = !item.track.title ? real.get(item.track.id) : undefined;
    items.push(full ? queueItemFromSpotify(full, items.length) : item);
  }

  const current = playback.item;
  const currentKey = current ? (current.id ? spotifyTrackId(current.id) : current.uri) : '';
  if (current && !seen.has(currentKey)) {
    seen.add(currentKey);
    items.push(queueItemFromSpotify(current, items.length));
  }

  for (const sp of spotifyQueue?.queue ?? []) {
    const mapped = mapTrack(sp);
    if (seen.has(mapped.id)) continue;
    seen.add(mapped.id);
    items.push(queueItemFromSpotify(sp, items.length));
  }

  let index = current
    ? items.findIndex((q) => q.track.id === currentKey || q.track.spotifyUri === current.uri)
    : -1;

  // With Spotify's shuffle on, what plays next is Spotify's own order, not the list we sent:
  // put the upcoming songs in the order /me/player/queue reports them.
  if (playback.shuffle_state && index >= 0 && (spotifyQueue?.queue?.length ?? 0) > 0) {
    const byId = new Map(items.map((q) => [q.track.id, q]));
    const upcoming: QueueItem[] = [];
    const taken = new Set<string>([items[index]!.track.id]);
    for (const sp of spotifyQueue!.queue) {
      const id = mapTrack(sp).id;
      const it = byId.get(id);
      if (!it || taken.has(id)) continue;
      taken.add(id);
      upcoming.push(it);
    }
    const before = items.slice(0, index).filter((q) => !taken.has(q.track.id));
    const rest = items.slice(index + 1).filter((q) => !taken.has(q.track.id));
    const reordered = [...before, items[index]!, ...upcoming, ...rest];
    items.splice(0, items.length, ...reordered);
    index = before.length;
  }

  return {
    zone,
    status: playback.is_playing ? 'playing' : current ? 'paused' : 'stopped',
    queue: items,
    index,
    positionMs: playback.progress_ms ?? 0,
    volume: playback.device?.volume_percent ?? 0,
    shuffle: playback.shuffle_state ?? false,
    repeat: mapRepeat(playback.repeat_state),
    updatedAt: now(),
  };
}

function mapRepeat(state: SpotifyPlaybackState['repeat_state'] | undefined): PlayerState['repeat'] {
  switch (state) {
    case 'context':
      return 'all';
    case 'track':
      return 'one';
    default:
      return 'off';
  }
}

function repeatParam(mode: PlayerState['repeat']): 'off' | 'track' | 'context' {
  switch (mode) {
    case 'all':
      return 'context';
    case 'one':
      return 'track';
    default:
      return 'off';
  }
}

export class SpotifyConnectZone implements PlaybackZone {
  readonly zone: Zone;
  readonly deviceId: string;
  readonly name: string;

  private readonly api: SpotifyZoneApi;
  private readonly hasClients: (() => boolean) | undefined;
  private readonly viewed: ((zone: Zone) => boolean) | undefined;
  private readonly shown: ((zone: Zone) => boolean) | undefined;
  private readonly budgetLevel: (() => SpotifyBudgetLevel) | undefined;
  private readonly knownTracks: ((ids: string[]) => QueueItem[]) | undefined;
  private readonly blockedUntil: (() => number | null) | undefined;
  private readonly logger: SpotifyBudgetLogger | undefined;
  private readonly now: () => number;
  private snapshot: PlayerState;
  private startedQueue: QueueItem[] = [];
  /** Bumped whenever startedQueue is replaced, so a slow background lookup cannot overwrite it. */
  private startedRev = 0;
  private readonly listeners = new Set<(s: PlayerState) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingVolume: { volume: number; device: string | undefined } | null = null;
  private volumeSending: Promise<void> | null = null;
  private inFlight: Promise<void> | null = null;
  private closed = false;
  /** Tail of the command queue, null while it is empty (see serialize). */
  private ops: Promise<void> | null = null;
  private claimUntil = 0;
  /** Last poll that found this device not playing: a start seen after it happened no earlier. */
  private lastIdleAt = Number.NEGATIVE_INFINITY;
  /** The song just sent to play: the first poll after it says what Spotify made of it. */
  private playSent: { trackId: string } | null = null;
  /** Last command that starts sound: such a start is seen as it happens, not at a later poll. */
  private startCommandAt = Number.NEGATIVE_INFINITY;
  private volumeHold: { volume: number; until: number } | null = null;
  /** Same for shuffle / repeat right after they were switched. */
  private toggleHold: { shuffle?: boolean; repeat?: PlayerState['repeat']; until: number } | null = null;
  private lastActiveDevice: string | null = null;
  /** When the run of empty /me/player answers began, and how long it is (see passingEmpty). */
  private emptySince: number | null = null;
  private emptyReads = 0;
  /** The song just skipped/jumped to: shown at once and kept while Spotify still reports the old one. */
  private trackHold: { id: string; until: number } | null = null;
  /** Queue reuse: only re-read when the item changed, a command ran, or it went stale. */
  private lastQueue: SpotifyQueue | undefined;
  private lastQueueAt = Number.NEGATIVE_INFINITY;
  private lastQueueItemId: string | null = null;
  private queueDirty = false;
  /** Last successful /me/player answer: duration/position drive the next poll time. */
  private lastPlayback: SpotifyPlaybackState | null = null;
  /** Polls still owed after a user command (fast UI confirmation, budget never applies). */
  private fastPolls = 0;

  constructor(api: SpotifyZoneApi, deviceId: string, name: string, opts: ConnectZoneOptions = {}) {
    this.api = api;
    this.deviceId = deviceId;
    this.name = name;
    this.zone = `spotify:${deviceId}`;
    this.hasClients = opts.hasClients;
    this.viewed = opts.viewed;
    this.shown = opts.shown;
    this.budgetLevel = opts.budgetLevel;
    this.knownTracks = opts.knownTracks;
    this.blockedUntil = opts.blockedUntil;
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
    this.snapshot = emptyPlayerState(this.zone, this.now);
  }

  state(): PlayerState {
    return this.snapshot;
  }

  onChange(cb: (s: PlayerState) => void): () => void {
    this.listeners.add(cb);
    this.ensurePolling();
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0) this.clearTimer();
    };
  }

  command(cmd: PlayerCommand): Promise<PlayerState> {
    // Volume stays out of the queue: a slider drag coalesces on its own and must not wait behind a play. It reads
    // nothing back either: the level is already shown, and a voice duck (two changes) must not cost four polls.
    return cmd.type === 'volume' ? this.runCommand(cmd) : this.serialize(() => this.dispatch(cmd));
  }

  /** One command at a time, in the order they came: a pause sent just before a play must not land after it. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.ops ? this.ops.then(fn, fn) : fn();
    const tail = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, COMMAND_WAIT_MS);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      run.then(done, done);
    }).then(() => {
      if (this.ops === tail) this.ops = null;
    });
    this.ops = tail;
    return run;
  }

  /**
   * When the current playing began, as near as can be told. Rune's own starts are seen at once. A start found by a poll
   * lies between the last idle poll and now, and the position dates it unless the song was resumed part-way through.
   */
  startedAt(): number {
    const at = this.now();
    if (at - this.startCommandAt < CLAIM_MS) return at;
    return Math.max(this.lastIdleAt, at - this.snapshot.positionMs);
  }

  /** rune's description of a song this zone holds (the queue it started, or the one it shows), for a free read source. */
  knownItem(trackId: string): QueueItem | undefined {
    const titled = (q: QueueItem) => q.track.id === trackId && !!q.track.title;
    return this.startedQueue.find(titled) ?? this.snapshot.queue.find(titled);
  }

  private async dispatch(cmd: PlayerCommand): Promise<PlayerState> {
    if (STARTS_SOUND.has(cmd.type)) this.startCommandAt = this.now();
    // A command may change what is up next: the next poll must not reuse a cached queue.
    this.queueDirty = true;
    // Two fast follow-up polls confirm the command in the UI regardless of budget.
    this.fastPolls = 2;
    // Drop a slow background timer: it must not fire at the old, track-aware time now.
    this.clearTimer();
    try {
      return await this.runCommand(cmd);
    } finally {
      this.scheduleFastFollowUp();
    }
  }

  private async runCommand(cmd: PlayerCommand): Promise<PlayerState> {
    const device = this.deviceId;
    switch (cmd.type) {
      case 'play': {
        const window = playWindow(cmd.trackIds.map((id) => this.requireSpotifyTrack(id)), cmd.startIndex ?? 0);
        const spotifyIds = window.list;
        const uris = spotifyIds.map((id) => `spotify:track:${id}`);
        const body: SpotifyPlayBody = { uris };
        // always name the first song: with Spotify's shuffle on, a list without an offset starts on a
        // random one (rune shuffles before sending, so the order it sends is the order it wants)
        if (uris.length > 0) body.offset = { position: window.start };
        if (cmd.positionMs && cmd.positionMs > 0) body.position_ms = Math.round(cmd.positionMs);
        // Send the songs right away (one read like any other command): a lot of tests, and the UI, depend on the
        // started queue reaching the listeners before the first poll can. Only an unreachable device costs extra.
        try {
          await this.api.play(body, device);
        } catch (err) {
          if (!deviceUnreachable(err)) throw err;
          await this.recoverStart(body);
        }
        this.claim();
        if (cmd.paused) await this.api.pause(device).catch(() => undefined);
        // Show the picked song and the queue we sent at once; Spotify's metadata for those
        // songs is fetched in the background (the command must not wait for it).
        const start = window.start;
        if (!cmd.paused) this.playSent = { trackId: spotifyTrackId(spotifyIds[start] ?? '') };
        const rev = ++this.startedRev;
        this.startedQueue = this.seedQueue(spotifyIds);
        this.showStarted(start, cmd.positionMs ?? 0, cmd.paused === true);
        void this.fetchStartedQueue(spotifyIds, start)
          .then((queue) => {
            if (this.closed || rev !== this.startedRev) return;
            this.startedQueue = queue;
            this.publishStartedQueue();
          })
          .catch(() => undefined);
        return this.confirmStart(body);
      }
      case 'enqueue': {
        // Spotify's Web API only appends; it cannot insert next. `next` is ignored.
        for (const id of cmd.trackIds) {
          await this.api.enqueue(`spotify:track:${this.requireSpotifyTrack(id)}`, device);
        }
        return this.refresh();
      }
      case 'pause':
        await this.api.pause(device).catch(unlessAlreadyDone);
        return this.refresh();
      case 'resume':
        try {
          await this.api.play({}, device);
        } catch (err) {
          unlessAlreadyDone(err);
          return this.refresh();
        }
        this.claim();
        this.playSent = { trackId: this.snapshot.queue[this.snapshot.index]?.track.id ?? '' };
        return this.settle();
      case 'next':
        this.expectSong(this.snapshot.index + 1);
        await this.api.next(device);
        return this.refresh();
      case 'prev':
        await this.api.previous(device);
        return this.refresh();
      case 'seek':
        await this.api.seek(cmd.positionMs, device);
        return this.refresh();
      case 'jump': {
        const item = this.snapshot.queue[cmd.index];
        if (!item) throw new Error(`No queue item at index ${cmd.index} in zone ${this.zone}.`);
        if (!item.track.spotifyUri) throw new Error(`Queue item ${cmd.index} has no Spotify URI.`);
        // replay the whole queue starting at the picked song (an explicit offset: with shuffle on,
        // Spotify would otherwise start on a random song), so the queue and Previous stay intact
        const all = this.snapshot.queue.filter((q) => !!q.track.spotifyUri);
        const picked = playWindow(all, all.indexOf(item));
        const uris = picked.list.map((q) => q.track.spotifyUri as string);
        const position = picked.start;
        this.expectSong(cmd.index);
        await this.api.play({ uris, offset: { position } }, device);
        this.claim();
        this.playSent = { trackId: item.track.id };
        const ids = uris.map((u) => u.split(':').pop() as string);
        const rev = ++this.startedRev;
        const queue = await this.fetchStartedQueue(ids, position);
        if (rev === this.startedRev) this.startedQueue = queue;
        return this.settle();
      }
      case 'remove':
        throw new Error(
          'Spotify Connect does not support removing individual queue items: Spotify has no Web API for it.',
        );
      case 'move':
        throw new Error(
          'Spotify Connect does not support reordering its queue: Spotify has no Web API for it.',
        );
      case 'clear':
        throw new Error(
          'Spotify Connect does not support clearing its queue: Spotify has no Web API for it.',
        );
      case 'volume': {
        // Spotify keeps reporting the previous level for a moment: don't bounce back to it.
        this.volumeHold = { volume: Math.round(cmd.volume), until: this.now() + VOLUME_HOLD_MS };
        this.snapshot = { ...this.snapshot, volume: this.volumeHold.volume };
        for (const cb of this.listeners) cb(this.snapshot);
        // A slider drag sends many levels: send one at a time and only the newest one waiting, and don't
        // re-read the player afterwards (the level is already shown; the next scheduled poll confirms it).
        this.pendingVolume = { volume: cmd.volume, device };
        if (!this.volumeSending) {
          this.volumeSending = (async () => {
            while (this.pendingVolume) {
              const next = this.pendingVolume;
              this.pendingVolume = null;
              await this.api.setVolume(next.volume, next.device);
            }
          })().finally(() => {
            this.volumeSending = null;
            this.pendingVolume = null;
          });
        }
        await this.volumeSending;
        return this.snapshot;
      }
      case 'shuffle':
        await this.api.setShuffle(cmd.on, device);
        this.toggleHold = { ...this.toggleHold, shuffle: cmd.on, until: this.now() + VOLUME_HOLD_MS };
        this.snapshot = { ...this.snapshot, shuffle: cmd.on };
        for (const cb of this.listeners) cb(this.snapshot);
        return this.refresh();
      case 'repeat':
        await this.api.setRepeat(repeatParam(cmd.mode), device);
        this.toggleHold = { ...this.toggleHold, repeat: cmd.mode, until: this.now() + VOLUME_HOLD_MS };
        this.snapshot = { ...this.snapshot, repeat: cmd.mode };
        for (const cb of this.listeners) cb(this.snapshot);
        return this.refresh();
      default:
        return assertNever(cmd);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearTimer();
    this.listeners.clear();
    if (this.inFlight) await this.inFlight.catch(() => undefined);
  }

  // ---------- internals ----------

  private requireSpotifyTrack(id: string): string {
    if (!id.startsWith('sp:')) {
      throw new Error(
        `Cannot play "${id}" on Spotify Connect zone ${this.zone}: only Spotify tracks ('sp:' ids) ` +
          'can be played there. Use the PC or browser zone for local library tracks.',
      );
    }
    return id.slice(3);
  }

  /** The queue we just sent, filled from rune's own database where it can be; placeholders otherwise. */
  private seedQueue(spotifyIds: string[]): QueueItem[] {
    let known = new Map<string, QueueItem>();
    try {
      known = new Map((this.knownTracks?.(spotifyIds.map(spotifyTrackId)) ?? []).map((q) => [q.track.id, q]));
    } catch {
      // the database is a shortcut only
    }
    return spotifyIds.map((id, position) => {
      const k = known.get(spotifyTrackId(id));
      return k ? { ...k, queueId: `spq:${position}:${k.track.id}` } : placeholderQueueItem(placeholderTrack(spotifyTrackId(id)), position);
    });
  }

  private async fetchStartedQueue(spotifyIds: string[], startIndex = 0): Promise<QueueItem[]> {
    if (spotifyIds.length === 0) return [];
    // what rune already knows needs no Spotify request
    const seeded = this.seedQueue(spotifyIds);
    if (seeded.every((q) => !!q.track.title)) return seeded;
    // The songs around the one being started first: those are the ones that get looked up
    // (Spotify's own "up next" fills in later ones).
    const from = Math.max(0, Math.min(startIndex, spotifyIds.length - 1) - 2);
    const unknown = new Set(seeded.filter((q) => !q.track.title).map((q) => q.track.id));
    const ordered = [...spotifyIds.slice(from), ...spotifyIds.slice(0, from)]
      .filter((id) => unknown.has(spotifyTrackId(id)))
      .slice(0, STARTED_LOOKUPS);
    const byId = new Map<string, SpotifyTrack>();
    try {
      // Single GET /tracks/{id} lookups (development-mode apps may not use /tracks?ids=),
      // at most STARTED_LOOKUP_CONCURRENCY in flight.
      await eachLimit(ordered, STARTED_LOOKUP_CONCURRENCY, async (id) => {
        try {
          const track = await this.api.track(id);
          if (track?.id) byId.set(track.id, track);
        } catch (err) {
          if ((err as { status?: number }).status === 429) throw err;
          // unknown / unavailable track: leave its placeholder
        }
      });
    } catch {
      // Metadata is cosmetic for the queue; fall back to placeholders.
    }

    return spotifyIds.map((id, position) => {
      const sp = byId.get(id);
      return sp ? queueItemFromSpotify(sp, position) : seeded[position]!;
    });
  }

  /** Show the song that was just started at once, before Spotify's poll catches up. */
  private showStarted(index: number, positionMs: number, paused: boolean): void {
    const item = this.startedQueue[index];
    if (!item) return;
    this.trackHold = { id: item.track.id, until: this.now() + TRACK_HOLD_MS };
    this.snapshot = {
      ...this.snapshot,
      queue: this.startedQueue.slice(),
      index,
      positionMs: positionMs > 0 ? Math.round(positionMs) : 0,
      status: paused ? 'paused' : 'playing',
      updatedAt: this.now(),
    };
    for (const cb of this.listeners) cb(this.snapshot);
  }

  /** Metadata for the just-started queue arrived: fill its placeholders and tell listeners. */
  private publishStartedQueue(): void {
    if (this.startedQueue.length === 0) return;
    const byId = new Map(this.startedQueue.map((q) => [q.track.id, q]));
    let changed = false;
    const queue = this.snapshot.queue.map((q) => {
      const real = byId.get(q.track.id);
      if (!real) return q;
      if (real.track.title === q.track.title && real.album.id === q.album.id) return q;
      changed = true;
      return { ...q, track: real.track, album: real.album };
    });
    // A play command always seeds snapshot.queue from startedQueue, but stay safe if it did not.
    if (queue.length === 0 && this.startedQueue.length > 0) {
      this.snapshot = { ...this.snapshot, queue: this.startedQueue.slice() };
      for (const cb of this.listeners) cb(this.snapshot);
      return;
    }
    if (!changed) return;
    this.snapshot = { ...this.snapshot, queue, updatedAt: this.now() };
    for (const cb of this.listeners) cb(this.snapshot);
  }

  private async refresh(): Promise<PlayerState> {
    await this.pollOnce();
    return this.snapshot;
  }

  /** Show the song at `index` right away (position 0) instead of waiting ~1 s for Spotify to report it. */
  private expectSong(index: number): void {
    const item = this.snapshot.queue[index];
    if (!item) return;
    this.trackHold = { id: item.track.id, until: this.now() + TRACK_HOLD_MS };
    this.snapshot = { ...this.snapshot, index, positionMs: 0, status: 'playing', updatedAt: this.now() };
    for (const cb of this.listeners) cb(this.snapshot);
  }

  /** Playback was just sent to this device: Spotify takes a moment before /me/player names it. */
  private claim(): void {
    this.claimUntil = this.now() + CLAIM_MS;
  }

  /** Poll until Spotify reports this device as the active one (or give up after a few tries). */
  private async settle(): Promise<PlayerState> {
    await this.settledOnDevice();
    return this.snapshot;
  }

  /** Does Spotify now name this device as the active one? Polls a few times: the switch takes a moment. */
  private async settledOnDevice(tries = SETTLE_TRIES, gapMs = SETTLE_GAP_MS): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
      await this.pollOnce();
      if (this.lastActiveDevice === this.deviceId) return true;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, gapMs));
    }
    return false;
  }

  /** This device as Spotify's device list describes it right now (undefined if the list cannot be read). */
  private async deviceInfo(): Promise<SpotifyDevice | undefined> {
    try {
      return (await this.api.devices()).find((d) => d.id === this.deviceId);
    } catch {
      return undefined;
    }
  }

  /**
   * Spotify could not reach this Connect device at all (404, a 403): its app is asleep or gone. Ask the device list
   * whether it is restricted, then wake it once (a transfer with play:true starts the app) and send the songs again.
   * If Spotify accepts the play instead, that is all this can tell — a sleeping phone accepts it too (confirmStart).
   */
  private async recoverStart(body: SpotifyPlayBody): Promise<void> {
    const info = await this.deviceInfo();
    if (info?.is_restricted) throw this.restrictedError();
    await this.wakeApp();
    try {
      await this.api.play(body, this.deviceId);
    } catch (err) {
      // Refused twice: a plain message the user can act on, not a retry that claims success from /me/player.
      if (!deviceUnreachable(err)) throw err;
      throw new Error(this.wakeMessage(info?.type));
    }
    if (await this.settledOnDevice(6, 500)) return;
    throw new Error(this.wakeMessage(info?.type));
  }

  /**
   * After a play Spotify accepted, check that this device really became the active one. A phone whose app went to
   * sleep stays listed as inactive and accepts a play that then does nothing: then transfer to it (play:true wakes
   * the app), send the songs again, and if it never wakes, throw what the user can act on. A device that is merely
   * slow to switch is left to the ordinary polling: nothing here blocks the started queue from showing.
   */
  private async confirmStart(body: SpotifyPlayBody): Promise<PlayerState> {
    if (await this.settledOnDevice()) return this.snapshot;
    const info = await this.deviceInfo();
    if (info?.is_restricted) throw this.restrictedError();
    if (!info || info.is_active) return this.snapshot;
    await this.wakeApp();
    try {
      await this.api.play(body, this.deviceId);
    } catch (err) {
      if (!deviceUnreachable(err)) throw err;
      throw new Error(this.wakeMessage(info.type));
    }
    if (await this.settledOnDevice(6, 500)) return this.snapshot;
    throw new Error(this.wakeMessage(info.type));
  }

  private restrictedError(): Error {
    return new Error(
      `Spotify has marked “${this.name}” as restricted, so rune cannot control it. ` +
        'Turn off the private session there (or pick another device).',
    );
  }

  /** Wake a sleeping Connect app: a transfer with play:true starts it on whatever it last held. (Not the public
   *  wake(), which starts this zone's polling.) */
  private async wakeApp(): Promise<void> {
    const transfer = this.api.transfer;
    if (!transfer) return;
    await transfer.call(this.api, this.deviceId, true).catch((err: unknown) => {
      // A phone that is deeply asleep refuses even the transfer; the retry after the songs is what matters.
      if ((err as { status?: number }).status === 429) throw err;
    });
  }

  private wakeMessage(type?: string | null): string {
    const phone = /smartphone|tablet/i.test(type ?? '') || /phone|iphone|ipad|android|pixel|galaxy/i.test(this.name);
    return phone
      ? `Open Spotify on your phone (“${this.name}”), then try again.`
      : `Open Spotify on “${this.name}”, then try again.`;
  }

  private async pollOnce(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.doPoll().finally(() => {
        this.inFlight = null;
      });
    }
    await this.inFlight;
  }

  /** A song that stays silent while rune shows it playing: was Spotify playing anything right after the command? */
  private logPlaySent(sent: { trackId: string }, playback: SpotifyPlaybackState | null): void {
    this.playSent = null;
    this.logger?.warn(
      {
        trackId: sent.trackId,
        reportedTrackId: playback?.item?.id ? spotifyTrackId(playback.item.id) : null,
        is_playing: playback?.is_playing ?? null,
        onThisDevice: playback?.device?.id === this.deviceId,
      },
      'spotify first poll after play',
    );
  }

  /**
   * Spotify answers 204 in passing too: a dormant device just told to play, a hiccup mid-song. Showing that as stopped
   * would read as the song ending, so the zone stays as it was until the answer repeats some seconds later, which is
   * how a player that is really gone looks.
   */
  private passingEmpty(): boolean {
    if (this.snapshot.status === 'stopped') {
      this.clearEmpty();
      return false;
    }
    const at = this.now();
    this.emptySince ??= at;
    this.emptyReads++;
    if (at < this.claimUntil || this.emptyReads < 2 || at - this.emptySince < EMPTY_CONFIRM_MS) return true;
    this.clearEmpty();
    return false;
  }

  private clearEmpty(): void {
    this.emptySince = null;
    this.emptyReads = 0;
  }

  private async doPoll(): Promise<void> {
    // Taken before the read: a poll already on its way when the play went out says nothing about it.
    const sent = this.playSent;
    let playback: SpotifyPlaybackState | null;
    try {
      playback = await this.api.currentPlayback(this.deviceId);
    } catch {
      // Do not schedule from a stale position: a failed read falls back to the capped delay.
      this.lastPlayback = null;
      return;
    }
    this.lastPlayback = playback;
    if (sent && sent === this.playSent) this.logPlaySent(sent, playback);
    // Reuse the last queue unless the playing item changed, a command ran, or the read went
    // stale (5 min). Only a zone a visible tab shows needs it: nobody else sees the queue.
    let queue: SpotifyQueue | undefined = this.lastQueue;
    if (playback && (!playback.device?.id || playback.device.id === this.deviceId)) {
      const itemId = playback.item?.id ?? null;
      // A paused player's up-next list does not move on by itself: only a playing one goes stale.
      const stale = playback.is_playing && this.now() - this.lastQueueAt >= QUEUE_STALE_MS;
      const itemChanged = itemId !== this.lastQueueItemId;
      if (this.isShown() && (this.queueDirty || itemChanged || stale || !this.lastQueue)) {
        try {
          queue = await this.api.queue();
          this.lastQueue = queue;
          this.lastQueueAt = this.now();
          this.lastQueueItemId = itemId;
        } catch {
          queue = this.lastQueue;
        }
        this.queueDirty = false;
      }
    }
    // /me/player describes the account's ACTIVE device, which may be another one (the browser,
    // the phone): then nothing is playing on this zone.
    const activeId = playback?.device?.id ?? null;
    this.lastActiveDevice = activeId;
    let next: PlayerState;
    if (playback && activeId && activeId !== this.deviceId) {
      this.clearEmpty();
      if (this.now() < this.claimUntil) return; // just told to play here: Spotify hasn't switched yet
      next = { ...emptyPlayerState(this.zone, this.now), volume: this.snapshot.volume, elsewhere: true };
    } else {
      if (!playback || (!playback.item && !playback.is_playing)) {
        if (this.passingEmpty()) return;
      } else this.clearEmpty();
      next = mapPlaybackState(this.zone, playback, queue, this.startedQueue, this.now);
      this.claimUntil = 0;
    }
    const th = this.toggleHold;
    if (th) {
      if (this.now() >= th.until) this.toggleHold = null;
      else {
        if (th.shuffle !== undefined) {
          if (next.shuffle === th.shuffle) delete th.shuffle;
          else next = { ...next, shuffle: th.shuffle };
        }
        if (th.repeat !== undefined) {
          if (next.repeat === th.repeat) delete th.repeat;
          else next = { ...next, repeat: th.repeat };
        }
      }
    }
    const tk = this.trackHold;
    if (tk) {
      const reported = next.queue[next.index]?.track.id;
      if (this.now() >= tk.until || reported === tk.id) this.trackHold = null;
      else {
        const i = next.queue.findIndex((q) => q.track.id === tk.id);
        if (i >= 0) next = { ...next, index: i, positionMs: 0, status: 'playing', updatedAt: this.now() };
      }
    }
    const hold = this.volumeHold;
    if (hold) {
      if (this.now() >= hold.until || Math.abs(next.volume - hold.volume) <= 1) this.volumeHold = null;
      else next = { ...next, volume: hold.volume };
    }
    // MPRIS saw the start as it happened: it began then, not when the position says (a resume at 2:00 is new). Set
    // before the listeners hear of it: the speaker guard asks startedAt() as it does.
    const since = (playback as MprisPlaybackState | null)?.playingSince;
    if (next.status === 'playing' && typeof since === 'number') this.lastIdleAt = Math.max(this.lastIdleAt, since);
    if (!sameState(next, this.snapshot)) {
      this.snapshot = next;
      for (const cb of this.listeners) cb(next);
    }
    if (next.status !== 'playing') this.lastIdleAt = this.now();
  }

  private ensurePolling(): void {
    if (this.closed || this.listeners.size === 0 || this.timer || this.inFlight) return;
    void this.loop();
  }

  /** A client just connected (or came back): poll now instead of waiting out a slow interval. */
  wake(): void {
    if (this.closed || this.listeners.size === 0) return;
    this.clearTimer();
    if (!this.inFlight) void this.loop();
  }

  private isViewed(): boolean {
    return this.viewed ? this.viewed(this.zone) : true;
  }

  private clientsWatching(): boolean {
    return this.hasClients ? this.hasClients() : true;
  }

  /** Someone looks at this zone's queue: worth a Spotify read of it. */
  private isShown(): boolean {
    return this.shown ? this.clientsWatching() && this.shown(this.zone) : this.clientsWatching();
  }

  /** The next read of this device costs nothing (MPRIS): the budget and the breaker do not apply to it. */
  private readsFree(): boolean {
    return this.api.readsFree?.(this.deviceId) ?? false;
  }

  private async loop(): Promise<void> {
    if (this.closed || this.listeners.size === 0) return;
    // Nobody views this zone and no command is owed a read: no background polls until wake().
    if (this.fastPolls === 0 && !this.isViewed()) return;
    // Spotify is out of quota: park the loop until the breaker expires (+1 s slack),
    // without touching the network at all.
    const blocked = this.blockedUntil?.() ?? null;
    if (blocked !== null && blocked > this.now() && !this.readsFree()) {
      this.parkWhileBlocked(blocked);
      return;
    }
    await this.pollOnce();
    if (this.closed || this.listeners.size === 0) return;
    // The poll may just have discovered the quota block.
    const nowBlocked = this.blockedUntil?.() ?? null;
    if (nowBlocked !== null && nowBlocked > this.now() && !this.readsFree()) {
      this.parkWhileBlocked(nowBlocked);
      return;
    }
    // A command is still owed fast follow-ups: budget never delays them.
    if (this.fastPolls > 0) {
      this.fastPolls--;
      if (this.fastPolls > 0) {
        this.scheduleIn(FAST_FOLLOW_UP_SECOND_MS);
        return;
      }
    }
    // The follow-ups land inside the hold and the claim, and the background delay comes from the song before: a song
    // the device never took would stay on screen as playing until that timer ran out.
    const held = this.holdExpiryDelayMs();
    const background = this.backgroundDelayMs();
    this.scheduleIn(held === null ? background : Math.min(held, background));
  }

  /**
   * Spotify is out of quota until `blocked`: wait for it without touching the network. A song shown playing would stay
   * "playing" on every client for hours (X3), so once its time is up it is shown paused at its end. Nobody can know
   * what Spotify did next; a pause holds a tab-driven queue (it never reads as the song ending), and the next real
   * read after the breaker puts it right.
   */
  private parkWhileBlocked(blocked: number): void {
    const end = this.staleAt();
    if (end !== null && this.now() >= end) {
      const s = this.snapshot;
      const dur = s.queue[s.index]?.track.durationMs ?? 0;
      this.snapshot = { ...s, status: 'paused', positionMs: dur > 0 ? dur : s.positionMs + (this.now() - s.updatedAt), updatedAt: this.now() };
      for (const cb of this.listeners) cb(this.snapshot);
    }
    const next = this.staleAt();
    this.scheduleAt(next === null ? blocked + 1000 : Math.min(next, blocked + 1000));
  }

  /** When a zone shown playing, with nothing re-reading it, should be taken as no longer known to play. */
  private staleAt(): number | null {
    const s = this.snapshot;
    if (s.status !== 'playing') return null;
    const dur = s.queue[s.index]?.track.durationMs ?? this.lastPlayback?.item?.duration_ms ?? 0;
    return dur > 0 ? s.updatedAt + Math.max(0, dur - s.positionMs) + BLOCKED_STALE_SLACK_MS : s.updatedAt + BLOCKED_STALE_UNKNOWN_MS;
  }

  /** How long until a hold, claim or unconfirmed empty answer can be settled by a poll showing what Spotify really reports; null if none is pending. */
  private holdExpiryDelayMs(): number | null {
    const left = Math.max(this.trackHold?.until ?? 0, this.claimUntil) - this.now();
    const held = left > 0 ? left + HOLD_EXPIRY_SLACK_MS : null;
    if (this.emptySince === null) return held;
    return held === null ? EMPTY_RECHECK_MS : Math.min(held, EMPTY_RECHECK_MS);
  }

  /** One fast poll after a command; the loop schedules the second one. */
  private scheduleFastFollowUp(): void {
    if (this.closed || this.listeners.size === 0 || this.fastPolls <= 0) return;
    this.scheduleIn(FAST_FOLLOW_UP_FIRST_MS);
  }

  /**
   * Next background poll: just after the current song ends while playing (so a track
   * change is seen ~1.5 s after it happens), much slower when paused/idle, and slower
   * still with nobody connected. The daily budget multiplies this delay.
   */
  private backgroundDelayMs(): number {
    const watched = this.clientsWatching();
    // A free read (MPRIS) spends no budget: it keeps the normal schedule whatever the level.
    const level = this.readsFree() ? 'normal' : (this.budgetLevel?.() ?? 'normal');
    const multiplier = level === 'out' ? 1 : BUDGET_DELAY_MULTIPLIER[level];
    let delay: number;
    // The poll aimed at the song's end. Never stretched by the budget: it replaces a periodic poll, so it costs
    // nothing extra, and stretching it left a finished song on screen for up to 30 s after the next one began.
    let songEnd: number | null = null;
    if (this.snapshot.status === 'playing') {
      const cap = watched ? WATCHED_PLAYING_MAX_MS : UNWATCHED_PLAYING_MAX_MS;
      const known = this.lastPlayback;
      const duration = known?.item?.duration_ms ?? this.snapshot.queue[this.snapshot.index]?.track.durationMs ?? 0;
      const remaining = duration > 0 ? Math.max(0, duration - (known?.progress_ms ?? this.snapshot.positionMs)) : null;
      const slack = watched ? WATCHED_PLAYING_SLACK_MS : UNWATCHED_PLAYING_SLACK_MS;
      // After a failed read the position is stale, and aiming at the song's end from it would poll a failing Spotify fast.
      if (!known) delay = cap;
      else if (remaining === null) delay = watched ? WATCHED_PLAYING_UNKNOWN_MS : UNWATCHED_PLAYING_UNKNOWN_MS;
      else {
        delay = cap;
        songEnd = remaining + slack;
      }
    } else {
      delay = watched ? WATCHED_IDLE_MS : UNWATCHED_IDLE_MS;
    }
    delay = Math.max(MIN_BACKGROUND_POLL_MS, delay);
    if (level === 'out') return Math.max(delay, OUT_BACKGROUND_POLL_MS);
    const periodic = delay * multiplier;
    // The floor keeps its budget stretch: a song stuck at its end must not poll flat out.
    return songEnd === null ? periodic : Math.min(periodic, Math.max(songEnd, MIN_BACKGROUND_POLL_MS * multiplier));
  }

  private scheduleAt(at: number): void {
    this.scheduleIn(at - this.now());
  }

  private scheduleIn(delay: number): void {
    if (this.closed || this.listeners.size === 0) return;
    // One timer at a time: a command may schedule its follow-up while a poll is in flight.
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.loop();
    }, Math.max(0, delay));
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

function sameState(a: PlayerState, b: PlayerState): boolean {
  if (
    a.status !== b.status ||
    a.index !== b.index ||
    a.positionMs !== b.positionMs ||
    a.volume !== b.volume ||
    a.shuffle !== b.shuffle ||
    a.repeat !== b.repeat ||
    a.elsewhere !== b.elsewhere ||
    a.queue.length !== b.queue.length
  ) {
    return false;
  }
  for (let i = 0; i < a.queue.length; i++) {
    if (a.queue[i]?.queueId !== b.queue[i]?.queueId) return false;
  }
  return true;
}

function assertNever(x: never): never {
  throw new Error(`Unsupported player command: ${JSON.stringify(x)}`);
}

/** Spotify's answers for a Connect device that is asleep, gone from the list, or in a private session. */
function deviceUnreachable(err: unknown): boolean {
  const { status, body } = err as { status?: number; body?: unknown };
  return status === 404 || (status === 403 && typeof body === 'string' && /restriction violated|restricted|device/i.test(body));
}

/**
 * Spotify answers 403 "Restriction violated" when the player is already where it was told to go: pausing what is
 * paused, resuming what plays. Commands sent on a stale state do that, and it is no failure. Anything else is rethrown.
 */
function unlessAlreadyDone(err: unknown): void {
  const { status, body } = err as { status?: number; body?: unknown };
  if (status === 403 && typeof body === 'string' && /restriction violated/i.test(body)) return;
  throw err;
}

/** Run `fn` over `items` with at most `limit` promises in flight, preserving nothing about order. */
async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ---------- manager ----------

export interface SpotifyZoneInfo {
  id: Zone;
  name: string;
  kind: 'spotify';
  /** Spotify's device type: 'Smartphone', 'Tablet', 'Computer', 'Speaker', … (the picker labels phones clearly). */
  deviceType?: string;
  /** True while this device is the account's active one. */
  isActive?: boolean;
  /** Private session / otherwise not controllable through the Web API. */
  isRestricted?: boolean;
}

/** A Connect device: its state is read from, and its commands go through, the Spotify Web API. */
export type SpotifyZone = SpotifyConnectZone;

export class SpotifyZones {
  private readonly zones = new Map<string, SpotifyZone>();

  private readonly api: SpotifyZoneApi;
  private readonly now: () => number;

  constructor(
    api: SpotifyZoneApi,
    private readonly opts: ConnectZoneOptions = {},
  ) {
    // /me/player describes the whole account, so every zone polling it can share one answer.
    this.now = opts.now ?? Date.now;
    this.api = sharedPlaybackReads(api, this.now, opts.localPlayback, opts.mpris, opts.budgetLevel);
    // A local report that changes what is playing wakes every zone: they update from the
    // synthetic (free) answer immediately.
    opts.localPlayback?.setWake(() => this.wake());
    // An MPRIS signal wakes only this PC's own zone: every other zone would spend a real read on it.
    opts.mpris?.setWake(() => {
      const id = opts.mpris?.deviceId();
      if (id) this.zones.get(`spotify:${id}`)?.wake();
    });
    opts.mpris?.setKnown((trackId) => {
      const id = opts.mpris?.deviceId();
      return id ? this.zones.get(`spotify:${id}`)?.knownItem(trackId) : undefined;
    });
  }

  /**
   * Devices for GET /zones; shapes merge cleanly with the PC/browser zones. `fresh` asks the API for a new list even
   * if its short cache is still warm (the picker just opened); the API itself skips that when the budget is low.
   */
  async listZones(opts: { fresh?: boolean } = {}): Promise<SpotifyZoneInfo[]> {
    const devices = await this.api.devices(opts.fresh === true);
    const out: SpotifyZoneInfo[] = [];
    for (const device of devices) {
      if (!device.id) continue;
      const zone = this.ensureZone(device.id, device.name);
      out.push({
        id: zone.zone,
        name: device.name,
        kind: 'spotify',
        ...(device.type ? { deviceType: device.type } : {}),
        isActive: device.is_active,
        isRestricted: device.is_restricted,
      });
    }
    return out;
  }

  /** The Connect zone for a device, made the first time the device is seen. */
  ensureZone(deviceId: string, name: string): SpotifyZone {
    const id = `spotify:${deviceId}`;
    const existing = this.zones.get(id);
    if (existing) return existing;
    const zone = new SpotifyConnectZone(this.api, deviceId, name, this.opts);
    this.zones.set(id, zone);
    return zone;
  }

  get(zoneId: Zone): SpotifyZone | undefined {
    return this.zones.get(zoneId);
  }

  /** The API the zones command through (shared reads, and every write noted for MPRIS): the server queue's Spotify
   *  output sends its plays this way too. */
  get controlApi(): SpotifyZoneApi {
    return this.api;
  }

  /** A client connected: every zone polls at once again and returns to the watched schedule. */
  wake(): void {
    for (const zone of this.zones.values()) zone.wake();
  }

  async close(): Promise<void> {
    await Promise.all([...this.zones.values()].map((z) => z.close()));
    this.zones.clear();
  }
}

export function createSpotifyZones(api: SpotifyZoneApi, opts: ConnectZoneOptions = {}): SpotifyZones {
  return new SpotifyZones(api, opts);
}

/** How long one /me/player (or /me/player/queue) answer is reused by all zones. */
const SHARED_READ_MS = 800;
/** The device list changes rarely; GET /zones can afford a 5 s cache. */
const DEVICES_READ_MS = 120_000;
/** A fresh read (the picker opening) when the budget is tight: still current, but no more often than this. */
const DEVICES_FRESH_LOW_MS = 5000;
/** A picker opening asks for a fresh list, but not more than once in this window (a request each time is waste). */
const DEVICES_FRESH_MS = 1500;

/** Spotify ids are the last URI segment: `spotify:artist:abc` → `abc`. */
function spotifyIdFromUri(uri: string): string {
  const parts = uri.split(':');
  return parts.length >= 3 ? parts[parts.length - 1]! : uri;
}

/** Build the /me/player shape from the browser's local report (no network). */
function syntheticPlaybackState(
  report: LocalPlaybackReport,
  receivedAt: number,
  now: number,
  deviceName: string,
): SpotifyPlaybackState {
  const base = report.positionMs + (report.playing ? Math.max(0, now - receivedAt) : 0);
  const progress = report.durationMs > 0 ? Math.min(report.durationMs, base) : base;
  const t = report.track;
  const item: SpotifyTrack | null = t
    ? {
        id: t.id,
        name: t.name,
        uri: t.uri,
        duration_ms: t.durationMs,
        disc_number: 0,
        track_number: 0,
        artists: t.artists.map((a) => ({ id: spotifyIdFromUri(a.uri), name: a.name })),
        album: {
          id: spotifyIdFromUri(t.album.uri),
          name: t.album.name,
          artists: [],
          images: t.album.images.map((i) => ({ url: i.url, width: i.width, height: i.height })),
        },
      }
    : null;
  return {
    device: {
      id: report.deviceId,
      is_active: true,
      is_private_session: false,
      is_restricted: false,
      name: deviceName,
      type: 'Computer',
      volume_percent: Math.round(report.volume * 100),
    },
    repeat_state: report.repeat === 1 ? 'context' : report.repeat === 2 ? 'track' : 'off',
    shuffle_state: report.shuffle,
    timestamp: now,
    progress_ms: progress,
    is_playing: report.playing,
    item,
  };
}

/**
 * Wrap the API so concurrent zone polls share /me/player and /me/player/queue reads
 * (N watched devices cost about one poll), and any command drops the cached answer.
 * When the browser's SDK reported recently, currentPlayback() answers from that report
 * instead of calling Spotify (a synthetic answer never touches the usage counter).
 */
export function sharedPlaybackReads(
  api: SpotifyZoneApi,
  now: () => number = Date.now,
  local?: LocalPlaybackSource,
  mpris?: MprisPlaybackSource,
  budgetLevel?: () => SpotifyBudgetLevel,
): SpotifyZoneApi {
  type Slot<T> = { at: number; value: Promise<T> } | null;
  let playback: Slot<SpotifyPlaybackState | null> = null;
  let queue: Slot<SpotifyQueue> = null;
  let devices: Slot<SpotifyDevice[]> = null;
  /** Names of the last device list read (the synthetic answer never fetches it itself). */
  let deviceNames = new Map<string, string>();
  const read = <T>(
    slot: Slot<T>,
    set: (s: Slot<T>) => void,
    load: () => Promise<T>,
    ttlMs = SHARED_READ_MS,
  ): Promise<T> => {
    if (slot && now() - slot.at < ttlMs) return slot.value;
    const value = load();
    const mine = { at: now(), value };
    set(mine);
    value.catch(() => undefined);
    return value;
  };
  /** `signals`: the app shows this change over MPRIS (play, pause, skip, seek), so a read after it can wait for that. */
  const write = async <T>(fn: () => Promise<T>, deviceId?: string, signals = true): Promise<T> => {
    const sentAt = now();
    try {
      return await fn();
    } finally {
      local?.noteCommand(deviceId);
      mpris?.noteCommand(deviceId, sentAt, signals);
      // Commands can add/remove/rename a device (and change playback/queue): drop everything.
      playback = null;
      queue = null;
      devices = null;
    }
  };
  const synthetic = (): SpotifyPlaybackState | null => {
    if (!local) return null;
    const at = now();
    const found = local.usable(at);
    if (!found) return null;
    return syntheticPlaybackState(
      found.report,
      found.receivedAt,
      at,
      deviceNames.get(found.report.deviceId) ?? '',
    );
  };
  return {
    devices: (fresh = false) => {
      // A fresh read is a user-facing action (the picker opened), but at a low or used-up budget the cached list is
      // good enough: an extra request there costs more than a few seconds of staleness.
      const level = budgetLevel?.() ?? 'normal';
      const ttl = !fresh ? DEVICES_READ_MS : level === 'low' || level === 'out' ? DEVICES_FRESH_LOW_MS : DEVICES_FRESH_MS;
      return read(
        devices,
        (s) => (devices = s),
        async () => {
          const list = await api.devices();
          deviceNames = new Map(
            list.filter((d): d is SpotifyDevice & { id: string } => !!d.id).map((d) => [d.id, d.name]),
          );
          return list;
        },
        ttl,
      );
    },
    tracks: (ids, o) => api.tracks(ids, o),
    track: (id) => api.track(id),
    currentPlayback: (forDevice) => {
      const real = () =>
        read(playback, (s) => (playback = s), async () => {
          const answer = await api.currentPlayback();
          mpris?.noteReal(answer);
          return answer;
        });
      if (mpris && forDevice && forDevice === mpris.deviceId()) return mpris.answer(real);
      const localAnswer = synthetic();
      return localAnswer ? Promise.resolve(localAnswer) : real();
    },
    readsFree: (deviceId) => mpris?.readsFree(deviceId) ?? false,
    queue: () => read(queue, (s) => (queue = s), () => api.queue()),
    play: (body, deviceId) => write(() => api.play(body, deviceId), deviceId),
    // Only when the underlying client has it: an older fake without transfer stays transfer-less (the zone skips waking).
    ...(api.transfer
      ? { transfer: (deviceId: string, play = false) => write(() => api.transfer!(deviceId, play), deviceId) }
      : {}),
    pause: (deviceId) => write(() => api.pause(deviceId), deviceId),
    next: (deviceId) => write(() => api.next(deviceId), deviceId),
    previous: (deviceId) => write(() => api.previous(deviceId), deviceId),
    seek: (ms, deviceId) => write(() => api.seek(ms, deviceId), deviceId),
    setVolume: (v, deviceId) => write(() => api.setVolume(v, deviceId), deviceId, false),
    setShuffle: (on, deviceId) => write(() => api.setShuffle(on, deviceId), deviceId),
    setRepeat: (mode, deviceId) => write(() => api.setRepeat(mode, deviceId), deviceId),
    enqueue: (uri, deviceId) => write(() => api.enqueue(uri, deviceId), deviceId, false),
  };
}
