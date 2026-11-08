import type { PlayerState, QueueItem } from '@liner/shared';
import { isLiveTrack } from '../lib/listenTypes';
import type { ExtCommand, PlayItem } from '../lib/types';
import type { Engine } from './engine';
import type { TabChannel } from './oneTab';
import { matchBackendModes } from './modes';
import { emptyState, livePosition, type Backend, type PlayModes } from './types';

let qn = 0;
const newQueueId = () => `q${Date.now().toString(36)}${(qn++).toString(36)}`;
const toQueueItems = (items: PlayItem[]): QueueItem[] => items.map((i) => ({ queueId: newQueueId(), track: i.track, album: i.album }));

/**
 * A zone whose queue lives in this tab. Used for the browser zone (real <audio>) and for every zone
 * in mock mode (simulated playback). Mirrors what the server does for pc/spotify zones.
 */
export class LocalBackend implements Backend {
  state: PlayerState;
  private subs = new Set<(s: PlayerState) => void>();
  private timer: ReturnType<typeof setInterval>;

  constructor(
    readonly zone: string,
    private engine: Engine,
    init?: Partial<PlayerState>,
    private onNotice?: (m: string) => void,
    /** The queue ran out naturally (not repeat): browser/mock auto-radio hangs off this. */
    private onQueueEnd?: () => void,
    /** The browser zone: one tab of this browser sounds at a time (oneTab.ts). */
    private tabs?: TabChannel | null,
  ) {
    this.state = { ...emptyState(zone), ...init, zone };
    // Another tab started to play: this one pauses, as if its Pause had been pressed.
    this.tabs?.onOtherStarted(() => { if (this.state.status === 'playing') void this.send({ type: 'pause' }); });
    this.engine.onEnded(() => this.advance());
    this.engine.onError((m) => {
      this.onNotice?.(m);
      this.set({ status: 'paused', positionMs: livePosition(this.state), updatedAt: Date.now() });
    });
    this.engine.onSync?.((pos, playing) => this.onEngineSync(pos, playing));
    this.engine.setVolume(this.state.volume);
    this.timer = setInterval(() => this.tick(), 400);
  }

  subscribe(fn: (s: PlayerState) => void) {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }
  async refresh() {}
  async matchModes(want: PlayModes) { await matchBackendModes(this, want); }
  dispose() { clearInterval(this.timer); this.engine.stop(); this.subs.clear(); this.tabs?.close(); }

  private set(patch: Partial<PlayerState>) {
    const was = this.state.status;
    this.state = { ...this.state, ...patch };
    if (this.state.status === 'playing' && was !== 'playing') this.tabs?.started();
    for (const f of this.subs) f(this.state);
  }
  private snapshot(): Pick<PlayerState, 'positionMs' | 'updatedAt'> {
    const real = this.engine.position();
    const now = Date.now();
    return { positionMs: real ?? livePosition(this.state, now), updatedAt: now };
  }

  private tick() {
    const s = this.state;
    if (s.status !== 'playing') return;
    const cur = s.queue[s.index];
    if (!cur) return;
    const real = this.engine.position();
    const pos = real ?? livePosition(s);
    // duration 0 = live radio: there is no end to advance past
    if (real === null && cur.track.durationMs > 0 && !isLiveTrack(cur.track) && pos >= cur.track.durationMs - 5) this.advance();
  }

  /** The engine saw the real position / play state (Spotify SDK: also changes made from other Spotify apps). */
  private onEngineSync(pos: number, playing: boolean) {
    const s = this.state;
    if (!s.queue[s.index] || s.status === 'stopped') return;
    const status = playing ? 'playing' : 'paused';
    if (status !== s.status || Math.abs(pos - livePosition(s)) > 700) this.set({ status, positionMs: pos, updatedAt: Date.now() });
  }

  /** What plays after the current track, in order (repeat-one replays it, so nothing comes next). */
  private upcomingTracks() {
    return this.state.repeat === 'one' ? [] : this.state.queue.slice(this.state.index + 1, this.state.index + 21).map((q) => q.track);
  }

  /** A queue edit changed what is next: let a look-ahead engine release/refresh its buffer. */
  private refreshUpcoming() {
    const s = this.state;
    if (s.status !== 'playing' && s.status !== 'paused') return;
    this.engine.setUpcoming?.(this.upcomingTracks());
  }

  private startCurrent(positionMs = 0, autoplay = true) {
    const cur = this.state.queue[this.state.index];
    if (!cur) { this.engine.stop(); return; }
    this.engine.load(cur.track, positionMs, autoplay, this.upcomingTracks());
    this.set({ status: autoplay ? 'playing' : 'paused', positionMs, updatedAt: Date.now() });
  }

  private advance() {
    const s = this.state;
    if (s.repeat === 'one') return this.startCurrent(0);
    if (s.index + 1 < s.queue.length) return this.jump(s.index + 1);
    if (s.repeat === 'all' && s.queue.length) return this.jump(0);
    this.engine.pause();
    this.set({ status: 'stopped', positionMs: 0, updatedAt: Date.now() });
    this.onQueueEnd?.();
  }

