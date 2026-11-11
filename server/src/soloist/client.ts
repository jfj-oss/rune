// A client for Spotify Soloist's local WebSocket API (developer.spotify.com/documentation/soloist/reference/websocket-api).
//
// Soloist is Spotify's official headless Connect client. Everything rune needs from it comes over this socket: commands
// (`{"type":"command","command":"play","uri":…}`) and events (`playback_state`, `track_changed`, `position_sync`, …).
// Nothing here touches the Spotify Web API, so a Soloist zone costs no quota at all.
//
// The socket has no authentication: Soloist must bind 127.0.0.1 only, and this client only ever connects to ws://127.0.0.1.
// Node 22's global WebSocket is used; tests point it at a fake Soloist (a Fastify websocket route).

export type SoloistStatus = 'idle' | 'playing' | 'paused' | 'buffering';

/** The common entity envelope: a track, album, playlist, … with the decorations Soloist knows about. */
export interface SoloistEntity {
  uri: string;
  entity_type: string;
  decorations?: {
    identity?: { name?: string };
    visual_identity?: { cover?: { url: string; size?: string }[] };
    parent?: { entity?: SoloistEntity };
    creators?: { entity?: SoloistEntity }[];
    playback?: { duration_ms?: number; content_ratings?: string[] };
  };
}

export interface SoloistPosition {
  position_ms: number;
  timestamp_ms: number;
  speed: number;
}

export interface SoloistPlaybackState {
  type: 'playback_state';
  status: SoloistStatus;
  item?: SoloistEntity | null;
  context?: SoloistEntity | null;
  position?: SoloistPosition;
  volume?: number;
  is_active?: boolean;
  options?: { shuffle?: boolean; repeat?: 'off' | 'context' | 'track'; playback_speed?: number };
}

export interface SoloistQueueEntry {
  uid: string;
  source: 'context' | 'queue' | 'autoplay' | string;
  item: SoloistEntity;
}

export type SoloistEvent =
  | { type: 'auth_state'; logged_in: boolean; is_active: boolean; device_name: string }
  | SoloistPlaybackState
  | { type: 'track_changed'; item: SoloistEntity }
  | { type: 'playback_changed'; status: SoloistStatus }
  | { type: 'volume_changed'; volume: number }
  | { type: 'device_changed'; is_active: boolean; device_name: string }
  | { type: 'context_changed'; context: SoloistEntity }
  | { type: 'options_changed'; options: NonNullable<SoloistPlaybackState['options']> }
  | { type: 'position_sync'; position: SoloistPosition }
  | { type: 'queue_changed'; previous: SoloistQueueEntry[]; upcoming: SoloistQueueEntry[] }
  | { type: 'command_result'; command: string }
  | { type: 'error'; message: string };

export type SoloistCommand =
  | { command: 'get_auth_state' | 'get_state' | 'pause' | 'skip_next' | 'skip_prev' | 'activate' | 'deactivate' }
  | { command: 'get_queue'; limit?: number }
  | { command: 'play'; uri?: string }
  | { command: 'seek'; position_ms: number }
  | { command: 'set_volume'; volume: number }
  | { command: 'set_shuffle' | 'set_repeat_context' | 'set_repeat_track'; enabled: boolean }
  | { command: 'add_to_queue'; uri: string };

/** What this client knows about Soloist right now, kept up to date from the events. */
export interface SoloistView {
  connected: boolean;
  loggedIn: boolean;
  isActive: boolean;
  deviceName: string;
  status: SoloistStatus;
  item: SoloistEntity | null;
  position: SoloistPosition | null;
  volume: number;
  shuffle: boolean;
  repeat: 'off' | 'context' | 'track';
}

/** The pieces of the global WebSocket this client uses (tests may hand in their own constructor). */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'close' | 'error' | 'message', fn: (ev: { data?: unknown }) => void): void;
}
export type SocketCtor = new (url: string) => SocketLike;

