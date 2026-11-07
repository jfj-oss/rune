// The PC's own Spotify speaker, driven through go-librespot's local HTTP API and
// websocket instead of the Spotify Web API. rune owns the queue: go-librespot is
// handed one Spotify track at a time, and the next one is started when its
// websocket says the current one finished. Nothing here talks to api.spotify.com.
import { WebSocket } from 'node:http';
import type { PlayerCommand, PlayerState, QueueItem, Track } from '@liner/shared';
import type { PlaybackZone } from '../modules.js';
import {
  createQueue,
  currentItem,
  enqueue as queueEnqueue,
  jump as queueJump,
  next as queueNext,
  play as queuePlay,
  prev as queuePrev,
  remove as queueRemove,
  setRepeat as queueSetRepeat,
  setShuffle as queueSetShuffle,
  type QueueState,
} from '../play/queue.js';

/** The parts of fetch this module uses; injectable so tests never touch the network. */
export interface LibrespotResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface LibrespotRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type LibrespotFetch = (
  url: string,
  init?: LibrespotRequestInit,
) => Promise<LibrespotResponse>;

/** The websocket callbacks this module needs; a fake is injected in tests. */
export interface LibrespotSocket {
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (err: unknown) => void): void;
  close(): void;
}

export type LibrespotSocketFactory = (url: string) => LibrespotSocket;

export interface LibrespotStatus {
  device_id: string;
  device_name?: string;
  [key: string]: unknown;
}

