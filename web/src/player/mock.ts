import type { PlayerState, QueueItem } from '@liner/shared';
import * as Q from '@liner/shared';
import { isLiveTrack } from '../lib/listenTypes';
import type { ExtCommand, PlayItem } from '../lib/types';
import { matchBackendModes } from './modes';
import { emptyState, livePosition, type Backend, type PlayModes } from './types';

let qn = 0;
const newQueueId = () => `q${Date.now().toString(36)}${(qn++).toString(36)}`;
const toQueueItems = (items: PlayItem[]): QueueItem[] => items.map((i) => ({ queueId: newQueueId(), track: i.track, album: i.album }));

/**
 * Mock mode only (no server: `?mock`, screenshots, design work): a pretend zone that keeps its queue with the very same
 * queue module the server uses (@liner/shared) and plays on a clock, in silence. Never used with a real server.
 */
export class MockBackend implements Backend {
  state: PlayerState;
  private q = Q.createQueue();
  private subs = new Set<(s: PlayerState) => void>();
  private timer: ReturnType<typeof setInterval>;

  constructor(readonly zone: string) {
    this.state = emptyState(zone);
    this.timer = setInterval(() => this.tick(), 400);
  }

  subscribe(fn: (s: PlayerState) => void) {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }
  async refresh() {}
  async matchModes(want: PlayModes) { await matchBackendModes(this, want); }
  dispose() { clearInterval(this.timer); this.subs.clear(); }

  private publish(patch: Partial<PlayerState> = {}) {
    this.state = { ...this.state, queue: this.q.items, index: this.q.index, shuffle: this.q.shuffle, repeat: this.q.repeat, ...patch };
    for (const f of this.subs) f(this.state);
  }

  private tick() {
    const s = this.state;
    const cur = s.queue[s.index];
    if (s.status !== 'playing' || !cur || isLiveTrack(cur.track) || cur.track.durationMs <= 0) return;
    if (livePosition(s) >= cur.track.durationMs - 5) this.advance();
  }

  private advance() {
    const r = Q.next(this.q, { auto: true });
    if (r.ended) { this.publish({ status: 'stopped', positionMs: 0, updatedAt: Date.now() }); return; }
    this.q = r.state;
    this.publish({ status: 'playing', positionMs: 0, updatedAt: Date.now() });
  }

  private go(q: Q.QueueState, positionMs = 0, paused = false) {
    this.q = q;
    this.publish({ status: paused ? 'paused' : 'playing', positionMs, updatedAt: Date.now() });
  }

  async send(cmd: ExtCommand, items: PlayItem[] = []): Promise<void> {
    const s = this.state;
    const now = Date.now();
    switch (cmd.type) {
      case 'play': {
        const q = toQueueItems(items);
        if (!q.length) return;
        return this.go(Q.play(this.q, q, cmd.startIndex ?? 0, Math.random, cmd.shuffle === true), Math.max(0, cmd.positionMs ?? 0), cmd.paused === true);
      }
      case 'enqueue': {
        const q = toQueueItems(items);
        if (!q.length) return;
        const empty = this.q.items.length === 0 || s.status === 'stopped';
        const added = Q.enqueue(this.q, q, { next: cmd.next });
        if (empty && this.q.items.length === 0) return this.go(added);
        this.q = added;
        return this.publish();
      }
      case 'pause': return this.publish({ status: 'paused', positionMs: livePosition(s, now), updatedAt: now });
      case 'resume':
        if (s.status === 'stopped') return this.q.items.length ? this.go(this.q) : undefined;
        return this.publish({ status: 'playing', updatedAt: now });
      case 'next': {
        const r = Q.next(this.q);
        return r.ended ? undefined : this.go(r.state);
      }
      case 'prev': {
        const r = Q.prev(this.q, livePosition(s, now));
        return this.go(r.state, 0, s.status === 'paused');
      }
      case 'seek': return this.publish({ positionMs: Math.max(0, cmd.positionMs), updatedAt: now });
      case 'jump': return this.q.items[cmd.index] ? this.go(Q.jump(this.q, cmd.index)) : undefined;
      case 'remove': {
        const wasCurrent = this.q.items[this.q.index]?.queueId === cmd.queueId;
        const q = Q.remove(this.q, cmd.queueId);
        if (!q.items.length) { this.q = q; return this.publish({ status: 'stopped', positionMs: 0, updatedAt: now }); }
        return wasCurrent ? this.go(q, 0, s.status === 'paused') : (this.q = q, this.publish());
      }
      case 'clear': this.q = Q.clear(this.q); return this.publish({ status: 'stopped', positionMs: 0, updatedAt: now });
      case 'move': this.q = Q.move(this.q, cmd.queueId, cmd.toIndex); return this.publish();
      case 'volume': return this.publish({ volume: cmd.volume });
      case 'shuffle': this.q = Q.setShuffle(this.q, cmd.on); return this.publish();
      case 'repeat': this.q = Q.setRepeat(this.q, cmd.mode); return this.publish();
    }
  }
}
