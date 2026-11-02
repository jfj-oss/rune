import type { PlayerState, QueueItem } from '@liner/shared';
import type { ExtCommand, PlayItem } from '../lib/types';
import type { Engine } from './engine';
import { emptyState, livePosition, type Backend } from './types';

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

  constructor(readonly zone: string, private engine: Engine, init?: Partial<PlayerState>, private onNotice?: (m: string) => void) {
    this.state = { ...emptyState(zone), ...init, zone };
    this.engine.onEnded(() => this.advance());
    this.engine.onError((m) => {
      this.onNotice?.(m);
      this.set({ status: 'paused', positionMs: livePosition(this.state), updatedAt: Date.now() });
    });
    this.engine.setVolume(this.state.volume);
    this.timer = setInterval(() => this.tick(), 400);
  }

  subscribe(fn: (s: PlayerState) => void) {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }
  async refresh() {}
  dispose() { clearInterval(this.timer); this.engine.stop(); this.subs.clear(); }

  private set(patch: Partial<PlayerState>) {
    this.state = { ...this.state, ...patch };
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
    if (real === null && pos >= cur.track.durationMs - 5) this.advance();
  }

  private startCurrent(positionMs = 0, autoplay = true) {
    const cur = this.state.queue[this.state.index];
    if (!cur) { this.engine.stop(); return; }
    this.engine.load(cur.track, positionMs, autoplay);
    this.set({ status: autoplay ? 'playing' : 'paused', positionMs, updatedAt: Date.now() });
  }

  private advance() {
    const s = this.state;
    if (s.repeat === 'one') return this.startCurrent(0);
    if (s.index + 1 < s.queue.length) return this.jump(s.index + 1);
    if (s.repeat === 'all' && s.queue.length) return this.jump(0);
    this.engine.pause();
    this.set({ status: 'stopped', positionMs: 0, updatedAt: Date.now() });
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
        this.set({ queue: q, index: Math.min(cmd.startIndex ?? 0, q.length - 1) });
        this.startCurrent(0);
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
        return;
      }
      case 'pause':
        this.engine.pause();
        this.set({ status: 'paused', ...this.snapshot() });
        return;
      case 'resume':
        if (s.status === 'stopped') { if (s.queue.length) this.startCurrent(0); return; }
        this.engine.play();
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
        if (i < s.index) this.set({ queue, index: s.index - 1 });
        else if (i > s.index) this.set({ queue });
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
        return;
      }
      case 'repeat':
        this.set({ repeat: cmd.mode });
        return;
    }
  }

  private advanceManual(dir: 1) {
    const s = this.state;
    if (s.index + dir < s.queue.length) this.jump(s.index + dir);
    else if (s.repeat === 'all' && s.queue.length) this.jump(0);
  }
}
