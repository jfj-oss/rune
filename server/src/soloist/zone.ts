// The Soloist zone: Spotify songs played by Spotify Soloist on this PC, with rune's own queue.
//
// rune keeps the queue (the same pure queue logic as the pc zone) and tells Soloist one song at a time: `play {uri}`
// for the current song and `add_to_queue {uri}` for the one after it, so transitions are gapless. When Soloist reports
// `track_changed` to the song rune queued next, the cursor moves on. When it reports a song rune never asked for, rune
// FOLLOWS Soloist: Spotify's autoplay after the last song of the list (like Spotify's own radio), or a song picked in a
// Spotify app on this device, is adopted as the current item (a placeholder named from Soloist's own metadata) and the
// controls act on it. The one exception: Soloist moving on by itself while rune's queue still has a next song (an
// add_to_queue that was lost) — then rune's song plays, not autoplay. Position comes from `position_sync` anchors: no
// polling, and not one Web API request.
//
// Soloist is a Spotify Connect client, and only ONE device of an account plays at a time. While another device is the
// active one (a rune browser tab's Web Playback SDK player, a Spotify app playing on its own speakers), Soloist's events
// describe THAT device's playback and its commands remote-control THAT device. None of it is this zone's: such events
// are not followed and nothing is sent, or rune's queue here would be played into the other player's session (the song
// shown there and the song heard then differ). The zone waits, paused, until rune starts a song on it again, which
// first makes Soloist the active device (`activate`).
//
// `output` says where the sound goes: the PC speakers, or the rune-phone sink that the phone hears over HLS. The state's
// `rev` is bumped whenever a new HLS program starts (play, skip, seek), which is the phone's cue to reload its player;
// a song that simply follows the previous one keeps the program, so the phone hears it gapless.
import type { PlayerCommand, PlayerState, QueueItem } from '@liner/shared';
import type { PlaybackZone } from '../modules.js';
import {
  clear as queueClear,
  createQueue,
  currentItem,
  enqueue as queueEnqueue,
  jump as queueJump,
  move as queueMove,
  next as queueNext,
  prev as queuePrev,
  play as queuePlay,
  remove as queueRemove,
  setRepeat as queueSetRepeat,
  setShuffle as queueSetShuffle,
  upcoming as queueUpcoming,
  type QueueState,
} from '../play/queue.js';
import { idOfUri, type SoloistCommand, type SoloistEntity, type SoloistEvent, type SoloistView } from './client.js';
import type { SoloistOutput } from './audio.js';

/** What the zone needs from the Soloist client (the real one, or a fake in tests). */
export interface SoloistLink {
  readonly view: SoloistView;
  send(cmd: SoloistCommand): Promise<void>;
  onEvent(fn: (ev: SoloistEvent) => void): () => void;
  onView(fn: (v: SoloistView) => void): () => void;
  positionMs(at?: number): number | null;
}

export interface SoloistZoneDeps {
  link: SoloistLink;
  /** rune's own records of the songs (title, artists, cover) by id; Spotify songs only. */
  loadItems(ids: string[]): QueueItem[];
  /** Where the sound goes now; the zone bumps `rev` so the phone reloads when `newProgram` is called. */
  output(): SoloistOutput;
  /** Start a new HLS program (play, skip, seek while the phone listens). */
  newProgram?(): void;
  /** Is Soloist's own sound stream there and running (PipeWire)? null: unknown. Second opinion on "not the active device". */
  sounding?(): Promise<boolean | null>;
  now?(): number;
  log?(obj: Record<string, unknown>, msg: string): void;
}

export const SOLOIST_ZONE = 'soloist';

/** The last signal-path step while the phone hears the stream. The web keys on "to the phone" (player/routing.ts). */
export const PHONE_STREAM_STEP = 'AAC stream to the phone';

/** A song rune did not choose, shown as the current item because Soloist plays it. */
export interface AdoptedSong {
  queueId: string;
  /** Spotify id. */
  id: string;
  /** `autoplay`: Soloist went on by itself after rune's song (autoplay, its own context). `takeover`: a Spotify app on
   *  the account started it in the middle of rune's song. */
  reason: 'autoplay' | 'takeover';
}

/** A song that ended this close to its length ended by itself: what plays next was Soloist's own next, not a takeover. */
const END_SLACK_MS = 5000;

/** A snapshot saying "not the active device" this soon after rune's own play may describe the moment before it. */
const OWN_PLAY_GRACE_MS = 2000;
/** After rune's own play: when Soloist is asked whether it really became the active device. */
const OWN_PLAY_CHECK_MS = 2500;
/** A song rune did not ask for is acted on once Soloist confirmed it is the device playing it; at the latest after this. */
const CONFIRM_MS = 400;

