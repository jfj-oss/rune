// Spotify Connect playback zones. Each Connect device exposed by the account
// becomes a PlaybackZone whose state is polled from /me/player (1 s while
// playing, 3 s while idle; polling stops when nothing subscribes).
import type { PlayerCommand, PlayerState, QueueItem, Track, Zone } from '@liner/shared';
import type { PlaybackZone } from '../modules.js';
import type {
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

/** Subset of SpotifyApi used by zones (a fake is injected in tests). */
export interface SpotifyZoneApi {
  devices(): Promise<SpotifyDevice[]>;
  tracks(ids: string[]): Promise<SpotifyTrack[]>;
  currentPlayback(): Promise<SpotifyPlaybackState | null>;
  queue(): Promise<SpotifyQueue>;
  play(body: SpotifyPlayBody, deviceId?: string): Promise<void>;
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
  pollMsPlaying?: number;
  pollMsIdle?: number;
  now?: () => number;
}

/** How long a just-played zone ignores /me/player still naming the previous device. */
const CLAIM_MS = 5000;
const SETTLE_TRIES = 4;
/** How long a just-set volume wins over /me/player still reporting the old one. */
const VOLUME_HOLD_MS = 4000;
const SETTLE_GAP_MS = 350;

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

  for (const item of startedQueue) {
    if (seen.has(item.track.id)) continue;
    seen.add(item.track.id);
    items.push(item);
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

  const index = current
    ? items.findIndex((q) => q.track.id === currentKey || q.track.spotifyUri === current.uri)
    : -1;

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
  private readonly pollMsPlaying: number;
  private readonly pollMsIdle: number;
  private readonly now: () => number;
  private snapshot: PlayerState;
  private startedQueue: QueueItem[] = [];
  private readonly listeners = new Set<(s: PlayerState) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private closed = false;
  private claimUntil = 0;
  private volumeHold: { volume: number; until: number } | null = null;
  /** Same for shuffle / repeat right after they were switched. */
  private toggleHold: { shuffle?: boolean; repeat?: PlayerState['repeat']; until: number } | null = null;
  private lastActiveDevice: string | null = null;

  constructor(api: SpotifyZoneApi, deviceId: string, name: string, opts: ConnectZoneOptions = {}) {
    this.api = api;
    this.deviceId = deviceId;
    this.name = name;
    this.zone = `spotify:${deviceId}`;
    this.pollMsPlaying = opts.pollMsPlaying ?? 1000;
    this.pollMsIdle = opts.pollMsIdle ?? 3000;
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

  async command(cmd: PlayerCommand): Promise<PlayerState> {
    const device = this.deviceId;
    switch (cmd.type) {
      case 'play': {
        const spotifyIds = cmd.trackIds.map((id) => this.requireSpotifyTrack(id));
        const uris = spotifyIds.map((id) => `spotify:track:${id}`);
        const body: SpotifyPlayBody = { uris };
        if (cmd.startIndex !== undefined && cmd.startIndex > 0 && uris.length > 0) {
          body.offset = { position: Math.min(cmd.startIndex, uris.length - 1) };
        }
        if (cmd.positionMs && cmd.positionMs > 0) body.position_ms = Math.round(cmd.positionMs);
        await this.api.play(body, device);
        this.claim();
        if (cmd.paused) await this.api.pause(device).catch(() => undefined);
        this.startedQueue = await this.fetchStartedQueue(spotifyIds);
        return this.settle();
      }
      case 'enqueue': {
        // Spotify's Web API only appends; it cannot insert next. `next` is ignored.
        for (const id of cmd.trackIds) {
          await this.api.enqueue(`spotify:track:${this.requireSpotifyTrack(id)}`, device);
        }
        return this.refresh();
      }
      case 'pause':
        await this.api.pause(device);
        return this.refresh();
      case 'resume':
        await this.api.play({}, device);
        this.claim();
        return this.settle();
      case 'next':
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
        const uris = this.snapshot.queue
          .slice(cmd.index)
          .map((q) => q.track.spotifyUri)
          .filter((u): u is string => !!u);
        if (uris.length === 0) throw new Error(`Queue item ${cmd.index} has no Spotify URI.`);
        await this.api.play({ uris }, device);
        this.claim();
        return this.settle();
      }
      case 'remove':
        throw new Error(
          'Spotify Connect does not support removing individual queue items: Spotify has no Web API for it.',
        );
      case 'volume':
        await this.api.setVolume(cmd.volume, device);
        // Spotify keeps reporting the previous level for a moment: don't bounce back to it.
        this.volumeHold = { volume: Math.round(cmd.volume), until: this.now() + VOLUME_HOLD_MS };
        this.snapshot = { ...this.snapshot, volume: this.volumeHold.volume };
        for (const cb of this.listeners) cb(this.snapshot);
        return this.refresh();
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

  private async fetchStartedQueue(spotifyIds: string[]): Promise<QueueItem[]> {
    if (spotifyIds.length === 0) return [];
    let tracks: SpotifyTrack[] = [];
    try {
      tracks = await this.api.tracks(spotifyIds);
    } catch {
      // Metadata is cosmetic for the queue; fall back to placeholders.
    }
    const byId = new Map<string, SpotifyTrack>();
    for (const t of tracks) if (t.id) byId.set(t.id, t);

    return spotifyIds.map((id, position) => {
      const sp = byId.get(id);
      if (!sp) return placeholderQueueItem(placeholderTrack(spotifyTrackId(id)), position);
      return queueItemFromSpotify(sp, position);
    });
  }

  private async refresh(): Promise<PlayerState> {
    await this.pollOnce();
    return this.snapshot;
  }

  /** Playback was just sent to this device: Spotify takes a moment before /me/player names it. */
  private claim(): void {
    this.claimUntil = this.now() + CLAIM_MS;
  }

  /** Poll until Spotify reports this device as the active one (or give up after a few tries). */
  private async settle(): Promise<PlayerState> {
    for (let i = 0; i < SETTLE_TRIES; i++) {
      await this.pollOnce();
      if (this.lastActiveDevice === this.deviceId) break;
      if (i < SETTLE_TRIES - 1) await new Promise((r) => setTimeout(r, SETTLE_GAP_MS));
    }
    return this.snapshot;
  }

  private async pollOnce(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.doPoll().finally(() => {
        this.inFlight = null;
      });
    }
    await this.inFlight;
  }

  private async doPoll(): Promise<void> {
    let playback: SpotifyPlaybackState | null;
    try {
      playback = await this.api.currentPlayback();
    } catch {
      return;
    }
    let queue: SpotifyQueue | undefined;
    if (playback && (!playback.device?.id || playback.device.id === this.deviceId)) {
      try {
        queue = await this.api.queue();
      } catch {
        queue = undefined;
      }
    }
    // /me/player describes the account's ACTIVE device, which may be another one (the browser,
    // the phone): then nothing is playing on this zone.
    const activeId = playback?.device?.id ?? null;
    this.lastActiveDevice = activeId;
    let next: PlayerState;
    if (playback && activeId && activeId !== this.deviceId) {
      if (this.now() < this.claimUntil) return; // just told to play here: Spotify hasn't switched yet
      next = { ...emptyPlayerState(this.zone, this.now), volume: this.snapshot.volume };
    } else {
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
    const hold = this.volumeHold;
    if (hold) {
      if (this.now() >= hold.until || Math.abs(next.volume - hold.volume) <= 1) this.volumeHold = null;
      else next = { ...next, volume: hold.volume };
    }
    if (!sameState(next, this.snapshot)) {
      this.snapshot = next;
      for (const cb of this.listeners) cb(next);
    }
  }

  private ensurePolling(): void {
    if (this.closed || this.listeners.size === 0 || this.timer || this.inFlight) return;
    void this.loop();
  }

  private async loop(): Promise<void> {
    if (this.closed || this.listeners.size === 0) return;
    await this.pollOnce();
    if (this.closed || this.listeners.size === 0) return;
    const delay = this.snapshot.status === 'playing' || this.now() < this.claimUntil ? this.pollMsPlaying : this.pollMsIdle;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.loop();
    }, delay);
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

// ---------- manager ----------

export interface SpotifyZoneInfo {
  id: Zone;
  name: string;
  kind: 'spotify';
}

export class SpotifyZones {
  private readonly zones = new Map<string, SpotifyConnectZone>();

  private readonly api: SpotifyZoneApi;

  constructor(
    api: SpotifyZoneApi,
    private readonly opts: ConnectZoneOptions = {},
  ) {
    // /me/player describes the whole account, so every zone polling it can share one answer.
    this.api = sharedPlaybackReads(api, opts.now ?? Date.now);
  }

  /** Devices for GET /zones; shapes merge cleanly with the PC/browser zones. */
  async listZones(): Promise<SpotifyZoneInfo[]> {
    const devices = await this.api.devices();
    const out: SpotifyZoneInfo[] = [];
    for (const device of devices) {
      if (!device.id) continue;
      const zone = this.ensureZone(device.id, device.name);
      out.push({ id: zone.zone, name: device.name, kind: 'spotify' });
    }
    return out;
  }

  ensureZone(deviceId: string, name: string): SpotifyConnectZone {
    const id = `spotify:${deviceId}`;
    let zone = this.zones.get(id);
    if (!zone) {
      zone = new SpotifyConnectZone(this.api, deviceId, name, this.opts);
      this.zones.set(id, zone);
    }
    return zone;
  }

  get(zoneId: Zone): SpotifyConnectZone | undefined {
    return this.zones.get(zoneId);
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

/**
 * Wrap the API so concurrent zone polls share /me/player and /me/player/queue reads
 * (N watched devices cost about one poll), and any command drops the cached answer.
 */
export function sharedPlaybackReads(api: SpotifyZoneApi, now: () => number = Date.now): SpotifyZoneApi {
  type Slot<T> = { at: number; value: Promise<T> } | null;
  let playback: Slot<SpotifyPlaybackState | null> = null;
  let queue: Slot<SpotifyQueue> = null;
  const read = <T>(slot: Slot<T>, set: (s: Slot<T>) => void, load: () => Promise<T>): Promise<T> => {
    if (slot && now() - slot.at < SHARED_READ_MS) return slot.value;
    const value = load();
    const mine = { at: now(), value };
    set(mine);
    value.catch(() => undefined);
    return value;
  };
  const write = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } finally {
      playback = null;
      queue = null;
    }
  };
  return {
    devices: () => api.devices(),
    tracks: (ids) => api.tracks(ids),
    currentPlayback: () => read(playback, (s) => (playback = s), () => api.currentPlayback()),
    queue: () => read(queue, (s) => (queue = s), () => api.queue()),
    play: (body, deviceId) => write(() => api.play(body, deviceId)),
    pause: (deviceId) => write(() => api.pause(deviceId)),
    next: (deviceId) => write(() => api.next(deviceId)),
    previous: (deviceId) => write(() => api.previous(deviceId)),
    seek: (ms, deviceId) => write(() => api.seek(ms, deviceId)),
    setVolume: (v, deviceId) => write(() => api.setVolume(v, deviceId)),
    setShuffle: (on, deviceId) => write(() => api.setShuffle(on, deviceId)),
    setRepeat: (mode, deviceId) => write(() => api.setRepeat(mode, deviceId)),
    enqueue: (uri, deviceId) => write(() => api.enqueue(uri, deviceId)),
  };
}