export interface LibrespotZoneOptions {
  /** Base URL of the local API, e.g. http://127.0.0.1:3678. */
  baseUrl: string;
  fetch?: LibrespotFetch;
  socket?: LibrespotSocketFactory;
  /** Songs rune already has (title, artists, album, cover) by 'sp:' id. */
  knownTracks?: (ids: string[]) => QueueItem[];
  now?: () => number;
  /** First reconnect delay and its cap. */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

interface LibrespotEvent {
  type?: string;
  data?: Record<string, unknown>;
}

const STATUS_TIMEOUT_MS = 2_000;
const COMMAND_TIMEOUT_MS = 3_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;
/** A stopped event right after an explicit play/stop belongs to the old context. */
const END_SUPPRESS_MS = 1_500;
/** this many songs failing to load in a row stops playback instead of skipping on */
const MAX_FAIL_STREAK = 3;
const POSITION_TICK_MS = 1_000;
const EMPTY_ALBUM = { id: 'sp:unknown', title: '', coverUrl: undefined } as const;

export const defaultLibrespotFetch: LibrespotFetch = (url, init) => fetch(url, init);

export const defaultLibrespotSocket: LibrespotSocketFactory = (url) => {
  const ws = new WebSocket(url);
  return {
    onOpen(cb) {
      ws.addEventListener('open', () => cb());
    },
    onMessage(cb) {
      ws.addEventListener('message', (ev) => {
        const data = (ev as { data?: unknown }).data;
        if (typeof data === 'string') cb(data);
      });
    },
    onClose(cb) {
      ws.addEventListener('close', () => cb());
    },
    onError(cb) {
      ws.addEventListener('error', (err) => cb(err));
    },
    close() {
      ws.close();
    },
  };
};

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** Is go-librespot up and authenticated? 204 (no active session) is not usable. */
export async function fetchLibrespotStatus(
  baseUrl: string,
  fetchFn: LibrespotFetch = defaultLibrespotFetch,
): Promise<LibrespotStatus | null> {
  const res = await fetchFn(`${trimBase(baseUrl)}/status`, {
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  });
  if (res.status !== 200) return null;
  const body = (await res.json()) as Partial<LibrespotStatus> | null;
  if (!body || typeof body.device_id !== 'string' || body.device_id.length === 0) return null;
  return body as LibrespotStatus;
}

function eventsUrl(baseUrl: string): string {
  const url = new URL('events', `${trimBase(baseUrl)}/`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function spotifyTrackUri(track: Track): string {
  if (track.spotifyUri) return track.spotifyUri;
  const id = track.id.startsWith('sp:') ? track.id.slice(3) : track.id;
  return `spotify:track:${id}`;
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

/** Queue ids must stay unique across plays and enqueues (remove/move address entries by them). */
let queueSeq = 0;
const nextQueueId = (trackId: string) => `spq:${++queueSeq}:${trackId}`;

function placeholderQueueItem(track: Track): QueueItem {
  return { queueId: nextQueueId(track.id), track, album: { ...EMPTY_ALBUM } };
}

/** Local JSON client for the go-librespot REST API. Never touches the Spotify Web API. */
class LibrespotApi {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: LibrespotFetch,
  ) {}

  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<LibrespotResponse> {
    const res = await this.fetchFn(`${trimBase(this.baseUrl)}${path}`, {
      method,
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`go-librespot ${method} ${path} failed (${res.status})`);
    return res;
  }

  async play(uri: string, opts: { paused?: boolean; position?: number } = {}): Promise<void> {
    const body: Record<string, unknown> = { uri };
    if (opts.paused) body.paused = true;
    if (opts.position && opts.position > 0) body.position = Math.round(opts.position);
    await this.request('POST', '/player/play', body);
  }

  async pause(): Promise<void> {
    await this.request('POST', '/player/pause');
  }

  async resume(): Promise<void> {
    await this.request('POST', '/player/resume');
  }

  async seek(positionMs: number): Promise<void> {
    await this.request('POST', '/player/seek', { position: Math.round(positionMs) });
  }

  async stop(): Promise<void> {
    await this.request('POST', '/player/stop');
  }

  async setVolume(volume: number): Promise<void> {
    await this.request('POST', '/player/volume', { volume: Math.round(volume) });
  }

  async volume(): Promise<{ value: number; max: number } | null> {
    const res = await this.request('GET', '/player/volume');
    const body = (await res.json()) as Partial<{ value: number; max: number }> | null;
    if (!body || typeof body.value !== 'number' || typeof body.max !== 'number') return null;
    return { value: body.value, max: body.max };
  }
}

/**
 * A PlaybackZone backed by go-librespot. The zone id matches the Connect device
 * (`spotify:<deviceId>`), so the UI and the pc zone reach it without knowing how
 * it is driven.
 */
export class LibrespotZone implements PlaybackZone {
  readonly zone: string;
  readonly deviceId: string;
  readonly name: string;

  private readonly baseUrl: string;
  private readonly api: LibrespotApi;
  private readonly makeSocket: LibrespotSocketFactory;
  private readonly knownTracks: ((ids: string[]) => QueueItem[]) | undefined;
  private readonly now: () => number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly listeners = new Set<(s: PlayerState) => void>();

  private q: QueueState = createQueue();
  private status: PlayerState['status'] = 'stopped';
  /** Position at `positionAt`, extended by the wall clock while playing. */
  private positionMs = 0;
  private positionAt = 0;
  private volume = 0;
  private maxVolume = 100;
  private currentUri: string | undefined;

  private socket: LibrespotSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private suppressEndsUntil = 0;
  private endHandled = false;
  /** Playback left for another device (or the session ended) without the song ending. */
  private elsewhere = false;
  /** songs in a row that failed to load; a run of them means the account or connection is refused, not one bad song */
  private failStreak = 0;

  constructor(deviceId: string, name: string, opts: LibrespotZoneOptions) {
    this.deviceId = deviceId;
    this.name = name;
    this.zone = `spotify:${deviceId}`;
    this.baseUrl = trimBase(opts.baseUrl);
    this.api = new LibrespotApi(this.baseUrl, opts.fetch ?? defaultLibrespotFetch);
    this.makeSocket = opts.socket ?? defaultLibrespotSocket;
    this.knownTracks = opts.knownTracks;
    this.now = opts.now ?? Date.now;
    this.reconnectBaseMs = opts.reconnectBaseMs ?? RECONNECT_BASE_MS;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? RECONNECT_MAX_MS;
    this.connect();
  }

  state(): PlayerState {
    return this.buildState();
  }

  onChange(cb: (s: PlayerState) => void): () => void {
    this.listeners.add(cb);
    this.ensureTicker();
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0) this.clearTicker();
    };
  }

  async command(cmd: PlayerCommand | { type: 'move'; queueId: string; toIndex: number } | { type: 'clear' }): Promise<PlayerState> {
    switch (cmd.type) {
      case 'play':
        return this.cmdPlay(cmd.trackIds, cmd.startIndex, cmd.positionMs, cmd.paused);
      case 'enqueue':
        return this.cmdEnqueue(cmd.trackIds, cmd.next);
      case 'pause':
        return this.cmdPause();
      case 'resume':
        return this.cmdResume();
      case 'next':
        return this.cmdNext();
      case 'prev':
        return this.cmdPrev();
      case 'seek':
        return this.cmdSeek(cmd.positionMs);
      case 'jump':
        return this.cmdJump(cmd.index);
      case 'remove':
        return this.cmdRemove(cmd.queueId);
      case 'move':
        return this.cmdMove(cmd.queueId, cmd.toIndex);
      case 'clear':
        return this.cmdClear();
      case 'volume':
        return this.cmdVolume(cmd.volume);
      case 'shuffle':
        this.q = queueSetShuffle(this.q, cmd.on);
        return this.publish();
      case 'repeat':
        this.q = queueSetRepeat(this.q, cmd.mode);
        return this.publish();
      default:
        return assertNever(cmd);
    }
  }

  /** A client connected: reconnect now if the socket dropped, and resume position ticks. */
  wake(): void {
    if (this.closed) return;
    this.clearTimer();
    if (!this.socket) this.connect();
    this.publish();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearTimer();
    this.clearTicker();
    this.listeners.clear();
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      // already gone
    }
  }

  // ---------- commands ----------

  private async cmdPlay(
    trackIds: string[],
    startIndex = 0,
    positionMs = 0,
    paused = false,
  ): Promise<PlayerState> {
    const items = this.seedQueue(trackIds);
    if (items.length === 0) return this.publish();
    this.q = queuePlay(this.q, items, startIndex);
    await this.playCurrent(Math.max(0, positionMs), paused);
    return this.publish();
  }

  private async cmdEnqueue(trackIds: string[], next?: boolean): Promise<PlayerState> {
    const items = this.seedQueue(trackIds);
    if (items.length === 0) return this.publish();
    const wasEmpty = this.q.items.length === 0 || this.q.index < 0;
    this.q = queueEnqueue(this.q, items, { next });
    if (wasEmpty) await this.playCurrent(0, false);
    return this.publish();
  }

  private async cmdPause(): Promise<PlayerState> {
    if (this.status !== 'playing') return this.publish();
    this.positionMs = this.currentPosition();
    this.positionAt = this.now();
    this.status = 'paused';
    await this.api.pause();
    return this.publish();
  }

  private async cmdResume(): Promise<PlayerState> {
    if (this.status === 'paused') {
      this.status = 'playing';
      this.positionAt = this.now();
      await this.api.resume();
      return this.publish();
    }
    if (this.status === 'stopped' && this.q.index >= 0) {
      await this.playCurrent(0, false);
    }
    return this.publish();
  }

  private async cmdNext(): Promise<PlayerState> {
    const wasActive = this.isActive();
    const paused = this.status === 'paused';
    const result = queueNext(this.q, { auto: false });
    if (result.ended) {
      this.q = result.state;
      if (wasActive) await this.stopPlayback();
      else this.publish();
      return this.publish();
    }
    this.q = result.state;
    if (wasActive) await this.playCurrent(0, paused);
    else this.setPosition(0);
    return this.publish();
  }

  private async cmdPrev(): Promise<PlayerState> {
    const wasActive = this.isActive();
    const paused = this.status === 'paused';
    const result = queuePrev(this.q, this.currentPosition());
    this.q = result.state;
    if (result.restart) {
      this.setPosition(0);
      if (wasActive) await this.api.seek(0).catch(() => undefined);
      return this.publish();
    }
    if (wasActive) await this.playCurrent(0, paused);
    else this.setPosition(0);
    return this.publish();
  }

  private async cmdSeek(positionMs: number): Promise<PlayerState> {
    const duration = this.currentDuration();
    const pos = duration > 0 ? Math.min(duration, Math.max(0, Math.round(positionMs))) : Math.max(0, Math.round(positionMs));
    this.setPosition(pos);
    if (this.isActive()) await this.api.seek(pos);
    return this.publish();
  }

  private async cmdJump(index: number): Promise<PlayerState> {
    if (!Number.isInteger(index) || index < 0 || index >= this.q.items.length) return this.publish();
    this.q = queueJump(this.q, index);
    if (this.isActive()) await this.playCurrent(0, this.status === 'paused');
    else this.setPosition(0);
    return this.publish();
  }

  private async cmdRemove(queueId: string): Promise<PlayerState> {
    const before = currentItem(this.q)?.queueId;
    this.q = queueRemove(this.q, queueId);
    const after = currentItem(this.q)?.queueId;
    if (this.q.items.length === 0) {
      await this.stopPlayback();
    } else if (after !== before) {
      if (this.isActive()) await this.playCurrent(0, this.status === 'paused');
      else this.setPosition(0);
    }
    return this.publish();
  }

  private async cmdMove(queueId: string, toIndex: number): Promise<PlayerState> {
    this.q = moveItem(this.q, queueId, toIndex);
    return this.publish();
  }

  private async cmdClear(): Promise<PlayerState> {
    await this.stopPlayback();
    this.q = { ...createQueue(), shuffle: this.q.shuffle, repeat: this.q.repeat };
    this.setPosition(0);
    return this.publish();
  }

  private async cmdVolume(volume: number): Promise<PlayerState> {
    const percent = Math.min(100, Math.max(0, Math.round(volume)));
    this.volume = percent;
    this.publish();
    await this.api.setVolume((percent / 100) * this.maxVolume);
    return this.publish();
  }

  // ---------- playout ----------

  /** Start the current queue entry in go-librespot. `paused` keeps it silent. */
  private async playCurrent(positionMs: number, paused: boolean): Promise<void> {
    const item = currentItem(this.q);
    if (!item) {
      await this.stopPlayback();
      return;
    }
    const uri = spotifyTrackUri(item.track);
    this.currentUri = uri;
    this.elsewhere = false;
    this.setPosition(positionMs);
    this.status = paused ? 'paused' : 'playing';
    // go-librespot may emit `stopped` for the context it is replacing.
    this.suppressEndsUntil = this.now() + END_SUPPRESS_MS;
    this.publish();
    await this.api.play(uri, { paused, position: positionMs });
  }

  private async stopPlayback(): Promise<void> {
    const wasActive = this.status === 'playing' || this.status === 'paused';
    this.suppressEndsUntil = this.now() + END_SUPPRESS_MS;
    this.currentUri = undefined;
    this.status = 'stopped';
    this.setPosition(0);
    this.publish();
    if (wasActive) await this.api.stop().catch(() => undefined);
  }

  private isActive(): boolean {
    return this.status === 'playing' || this.status === 'paused' || this.status === 'loading';
  }

  // ---------- websocket ----------

  private connect(): void {
    if (this.closed || this.socket) return;
    let socket: LibrespotSocket;
    try {
      socket = this.makeSocket(eventsUrl(this.baseUrl));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onOpen(() => {
      this.reconnectAttempts = 0;
      void this.seedVolume();
    });
    socket.onMessage((data) => this.onMessage(data));
    socket.onClose(() => {
      if (this.socket === socket) this.socket = null;
      this.scheduleReconnect();
    });
    socket.onError(() => {
      if (this.socket === socket) this.socket = null;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async seedVolume(): Promise<void> {
    try {
      const v = await this.api.volume();
      if (v && v.max > 0) {
        this.maxVolume = v.max;
        this.volume = Math.round((v.value / v.max) * 100);
        this.publish();
      }
    } catch {
      // no session yet: volume events will tell us later
    }
  }

  private onMessage(raw: string): void {
    let ev: LibrespotEvent;
    try {
      ev = JSON.parse(raw) as LibrespotEvent;
    } catch {
      return;
    }
    const data = ev.data ?? {};
    switch (ev.type) {
      case 'metadata':
        this.onMetadata(data);
        break;
      case 'playing':
        this.onPlaying(data);
        break;
      case 'paused':
        this.status = 'paused';
        this.positionMs = this.currentPosition();
        this.positionAt = this.now();
        this.publish();
        break;
      case 'not_playing':
        if (this.matchesCurrent(data.uri)) {
          this.endHandled = true;
          void this.advance();
        }
        break;
      case 'stopped':
      case 'inactive':
        // `stopped` follows the not_playing we already advanced on. On its own (or `inactive`) it means
        // playback moved to another device or the session ended: show stopped, but never start the next
        // song here, which would pull playback back to the PC.
        if (this.endHandled) {
          this.endHandled = false;
          break;
        }
        if (this.now() < this.suppressEndsUntil) break;
        if (this.isActive()) {
          this.positionMs = this.currentPosition();
          this.positionAt = this.now();
          this.status = 'stopped';
          this.elsewhere = true;
          this.publish();
        }
        break;
      case 'playback_error':
        // a song Spotify won't play here (restricted, no format, refused key) is skipped like a finished one
        if (this.matchesCurrent(data.uri) && (data.unplayable === true || data.stage === 'load')) {
          this.endHandled = true;
          this.failStreak += 1;
          if (this.failStreak >= MAX_FAIL_STREAK) {
            // stop instead of racing through the whole queue without playing anything
            this.failStreak = 0;
            this.positionMs = 0;
            this.positionAt = this.now();
            this.status = 'stopped';
            this.publish();
            break;
          }
          void this.advance();
        }
        break;
      case 'seek':
        if (this.matchesCurrent(data.uri) && typeof data.position === 'number') {
          this.setPosition(data.position);
          this.publish();
        }
        break;
      case 'volume':
        this.onVolume(data);
        break;
      default:
        break;
    }
  }

  private onMetadata(data: Record<string, unknown>): void {
    const uri = typeof data.uri === 'string' ? data.uri : undefined;
    if (!uri) return;
    const duration = typeof data.duration === 'number' ? data.duration : undefined;
    const position = typeof data.position === 'number' ? data.position : undefined;

    const index = this.q.items.findIndex(
      (q) => q.track.spotifyUri === uri || spotifyTrackUri(q.track) === uri,
    );
    if (index >= 0) {
      const item = this.q.items[index]!;
      const track: Track = { ...item.track };
      let album = { ...item.album };
      let changed = false;
      if (!track.title && typeof data.name === 'string') {
        track.title = data.name;
        changed = true;
      }
      if (track.artists.length === 0 && Array.isArray(data.artist_names)) {
        const names = data.artist_names.filter((n): n is string => typeof n === 'string');
        if (names.length > 0) {
          track.artists = names.map((name) => ({ id: `ar:sp:name:${name}`, name }));
          changed = true;
        }
      }
      if (!track.durationMs && duration !== undefined) {
        track.durationMs = duration;
        changed = true;
      }
      if (!album.title && typeof data.album_name === 'string') {
        album = { ...album, title: data.album_name };
        changed = true;
      }
      if (!album.coverUrl && typeof data.album_cover_url === 'string') {
        album = { ...album, coverUrl: data.album_cover_url };
        changed = true;
      }
      if (track.albumId === 'sp:unknown' && typeof data.album_uri === 'string' && data.album_uri.startsWith('spotify:album:')) {
        track.albumId = `sp:${data.album_uri.slice('spotify:album:'.length)}`;
        album = { ...album, id: track.albumId };
        changed = true;
      }
      if (changed) {
        const items = this.q.items.slice();
        items[index] = { ...item, track, album };
        this.q = { ...this.q, items };
      }
    }

    if (this.matchesCurrent(uri)) {
      if (position !== undefined) this.setPosition(position);
      this.publish();
    } else if (index >= 0) {
      this.publish();
    }
  }

  private onPlaying(data: Record<string, unknown>): void {
    this.failStreak = 0;
    this.elsewhere = false;
    const uri = typeof data.uri === 'string' ? data.uri : undefined;
    if (uri) {
      this.currentUri = uri;
      const index = this.q.items.findIndex(
        (q) => q.track.spotifyUri === uri || spotifyTrackUri(q.track) === uri,
      );
      if (index >= 0 && index !== this.q.index) this.q = queueJump(this.q, index);
    }
    this.status = 'playing';
    // `playing` carries no position: metadata just set it, and playCurrent set it for
    // our own starts. Restart the local clock from here instead of guessing zero.
    this.positionAt = this.now();
    this.publish();
  }

  private onVolume(data: Record<string, unknown>): void {
    if (typeof data.value !== 'number' || typeof data.max !== 'number' || data.max <= 0) return;
    this.maxVolume = data.max;
    this.volume = Math.min(100, Math.max(0, Math.round((data.value / data.max) * 100)));
    this.publish();
  }

  /** Does an event's uri name the track this zone thinks is playing? */
  private matchesCurrent(uri: unknown): boolean {
    // With nothing playing, no event belongs to this zone's queue: advancing on it
    // would skip a track the user has not reached yet.
    return typeof uri === 'string' && uri === this.currentUri;
  }

  /** The current track ended: move on (repeat modes are in the pure queue state). */
  private async advance(): Promise<void> {
    if (this.closed) return;
    const result = queueNext(this.q, { auto: true });
    if (result.ended) {
      this.q = result.state;
      this.status = 'stopped';
      this.setPosition(this.currentDuration());
      this.publish();
      return;
    }
    this.q = result.state;
    try {
      await this.playCurrent(0, this.status === 'paused');
    } catch {
      this.status = 'stopped';
      this.publish();
    }
  }

  // ---------- state ----------

  private buildState(): PlayerState {
    return {
      zone: this.zone,
      status: this.status,
      ...(this.elsewhere ? { elsewhere: true } : {}),
      queue: this.q.items.slice(),
      index: this.q.index,
      positionMs: this.currentPosition(),
      volume: this.volume,
      shuffle: this.q.shuffle,
      repeat: this.q.repeat,
      updatedAt: this.now(),
    };
  }

  private publish(): PlayerState {
    const snapshot = this.buildState();
    for (const cb of this.listeners) {
      try {
        cb(snapshot);
      } catch {
        // a bad listener must not break playback
      }
    }
    if (this.status === 'playing') this.ensureTicker();
    else this.clearTicker();
    return snapshot;
  }

  private currentPosition(): number {
    let pos = this.positionMs;
    if (this.status === 'playing') pos += Math.max(0, this.now() - this.positionAt);
    const duration = this.currentDuration();
    if (duration > 0) pos = Math.min(duration, pos);
    return Math.max(0, Math.round(pos));
  }

  private setPosition(ms: number): void {
    this.positionMs = Math.max(0, ms);
    this.positionAt = this.now();
  }

  private currentDuration(): number {
    return currentItem(this.q)?.track.durationMs ?? 0;
  }

  private ensureTicker(): void {
    if (this.closed || this.status !== 'playing' || this.listeners.size === 0 || this.tickTimer) return;
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;
      if (!this.closed && this.status === 'playing') this.publish();
    }, POSITION_TICK_MS);
    this.tickTimer.unref?.();
  }

  private clearTicker(): void {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /** Build queue items from rune's own rows where possible, placeholders otherwise. */
  private seedQueue(trackIds: string[]): QueueItem[] {
    for (const id of trackIds) this.requireSpotifyTrack(id);
    let known = new Map<string, QueueItem>();
    try {
      known = new Map((this.knownTracks?.(trackIds) ?? []).map((q) => [q.track.id, q]));
    } catch {
      // the database is a shortcut only
    }
    return trackIds.map((id) => {
      const k = known.get(id);
      return k ? { ...k, queueId: nextQueueId(id) } : placeholderQueueItem(placeholderTrack(id));
    });
  }

  private requireSpotifyTrack(id: string): void {
    if (!id.startsWith('sp:')) {
      throw new Error(
        `Cannot play "${id}" on Spotify Connect zone ${this.zone}: only Spotify tracks ('sp:' ids) ` +
          'can be played there. Use the PC or browser zone for local library tracks.',
      );
    }
  }
}

/**
 * Move one queue entry to `toIndex`. The current entry stays current, and the
 * shuffle playback order is remapped so it keeps describing the same items.
 */
function moveItem(q: QueueState, queueId: string, toIndex: number): QueueState {
  const from = q.items.findIndex((it) => it.queueId === queueId);
  if (from < 0) return q;
  const to = Math.min(q.items.length - 1, Math.max(0, Math.trunc(toIndex)));
  if (!Number.isFinite(to) || from === to) return q;
  const currentId = currentItem(q)?.queueId;
  const items = q.items.slice();
  const [moved] = items.splice(from, 1);
  if (!moved) return q;
  items.splice(to, 0, moved);

  // old index -> new index (a bijection, so the playback order stays valid)
  const map = (old: number): number => {
    if (old === from) return to;
    if (from < to) return old > from && old <= to ? old - 1 : old;
    return old >= to && old < from ? old + 1 : old;
  };
  const order = q.shuffle ? q.order.map(map) : Array.from({ length: items.length }, (_, i) => i);
  const index = currentId ? items.findIndex((it) => it.queueId === currentId) : -1;
  return { ...q, items, index, order };
}

function assertNever(x: never): never {
  throw new Error(`Unsupported player command: ${JSON.stringify(x)}`);
}
