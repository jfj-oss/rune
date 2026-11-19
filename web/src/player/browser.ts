import type { PlayerState } from '@liner/shared';
import { api } from '../api';
import type { ExtCommand, PlayItem } from '../lib/types';
import type { Engine } from './engine';
import type { TabChannel } from './oneTab';
import { RemoteBackend } from './remote';
import { TabPlayer } from './tabPlayer';
import type { Backend, PlayModes } from './types';

/** A command that makes this tab the one that sounds the zone (the tab the user pressed Play in). */
export function startsSoundHere(cmd: ExtCommand, state: PlayerState): boolean {
  switch (cmd.type) {
    case 'play':
    case 'resume':
    case 'next':
    case 'prev':
    case 'jump':
      return true;
    // Adding to a queue that is playing elsewhere must not pull the sound over; into an empty or stopped one it starts it.
    case 'enqueue':
      return state.queue.length === 0 || state.status === 'stopped';
    default:
      return false;
  }
}

/**
 * The browser zone: this browser's queue lives on the server (zone "browser:<id>"), exactly like the PC's. This page
 * shows it and sends the buttons; the tab that pressed Play also sounds it, through the audio engine (TabPlayer).
 */
export class BrowserBackend implements Backend {
  private readonly remote: RemoteBackend;
  private readonly player: TabPlayer;
  private readonly off: () => void;
  private unhook: () => void = () => {};

  constructor(
    readonly zone: string,
    engine: Engine,
    deps: { notice(message: string): void; channel: TabChannel | null },
  ) {
    this.remote = new RemoteBackend(zone);
    this.player = new TabPlayer(zone, engine, {
      report: (r) => api.tabReport(zone, r),
      setVolume: (volume) => void this.remote.send({ type: 'volume', volume }).catch(() => undefined),
      notice: deps.notice,
      visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
      refresh: () => this.remote.refresh(),
      channel: deps.channel,
    });
    this.off = this.remote.subscribe((s) => this.player.apply(s));
    // Timers and fetches of a locked or hidden page are suspended while its audio goes on: whenever the page can speak
    // again, or is about to be frozen, it tells the server where it is and catches up.
    const sync = () => void this.player.sync().catch(() => undefined);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', sync);
      window.addEventListener('pagehide', sync);
      this.unhook = () => { document.removeEventListener('visibilitychange', sync); window.removeEventListener('pagehide', sync); };
    }
  }

  get state(): PlayerState { return this.remote.state; }
  get ready(): boolean { return this.remote.ready; }
  /** Does this tab sound the zone right now? */
  get hosting(): boolean { return this.player.isHosting; }
  subscribe(fn: (s: PlayerState) => void) { return this.remote.subscribe(fn); }
  refresh() { return this.remote.refresh(); }
  matchModes(want: PlayModes) { return this.remote.matchModes(want); }

  async send(cmd: ExtCommand, items?: PlayItem[]): Promise<void> {
    if (startsSoundHere(cmd, this.remote.state)) this.player.claim();
    await this.remote.send(cmd, items);
    // (a lock-screen next/previous lands here too: the answer was applied above; say where this page is now)
    if (cmd.type === 'next' || cmd.type === 'prev') void this.player.sync().catch(() => undefined);
  }

  dispose(): void {
    this.off();
    this.unhook();
    this.player.dispose();
    this.remote.dispose();
  }
}
