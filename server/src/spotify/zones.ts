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
  tracks(ids: string[], opts?: { maxSingles?: number }): Promise<SpotifyTrack[]>;
  /** One track by id (GET /tracks/{id}). Dev-mode apps may not use the batch endpoint. */
  track(id: string): Promise<SpotifyTrack>;
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
  /** Poll delays when no rune client is connected (default 15 s playing / 30 s idle). */
  pollMsPlayingUnwatched?: number;
  pollMsIdleUnwatched?: number;
  /** Whether at least one websocket client is connected. Undefined = always watched. */
  hasClients?: () => boolean;
  /** Songs rune already has (title, artists, album, cover) by 'sp:' id: shown at once, no Spotify lookup. */
  knownTracks?: (ids: string[]) => QueueItem[];
  now?: () => number;
}

/** How long a just-played zone ignores /me/player still naming the previous device. */
const CLAIM_MS = 5000;
const SETTLE_TRIES = 4;
/** How long a just-set volume wins over /me/player still reporting the old one. */
const VOLUME_HOLD_MS = 4000;
/** How long a just-skipped-to song is shown while Spotify still reports the previous one. */
const TRACK_HOLD_MS = 4000;
const SETTLE_GAP_MS = 350;
/**
 * How long a /me/player/queue answer stays good enough to reuse. The item id changing
 * (or a command / a connected client) forces a fresh read sooner.
 */
const QUEUE_STALE_MS = 10_000;
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
  private readonly pollMsPlaying: number;
  private readonly pollMsIdle: number;
  private readonly pollMsPlayingUnwatched: number;
  private readonly pollMsIdleUnwatched: number;
  private readonly hasClients: (() => boolean) | undefined;
  private readonly knownTracks: ((ids: string[]) => QueueItem[]) | undefined;
  private readonly now: () => number;
  private snapshot: PlayerState;
  private startedQueue: QueueItem[] = [];
  /** Bumped whenever startedQueue is replaced, so a slow background lookup cannot overwrite it. */
  private startedRev = 0;
  private readonly listeners = new Set<(s: PlayerState) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private closed = false;
  private claimUntil = 0;
  private volumeHold: { volume: number; until: number } | null = null;
  /** Same for shuffle / repeat right after they were switched. */
  private toggleHold: { shuffle?: boolean; repeat?: PlayerState['repeat']; until: number } | null = null;
  private lastActiveDevice: string | null = null;
  /** The song just skipped/jumped to: shown at once and kept while Spotify still reports the old one. */
  private trackHold: { id: string; until: number } | null = null;
  /** Queue reuse: only re-read when the item changed, a command ran, or it went stale. */
  private lastQueue: SpotifyQueue | undefined;
  private lastQueueAt = Number.NEGATIVE_INFINITY;
  private lastQueueItemId: string | null = null;
  private queueDirty = false;

  constructor(api: SpotifyZoneApi, deviceId: string, name: string, opts: ConnectZoneOptions = {}) {
    this.api = api;
    this.deviceId = deviceId;
    this.name = name;
    this.zone = `spotify:${deviceId}`;
    this.pollMsPlaying = opts.pollMsPlaying ?? 1000;
    this.pollMsIdle = opts.pollMsIdle ?? 3000;
    this.pollMsPlayingUnwatched = opts.pollMsPlayingUnwatched ?? 15_000;
    this.pollMsIdleUnwatched = opts.pollMsIdleUnwatched ?? 30_000;
    this.hasClients = opts.hasClients;
    this.knownTracks = opts.knownTracks;
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
    // A command may change what is up next: the next poll must not reuse a cached queue.
    this.queueDirty = true;
    switch (cmd.type) {
      case 'play': {
        const spotifyIds = cmd.trackIds.map((id) => this.requireSpotifyTrack(id));
        const uris = spotifyIds.map((id) => `spotify:track:${id}`);
        const body: SpotifyPlayBody = { uris };
        // always name the first song: with Spotify's shuffle on, a list without an offset starts on a
        // random one (rune shuffles before sending, so the order it sends is the order it wants)
        if (uris.length > 0) body.offset = { position: Math.max(0, Math.min(cmd.startIndex ?? 0, uris.length - 1)) };
        if (cmd.positionMs && cmd.positionMs > 0) body.position_ms = Math.round(cmd.positionMs);
        await this.api.play(body, device);
        this.claim();
        if (cmd.paused) await this.api.pause(device).catch(() => undefined);
        // Show the picked song and the queue we sent at once; Spotify's metadata for those
        // songs is fetched in the background (the command must not wait for it).
        const start = Math.max(0, Math.min(cmd.startIndex ?? 0, spotifyIds.length - 1));
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
        const playable = this.snapshot.queue.filter((q) => !!q.track.spotifyUri);
        const uris = playable.map((q) => q.track.spotifyUri as string);
        const position = playable.indexOf(item);
        this.expectSong(cmd.index);
        await this.api.play({ uris, offset: { position } }, device);
        this.claim();
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
    // Reuse the last queue unless the playing item changed, a command ran, or the read went
    // stale (10 s). With no connected client there is nobody to show it to: do not fetch it.
    let queue: SpotifyQueue | undefined = this.lastQueue;
    if (playback && (!playback.device?.id || playback.device.id === this.deviceId)) {
      const itemId = playback.item?.id ?? null;
      const stale = this.now() - this.lastQueueAt >= QUEUE_STALE_MS;
      const itemChanged = itemId !== this.lastQueueItemId;
      if (this.clientsWatching() && (this.queueDirty || itemChanged || stale || !this.lastQueue)) {
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
    if (!sameState(next, this.snapshot)) {
      this.snapshot = next;
      for (const cb of this.listeners) cb(next);
    }
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

  private clientsWatching(): boolean {
    return this.hasClients ? this.hasClients() : true;
  }

  private async loop(): Promise<void> {
    if (this.closed || this.listeners.size === 0) return;
    await this.pollOnce();
    if (this.closed || this.listeners.size === 0) return;
    const busy = this.snapshot.status === 'playing' || this.now() < this.claimUntil;
    // Nobody connected: poll slowly (history still gets recorded, just coarser).
    const delay = this.clientsWatching()
      ? busy
        ? this.pollMsPlaying
        : this.pollMsIdle
      : busy
        ? this.pollMsPlayingUnwatched
        : this.pollMsIdleUnwatched;
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

  /** A client connected: every zone polls at once again (1 s / 3 s while watched). */
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
const DEVICES_READ_MS = 5000;

/**
 * Wrap the API so concurrent zone polls share /me/player and /me/player/queue reads
 * (N watched devices cost about one poll), and any command drops the cached answer.
 */
export function sharedPlaybackReads(api: SpotifyZoneApi, now: () => number = Date.now): SpotifyZoneApi {
  type Slot<T> = { at: number; value: Promise<T> } | null;
  let playback: Slot<SpotifyPlaybackState | null> = null;
  let queue: Slot<SpotifyQueue> = null;
  let devices: Slot<SpotifyDevice[]> = null;
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
  const write = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } finally {
      // Commands can add/remove/rename a device (and change playback/queue): drop everything.
      playback = null;
      queue = null;
      devices = null;
    }
  };
  return {
    devices: () => read(devices, (s) => (devices = s), () => api.devices(), DEVICES_READ_MS),
    tracks: (ids, o) => api.tracks(ids, o),
    track: (id) => api.track(id),
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
