// The output behind a browser zone: the tab that sounds it. The server queue (play/driver.ts) decides what plays; this
// output only publishes the instruction (PlayerState.tab: which run, a new load, a new seek) and turns the tab's
// reports back into the facts every output gives the driver. A quiet tab (a locked or backgrounded phone, whose timers
// and fetches the browser suspends while its audio goes on) is never a reason to pause: its position is then unknown
// (the driver counts by the clock) and the queue stays as it is. It catches up when it reports again. Only a tab that
// has been gone for 30 minutes releases the zone.
import type { PlayerState, QueueItem, TabReport } from '@liner/shared';
import type { Output, OutputFact } from './driver.js';

export interface TabOutputOptions {
  now?: () => number;
  /** A song the tab never started within this long failed (nobody is listening). */
  startTimeoutMs?: number;
  /** A tab that has not reported within this long is gone (the zone is released, paused). */
  goneMs?: number;
  /** Without a report for this long the tab's position is unknown (the clock counts instead). */
  staleMs?: number;
}

export const TAB_START_TIMEOUT_MS = 20_000;
export const TAB_GONE_MS = 30 * 60_000;
export const TAB_STALE_MS = 20_000;

export class TabOutput implements Output {
  readonly kind = 'tab' as const;
  private token = 0;
  private loadV = 0;
  private seekV = 0;
  private run: string[] = [];
  private active = false;
  /** The song the tab said it is sounding. */
  private cur: string | null = null;
  private playing = false;
  private lastContact = 0;
  private reported: { positionMs: number; at: number } | null = null;
  private readonly facts = new Set<(f: OutputFact) => void>();
  private readonly detailFns = new Set<() => void>();
  private readonly now: () => number;
  private readonly startTimeoutMs: number;
  private readonly goneMs: number;
  private readonly staleMs: number;
  /** The last report said the page is not on screen: it may be unable to answer a new start. */
  private hidden = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: TabOutputOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.startTimeoutMs = opts.startTimeoutMs ?? TAB_START_TIMEOUT_MS;
    this.goneMs = opts.goneMs ?? TAB_GONE_MS;
    this.staleMs = opts.staleMs ?? TAB_STALE_MS;
  }

  async start(run: QueueItem[], opts: { token: number; positionMs: number; volume: number }): Promise<void> {
    this.token = opts.token;
    this.run = run.map((q) => q.queueId);
    this.loadV++;
    this.active = true;
    this.cur = null;
    this.playing = true;
    this.reported = null;
    this.lastContact = this.now();
    this.arm();
    // The driver shows "loading" before this call: tell it (and so the page) about the new instruction now.
    for (const fn of this.detailFns) fn();
  }

  update(run: QueueItem[], token: number): void {
    if (!this.active || token !== this.token) return;
    this.run = run.map((q) => q.queueId);
  }

  async pause(): Promise<void> {
    this.playing = false;
  }

  async resume(): Promise<void> {
    if (!this.active) throw new Error('no tab holds a song');
    this.playing = true;
    this.lastContact = this.now();
  }

  async seek(): Promise<void> {
    if (!this.active) return;
    this.seekV++;
    this.reported = null;
    this.lastContact = this.now();
  }

  async stop(): Promise<void> {
    this.active = false;
    this.cur = null;
    this.run = [];
    this.playing = false;
    this.reported = null;
    this.disarm();
  }

  async setVolume(): Promise<void> {}

  position(): number | null {
    if (!this.active || !this.playing || !this.reported) return null;
    if (this.now() - this.lastContact > this.staleMs) return null;
    return this.reported.positionMs + Math.max(0, this.now() - this.reported.at);
  }

  onFact(fn: (f: OutputFact) => void): void {
    this.facts.add(fn);
  }

  details(): Pick<PlayerState, 'tab'> {
    return this.active ? { tab: { token: this.token, loadV: this.loadV, seekV: this.seekV, run: [...this.run] } } : {};
  }

  onDetails(fn: () => void): void {
    this.detailFns.add(fn);
  }

  close(): void {
    this.disarm();
    this.facts.clear();
    this.detailFns.clear();
  }

  /** The tab's own report. Reports of an older run, or about a song that is not in the run, are dropped. */
  report(r: TabReport): void {
    if (r.visible !== undefined) this.hidden = !r.visible;
    if (!this.active || r.token !== this.token) return;
    const at = this.now();
    this.lastContact = at;
    if (r.type === 'position') {
      if (r.queueId === this.cur) this.reported = { positionMs: r.positionMs, at };
      return;
    }
    if (r.type === 'failed') {
      this.fact({ type: 'failed', token: this.token, queueId: r.queueId, reason: 'output-failed', message: r.message, at });
      this.active = false;
      this.disarm();
      return;
    }
    if (!this.run.includes(r.queueId)) return;
    switch (r.type) {
      case 'started':
        this.cur = r.queueId;
        this.playing = true;
        this.reported = { positionMs: r.positionMs, at };
        this.fact({ type: 'started', token: this.token, queueId: r.queueId, positionMs: r.positionMs, at, ...(r.durationMs ? { durationMs: r.durationMs } : {}) });
        return;
      case 'ended': {
        if (r.queueId !== this.cur) return;
        const last = this.run.at(-1) === r.queueId;
        this.fact({ type: 'ended', token: this.token, queueId: r.queueId, at, last });
        if (last) {
          this.active = false;
          this.cur = null;
          this.disarm();
        }
        return;
      }
      case 'paused':
        if (r.queueId !== this.cur) return;
        this.playing = false;
        this.reported = { positionMs: r.positionMs, at };
        this.fact({ type: 'paused', token: this.token, queueId: r.queueId, positionMs: r.positionMs, at });
        return;
      case 'resumed':
        if (r.queueId !== this.cur) return;
        this.playing = true;
        this.reported = { positionMs: r.positionMs, at };
        this.fact({ type: 'resumed', token: this.token, queueId: r.queueId, positionMs: r.positionMs, at });
        return;
    }
  }

  private fact(f: OutputFact): void {
    for (const fn of this.facts) fn(f);
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.watch(), Math.max(50, Math.min(this.startTimeoutMs, 5_000)));
    this.timer.unref?.();
  }

  private disarm(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Nobody answered a start of a page that is on screen, or the tab has been gone for 30 minutes: the zone pauses with a reason. */
  private watch(): void {
    if (!this.active) return;
    const at = this.now();
    const waited = at - this.lastContact;
    const starting = this.cur === null;
    const dead = starting ? !this.hidden && waited > this.startTimeoutMs && waited > 0 : this.playing && waited > this.goneMs;
    if (!dead) return;
    this.fact({
      type: 'failed',
      token: this.token,
      queueId: this.cur,
      reason: 'output-failed',
      message: starting ? 'No rune page answered to play this: open rune in this browser and press Play.' : 'This browser has been gone for a long time: playback paused.',
      at,
    });
    this.active = false;
    this.disarm();
  }
}