export interface SoloistClientOptions {
  /** ws://127.0.0.1:PORT */
  url: string;
  socket?: SocketCtor;
  now?: () => number;
  /** Reconnect delays: first retry after `reconnectMs`, doubling up to `reconnectMaxMs`. */
  reconnectMs?: number;
  reconnectMaxMs?: number;
  /** A command_result (or error) must come back within this long (default 5 s). */
  commandTimeoutMs?: number;
  log?: (obj: Record<string, unknown>, msg: string) => void;
}

const QUERY_COMMANDS = new Set(['get_auth_state', 'get_state', 'get_queue']);

export class SoloistClient {
  private socket: SocketLike | null = null;
  private closed = false;
  private retry = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(ev: SoloistEvent) => void>();
  private readonly viewListeners = new Set<(v: SoloistView) => void>();
  /** Control commands waiting for their command_result / error, oldest first (Soloist answers in order). */
  private readonly pending: { command: string; resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  private readonly now: () => number;
  private readonly Socket: SocketCtor;
  view: SoloistView = { connected: false, loggedIn: false, isActive: false, deviceName: '', status: 'idle', item: null, position: null, volume: 100, shuffle: false, repeat: 'off' };

  constructor(private readonly opts: SoloistClientOptions) {
    this.now = opts.now ?? Date.now;
    const ctor = opts.socket ?? (globalThis as { WebSocket?: SocketCtor }).WebSocket;
    if (!ctor) throw new Error('no WebSocket implementation available');
    this.Socket = ctor;
    if (!/^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/.test(opts.url)) throw new Error('Soloist must be reached on the loopback interface only');
  }

  /** Open the socket (and keep it open: reconnects with backoff until close()). */
  connect(): void {
    if (this.closed || this.socket) return;
    let ws: SocketLike;
    try {
      ws = new this.Socket(this.opts.url);
    } catch (err) {
      this.scheduleReconnect();
      this.opts.log?.({ err: String(err) }, 'soloist socket failed to open');
      return;
    }
    this.socket = ws;
    ws.addEventListener('open', () => {
      this.retry = 0;
      this.setView({ connected: true });
      // auth_state (and playback_state when logged in) arrive on their own; ask once anyway in case the build is older.
      try { ws.send(JSON.stringify({ type: 'command', command: 'get_auth_state' })); } catch { /* closing */ }
    });
    ws.addEventListener('message', (m) => this.onMessage(String(m.data ?? '')));
    ws.addEventListener('close', () => this.onClose(ws));
    // Node's built-in WebSocket (undici): an error before the socket opened (Soloist not listening yet) fires no 'close',
    // and close() inside this handler re-fires 'error' until the stack overflows, so the retry never happened. Treat a
    // pre-open error as the close; only an open socket is closed here.
    ws.addEventListener('error', () => {
      if (ws.readyState === 1) { try { ws.close(); } catch { /* already closed */ } } else this.onClose(ws);
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.socket;
    this.socket = null;
    try { ws?.close(); } catch { /* already closed */ }
    this.failPending(new Error('Soloist client closed'));
    this.setView({ connected: false });
  }

  onEvent(fn: (ev: SoloistEvent) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  onView(fn: (v: SoloistView) => void): () => void {
    this.viewListeners.add(fn);
    return () => { this.viewListeners.delete(fn); };
  }

  /** Send a command. Control commands resolve on command_result and reject on Soloist's error; queries resolve at once. */
  send(cmd: SoloistCommand): Promise<void> {
    const ws = this.socket;
    if (!ws || ws.readyState !== 1 || !this.view.connected) return Promise.reject(new Error('Soloist is not connected'));
    const text = JSON.stringify({ type: 'command', ...cmd });
    if (QUERY_COMMANDS.has(cmd.command)) {
      ws.send(text);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.pending.findIndex((p) => p.timer === timer);
        if (i >= 0) this.pending.splice(i, 1);
        reject(new Error(`Soloist did not answer ${cmd.command}`));
      }, this.opts.commandTimeoutMs ?? 5000);
      this.pending.push({ command: cmd.command, resolve, reject, timer });
      try {
        ws.send(text);
      } catch (err) {
        clearTimeout(timer);
        this.pending.pop();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Where the song is now, from the last position anchor (null when nothing is loaded). */
  positionMs(at = this.now()): number | null {
    const p = this.view.position;
    if (!p) return null;
    const speed = this.view.status === 'playing' ? (p.speed || 1) : p.speed;
    return Math.max(0, Math.round(p.position_ms + (speed > 0 ? (at - p.timestamp_ms) * speed : 0)));
  }

  // ----- internals -----

  private onMessage(text: string): void {
    let ev: SoloistEvent;
    try {
      ev = JSON.parse(text) as SoloistEvent;
    } catch {
      return;
    }
    if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return;
    switch (ev.type) {
      case 'auth_state':
        this.setView({ loggedIn: !!ev.logged_in, isActive: !!ev.is_active, deviceName: ev.device_name ?? '' });
        break;
      case 'playback_state':
        this.setView({
          status: ev.status,
          item: ev.item ?? null,
          position: ev.position ?? null,
          volume: typeof ev.volume === 'number' ? ev.volume : this.view.volume,
          isActive: ev.is_active ?? this.view.isActive,
          shuffle: ev.options?.shuffle ?? this.view.shuffle,
          repeat: ev.options?.repeat ?? this.view.repeat,
        });
        break;
      case 'track_changed':
        this.setView({ item: ev.item });
        break;
      case 'playback_changed':
        this.setView({ status: ev.status });
        break;
      case 'volume_changed':
        this.setView({ volume: ev.volume });
        break;
      case 'device_changed':
        this.setView({ isActive: !!ev.is_active, deviceName: ev.device_name ?? this.view.deviceName });
        break;
      case 'options_changed':
        this.setView({ shuffle: ev.options?.shuffle ?? this.view.shuffle, repeat: ev.options?.repeat ?? this.view.repeat });
        break;
      case 'position_sync':
        this.setView({ position: ev.position });
        break;
      case 'command_result': {
        const i = this.pending.findIndex((p) => p.command === ev.command);
        if (i >= 0) {
          const [p] = this.pending.splice(i, 1);
          clearTimeout(p!.timer);
          p!.resolve();
        }
        break;
      }
      case 'error': {
        // Errors go to the originating client only and carry no command name: the oldest waiting command takes it.
        const p = this.pending.shift();
        if (p) {
          clearTimeout(p.timer);
          p.reject(new Error(`Soloist: ${ev.message}`));
        }
        this.opts.log?.({ message: ev.message }, 'soloist error');
        break;
      }
      default:
        break;
    }
    for (const f of this.listeners) f(ev);
  }

  private onClose(ws: SocketLike): void {
    if (this.socket !== ws) return;
    this.socket = null;
    this.failPending(new Error('Soloist disconnected'));
    this.setView({ connected: false, loggedIn: false, status: 'idle', position: null });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const base = this.opts.reconnectMs ?? 1000;
    const delay = Math.min(this.opts.reconnectMaxMs ?? 15_000, base * 2 ** this.retry++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    (this.reconnectTimer as { unref?: () => void }).unref?.();
  }

  private failPending(err: Error): void {
    for (const p of this.pending.splice(0)) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  private setView(patch: Partial<SoloistView>): void {
    this.view = { ...this.view, ...patch };
    for (const f of this.viewListeners) f(this.view);
  }
}

/** The Spotify id of an entity URI: spotify:track:abc → abc. */
export function idOfUri(uri: string | undefined | null): string | null {
  if (!uri) return null;
  const parts = uri.split(':');
  return parts.length >= 3 && parts[1] === 'track' ? parts[2]! : null;
}
