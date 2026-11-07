import type { ClientEvent, PlayerState, ScanProgress, ServerEvent } from '@liner/shared';
import { api } from '../api';
import type { ExtCommand, PlayItem } from '../lib/types';
import { setSdkReporter } from './spotifySdk';
import { emptyState, livePosition, type Backend } from './types';
import type { ZoneTransport } from './zoneEngine';

type Listener = (e: ServerEvent) => void;

/** One shared websocket (/api/ws) with backoff reconnect; fans events out to listeners. */
class Socket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private retry = 0;
  private closed = false;
  private everOpen = false;
  private reconnectFns = new Set<() => void>();
  connected = false;

  /** Called after the socket comes back (server restart, network blip): events were missed meanwhile. */
  onReconnect(fn: () => void) {
    this.reconnectFns.add(fn);
    return () => { this.reconnectFns.delete(fn); };
  }

  on(fn: Listener) {
    this.listeners.add(fn);
    if (!this.ws) this.open();
    return () => { this.listeners.delete(fn); };
  }
  private emit(ev: ServerEvent) {
    for (const f of this.listeners) f(ev);
  }

  /** Send a client → server message; silently drops when the socket is not open (mock mode has none). */
  send(ev: ClientEvent) {
    const ws = this.ws;
    if (this.closed || !ws || typeof ws.send !== 'function') return;
    // 1 = OPEN (the stub in the socket tests has no readyState at all)
    if (typeof ws.readyState === 'number' && ws.readyState !== 1) return;
    try { ws.send(JSON.stringify(ev)); } catch { /* closing */ }
  }

  /** A hidden tab (background, other Space) is not watching. */
  sendPresence() {
    const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
    this.send({ type: 'presence', visible });
  }

  /** Last full queue per zone and its fingerprint, to fill in slim player events. */
  private queues = new Map<string, { rev: string; queue: PlayerState['queue'] }>();
  private fetching = new Set<string>();
  private restoreQueue(ev: Extract<ServerEvent, { type: 'player' }>) {
    const zone = ev.state.zone;
    if (Array.isArray(ev.state.queue)) {
      if (ev.queueRev) this.queues.set(zone, { rev: ev.queueRev, queue: ev.state.queue });
      this.emit(ev);
      return;
    }
    const known = this.queues.get(zone);
    if (known && known.rev === ev.queueRev) {
      this.emit({ ...ev, state: { ...ev.state, queue: known.queue } });
      return;
    }
    // a queue we never saw (joined mid-way, or missed an event): fetch the full state once
    if (this.fetching.has(zone)) return;
    this.fetching.add(zone);
    void api.playerState(zone)
      .then((state) => {
        if (ev.queueRev) this.queues.set(zone, { rev: ev.queueRev, queue: state.queue });
        this.emit({ type: 'player', state, queueRev: ev.queueRev });
      })
      .catch(() => undefined)
      .finally(() => this.fetching.delete(zone));
  }

  private open() {
    if (this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // slim=1: player events leave out an unchanged queue (see restoreQueue)
    const ws = new WebSocket(`${proto}://${location.host}/api/ws?slim=1`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.connected = true;
      this.sendPresence();
      if (this.everOpen) for (const f of this.reconnectFns) f();
      this.everOpen = true;
    };
    ws.onmessage = (m) => {
      try {
        const ev = JSON.parse(String(m.data)) as ServerEvent;
        if (ev.type === 'player') { this.restoreQueue(ev); return; }
        this.emit(ev);
      } catch { /* ignore malformed */ }
    };
    ws.onclose = () => {
      this.connected = false;
      this.queues.clear(); // events were missed: the next one for each zone must carry or fetch the queue
      this.ws = null;
      if (this.closed || !this.listeners.size) return;
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.open(), delay);
    };
    ws.onerror = () => ws.close();
  }
}
export const socket = new Socket();

// The Spotify SDK engine reports its local state through this socket (it never imports the socket).
setSdkReporter((report) => socket.send(report));

// Tabs in the background do not count as watching: tell the server whenever visibility changes.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => socket.sendPresence());
}

export type { ScanProgress };

/** A zone controlled on the server (pc via mpv, or a Spotify Connect device). */
export class RemoteBackend implements Backend {
  state: PlayerState;
  ready = false;
  private subs = new Set<(s: PlayerState) => void>();
  private off: () => void;
  private offReconnect: () => void;

  constructor(readonly zone: string) {
    this.state = emptyState(zone);
    this.off = socket.on((e) => {
      if (e.type === 'player' && e.state.zone === this.zone) this.apply(e.state);
    });
    // Re-read the state (this also makes the server watch the zone again after a restart).
    this.offReconnect = socket.onReconnect(() => void this.refresh());
    void this.refresh();
  }
  subscribe(fn: (s: PlayerState) => void) {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }
  private apply(s: PlayerState) {
    this.state = s;
    this.ready = true;
    for (const f of this.subs) f(s);
  }
  async refresh() {
    try { this.apply(await api.playerState(this.zone)); } catch { /* server offline; keep last */ }
  }
  dispose() { this.off(); this.offReconnect(); this.subs.clear(); }

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
    connected: () => socket.connected,
  };
}
