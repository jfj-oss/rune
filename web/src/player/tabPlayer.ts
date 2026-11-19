import type { PlayerState, QueueItem, TabReport } from '@liner/shared';
import type { Engine } from './engine';
import type { TabChannel } from './oneTab';
import { livePosition } from './types';

/** A report without its token (the player adds the token of the instruction it is following). */
type TabReportBody = TabReport extends infer R ? (R extends TabReport ? Omit<R, 'token'> : never) : never;

/** How often the sounding tab tells the server where its player is (the server pauses a zone whose tab fell silent). */
export const HEARTBEAT_MS = 8_000;
/** After the tab told its engine to load/play/pause, the engine's own reports of that moment are not a decision of its own. */
const QUIET_MS = 2_500;

export interface TabPlayerDeps {
  /** Send one report to the server (serialised by the player: they arrive in the order they were made). */
  report(r: TabReport): Promise<unknown>;
  /** The engine's own level changed (Soloist heard on the phone keeps its own): tell the server queue. */
  setVolume(volume: number): void;
  notice(message: string): void;
  /** Is this page on screen? (reports say so: a hidden page may go quiet without being gone) */
  visible?(): boolean;
  /** Re-read the server's state (after a lock or a missed push); resolves once it was applied. */
  refresh?(): Promise<void>;
  channel: TabChannel | null;
}

/**
 * The tab behind a browser zone. It holds NO queue: the server's queue says which song plays, whether it should sound
 * and where (PlayerState + `tab`), and this class only makes the engine (the <audio> element, Soloist on a phone) do that, then reports what the engine did. One thing it decides by itself: when a song ends it goes on to the
 * next one of the server's `run` at once (gapless, no round trip), and says so.
 */
export class TabPlayer {
  private hosting = false;
  private state: PlayerState | null = null;
  /** The last start instruction carried out. */
  private applied: { token: number; loadV: number; seekV: number } | null = null;
  /** The queue entry the engine holds. */
  private loaded: string | null = null;
  /** Whether the engine was last told to sound. */
  private sounding = false;
  private volume = -1;
  private runKey = '';
  private reports: Promise<unknown> = Promise.resolve();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private adopting = false;
  private quietUntil = 0;
  private unsent: TabReport[] = [];

  constructor(
    readonly zone: string,
    private readonly engine: Engine,
    private readonly deps: TabPlayerDeps,
  ) {
    engine.onEnded(() => this.ended());
    engine.onError((m) => this.failed(m));
    engine.onSync?.((pos, playing) => this.engineSync(pos, playing));
    engine.onVolume?.((v) => this.engineVolume(v));
    deps.channel?.onClaimedElsewhere(() => this.letGo());
    deps.channel?.onAsked(() => this.hosting && this.loaded !== null && this.sounding);
  }

  get isHosting(): boolean {
    return this.hosting;
  }

  /** This tab sounds the zone from now on (a command of its own started playback). */
  claim(): void {
    if (this.hosting) return;
    this.hosting = true;
    this.deps.channel?.claimed();
    this.startHeartbeat();
    if (this.state) this.reconcile(this.state);
  }

  dispose(): void {
    this.letGo();
    this.deps.channel?.close();
  }

  /** The server's state for this zone. */
  apply(s: PlayerState): void {
    const first = this.state === null;
    this.state = s;
    if (this.hosting) {
      this.reconcile(s);
      return;
    }
    // A page that opens (or reloads) while the zone plays takes it over, unless another tab of this browser sounds it.
    if (first && !this.adopting && (s.status === 'playing' || s.status === 'loading') && s.tab) {
      this.adopting = true;
      void (this.deps.channel ? this.deps.channel.anyoneSounding() : Promise.resolve(false)).then((other) => {
        this.adopting = false;
        if (!other && !this.hosting) this.claim();
      });
    }
  }

  // ------------------------------------------------------------------ the engine follows the server

  private reconcile(s: PlayerState): void {
    const cur = s.queue[s.index];
    const plan = s.tab;
    if (s.volume !== this.volume) {
      this.volume = s.volume;
      this.engine.setVolume(s.volume);
    }
    if (!cur || !plan || s.status === 'stopped') {
      this.silence();
      return;
    }
    const wantsSound = s.status === 'playing' || s.status === 'loading';
    const fresh = !this.applied || this.applied.token !== plan.token || this.applied.loadV !== plan.loadV;
    // The server is still starting a song (its new instruction follows): nothing to do yet.
    if (s.status === 'loading' && !fresh) return;
    if (fresh || (this.loaded !== cur.queueId && wantsSound)) {
      this.applied = { token: plan.token, loadV: plan.loadV, seekV: plan.seekV };
      if (!wantsSound) return this.silence();
      this.load(cur, s.status === 'playing' ? livePosition(s) : s.positionMs, s);
      return;
    }
    if (this.loaded !== cur.queueId) {
      // Paused on a song this engine does not hold: nothing to hold until Play.
      this.silence();
      return;
    }
    if (this.applied && this.applied.seekV !== plan.seekV) {
      this.applied.seekV = plan.seekV;
      this.engine.seek(s.positionMs);
    }
    const key = plan.run.join(',');
    if (key !== this.runKey) {
      this.runKey = key;
      this.engine.setUpcoming?.(this.after(s, cur.queueId).map((q) => q.track));
    }
    if (wantsSound && !this.sounding) {
      this.sounding = true;
      this.quietUntil = Date.now() + QUIET_MS;
      this.engine.play();
    } else if (s.status === 'paused' && this.sounding) {
      this.sounding = false;
      this.quietUntil = Date.now() + QUIET_MS;
      this.engine.pause();
    }
  }

