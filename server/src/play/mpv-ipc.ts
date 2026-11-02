// Minimal client for mpv's JSON IPC protocol (newline-delimited JSON over a unix
// socket). Kept separate from process management so it can be tested against a fake
// unix-socket "mpv" server without spawning anything.
import net from 'node:net';

export type MpvArg = string | number | boolean | null;

export interface MpvMessage {
  request_id?: number;
  error?: string;
  data?: unknown;
  event?: string;
  name?: string;
  id?: number;
  reason?: string;
  playlist_entry_id?: number;
  [key: string]: unknown;
}

export class MpvCommandError extends Error {
  readonly command: MpvArg[];
  readonly mpvError: string;
  constructor(command: MpvArg[], mpvError: string) {
    super(`mpv command ${String(command[0])} failed: ${mpvError}`);
    this.name = 'MpvCommandError';
    this.command = command;
    this.mpvError = mpvError;
  }
}

export class MpvIpcTimeoutError extends Error {
  constructor(command: MpvArg[]) {
    super(`mpv command ${String(command[0])} timed out`);
    this.name = 'MpvIpcTimeoutError';
  }
}

export interface MpvOpenOptions {
  /** Time allowed for the socket to accept a connection. */
  connectTimeoutMs?: number;
  /** How long to keep retrying while mpv is still starting. */
  retryIntervalMs?: number;
}

interface Pending {
  resolve: (msg: MpvMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  command: MpvArg[];
}

export class MpvIpc {
  private readonly socket: net.Socket;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly eventListeners = new Set<(msg: MpvMessage) => void>();
  private readonly closeListeners = new Set<(err?: Error) => void>();
  private isClosed = false;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', (err) => this.shutdown(err));
    socket.on('close', () => this.shutdown());
  }

  /** Open a connection, retrying until `timeoutMs` so callers can race mpv startup. */
  static async connect(
    socketPath: string,
    opts: MpvOpenOptions & { timeoutMs?: number } = {},
  ): Promise<MpvIpc> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const retryIntervalMs = opts.retryIntervalMs ?? 50;
    const deadline = Date.now() + timeoutMs;
    let lastErr: Error | undefined;
    while (Date.now() < deadline) {
      try {
        return await MpvIpc.open(socketPath, opts.connectTimeoutMs ?? 2_000);
      } catch (err) {
        lastErr = err as Error;
        await sleep(retryIntervalMs);
      }
    }
    throw new Error(
      `could not connect to mpv IPC socket ${socketPath}: ${lastErr?.message ?? 'timeout'}`,
    );
  }

  static open(socketPath: string, timeoutMs = 2_000): Promise<MpvIpc> {
    return new Promise<MpvIpc>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let settled = false;
      const onError = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`timed out connecting to ${socketPath}`));
      }, timeoutMs);
      timer.unref?.();
      socket.once('connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeListener('error', onError);
        resolve(new MpvIpc(socket));
      });
      socket.once('error', onError);
    });
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /** Send a command and resolve with mpv's response (mpv `error` must be "success"). */
  command(args: MpvArg[], timeoutMs = 5_000): Promise<MpvMessage> {
    if (this.isClosed) {
      return Promise.reject(new Error('mpv IPC connection is closed'));
    }
    const id = this.nextId++;
    return new Promise<MpvMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MpvIpcTimeoutError(args));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, command: args });
      const line = JSON.stringify({ command: args, request_id: id }) + '\n';
      try {
        this.socket.write(line);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  observe(id: number, name: string): Promise<MpvMessage> {
    return this.command(['observe_property', id, name]);
  }

  onEvent(cb: (msg: MpvMessage) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  onClose(cb: (err?: Error) => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  close(): void {
    this.shutdown();
    if (!this.socket.destroyed) this.socket.destroy();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.onLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    let msg: MpvMessage;
    try {
      msg = JSON.parse(line) as MpvMessage;
    } catch {
      return; // ignore malformed lines rather than killing playback
    }
    if (typeof msg.request_id === 'number' && this.pending.has(msg.request_id)) {
      const pending = this.pending.get(msg.request_id)!;
      this.pending.delete(msg.request_id);
      clearTimeout(pending.timer);
      if (msg.error !== undefined && msg.error !== 'success') {
        pending.reject(new MpvCommandError(pending.command, msg.error));
      } else {
        pending.resolve(msg);
      }
      return;
    }
    if (msg.event !== undefined) {
      for (const cb of this.eventListeners) {
        try {
          cb(msg);
        } catch {
          // listener errors must not break the IPC loop
        }
      }
    }
  }

  private shutdown(err?: Error): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`mpv IPC closed while waiting for ${String(pending.command[0])}`));
    }
    this.pending.clear();
    for (const cb of this.closeListeners) {
      try {
        cb(err);
      } catch {
        // ignore
      }
    }
    this.closeListeners.clear();
    this.eventListeners.clear();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
