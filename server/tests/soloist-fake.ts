// A fake Spotify Soloist: its WebSocket API (commands in, events out) on a loopback port, with the small amount of
// player state the zone relies on. Not a test file. The real binary is never run by the tests.
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';

interface Socket { send(data: string): void }

export interface FakeSoloistOptions {
  loggedIn?: boolean;
  deviceName?: string;
  now?: () => number;
}

export class FakeSoloist {
  app: FastifyInstance;
  url = '';
  /** Every command received, in order (type + fields, without the "type":"command" envelope). */
  commands: Record<string, unknown>[] = [];
  loggedIn: boolean;
  deviceName: string;
  isActive = false;
  status: 'idle' | 'playing' | 'paused' | 'buffering' = 'idle';
  item: string | null = null;
  /** Soloist's own queue: track uris added with add_to_queue, next first. */
  queue: string[] = [];
  /** Spotify's autoplay: when the queue runs out, these play on (source "autoplay"), one after another. */
  autoplay: string[] = [];
  /** add_to_queue is acknowledged but the song never lands in the queue (a lost request): autoplay then follows. */
  dropQueue = false;
  /** Songs played before the current one, with where each came from (the `previous` of queue_changed). */
  previous: { uri: string; source: string }[] = [];
  /**
   * Another Connect device of the account is the active one (a browser tab's Web Playback SDK player, a Spotify app).
   * Like the real Soloist then: is_active is false, its events mirror that device's playback, and its control commands
   * act on that device. They are recorded in `remote`, and nothing sounds from Soloist until `activate`.
   */
  elsewhere = false;
  /** Control commands that went to the other device's session instead of to Soloist's own player. */
  remote: Record<string, unknown>[] = [];
  /** A build that keeps saying is_active: false although it plays (never seen; the zone must still not go silent). */
  claimsInactive = false;
  private currentSource = 'context';
  positionMs = 0;
  volume = 70;
  shuffle = false;
  repeat: 'off' | 'context' | 'track' = 'off';
  private sockets = new Set<Socket>();
  private readonly now: () => number;

  constructor(opts: FakeSoloistOptions = {}) {
    this.loggedIn = opts.loggedIn ?? true;
    this.deviceName = opts.deviceName ?? 'rune';
    this.now = opts.now ?? Date.now;
    this.app = Fastify({ logger: false });
  }

