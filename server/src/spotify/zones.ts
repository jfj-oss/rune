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
        if (cmd.paused) await this.api.pause(device).catch(() => undefined);
        this.startedQueue = await this.fetchStartedQueue(spotifyIds);
        return this.refresh();
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
        return this.refresh();
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
        return this.refresh();
      }
      case 'remove':
        throw new Error(
          'Spotify Connect does not support removing individual queue items: Spotify has no Web API for it.',
        );
      case 'volume':
        await this.api.setVolume(cmd.volume, device);
        return this.refresh();
      case 'shuffle':
        await this.api.setShuffle(cmd.on, device);
        return this.refresh();
      case 'repeat':
        await this.api.setRepeat(repeatParam(cmd.mode), device);
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
    if (playback) {
      try {
        queue = await this.api.queue();
      } catch {
        queue = undefined;
      }
    }
    const next = mapPlaybackState(this.zone, playback, queue, this.startedQueue, this.now);
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
    const delay = this.snapshot.status === 'playing' ? this.pollMsPlaying : this.pollMsIdle;
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

  constructor(
    private readonly api: SpotifyZoneApi,
    private readonly opts: ConnectZoneOptions = {},
  ) {}

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
