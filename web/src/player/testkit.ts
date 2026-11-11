// Test doubles for the pc zone: a fake server zone (what mpv / the Spotify app would report).
import type { PlayerCommand, PlayerState, QueueItem, Track } from '@liner/shared';
import type { PlayItem } from '../lib/types';
import { emptyState } from './types';
import type { ZoneTransport } from './zoneEngine';

export const mkTrack = (id: string, source: 'local' | 'spotify', durationMs = 200_000): Track => ({
  id, albumId: source === 'spotify' ? 'sp:alb' : 'la:alb', source, title: id, artists: [{ id: 'ar:1', name: 'A' }], disc: 1, number: 1, durationMs,
  ...(source === 'spotify' ? { spotifyUri: `spotify:track:${id.slice(3)}` } : {}),
});
export const mkItem = (t: Track): PlayItem => ({ track: t, album: { id: t.albumId, title: 'Alb' } });

/** A server zone holding the queue it was last given. */
export class FakeZone implements ZoneTransport {
  state: PlayerState;
  log: string[] = [];
  private subs = new Set<(s: PlayerState) => void>();
  private clock = 1_000;
  fail = false;
  /** No push channel by default: the engine then polls at `pollMs`. */
  connected: (() => boolean) | undefined = () => false;
  constructor(public id: string) { this.state = emptyState(id); }

  private bump(patch: Partial<PlayerState>) {
    this.state = { ...this.state, ...patch, updatedAt: (this.clock = Math.max(this.clock + 1, Date.now())) };
    for (const f of this.subs) f(this.state);
  }
  async send(cmd: PlayerCommand): Promise<PlayerState> {
    this.log.push(cmd.type === 'play' ? `play:${cmd.trackIds.join(',')}@${cmd.positionMs ?? 0}${cmd.paused ? ':paused' : ''}` : cmd.type === 'seek' ? `seek:${cmd.positionMs}` : cmd.type === 'volume' ? `volume:${cmd.volume}` : cmd.type);
    if (this.fail) throw new Error('boom');
    switch (cmd.type) {
      case 'play': {
        const queue: QueueItem[] = cmd.trackIds.map((id, i) => ({ queueId: `${this.id}:${i}:${id}`, track: mkTrack(id, id.startsWith('sp:') ? 'spotify' : 'local'), album: { id: 'a', title: 'Alb' } }));
        this.bump({ queue, index: cmd.startIndex ?? 0, status: cmd.paused ? 'paused' : 'playing', positionMs: cmd.positionMs ?? 0 });
        break;
      }
      case 'pause': this.bump({ status: 'paused' }); break;
      case 'resume': this.bump({ status: 'playing' }); break;
      case 'seek': this.bump({ positionMs: cmd.positionMs }); break;
      case 'volume': this.bump({ volume: cmd.volume }); break;
      case 'shuffle': this.bump({ shuffle: cmd.on }); break;
      case 'repeat': this.bump({ repeat: cmd.mode }); break;
      default: break;
    }
    return this.state;
  }
  async get() { return this.state; }
  subscribe(fn: (s: PlayerState) => void) { this.subs.add(fn); return () => { this.subs.delete(fn); }; }

  // ----- the "world" acting on its own -----
  /** the track played to its end */
  finish() { this.bump({ status: 'stopped', positionMs: this.state.queue[this.state.index]?.track.durationMs ?? 0 }); }
  /** the Spotify way: it pauses and rewinds instead of reporting `stopped` */
  finishPaused() { this.bump({ status: 'paused', positionMs: 0 }); }
  progress(positionMs: number) { this.bump({ positionMs, status: 'playing' }); }
  externalPause() { this.bump({ status: 'paused' }); }
  /** Soloist went on with a song of its own when ours ended (autoplay): the server zone follows it as a new current item. */
  autoplay(id: string) {
    const item: QueueItem = { queueId: `${this.id}:auto:${id}`, track: mkTrack(id, 'spotify'), album: { id: 'sp:alb', title: 'Alb' } };
    const at = this.state.index + 1;
    this.bump({ queue: [...this.state.queue.slice(0, at), item, ...this.state.queue.slice(at)], index: at, status: 'playing', positionMs: 0 });
  }
  setUnknown() { this.bump({ queue: [], index: -1, status: 'stopped' }); }
}
