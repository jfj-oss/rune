// A fake mpv JSON-IPC server on a unix socket. Tests can inspect the commands
// received and push property-change events back, without spawning mpv.
import net from 'node:net';
import type { MpvArg, MpvMessage } from '../../src/play/mpv-ipc.js';

export interface ReceivedMpvCommand {
  request_id?: number;
  command?: MpvArg[];
}

export interface FakeMpvSocket {
  socketPath: string;
  received: ReceivedMpvCommand[];
  sendEvent(msg: MpvMessage): void;
  sendRaw(text: string): void;
  close(): Promise<void>;
}

export type MpvResponder = (
  command: MpvArg[],
  requestId: number,
) => MpvMessage | undefined;

/** Every command succeeds unless the responder says otherwise. */
export function defaultMpvResponder(command: MpvArg[]): MpvMessage | undefined {
  if (command[0] === 'hang') return undefined;
  if (command[0] === 'fail') return { error: 'invalid parameter' };
  return { error: 'success', data: command[0] === 'get_property' ? 'value' : null };
}

export function startFakeMpvSocket(
  socketPath: string,
  responder?: MpvResponder,
): Promise<FakeMpvSocket> {
  return new Promise((resolve, reject) => {
    const received: ReceivedMpvCommand[] = [];
    const sockets = new Set<net.Socket>();
    const write = (socket: net.Socket, text: string) => {
      // The client (zone) may close while a response is still in flight.
      if (!socket.destroyed) socket.write(text);
    };
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.setEncoding('utf8');
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => sockets.delete(socket));
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf('\n');
        while (idx >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) {
            const msg = JSON.parse(line) as ReceivedMpvCommand;
            received.push(msg);
            const id = msg.request_id ?? 0;
            const response = responder
              ? responder(msg.command ?? [], id)
              : defaultMpvResponder(msg.command ?? []);
            if (response !== undefined) {
              write(socket, JSON.stringify({ request_id: id, ...response }) + '\n');
            }
          }
          idx = buffer.indexOf('\n');
        }
      });
    });
    server.on('error', reject);
    server.listen(socketPath, () => {
      resolve({
        socketPath,
        received,
        sendEvent(msg) {
          for (const s of sockets) write(s, JSON.stringify(msg) + '\n');
        },
        sendRaw(text) {
          for (const s of sockets) write(s, text);
        },
        close() {
          for (const s of sockets) s.destroy();
          return new Promise<void>((res) => server.close(() => res()));
        },
      });
    });
  });
}