  /** The songs after `queueId` in the server's run (what the engine may buffer ahead). */
  private after(s: PlayerState, queueId: string): QueueItem[] {
    const run = s.tab?.run ?? [];
    const at = run.indexOf(queueId);
    if (at < 0) return [];
    return run.slice(at + 1, at + 21).map((id) => s.queue.find((q) => q.queueId === id)).filter((q): q is QueueItem => !!q);
  }

  private load(cur: QueueItem, positionMs: number, s: PlayerState): void {
    this.loaded = cur.queueId;
    this.sounding = true;
    this.runKey = s.tab?.run.join(',') ?? '';
    this.quietUntil = Date.now() + QUIET_MS;
    this.engine.load(cur.track, positionMs, true, this.after(s, cur.queueId).map((q) => q.track));
    this.send({ type: 'started', queueId: cur.queueId, positionMs: Math.round(positionMs) });
  }

  private silence(): void {
    if (this.loaded !== null || this.sounding) this.engine.stop();
    this.loaded = null;
    this.sounding = false;
    this.applied = null;
    this.runKey = '';
  }

  private letGo(): void {
    this.hosting = false;
    this.stopHeartbeat();
    this.silence();
  }

  // ------------------------------------------------------------------ the engine tells

  private ended(): void {
    const s = this.state;
    const qid = this.loaded;
    if (!s || !qid || !this.hosting) return;
    this.send({ type: 'ended', queueId: qid });
    const run = s.tab?.run ?? [];
    const nextId = run[run.indexOf(qid) + 1];
    const next = nextId ? s.queue.find((q) => q.queueId === nextId) : undefined;
    if (!next) {
      // The last song of the run: the server decides what comes next and starts it with a new instruction.
      this.loaded = null;
      this.sounding = false;
      return;
    }
    this.load(next, 0, s);
  }

  private failed(message: string): void {
    const qid = this.loaded;
    if (!qid || !this.hosting) return;
    this.sounding = false;
    this.deps.notice(message);
    this.send({ type: 'failed', queueId: qid, message });
  }

  /** The player behind the engine moved by itself (Soloist on the phone). */
  private engineSync(positionMs: number, playing: boolean): void {
    const qid = this.loaded;
    // A player that is still starting (or was just told to play/pause) reports in-between states: not its own decision.
    if (!qid || !this.hosting || playing === this.sounding || Date.now() < this.quietUntil) return;
    this.sounding = playing;
    this.send({ type: playing ? 'resumed' : 'paused', queueId: qid, positionMs: Math.round(positionMs) });
  }

  private engineVolume(volume: number): void {
    if (volume === this.volume) return;
    this.volume = volume;
    this.deps.setVolume(volume);
  }

  // ------------------------------------------------------------------ reports

  private send(r: TabReportBody): void {
    const plan = this.state?.tab;
    if (!plan) return;
    const report = { ...r, token: plan.token, ...(this.deps.visible ? { visible: this.deps.visible() } : {}) } as TabReport;
    this.reports = this.reports
      .then(() => this.deps.report(report))
      .catch(() => {
        // A fetch a locked phone refused: keep it, in order, for the next time this page can speak (sync).
        if (report.type !== 'position') { this.unsent.push(report); if (this.unsent.length > 20) this.unsent.shift(); }
      });
  }

  /**
   * The page can speak again (unlock, visibility change, page hide, a media-key command) or is about to go quiet: send what
   * the server missed, in order, then where the player is now, then catch up with the server's state. The tab never
   * depends on a timer for any of this: song ends are handled when the audio element says so.
   */
  async sync(): Promise<void> {
    if (!this.hosting) { await this.deps.refresh?.(); return; }
    const missed = this.unsent.splice(0);
    for (const r of missed) await this.deps.report(r).catch(() => { this.unsent.push(r); });
    const qid = this.loaded;
    const s = this.state;
    if (qid && this.sounding && s) {
      // The truth of this page: what it sounds. (If the server missed song ends meanwhile, this moves its cursor here.)
      const pos = this.engine.position() ?? livePosition(s);
      const plan = s.tab;
      if (plan && s.queue[s.index]?.queueId !== qid) this.send({ type: 'started', queueId: qid, positionMs: Math.round(pos) });
      else this.send({ type: 'position', queueId: qid, positionMs: Math.round(pos) });
    }
    await this.reports;
    await this.deps.refresh?.();
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      const qid = this.loaded;
      const s = this.state;
      if (!qid || !this.sounding || !s) return;
      const pos = this.engine.position() ?? livePosition(s);
      this.send({ type: 'position', queueId: qid, positionMs: Math.round(pos) });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