  private jump(index: number) {
    if (index < 0 || index >= this.state.queue.length) return;
    this.set({ index });
    this.startCurrent(0);
  }

  async send(cmd: ExtCommand, items: PlayItem[] = []): Promise<void> {
    const s = this.state;
    switch (cmd.type) {
      case 'play': {
        const q = toQueueItems(items);
        if (!q.length) return;
        const pos = Math.max(0, cmd.positionMs ?? 0);
        this.set({
          queue: q,
          index: Math.min(cmd.startIndex ?? 0, q.length - 1),
          status: cmd.paused ? 'paused' : 'playing',
          positionMs: pos,
          updatedAt: Date.now(),
        });
        this.startCurrent(pos, !cmd.paused);
        return;
      }
      case 'enqueue': {
        const q = toQueueItems(items);
        if (!q.length) return;
        const wasEmpty = s.queue.length === 0 || s.status === 'stopped';
        let queue: QueueItem[];
        if (s.queue.length === 0) queue = q;
        else if (cmd.next) queue = [...s.queue.slice(0, s.index + 1), ...q, ...s.queue.slice(s.index + 1)];
        else queue = [...s.queue, ...q];
        const patch: Partial<PlayerState> = { queue };
        if (s.queue.length === 0) patch.index = 0;
        this.set(patch);
        if (wasEmpty && s.queue.length === 0) this.startCurrent(0);
        else this.refreshUpcoming();
        return;
      }
      case 'pause':
        this.engine.pause();
        this.set({ status: 'paused', ...this.snapshot() });
        return;
      case 'resume':
        if (s.status === 'stopped') { if (s.queue.length) this.startCurrent(0); return; }
        this.engine.play();
        if (this.state !== s) return; // the song was over: Play moved the queue on, and the state already says so
        this.set({ status: 'playing', positionMs: this.engine.position() ?? s.positionMs, updatedAt: Date.now() });
        return;
      case 'next': return this.advanceManual(1);
      case 'prev': {
        if (livePosition(s) > 3000 || s.index <= 0) return this.startCurrent(0, s.status !== 'paused');
        return this.jump(s.index - 1);
      }
      case 'seek': {
        const pos = Math.max(0, cmd.positionMs);
        this.engine.seek(pos);
        this.set({ positionMs: pos, updatedAt: Date.now() });
        return;
      }
      case 'jump': return this.jump(cmd.index);
      case 'remove': {
        const i = s.queue.findIndex((q) => q.queueId === cmd.queueId);
        if (i < 0) return;
        const queue = s.queue.filter((_, k) => k !== i);
        if (i < s.index) { this.set({ queue, index: s.index - 1 }); this.refreshUpcoming(); }
        else if (i > s.index) { this.set({ queue }); this.refreshUpcoming(); }
        else if (queue.length === 0) { this.engine.stop(); this.set({ queue, index: -1, status: 'stopped', positionMs: 0, updatedAt: Date.now() }); }
        else { this.set({ queue, index: Math.min(i, queue.length - 1) }); this.startCurrent(0, s.status === 'playing'); }
        return;
      }
      case 'clear':
        this.engine.stop();
        this.set({ queue: [], index: -1, status: 'stopped', positionMs: 0, updatedAt: Date.now() });
        return;
      case 'move': {
        const from = s.queue.findIndex((q) => q.queueId === cmd.queueId);
        if (from < 0) return;
        const to = Math.max(0, Math.min(s.queue.length - 1, cmd.toIndex));
        if (from === to) return;
        const queue = s.queue.slice();
        const [it] = queue.splice(from, 1);
        queue.splice(to, 0, it as QueueItem);
        const cur = s.queue[s.index]?.queueId;
        this.set({ queue, index: cur ? queue.findIndex((q) => q.queueId === cur) : s.index });
        this.refreshUpcoming();
        return;
      }
      case 'volume':
        this.engine.setVolume(cmd.volume);
        this.set({ volume: cmd.volume });
        return;
      case 'shuffle': {
        if (cmd.on && !s.shuffle && s.queue.length > 1) {
          const head = s.queue.slice(0, s.index + 1);
          const tail = s.queue.slice(s.index + 1);
          for (let i = tail.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [tail[i], tail[j]] = [tail[j] as QueueItem, tail[i] as QueueItem];
          }
          this.set({ shuffle: true, queue: [...head, ...tail] });
        } else this.set({ shuffle: cmd.on });
        this.refreshUpcoming();
        return;
      }
      case 'repeat':
        this.set({ repeat: cmd.mode });
        this.refreshUpcoming();
        return;
    }
  }

  private advanceManual(dir: 1) {
    const s = this.state;
    if (s.index + dir < s.queue.length) this.jump(s.index + dir);
    else if (s.repeat === 'all' && s.queue.length) this.jump(0);
  }
}
