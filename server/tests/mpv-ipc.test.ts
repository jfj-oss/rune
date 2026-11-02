import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MpvCommandError,
  MpvIpc,
  MpvIpcTimeoutError,
  type MpvArg,
  type MpvMessage,
} from '../src/play/mpv-ipc.js';

interface Received {
  request_id?: number;
  command?: MpvArg[];
}

interface FakeMpv {
  socketPath: string;
  received: Received[];
  sendEvent(msg: MpvMessage): void;
  sendRaw(text: string): void;
  close(): Promise<void>;
}

type Responder = (command: MpvArg[], requestId: number) => MpvMessage | undefined;

function startFakeMpv(
  socketPath: string,
  responder?: Responder,
): Promise<FakeMpv> {
  return new Promise((resolve, reject) => {
    const received: Received[] = [];
    const sockets = new Set<net.Socket>();
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.setEncoding('utf8');
      socket.on('close', () => sockets.delete(socket));
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf('\n');
        while (idx >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) {
            const msg = JSON.parse(line) as Received;
            received.push(msg);
            const id = msg.request_id ?? 0;
            const response = responder ? responder(msg.command ?? [], id) : defaultResponder(msg.command ?? []);
            if (response !== undefined) {
              socket.write(JSON.stringify({ request_id: id, ...response }) + '\n');
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
          for (const s of sockets) s.write(JSON.stringify(msg) + '\n');
        },
        sendRaw(text) {
          for (const s of sockets) s.write(text);
        },
        close() {
          for (const s of sockets) s.destroy();
          return new Promise<void>((res) => server.close(() => res()));
        },
      });
    });
  });
}

function defaultResponder(command: MpvArg[]): MpvMessage | undefined {
  if (command[0] === 'hang') return undefined;
  if (command[0] === 'fail') return { error: 'invalid parameter' };
  return { error: 'success', data: command[0] === 'get_property' ? 'value' : null };
}

const cleanups: (() => Promise<void> | void)[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'liner-ipc-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn();
  }
});

describe('MpvIpc', () => {
  it('sends commands as newline-delimited JSON and resolves matching responses', async () => {
    const socketPath = join(tempDir(), 'mpv.sock');
    const fake = await startFakeMpv(socketPath);
    cleanups.push(() => fake.close());
    const ipc = await MpvIpc.connect(socketPath);
    cleanups.push(() => ipc.close());

    const args: MpvArg[] = ['loadfile', '/music/a b.flac', 'append-play', -1, 'start=1.5,end=4'];
    const res = await ipc.command(args);
    expect(res.error).toBe('success');
    expect(fake.received).toHaveLength(1);
    expect(fake.received[0]!.command).toEqual(args);
    expect(typeof fake.received[0]!.request_id).toBe('number');

    const second = await ipc.command(['get_property', 'playlist-pos']);
    expect(second.data).toBe('value');
    expect(fake.received[1]!.request_id).toBe(fake.received[0]!.request_id! + 1);
  });

  it('observe_property uses the documented argument order', async () => {
    const socketPath = join(tempDir(), 'mpv.sock');
    const fake = await startFakeMpv(socketPath);
    cleanups.push(() => fake.close());
    const ipc = await MpvIpc.connect(socketPath);
    cleanups.push(() => ipc.close());
    await ipc.observe(7, 'audio-out-params');
    expect(fake.received[0]!.command).toEqual(['observe_property', 7, 'audio-out-params']);
  });

  it('rejects when mpv reports an error', async () => {
    const socketPath = join(tempDir(), 'mpv.sock');
    const fake = await startFakeMpv(socketPath);
    cleanups.push(() => fake.close());
    const ipc = await MpvIpc.connect(socketPath);
    cleanups.push(() => ipc.close());

    await expect(ipc.command(['fail', 'x'])).rejects.toBeInstanceOf(MpvCommandError);
    try {
      await ipc.command(['fail', 'x']);
    } catch (err) {
      expect((err as MpvCommandError).mpvError).toBe('invalid parameter');
      expect((err as MpvCommandError).command).toEqual(['fail', 'x']);
    }
  });

  it('dispatches events (including ones split across TCP chunks)', async () => {
    const socketPath = join(tempDir(), 'mpv.sock');
    const fake = await startFakeMpv(socketPath);
    cleanups.push(() => fake.close());
    const ipc = await MpvIpc.connect(socketPath);
    cleanups.push(() => ipc.close());

    const seen: MpvMessage[] = [];
    const unsubscribe = ipc.onEvent((m) => seen.push(m));
    fake.sendEvent({ event: 'property-change', id: 1, name: 'time-pos', data: 1.25 });
    fake.sendRaw('{"event":"property-change","id":2,"name":"pause","da');
    fake.sendRaw('ta":true}\n');
    await waitFor(() => seen.length === 2);
    expect(seen[0]).toMatchObject({ name: 'time-pos', data: 1.25 });
    expect(seen[1]).toMatchObject({ name: 'pause', data: true });

    unsubscribe();
    fake.sendEvent({ event: 'property-change', id: 1, name: 'time-pos', data: 2 });
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toHaveLength(2);
  });

  it('retries connecting until the socket appears', async () => {
    const socketPath = join(tempDir(), 'late.sock');
    const starting = new Promise<FakeMpv>((resolve) => {
      setTimeout(() => {
        void startFakeMpv(socketPath).then((fake) => {
          cleanups.push(() => fake.close());
          resolve(fake);
        });
      }, 250);
    });
    const ipc = await MpvIpc.connect(socketPath, { timeoutMs: 4_000, retryIntervalMs: 50 });
    cleanups.push(() => ipc.close());
    await starting;
    const res = await ipc.command(['get_property', 'volume']);
    expect(res.data).toBe('value');
  });

  it('times out commands that mpv never answers', async () => {
    const socketPath = join(tempDir(), 'mpv.sock');
    const fake = await startFakeMpv(socketPath);
    cleanups.push(() => fake.close());
    const ipc = await MpvIpc.connect(socketPath);
    cleanups.push(() => ipc.close());
    await expect(ipc.command(['hang'], 100)).rejects.toBeInstanceOf(MpvIpcTimeoutError);
  });

  it('rejects in-flight commands and notifies close listeners when the socket closes', async () => {
    const socketPath = join(tempDir(), 'mpv.sock');
    const fake = await startFakeMpv(socketPath);
    cleanups.push(() => fake.close());
    const ipc = await MpvIpc.connect(socketPath);
    let closed = false;
    ipc.onClose(() => {
      closed = true;
    });
    const pending = ipc.command(['hang'], 5_000);
    await new Promise((r) => setTimeout(r, 50));
    ipc.close();
    await expect(pending).rejects.toThrow(/closed/i);
    await waitFor(() => closed);
    expect(ipc.closed).toBe(true);
  });

  it('resolves commands whose response arrives after an unrelated event', async () => {
    const socketPath = join(tempDir(), 'mpv.sock');
    const fake = await startFakeMpv(socketPath, (command, id) => {
      if (command[0] === 'slow') {
        fake.sendEvent({ event: 'property-change', id: 99, name: 'pause', data: false });
        return { error: 'success', data: id };
      }
      return defaultResponder(command);
    });
    cleanups.push(() => fake.close());
    const ipc = await MpvIpc.connect(socketPath);
    cleanups.push(() => ipc.close());
    const res = await ipc.command(['slow']);
    expect(res.data).toBe(1);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}
