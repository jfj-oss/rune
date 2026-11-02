import type { PlayerState, ScanProgress, ServerEvent } from '@liner/shared';
import { api } from '../api';
import type { ExtCommand, PlayItem } from '../lib/types';
import { emptyState, livePosition, type Backend } from './types';
import type { ZoneTransport } from './zoneEngine';

type Listener = (e: ServerEvent) => void;

/** One shared websocket (/api/ws) with backoff reconnect; fans events out to listeners. */
class Socket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private retry = 0;
  private closed = false;
  connected = false;

  on(fn: Listener) {
    this.listeners.add(fn);
    if (!this.ws) this.open();
    return () => { this.listeners.delete(fn); };
  }
  private open() {
    if (this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/ws`);
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.connected = true; };
    ws.onmessage = (m) => {
      try {
        const ev = JSON.parse(String(m.data)) as ServerEvent;
        for (const f of this.listeners) f(ev);
      } catch { /* ignore malformed */ }
    };
    ws.onclose = () => {
      this.connected = false;
      this.ws = null;
      if (this.closed || !this.listeners.size) return;
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.open(), delay);
    };
    ws.onerror = () => ws.close();
  }
}
export const socket = new Socket();

export type { ScanProgress };

/** A zone controlled on the server (pc via mpv, or a Spotify Connect device). */
export class RemoteBackend implements Backend {
  state: PlayerState;
  private subs = new Set<(s: PlayerState) => void>();
  private off: () => void;

  constructor(readonly zone: string) {
    this.state = emptyState(zone);
    this.off = socket.on((e) => {
      if (e.type === 'player' && e.state.zone === this.zone) this.apply(e.state);
    });
    void this.refresh();
  }
  subscribe(fn: (s: PlayerState) => void) {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }
  private apply(s: PlayerState) {
    this.state = s;
    for (const f of this.subs) f(s);
  }
  async refresh() {
    try { this.apply(await api.playerState(this.zone)); } catch { /* server offline; keep last */ }
  }
  dispose() { this.off(); this.subs.clear(); }

  async send(cmd: ExtCommand, _items?: PlayItem[]): Promise<void> {
    const s = this.state;
    const now = Date.now();
    // optimistic bits so sliders and buttons feel immediate
    if (cmd.type === 'seek') this.apply({ ...s, positionMs: cmd.positionMs, updatedAt: now });
    else if (cmd.type === 'volume') this.apply({ ...s, volume: cmd.volume });
    else if (cmd.type === 'pause') this.apply({ ...s, status: 'paused', positionMs: livePosition(s, now), updatedAt: now });
    else if (cmd.type === 'resume') this.apply({ ...s, status: 'playing', updatedAt: now });
    else if (cmd.type === 'shuffle') this.apply({ ...s, shuffle: cmd.on });
    else if (cmd.type === 'repeat') this.apply({ ...s, repeat: cmd.mode });
    try {
      if (cmd.type === 'clear') {
        let last = s;
        for (const q of s.queue) last = await api.playerSend(this.zone, { type: 'remove', queueId: q.queueId });
        this.apply(last);
        return;
      }
      this.apply(await api.playerSend(this.zone, cmd));
    } catch (e) {
      await this.refresh();
      throw e;
    }
  }
}

/** Talk to one server zone directly (the pc zone's hybrid mode drives mpv and the Spotify app this way). */
export function zoneTransport(zone: string): ZoneTransport {
  return {
    send: (cmd) => api.playerSend(zone, cmd),
    get: () => api.playerState(zone),
    subscribe: (fn) => socket.on((e) => { if (e.type === 'player' && e.state.zone === zone) fn(e.state); }),
  };
}