const uriOf = (item: QueueItem): string | null => item.track.spotifyUri ?? (item.track.id.startsWith('sp:') ? `spotify:track:${item.track.id.slice(3)}` : null);
const idOf = (item: QueueItem): string | null => idOfUri(uriOf(item));

/** A Spotify song rune knows nothing about yet: `describe` fills it from Soloist's events. */
const placeholder = (id: string, queueId: string): QueueItem => ({
  queueId,
  track: { id: `sp:${id}`, albumId: 'sp:unknown', source: 'spotify', title: '', artists: [], disc: 1, number: 1, durationMs: 0, spotifyUri: `spotify:track:${id}` },
  album: { id: 'sp:unknown', title: '' },
});

export class SoloistZone implements PlaybackZone {
  readonly zone = SOLOIST_ZONE;
  private q: QueueState = createQueue();
  private status: PlayerState['status'] = 'stopped';
  private volume = 100;
  private rev = 0;
  private updatedAt: number;
  private positionMs = 0;
  /** When `positionMs` was true (the anchor the live position counts from); `updatedAt` is bumped for any change. */
  private anchorAt: number;
  /** The song rune queued in Soloist after the current one (its queue index), to tell a natural end from a takeover. */
  private queuedNext: { index: number; id: string } | null = null;
  /** The Spotify id Soloist should be playing now; a track_changed to anything else is looked at. */
  private expected: string | null = null;
  /** The song Soloist plays that rune never queued (see `adopted()`); stays set while that item is the current one. */
  private adoptedSong: AdoptedSong | null = null;
  private adoptSeq = 0;
  /** Where each song Soloist listed in its own queue (queue_changed: previous and upcoming) came from, by Spotify id. */
  private soloistSources = new Map<string, string>();
  /** Soloist's own shuffle/repeat were switched off once (rune orders the queue). */
  private modesChecked = false;
  private modesSet = false;
  /**
   * Soloist is the device that plays (or nothing plays anywhere). False once Soloist said another Connect device is the
   * active one: its events and commands then belong to that device's session (see the top of this file).
   */
  private mine = true;
  /** When rune last started a song on Soloist itself (which makes it the active device). */
  private ownPlayAt = Number.NEGATIVE_INFINITY;
  private ownPlayCheck: ReturnType<typeof setTimeout> | null = null;
  /** A song rune did not ask for, held until Soloist says whether it is the active device (`confirm`). */
  private pending: { id: string; live: boolean; ended: boolean; timer: ReturnType<typeof setTimeout> } | null = null;
  /** The "not believed" line was logged (once per run). */
  private doubted = false;
  /** A volume set while another device was the active one: Soloist gets it when it plays again. */
  private volumeDue = false;
  private readonly subs = new Set<(s: PlayerState) => void>();
  private readonly offs: (() => void)[] = [];
  private readonly now: () => number;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: SoloistZoneDeps) {
    this.now = deps.now ?? Date.now;
    this.updatedAt = this.now();
    this.anchorAt = this.updatedAt;
    this.volume = deps.link.view.volume;
    this.offs.push(deps.link.onEvent((ev) => this.onEvent(ev)));
  }

  // ----- PlaybackZone -----

  state(): PlayerState {
    const cur = currentItem(this.q);
    return {
      zone: this.zone,
      status: cur ? this.status : 'stopped',
      queue: this.q.items,
      index: this.q.index,
      positionMs: this.livePosition(),
      volume: this.volume,
      shuffle: this.q.shuffle,
      repeat: this.q.repeat,
      signalPath: ['Spotify', 'Soloist on the PC', this.deps.output() === 'phone' ? PHONE_STREAM_STEP : 'PipeWire'],
      rev: this.rev,
      output: 'spotify',
      updatedAt: this.updatedAt,
    };
  }

  command(cmd: PlayerCommand): Promise<PlayerState> {
    // One command at a time: a Next landing while a Play is still being sent would race Soloist's queue.
    const run = this.chain.then(() => this.apply(cmd));
    this.chain = run.catch(() => undefined);
    return run.then(() => this.state());
  }

  onChange(cb: (s: PlayerState) => void): () => void {
    this.subs.add(cb);
    return () => { this.subs.delete(cb); };
  }

  async close(): Promise<void> {
    for (const off of this.offs) off();
    this.subs.clear();
    this.dropPending();
    if (this.ownPlayCheck) clearTimeout(this.ownPlayCheck);
    this.ownPlayCheck = null;
  }

  /** Another Spotify Connect device is the active one: Soloist is silent and this zone waits (see the top of this file). */
  playsElsewhere(): boolean {
    return !this.mine;
  }

  /** The current item is a song Soloist plays that rune never queued (autoplay, a Spotify app), or null. */
  adopted(): AdoptedSong | null {
    const cur = currentItem(this.q);
    return cur && this.adoptedSong && cur.queueId === this.adoptedSong.queueId ? this.adoptedSong : null;
  }

  /**
   * The server-owned pc queue edited the songs after the current one: the current song keeps playing, the rest of the
   * zone's queue becomes `items` (play order). A song already queued in Soloist is corrected when its track_changed comes.
   */
  setUpcoming(items: QueueItem[]): Promise<PlayerState> {
    const run = this.chain.then(() => this.replaceUpcoming(items));
    this.chain = run.catch(() => undefined);
    return run.then(() => this.state());
  }

  private async replaceUpcoming(items: QueueItem[]): Promise<void> {
    const cur = currentItem(this.q);
    if (!cur) return;
    const list = [cur, ...items.filter((i) => i.track.source === 'spotify' && uriOf(i))];
    // The driver orders the queue (shuffle included): this zone plays it straight.
    this.q = { ...this.q, items: list, index: 0, shuffle: false, order: list.map((_, i) => i) };
    await this.syncNext();
  }

  // ----- commands -----

  private async apply(cmd: PlayerCommand): Promise<void> {
    switch (cmd.type) {
      case 'play': {
        const items = this.playable(cmd.trackIds);
        if (!items.length) throw new Error('None of these songs is a Spotify song');
        this.q = queuePlay(this.q, items, cmd.startIndex ?? 0);
        await this.startCurrent({ positionMs: cmd.positionMs ?? 0, paused: cmd.paused === true });
        return;
      }
      case 'enqueue': {
        const items = this.playable(cmd.trackIds);
        if (!items.length) throw new Error('None of these songs is a Spotify song');
        const wasEmpty = this.q.items.length === 0 || this.status === 'stopped';
        this.q = queueEnqueue(this.q, items, { next: cmd.next });
        if (wasEmpty) await this.startCurrent({ positionMs: 0, paused: false });
        else await this.syncNext();
        return;
      }
      case 'pause':
        // Not Soloist's session: a pause would stop the other device.
        if (this.mine) await this.deps.link.send({ command: 'pause' });
        this.setStatus('paused');
        return;
      case 'resume':
        if (!currentItem(this.q)) return;
        // A bare `play` resumes whatever the active device holds: after another device took over, rune's song is started anew.
        if (this.status === 'stopped' || this.deps.link.view.status === 'idle' || !this.mine) { await this.startCurrent({ positionMs: this.positionMs, paused: false }); return; }
        await this.deps.link.send({ command: 'play' });
        this.setStatus('playing');
        return;
      case 'next': {
        const r = queueNext(this.q);
        if (r.ended) {
          // Skipping a song rune only follows (autoplay): Soloist's own next, and that one is followed too.
          if (this.adopted() && this.mine) { await this.deps.link.send({ command: 'skip_next' }); this.newProgram(); return; }
          await this.stopAll();
          return;
        }
        this.q = r.state;
        await this.startCurrent({ positionMs: 0, paused: this.status === 'paused' });
        return;
      }
      case 'prev': {
        const r = queuePrev(this.q, this.livePosition());
        this.q = r.state;
        if (r.restart) { await this.seekTo(0); return; }
        await this.startCurrent({ positionMs: 0, paused: this.status === 'paused' });
        return;
      }
      case 'seek':
        await this.seekTo(Math.max(0, Math.round(cmd.positionMs)));
        return;
      case 'jump': {
        const before = this.q.index;
        this.q = queueJump(this.q, cmd.index);
        if (this.q.index !== before) await this.startCurrent({ positionMs: 0, paused: false });
        return;
      }
      case 'remove': {
        const cur = currentItem(this.q);
        this.q = queueRemove(this.q, cmd.queueId);
        const now = currentItem(this.q);
        if (!now) { await this.stopAll(); return; }
        if (cur && now.queueId !== cur.queueId) await this.startCurrent({ positionMs: 0, paused: this.status === 'paused' });
        else await this.syncNext();
        return;
      }
      case 'move':
        this.q = queueMove(this.q, cmd.queueId, cmd.toIndex);
        await this.syncNext();
        return;
      case 'clear':
        this.q = queueClear(this.q);
        await this.stopAll();
        return;
      case 'volume': {
        const v = Math.max(0, Math.min(100, Math.round(cmd.volume)));
        // Not Soloist's session: the level is kept and set when Soloist plays again, the other device keeps its own.
        if (this.mine) await this.deps.link.send({ command: 'set_volume', volume: v });
        else this.volumeDue = true;
        this.volume = v;
        this.bump();
        return;
      }
      case 'shuffle':
        this.q = queueSetShuffle(this.q, cmd.on);
        await this.syncNext();
        return;
      case 'repeat':
        this.q = queueSetRepeat(this.q, cmd.mode);
        await this.syncNext();
        return;
      default: {
        const exhaustive: never = cmd;
        throw new Error(`unknown player command ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private playable(ids: string[]): QueueItem[] {
    return this.deps.loadItems(ids).filter((i) => i.track.source === 'spotify' && uriOf(i));
  }

  /** Tell Soloist to play the current song (and queue the next one), as a new HLS program. */
  private async startCurrent(opts: { positionMs: number; paused: boolean }): Promise<void> {
    const cur = currentItem(this.q);
    const uri = cur && uriOf(cur);
    if (!cur || !uri) { await this.stopAll(); return; }
    if (!this.deps.link.view.connected || !this.deps.link.view.loggedIn) throw new Error('Soloist is not running or not paired yet — see Settings');
    // Another Connect device holds the session (playing or paused): Soloist's commands would act on THAT device, so it
    // is made the active device first. With nothing active anywhere, a play alone does that.
    const takeover = !this.deps.link.view.isActive && this.deps.link.view.status !== 'idle';
    if (takeover) await this.deps.link.send({ command: 'activate' }).catch((err) => this.deps.log?.({ err: String(err) }, 'soloist: could not become the active device'));
    else await this.ensureModes();
    this.expected = idOf(cur);
    this.queuedNext = null;
    this.adoptedSong = null;
    this.dropPending();
    // The song's own events can arrive before the play is acknowledged: from here on they are this zone's.
    const was = this.mine;
    this.mine = true;
    this.ownPlayAt = this.now();
    try {
      await this.deps.link.send({ command: 'play', uri });
    } catch (err) {
      this.mine = was;
      this.ownPlayAt = Number.NEGATIVE_INFINITY;
      throw err;
    }
    this.ownPlayAt = this.now();
    this.checkOwnPlay();
    if (takeover) {
      // The options seen so far were the other device's: Soloist's own are checked now that the session is its own.
      this.modesChecked = false;
      await this.ensureModes();
    }
    if (this.volumeDue) {
      this.volumeDue = false;
      await this.deps.link.send({ command: 'set_volume', volume: this.volume }).catch(() => undefined);
    }
    if (opts.positionMs > 0) await this.deps.link.send({ command: 'seek', position_ms: Math.round(opts.positionMs) });
    if (opts.paused) await this.deps.link.send({ command: 'pause' });
    this.setPos(opts.positionMs);
    this.status = opts.paused ? 'paused' : 'playing';
    this.newProgram();
    await this.syncNext();
  }

  /** Soloist's own shuffle and repeat would reorder or loop what rune sends: off, once per session. */
  private async ensureModes(): Promise<void> {
    if (this.modesChecked) return;
    this.modesChecked = true;
    const v = this.deps.link.view;
    try {
      if (v.shuffle) await this.deps.link.send({ command: 'set_shuffle', enabled: false });
      if (v.repeat !== 'off') {
        await this.deps.link.send({ command: 'set_repeat_track', enabled: false });
        await this.deps.link.send({ command: 'set_repeat_context', enabled: false });
      }
      this.modesSet = true;
    } catch (err) {
      this.modesChecked = false;
      this.deps.log?.({ err: String(err) }, 'soloist: could not switch off shuffle/repeat');
    }
  }

  /** Queue the song after the current one in Soloist (once per song; Soloist's queue cannot be edited). */
  private async syncNext(): Promise<void> {
    this.bump();
    if (this.status === 'stopped') return;
    // Not Soloist's session: the song would land in the other device's queue and play there.
    if (!this.mine) return;
    const nextEntry = this.q.repeat === 'one' ? undefined : queueUpcoming(this.q, 1)[0];
    const id = nextEntry ? idOf(nextEntry.item) : null;
    if (!nextEntry || !id) return;
    if (this.queuedNext?.id === id) return;
    if (this.queuedNext) return; // already queued another song: corrected when track_changed comes
    const uri = uriOf(nextEntry.item);
    if (!uri) return;
    try {
      await this.deps.link.send({ command: 'add_to_queue', uri });
      this.queuedNext = { index: nextEntry.queueIndex, id };
    } catch (err) {
      this.deps.log?.({ err: String(err) }, 'soloist: add_to_queue failed');
    }
  }

  private async seekTo(ms: number): Promise<void> {
    // Not Soloist's session: the place is kept for when rune's song starts here again.
    if (!this.mine) { this.setPos(ms); this.bump(); return; }
    await this.deps.link.send({ command: 'seek', position_ms: ms });
    this.setPos(ms);
    this.updatedAt = this.now();
    this.newProgram();
    this.emit();
  }

  private async stopAll(): Promise<void> {
    this.expected = null;
    this.queuedNext = null;
    this.dropPending();
    if (this.mine && this.deps.link.view.connected && this.deps.link.view.status !== 'idle') await this.deps.link.send({ command: 'pause' }).catch(() => undefined);
    this.status = 'stopped';
    this.setPos(0);
    this.bump();
  }

  // ----- events from Soloist -----

  private onEvent(ev: SoloistEvent): void {
    // Who plays comes first: everything else in an event is only this zone's while Soloist is the active device.
    if (ev.type === 'device_changed') { this.setMine(!!ev.is_active); return; }
    if (ev.type === 'auth_state') { void this.onActiveWord(typeof ev.is_active === 'boolean' ? ev.is_active : null); return; }
    if (ev.type === 'playback_state' && typeof ev.is_active === 'boolean') {
      // "Not the active device" is checked before it is believed, and such a snapshot describes another device's playback.
      if (ev.is_active) this.setMine(true);
      else {
        void this.onActiveWord(false);
        if (ev.status !== 'idle') return;
      }
    }
    if (!this.mine) {
      // Nothing plays anywhere any more (Soloist may give the device up before it says "idle" at the end of a queue).
      const idle = (ev.type === 'playback_changed' || ev.type === 'playback_state') && ev.status === 'idle';
      if (idle && this.status !== 'stopped' && currentItem(this.q)) { this.status = 'stopped'; this.bump(); }
      return;
    }
    switch (ev.type) {
      case 'track_changed':
        this.describe(ev.item);
        this.onTrack(idOfUri(ev.item?.uri));
        return;
      case 'playback_changed': {
        if (ev.status === 'idle') {
          if (this.status !== 'stopped' && currentItem(this.q)) { this.status = 'stopped'; this.bump(); }
          return;
        }
        const cur = currentItem(this.q);
        if (ev.status === 'paused') {
          // A pause while rune shows nothing playing is no sign of life (rune's own stop pauses Soloist).
          if (!cur || this.status === 'stopped') return;
          this.setStatus('paused');
          return;
        }
        // Soloist sounds: rune shows what it plays, even when it thought nothing was playing (a Spotify app pressed
        // Play on this device, or started a song of its own). While rune plays, track_changed says which song it is.
        if (!cur || this.status === 'stopped') this.onTrack(idOfUri(this.deps.link.view.item?.uri));
        // A song rune did not ask for is held until Soloist says who plays it: the status comes with that decision.
        if (this.pending || !currentItem(this.q)) return;
        this.setStatus(ev.status === 'buffering' ? 'loading' : 'playing');
        return;
      }
      case 'playback_state': {
        const live = ev.status === 'playing' || ev.status === 'buffering';
        if (ev.item) {
          this.describe(ev.item);
          this.onTrack(idOfUri(ev.item.uri), { snapshot: true, live });
        }
        if (!currentItem(this.q)) return;
        if (ev.position) this.setPos(ev.position.position_ms, ev.position.timestamp_ms);
        if (typeof ev.volume === 'number') this.volume = ev.volume;
        if (ev.status === 'idle') this.status = 'stopped';
        else if (this.status !== 'stopped' || live) this.status = ev.status === 'paused' ? 'paused' : ev.status === 'buffering' ? 'loading' : 'playing';
        this.bump();
        return;
      }
      case 'queue_changed':
        // Soloist's own queue: a song it lists (its context, autoplay, add_to_queue) is its own next, never a takeover.
        if (this.soloistSources.size > 2000) this.soloistSources.clear();
        for (const e of [...(ev.previous ?? []), ...(ev.upcoming ?? [])]) {
          const id = idOfUri(e.item?.uri);
          if (id) this.soloistSources.set(id, e.source);
        }
        return;
      case 'position_sync':
        // While a song is held (`confirm`), the anchor already describes that song, not the current item.
        if (!currentItem(this.q) || this.status === 'stopped' || this.pending) return;
        this.setPos(ev.position.position_ms + (ev.position.speed > 0 ? Math.max(0, this.now() - ev.position.timestamp_ms) : 0));
        this.updatedAt = this.now();
        this.emit();
        return;
      case 'volume_changed':
        if (ev.volume !== this.volume) { this.volume = ev.volume; this.bump(); }
        return;
      case 'options_changed':
        // rune orders the queue: anyone switching Soloist's shuffle/repeat back on gets it switched off again.
        if (this.modesSet && (ev.options?.shuffle || (ev.options?.repeat && ev.options.repeat !== 'off'))) {
          this.modesChecked = false;
          void this.ensureModes();
        }
        return;
      default:
        return;
    }
  }

  /** Is Soloist sounding right now (by its last word)? */
  private soloistLive(): boolean {
    const s = this.deps.link.view.status;
    return s === 'playing' || s === 'buffering';
  }

  /** rune thought nothing was playing, but Soloist sounds the current song: show it playing. */
  private revive(live: boolean): void {
    if (this.status !== 'stopped' || !live) return;
    this.status = 'playing';
    this.setPos(this.deps.link.positionMs(this.now()) ?? 0);
    this.bump();
  }

  /** Was the song as good as over (by rune's clock) when Soloist moved on? Then what follows is Soloist's own next. */
  private nearEnd(item: QueueItem): boolean {
    const dur = item.track.durationMs;
    if (dur <= 0 || this.status === 'stopped') return false;
    // Soloist's last anchor still describes this song until its next position_sync; rune's own clock is the fallback.
    const pos = Math.max(this.deps.link.positionMs(this.now()) ?? 0, this.livePosition());
    return pos >= dur - END_SLACK_MS;
  }

  /**
   * Soloist now plays `id`: our song, the one we queued next, another of ours, or a song rune never queued. `snapshot`:
   * from a playback_state (sent on connect and for get_state), which may describe a moment before rune's own play
   * landed, so it only ever changes the cursor while rune shows nothing playing.
   */
  private onTrack(id: string | null, opts: { snapshot?: boolean; live?: boolean } = {}): void {
    if (!id) return;
    const live = opts.live ?? this.soloistLive();
    if (id === this.expected) { this.revive(live); return; }
    const cur = currentItem(this.q);
    if (this.queuedNext && id === this.queuedNext.id) {
      // The natural end of the current song: Soloist moved on to what rune queued (gapless, same HLS program). The
      // queue may have been edited since it was queued: the cursor goes to that song wherever it is now, and a song
      // edited out of the queue is handled below like any other song rune did not ask for.
      const r = queueNext(this.q, { auto: true });
      const queuedAt = this.queuedNext.index;
      const same = (index: number) => { const item = this.q.items[index]; return !!item && idOf(item) === id; };
      const at = !r.ended && same(r.state.index) ? r.state.index : same(queuedAt) ? queuedAt : this.q.items.findIndex((i) => idOf(i) === id);
      this.queuedNext = null;
      if (at >= 0) {
        this.q = at === r.state.index ? r.state : { ...this.q, index: at };
        this.expected = id;
        this.setPos(0);
        this.updatedAt = this.now();
        if (this.status === 'stopped' && live) this.status = 'playing';
        void this.chain.then(() => this.syncNext());
        return;
      }
    }
    const at = this.q.items.findIndex((i) => idOf(i) === id);
    if (at >= 0 && at !== this.q.index) {
      this.q = { ...this.q, index: at };
      this.expected = id;
      this.queuedNext = null;
      this.setPos(0);
      if (this.status === 'stopped' && live) this.status = 'playing';
      this.bump();
      void this.chain.then(() => this.syncNext());
      return;
    }
    if (at === this.q.index && cur) { this.expected = id; this.revive(live); return; }
    // A song rune never asked for: what happens with it depends on which device plays it. A snapshot said so itself;
    // otherwise Soloist is asked first (another device taking over shows up as a song change here too).
    const ended = !!cur && this.nearEnd(cur);
    if (opts.snapshot) this.unasked(id, { snapshot: true, live, ended });
    else this.confirm(id, live, ended);
  }

  /**
   * Hold a song rune did not ask for until Soloist says whether it is the active device (its answer to get_auth_state
   * comes after every event of the same change, device_changed included). `ended`: rune's song was as good as over
   * when the change came, noted now because the next position_sync already describes the new song.
   */
  private confirm(id: string, live: boolean, ended: boolean): void {
    this.dropPending();
    const timer = setTimeout(() => this.settlePending(), CONFIRM_MS);
    (timer as { unref?: () => void }).unref?.();
    this.pending = { id, live, ended, timer };
    this.deps.link.send({ command: 'get_auth_state' }).catch(() => this.settlePending());
  }

  private dropPending(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }

  /** Soloist answered (or did not, in time): the held song is acted on if Soloist is the device playing it. */
  private settlePending(): void {
    const p = this.pending;
    if (!p) return;
    this.dropPending();
    if (!this.mine) return;
    // Soloist's status may have moved on while the song was held (its "playing" follows the track change).
    this.unasked(p.id, { live: p.live || this.soloistLive(), ended: p.ended });
  }

  /** Soloist itself plays a song rune never queued here: go on with rune's queue, or follow it. */
  private unasked(id: string, opts: { snapshot?: boolean; live: boolean; ended: boolean }): void {
    const live = opts.live;
    const cur = currentItem(this.q);
    if (id === this.expected) { this.revive(live); return; }
    // Soloist's own next (autoplay after rune's song, its context, a song queued in a Spotify app) is one it listed in
    // its queue, or one that began as rune's song ran out; anything else is a takeover.
    const natural = this.soloistSources.has(id) || opts.ended;
    const r = queueNext(this.q, { auto: true });
    if (natural && !r.ended && cur && this.status !== 'stopped') {
      if (opts.snapshot) return;
      // Soloist went on by itself although rune's queue has a next song (the add_to_queue was lost or came too late):
      // rune's song plays, not autoplay.
      this.deps.log?.({ id }, 'soloist: went on by itself while rune had a next song; playing it');
      this.q = r.state;
      this.chain = this.chain.then(() => this.startCurrent({ positionMs: 0, paused: false })).catch((err) => this.deps.log?.({ err: String(err) }, 'soloist: could not continue the queue'));
      return;
    }
    // A snapshot may be older than rune's own play: it only ever adopts a song while rune shows nothing playing.
    if (opts.snapshot && !(live && (this.status === 'stopped' || !cur))) return;
    // Nothing sounds and nothing is about to: nothing to follow (a playing/buffering playback_changed comes back here).
    if (!live && this.deps.link.view.status === 'idle') return;
    this.adopt(id, natural ? 'autoplay' : 'takeover', live);
  }

  // ----- which device plays -----

  /**
   * Soloist's word on whether it is the active device (auth_state, a snapshot), then the held song. "Not active" is not
   * believed when it may predate rune's own play, nor while Soloist's own sound stream is running: silencing a zone
   * that audibly plays would be the worse mistake. (device_changed, the event for the change itself, needs no check.)
   */
  private async onActiveWord(active: boolean | null): Promise<void> {
    if (active === false && this.mine) {
      if (this.now() - this.ownPlayAt < OWN_PLAY_GRACE_MS) active = null;
      else if (this.status === 'playing' && this.deps.sounding) {
        const sounding = await this.deps.sounding().catch(() => null);
        if (sounding === true) {
          if (!this.doubted) this.deps.log?.({}, 'soloist: says it is not the active device while its own stream runs; not believed');
          this.doubted = true;
          active = null;
        }
      }
    }
    if (active !== null) this.setMine(active);
    this.settlePending();
  }

  /** Soloist stopped being, or became, the device that plays. */
  private setMine(mine: boolean): void {
    if (mine === this.mine) return;
    if (!mine) {
      // Another device took the session over: Soloist is silent. rune's song waits where it was (Play starts it here
      // again), and what the other device plays from now on is not followed.
      const was = this.status;
      if (was === 'playing' || was === 'loading') {
        this.setPos(this.livePosition());
        this.status = 'paused';
      }
      this.mine = false;
      this.queuedNext = null;
      this.dropPending();
      if (was !== 'stopped' && currentItem(this.q)) this.deps.log?.({}, 'soloist: another Spotify device plays now; rune\'s queue here waits');
      this.bump();
      return;
    }
    // Soloist became the active device without rune asking (picked in a Spotify app): what it plays is followed again.
    this.mine = true;
    if (this.soloistLive()) this.onTrack(idOfUri(this.deps.link.view.item?.uri));
    this.bump();
  }

  /**
   * A while after rune's own play, Soloist is asked whether it really became the active device. If it says no (and its
   * own sound stream is not running either, see `onActiveWord`), the song went into another device's session and this
   * zone must not act as if it played.
   */
  private checkOwnPlay(): void {
    if (this.ownPlayCheck) clearTimeout(this.ownPlayCheck);
    const timer = setTimeout(() => {
      if (this.ownPlayCheck === timer) this.ownPlayCheck = null;
      if (!this.mine || this.status !== 'playing' || !this.deps.link.view.connected) return;
      this.deps.link.send({ command: 'get_auth_state' }).catch(() => undefined);
    }, OWN_PLAY_CHECK_MS);
    (timer as { unref?: () => void }).unref?.();
    this.ownPlayCheck = timer;
  }

  /**
   * Follow a song Soloist plays that rune never queued: it becomes the current item (a placeholder until `describe`
   * names it from Soloist's metadata, or rune's own record when it has one), right after rune's songs so far. A second
   * adopted song replaces the first (the queue does not grow with every autoplay song), and rune's songs still queued
   * stay after it (Next plays them; they are also queued into Soloist as usual). The HLS program is kept: the phone
   * hears the change as the gapless transition it is.
   */
  private adopt(id: string, reason: AdoptedSong['reason'], live: boolean): void {
    const queueId = `soloist:${++this.adoptSeq}:${id}`;
    const known = this.deps.loadItems([`sp:${id}`]).find((i) => idOf(i) === id);
    const item: QueueItem = known ? { ...known, queueId } : placeholder(id, queueId);
    const cur = currentItem(this.q);
    if (cur && this.adoptedSong && cur.queueId === this.adoptedSong.queueId) {
      this.q = { ...this.q, items: this.q.items.map((it, i) => (i === this.q.index ? item : it)) };
    } else if (!cur) {
      this.q = queuePlay(this.q, [item], 0);
    } else {
      this.q = queueJump(queueEnqueue(this.q, [item], { next: true }), this.q.index + 1);
    }
    this.adoptedSong = { queueId, id, reason };
    this.expected = id;
    this.queuedNext = null;
    const view = this.deps.link.view;
    this.setPos((idOfUri(view.item?.uri) === id ? this.deps.link.positionMs(this.now()) : null) ?? 0);
    this.status = live ? 'playing' : view.status === 'paused' ? 'paused' : view.status === 'buffering' ? 'loading' : 'stopped';
    this.deps.log?.({ id, reason }, 'soloist: following a song rune did not queue');
    this.bump();
    if (idOfUri(view.item?.uri) === id) this.describe(view.item);
    void this.chain.then(() => this.syncNext());
  }

  /**
   * A song rune never stored (a placeholder with no title) gets its title, artists, album, cover and length from what
   * Soloist says about it: metadata from Soloist's own events, not one Web API request.
   */
  private describe(entity: SoloistEntity | null | undefined): void {
    const id = idOfUri(entity?.uri);
    const d = entity?.decorations;
    if (!id || !d?.identity?.name) return;
    let changed = false;
    const items = this.q.items.map((item) => {
      if (idOf(item) !== id || item.track.title) return item;
      changed = true;
      const artists = (d.creators ?? [])
        .map((c) => c.entity)
        .filter((e): e is SoloistEntity => !!e?.uri && !!e.decorations?.identity?.name)
        .map((e) => ({ id: `sp:${idOfUri(e.uri) ?? e.uri.split(':').pop() ?? ''}`, name: e.decorations!.identity!.name! }));
      const album = d.parent?.entity;
      const albumId = album?.uri ? `sp:${album.uri.split(':').pop() ?? ''}` : item.album.id;
      const covers = [...(d.visual_identity?.cover ?? [])];
      const cover = covers.find((c) => c.size === 'large')?.url ?? covers[0]?.url;
      const durationMs = d.playback?.duration_ms ?? item.track.durationMs;
      return {
        ...item,
        track: { ...item.track, title: d.identity!.name!, artists: artists.length ? artists : item.track.artists, albumId, durationMs },
        album: { id: albumId, title: album?.decorations?.identity?.name ?? item.album.title, ...(cover ? { coverUrl: cover } : {}) },
      };
    });
    if (!changed) return;
    this.q = { ...this.q, items };
    this.bump();
  }

  // ----- state plumbing -----

  private livePosition(): number {
    const p = this.deps.link.positionMs(this.now());
    if (p !== null && this.mine && this.status !== 'stopped' && this.expected && idOfUri(this.deps.link.view.item?.uri) === this.expected) return p;
    return this.status === 'playing' ? this.positionMs + Math.max(0, this.now() - this.anchorAt) : this.positionMs;
  }

  private setPos(ms: number, at = this.now()): void {
    this.positionMs = ms;
    this.anchorAt = at;
  }

  private setStatus(status: PlayerState['status']): void {
    if (status === this.status) return;
    this.setPos(this.livePosition());
    this.status = status;
    this.bump();
  }

  private newProgram(): void {
    this.rev++;
    if (this.deps.output() === 'phone') this.deps.newProgram?.();
  }

  private bump(): void {
    this.updatedAt = this.now();
    this.emit();
  }

  private emit(): void {
    const s = this.state();
    for (const f of this.subs) f(s);
  }
}
