// A fake mpv for the server-owned queue: it plays the run it is given on the test clock, gaplessly, and reports the
// states play/zone.ts would. Nothing sounds; nothing is spawned.
import type { PlayerCommand, PlayerState, QueueItem } from '@liner/shared';
import type { MpvRunZone } from '../../src/play/zone.js';

export class FakeRunMpv implements MpvRunZone {
  items: QueueItem[] = [];
  index = -1;
  status: PlayerState['status'] = 'stopped';
  volume = 100;
  log: string[] = [];
  private pos = 0;
  private baseAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly subs = new Set<(s: PlayerState) => void>();

  /** Is it making sound right now? */
  get sounding(): boolean {
    return this.status === 'playing';
  }

  position(): number {
    const cur = this.items[this.index];
    const p = this.status === 'playing' ? this.pos + Date.now() - this.baseAt : this.pos;
    return cur && cur.track.durationMs > 0 ? Math.min(cur.track.durationMs, p) : p;
  }

  state(): PlayerState {
    return {
      zone: 'pc', status: this.status, queue: [...this.items], index: this.index, positionMs: Math.round(this.position()),
      volume: this.volume, shuffle: false, repeat: 'off', signalPath: ['FLAC 16/44.1', 'mpv'], updatedAt: Date.now(),
    };
  }

  onChange(cb: (s: PlayerState) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  async loadRun(items: QueueItem[], opts: { positionMs: number; paused: boolean }): Promise<PlayerState> {
    this.log.push(`load ${items.map((i) => i.track.id).join(',')}${opts.positionMs ? `@${opts.positionMs}` : ''}`);
    this.items = [...items];
    this.index = 0;
    this.pos = opts.positionMs;
    this.status = 'loading';
    this.emit();
    this.status = opts.paused ? 'paused' : 'playing';
    this.baseAt = Date.now();
    this.emit();
    this.arm();
    return this.state();
  }

  async setUpcoming(items: QueueItem[]): Promise<PlayerState> {
    this.log.push(`upcoming ${items.map((i) => i.track.id).join(',')}`);
    this.items = [...this.items.slice(0, this.index + 1), ...items];
    this.emit();
    return this.state();
  }

  async command(cmd: PlayerCommand): Promise<PlayerState> {
    this.log.push(cmd.type === 'volume' ? `volume ${cmd.volume}` : cmd.type === 'seek' ? `seek ${cmd.positionMs}` : cmd.type);
    switch (cmd.type) {
      case 'pause':
        if (this.status === 'playing') { this.pos = this.position(); this.status = 'paused'; this.emit(); this.arm(); }
        break;
      case 'resume':
        if (this.status === 'paused') { this.status = 'playing'; this.baseAt = Date.now(); this.emit(); this.arm(); }
        break;
      case 'seek':
        this.pos = cmd.positionMs; this.baseAt = Date.now(); this.emit(); this.arm();
        break;
      case 'clear':
        this.items = []; this.index = -1; this.pos = 0; this.status = 'stopped'; this.arm(); this.emit();
        break;
      case 'volume':
        this.volume = cmd.volume; this.emit();
        break;
      default:
        throw new Error(`the fake mpv does not take ${cmd.type}`);
    }
    return this.state();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const cur = this.items[this.index];
    if (this.status !== 'playing' || !cur || cur.track.durationMs <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.index + 1 < this.items.length) {
        // gapless: the next file was preloaded
        this.index += 1; this.pos = 0; this.baseAt = Date.now();
        this.log.push(`next ${this.items[this.index]!.track.id}`);
        this.emit();
        this.arm();
      } else {
        this.pos = cur.track.durationMs; this.status = 'stopped';
        this.log.push('idle');
        this.emit();
      }
    }, Math.max(0, cur.track.durationMs - this.position()));
  }

  private emit(): void {
    const s = this.state();
    for (const f of this.subs) f(s);
  }
}