  async start(listenPort = 0): Promise<string> {
    await this.app.register(websocket);
    this.app.get('/', { websocket: true }, (socket) => {
      this.sockets.add(socket as unknown as Socket);
      socket.on('close', () => this.sockets.delete(socket as unknown as Socket));
      socket.on('message', (data: unknown) => this.onMessage(socket as unknown as Socket, String(data)));
      this.sendTo(socket as unknown as Socket, this.authState());
      if (this.loggedIn) this.sendTo(socket as unknown as Socket, this.playbackState());
    });
    await this.app.listen({ port: listenPort, host: '127.0.0.1' });
    const address = this.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    this.url = `ws://127.0.0.1:${port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    await this.app.close();
  }

  // ----- what a test can make Soloist do -----

  /** The current song ended by itself: Soloist moves to its own queue, then to autoplay, or goes idle. */
  finishTrack(): void {
    const queued = this.queue.shift();
    const next = queued ?? this.autoplay.shift();
    if (next) {
      if (this.item) this.previous.push({ uri: this.item, source: this.currentSource });
      this.currentSource = queued ? 'queue' : 'autoplay';
      this.item = next;
      this.positionMs = 0;
      this.broadcast({ type: 'track_changed', item: this.entity(next) });
      this.broadcast({ type: 'position_sync', position: this.position() });
      this.broadcast(this.queueChanged());
    } else {
      this.status = 'idle';
      this.item = null;
      this.broadcast({ type: 'playback_changed', status: 'idle' });
    }
  }

  /**
   * Another Connect device starts `uri` on ITS OWN speakers (Soloist goes silent and only mirrors it). `deviceFirst`:
   * whether device_changed comes before or after the song's own events (the zone must cope with both).
   */
  playsElsewhere(uri: string, opts: { deviceFirst?: boolean } = {}): void {
    const wasActive = this.isActive;
    this.elsewhere = true;
    this.isActive = false;
    this.item = uri;
    this.queue = [];
    this.previous = [];
    this.currentSource = 'context';
    this.status = 'playing';
    this.positionMs = 0;
    const device = () => { if (wasActive) this.broadcast({ type: 'device_changed', is_active: false, device_name: this.deviceName }); };
    if (opts.deviceFirst) device();
    this.broadcast({ type: 'track_changed', item: this.entity(uri) });
    this.broadcast({ type: 'playback_changed', status: 'playing' });
    this.broadcast({ type: 'position_sync', position: this.position() });
    this.broadcast(this.queueChanged());
    if (!opts.deviceFirst) device();
  }

  /** Soloist becomes the device that plays (its own play, `activate`, or picked in a Spotify app). */
  private becomeActive(): void {
    this.elsewhere = false;
    if (this.isActive) return;
    this.isActive = true;
    this.broadcast({ type: 'device_changed', is_active: true, device_name: this.deviceName });
  }

  /** Another Spotify app on the account started a song on Soloist (a context of its own: the queue is gone). */
  takeOver(uri: string): void {
    this.becomeActive();
    this.item = uri;
    this.queue = [];
    this.previous = [];
    this.currentSource = 'context';
    this.status = 'playing';
    this.positionMs = 0;
    this.broadcast({ type: 'track_changed', item: this.entity(uri) });
    this.broadcast({ type: 'playback_changed', status: 'playing' });
    this.broadcast(this.queueChanged());
  }

  /** Spotify fills in the autoplay songs for after the queue (Soloist announces them in queue_changed, as the live one does). */
  setAutoplay(uris: string[]): void {
    this.autoplay = uris;
    this.broadcast(this.queueChanged());
  }

  /** Play pressed in a Spotify app on this device (Soloist was paused). */
  resumeFromApp(): void {
    if (!this.item) return;
    this.status = 'playing';
    this.broadcast({ type: 'playback_changed', status: 'playing' });
    this.broadcast({ type: 'position_sync', position: this.position() });
  }

  /** Soloist is already playing `uri` when a client connects (rune restarted under it). */
  playing(uri: string): void {
    this.item = uri;
    this.status = 'playing';
    this.isActive = true;
    this.positionMs = 0;
  }

  setLoggedIn(on: boolean): void {
    this.loggedIn = on;
    this.broadcast(this.authState());
  }

  // ----- the protocol -----

  private onMessage(socket: Socket, text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return this.sendTo(socket, { type: 'error', message: 'malformed JSON' });
    }
    if (msg.type !== 'command' || typeof msg.command !== 'string') return this.sendTo(socket, { type: 'error', message: 'unknown message type' });
    const { type: _t, ...rest } = msg;
    this.commands.push(rest);
    const command = msg.command;
    if (command === 'get_auth_state') return this.sendTo(socket, this.authState());
    if (!this.loggedIn) return this.sendTo(socket, { type: 'error', message: 'command requires authentication' });
    // Not the active device: a control command remote-controls the device that is (as the live Soloist does).
    if (this.elsewhere && !this.isActive && !['get_state', 'get_queue', 'activate', 'deactivate'].includes(command)) {
      this.remote.push(rest);
      this.ok(socket, command);
      if (command === 'play' && typeof msg.uri === 'string') {
        this.item = msg.uri;
        this.positionMs = 0;
        this.status = 'playing';
        this.broadcast({ type: 'track_changed', item: this.entity(msg.uri) });
        this.broadcast({ type: 'playback_changed', status: 'playing' });
        this.broadcast({ type: 'position_sync', position: this.position() });
      }
      return;
    }
    switch (command) {
      case 'get_state':
        return this.sendTo(socket, this.playbackState());
      case 'get_queue':
        return this.sendTo(socket, this.queueChanged());
      case 'play': {
        const uri = typeof msg.uri === 'string' ? msg.uri : null;
        this.ok(socket, command);
        if (uri) {
          this.item = uri;
          this.positionMs = 0;
          this.queue = [];
          this.previous = [];
          this.currentSource = 'context';
          this.status = 'playing';
          this.becomeActive();
          this.broadcast({ type: 'track_changed', item: this.entity(uri) });
          this.broadcast({ type: 'playback_changed', status: 'playing' });
          this.broadcast({ type: 'position_sync', position: this.position() });
          this.broadcast(this.queueChanged());
        } else if (this.item) {
          this.status = 'playing';
          this.broadcast({ type: 'playback_changed', status: 'playing' });
          this.broadcast({ type: 'position_sync', position: this.position() });
        }
        return;
      }
      case 'pause':
        this.ok(socket, command);
        if (this.status === 'playing') {
          this.status = 'paused';
          this.broadcast({ type: 'playback_changed', status: 'paused' });
          this.broadcast({ type: 'position_sync', position: this.position() });
        }
        return;
      case 'skip_next':
        this.ok(socket, command);
        this.finishTrack();
        return;
      case 'skip_prev':
        this.ok(socket, command);
        this.positionMs = 0;
        this.broadcast({ type: 'position_sync', position: this.position() });
        return;
      case 'seek':
        if (typeof msg.position_ms !== 'number') return this.sendTo(socket, { type: 'error', message: 'position_ms required' });
        this.ok(socket, command);
        this.positionMs = msg.position_ms;
        this.broadcast({ type: 'position_sync', position: this.position() });
        return;
      case 'set_volume':
        if (typeof msg.volume !== 'number') return this.sendTo(socket, { type: 'error', message: 'volume required' });
        this.ok(socket, command);
        this.volume = msg.volume;
        this.broadcast({ type: 'volume_changed', volume: this.volume });
        return;
      case 'set_shuffle':
        this.ok(socket, command);
        this.shuffle = msg.enabled === true;
        this.broadcast({ type: 'options_changed', options: { shuffle: this.shuffle, repeat: this.repeat } });
        return;
      case 'set_repeat_context':
        this.ok(socket, command);
        this.repeat = msg.enabled === true ? 'context' : this.repeat === 'context' ? 'off' : this.repeat;
        this.broadcast({ type: 'options_changed', options: { shuffle: this.shuffle, repeat: this.repeat } });
        return;
      case 'set_repeat_track':
        this.ok(socket, command);
        this.repeat = msg.enabled === true ? 'track' : this.repeat === 'track' ? 'off' : this.repeat;
        this.broadcast({ type: 'options_changed', options: { shuffle: this.shuffle, repeat: this.repeat } });
        return;
      case 'add_to_queue':
        if (typeof msg.uri !== 'string' || !msg.uri.startsWith('spotify:track:')) return this.sendTo(socket, { type: 'error', message: 'add_to_queue takes a track uri' });
        this.ok(socket, command);
        if (this.dropQueue) return;
        this.queue.push(msg.uri);
        this.broadcast(this.queueChanged());
        return;
      case 'activate':
        this.ok(socket, command);
        // The session moves to Soloist as it is (the other device's song goes on here until something else is played).
        this.becomeActive();
        return;
      case 'deactivate':
        this.ok(socket, command);
        this.isActive = false;
        this.broadcast({ type: 'device_changed', is_active: false, device_name: this.deviceName });
        return;
      default:
        return this.sendTo(socket, { type: 'error', message: `unknown command ${command}` });
    }
  }

  private ok(socket: Socket, command: string): void {
    this.sendTo(socket, { type: 'command_result', command });
  }

  private authState() {
    return { type: 'auth_state', logged_in: this.loggedIn, is_active: this.isActive && !this.claimsInactive, device_name: this.deviceName };
  }
  private position() {
    return { position_ms: this.positionMs, timestamp_ms: this.now(), speed: this.status === 'playing' ? 1 : 0 };
  }
  private entity(uri: string) {
    const id = uri.split(':')[2] ?? uri;
    return {
      uri,
      entity_type: 'track',
      decorations: {
        identity: { name: `Song ${id}` },
        visual_identity: { cover: [{ url: `https://i.scdn.co/image/${id}`, size: 'large' }] },
        parent: { entity: { uri: 'spotify:album:alb', entity_type: 'album', decorations: { identity: { name: 'An Album' } } } },
        creators: [{ entity: { uri: 'spotify:artist:art', entity_type: 'artist', decorations: { identity: { name: 'An Artist' } } } }],
        playback: { duration_ms: 180_000, content_ratings: [] },
      },
    };
  }
  private playbackState() {
    return {
      type: 'playback_state',
      status: this.status,
      item: this.item ? this.entity(this.item) : null,
      context: null,
      position: this.position(),
      volume: this.volume,
      is_active: this.isActive && !this.claimsInactive,
      options: { shuffle: this.shuffle, repeat: this.repeat, playback_speed: 1, modes: {} },
      available_actions: {},
    };
  }
  private queueChanged() {
    const entry = (uri: string, source: string) => ({ uid: `${source}:${uri}`, source, item: this.entity(uri) });
    return {
      type: 'queue_changed',
      previous: this.previous.map((p) => entry(p.uri, p.source)),
      upcoming: [...this.queue.map((uri) => entry(uri, 'queue')), ...this.autoplay.map((uri) => entry(uri, 'autoplay'))],
    };
  }

  private sendTo(socket: Socket, ev: unknown): void {
    try { socket.send(JSON.stringify(ev)); } catch { /* closed */ }
  }
  private broadcast(ev: unknown): void {
    for (const s of this.sockets) this.sendTo(s, ev);
  }
}

/** Wait until `fn` is true (polling), up to `ms`. */
export async function until(fn: () => boolean, ms = 3000, step = 10): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, step));
  }
}
