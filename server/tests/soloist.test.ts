// Spotify Soloist in rune, against a fake Soloist (tests/soloist-fake.ts). The real binary is never started.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueueItem } from '@liner/shared';
import { SoloistClient } from '../src/soloist/client.js';
import { SoloistZone } from '../src/soloist/zone.js';
import { SoloistSupervisor, type ChildLike } from '../src/soloist/supervisor.js';
import { SoloistAudio, hlsArgs, soloistSinkInputs, type AudioRunner } from '../src/soloist/audio.js';
import { createSoloist, soloistEnabled } from '../src/soloist/index.js';
import { TEST_CONFIG } from './spotify-helpers.js';
import { FakeSoloist, until } from './soloist-fake.js';

process.env.LOG_LEVEL = 'silent';

const item = (id: string): QueueItem => ({
  queueId: `q-${id}`,
  track: { id: `sp:${id}`, albumId: 'sp:alb', source: 'spotify', title: `Song ${id}`, artists: [{ id: 'ar:1', name: 'A' }], disc: 1, number: 1, durationMs: 180_000, spotifyUri: `spotify:track:${id}` },
  album: { id: 'sp:alb', title: 'Alb' },
});
const local = (id: string): QueueItem => ({ ...item(id), track: { ...item(id).track, id: `l:${id}`, source: 'local', spotifyUri: undefined } });
const loadItems = (ids: string[]): QueueItem[] => ids.map((id) => (id.startsWith('l:') ? local(id.slice(2)) : item(id.replace(/^sp:/, ''))));

let fake: FakeSoloist;
beforeAll(async () => {
  fake = new FakeSoloist();
  await fake.start();
});
afterAll(async () => {
  await fake.stop();
});
afterEach(() => {
  fake.commands = [];
  fake.queue = [];
  fake.item = null;
  fake.status = 'idle';
  fake.shuffle = false;
  fake.repeat = 'off';
  fake.setLoggedIn(true);
});

async function connected(): Promise<SoloistClient> {
  const client = new SoloistClient({ url: fake.url, reconnectMs: 50 });
  client.connect();
  await until(() => client.view.connected && client.view.loggedIn);
  return client;
}

describe('SoloistClient', () => {
  it('refuses anything but the loopback interface', () => {
    expect(() => new SoloistClient({ url: 'ws://192.168.1.5:9090' })).toThrow(/loopback/);
  });

  it('learns the auth state on connect, resolves control commands on command_result and rejects on error', async () => {
    const client = await connected();
    expect(client.view.deviceName).toBe('rune');
    await client.send({ command: 'set_volume', volume: 40 });
    await until(() => client.view.volume === 40);
    await expect(client.send({ command: 'add_to_queue', uri: 'spotify:album:nope' })).rejects.toThrow(/track uri/);
    client.close();
  });

  it('interpolates the position from the last anchor and stops it while paused', async () => {
    let t = 1_000_000;
    fake = Object.assign(fake, {});
    const client = new SoloistClient({ url: fake.url, now: () => t });
    client.connect();
    await until(() => client.view.loggedIn);
    await client.send({ command: 'play', uri: 'spotify:track:a' });
    await until(() => client.view.item?.uri === 'spotify:track:a' && client.view.status === 'playing');
    const anchor = client.view.position!.timestamp_ms;
    t = anchor + 5000;
    expect(client.positionMs()).toBe(5000);
    await client.send({ command: 'pause' });
    await until(() => client.view.status === 'paused');
    const paused = client.positionMs();
    t += 10_000;
    expect(client.positionMs()).toBe(paused);
    client.close();
  });

  it('reconnects after Soloist goes away and comes back', async () => {
    const client = new SoloistClient({ url: fake.url, reconnectMs: 30, reconnectMaxMs: 60 });
    client.connect();
    await until(() => client.view.connected);
    await fake.stop();
    await until(() => !client.view.connected);
    // the same port again
    const port = Number(fake.url.split(':').pop());
    fake = new FakeSoloist();
    await fake.app.register(() => Promise.resolve());
    fake.url = `ws://127.0.0.1:${port}`;
    // a fresh server on the old port
    const again = new FakeSoloist();
    await again.start();
    const client2 = new SoloistClient({ url: again.url, reconnectMs: 30 });
    client2.connect();
    await until(() => client2.view.connected);
    client.close();
    client2.close();
    fake = again;
  });
});

describe('SoloistZone', () => {
  it('plays a queue one song at a time, queues the next for a gapless change, and follows the natural end', async () => {
    const client = await connected();
    const programs: number[] = [];
    const zone = new SoloistZone({ link: client, loadItems, output: () => 'phone', newProgram: () => programs.push(1) });
    const s1 = await zone.command({ type: 'play', trackIds: ['sp:a', 'sp:b', 'sp:c'], startIndex: 0 });
    expect(s1.status).toBe('playing');
    expect(s1.index).toBe(0);
    expect(fake.item).toBe('spotify:track:a');
    await until(() => fake.queue.length === 1);
    expect(fake.queue).toEqual(['spotify:track:b']);
    expect(programs.length).toBe(1);
    // Shuffle/repeat on Soloist's side stay off: rune orders the queue.
    expect(fake.commands.some((c) => c.command === 'set_shuffle' && c.enabled === true)).toBe(false);

    // The song ends: Soloist moves on to b by itself; rune's cursor follows and c is queued; the program is kept.
    fake.finishTrack();
    await until(() => zone.state().index === 1);
    await until(() => fake.queue.includes('spotify:track:c'));
    expect(programs.length).toBe(1);
    expect(zone.state().status).toBe('playing');

    // Next: a new play and a new program (the phone must hear the change at once).
    await zone.command({ type: 'next' });
    expect(zone.state().index).toBe(2);
    expect(fake.item).toBe('spotify:track:c');
    expect(programs.length).toBe(2);

    // Pause / seek / resume map straight onto Soloist.
    await zone.command({ type: 'pause' });
    expect(zone.state().status).toBe('paused');
    await zone.command({ type: 'seek', positionMs: 42_000 });
    expect(fake.positionMs).toBe(42_000);
    await zone.command({ type: 'resume' });
    await until(() => zone.state().status === 'playing');
    expect(fake.status).toBe('playing');
    // The last song ends: Soloist has nothing queued and goes idle; rune's queue is over.
    fake.finishTrack();
    await until(() => zone.state().status === 'stopped');
    await zone.close();
    client.close();
  });

  it('refuses local files and reports a Soloist that is not paired in plain words', async () => {
    const client = await connected();
    const zone = new SoloistZone({ link: client, loadItems, output: () => 'pc' });
    await expect(zone.command({ type: 'play', trackIds: ['l:x'], startIndex: 0 })).rejects.toThrow(/Spotify song/);
    fake.setLoggedIn(false);
    await until(() => !client.view.loggedIn);
    await expect(zone.command({ type: 'play', trackIds: ['sp:a'], startIndex: 0 })).rejects.toThrow(/not running or not paired/);
    await zone.close();
    client.close();
  });

  it('plays its own queue on when a song outside the queue takes Soloist mid-list', async () => {
    const client = await connected();
    const zone = new SoloistZone({ link: client, loadItems, output: () => 'pc' });
    await zone.command({ type: 'play', trackIds: ['sp:a', 'sp:b'], startIndex: 0 });
    await until(() => fake.queue.length === 1);
    fake.takeOver('spotify:track:zzz');
    await until(() => fake.item === 'spotify:track:b');
    expect(zone.state().index).toBe(1);
    await zone.close();
    client.close();
  });
});

describe('SoloistSupervisor', () => {
  interface FakeChild extends ChildLike { exit(code: number | null): void }
  const makeChild = (): FakeChild => {
    const handlers: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
    return {
      pid: 1,
      kill: () => true,
      on(event: string, fn: never) { if (event === 'exit') handlers.push(fn); return this; },
      exit(code) { for (const h of handlers) h(code, null); },
    } as FakeChild;
  };

  it('starts soloist with the key from the file (never logged), restarts a crash, and stops on the expired exit code', () => {
    const spawned: { args: string[]; child: FakeChild }[] = [];
    const logs: Record<string, unknown>[] = [];
    const timers: (() => void)[] = [];
    const sup = new SoloistSupervisor({
      binary: '/bin/soloist',
      keyFile: '/k',
      deviceName: 'rune',
      ws: '127.0.0.1:4547',
      pipewireDevice: 'rune-phone',
      exists: () => true,
      readKey: () => 'SECRET-KEY',
      spawn: (_b, args) => { const child = makeChild(); spawned.push({ args, child }); return child; },
      setTimeout: (fn) => { timers.push(fn); return 0; },
      log: (obj) => logs.push(obj),
    });
    sup.start();
    expect(sup.run).toBe('running');
    expect(spawned[0]!.args).toEqual(['-n', 'rune', '-k', 'SECRET-KEY', '-w', '127.0.0.1:4547', '-d', 'rune-phone']);
    expect(JSON.stringify(logs)).not.toContain('SECRET-KEY');
    spawned[0]!.child.exit(1);
    expect(sup.run).toBe('crashed');
    expect(sup.problem()).toMatch(/restarted/);
    timers.shift()!();
    expect(spawned.length).toBe(2);
    expect(sup.run).toBe('running');
    spawned[1]!.child.exit(10);
    expect(sup.run).toBe('expired');
    expect(sup.problem()).toMatch(/Soloist build expired: update it/);
    expect(timers.length).toBe(0);
    sup.stop();
  });

  it('says what is missing instead of starting anything', () => {
    const sup = new SoloistSupervisor({ binary: '/nope', keyFile: '/k', deviceName: 'rune', ws: '127.0.0.1:1', exists: (p) => p === '/k', spawn: () => { throw new Error('must not spawn'); } });
    sup.start();
    expect(sup.problem()).toMatch(/not installed/);
    expect(() => new SoloistSupervisor({ binary: '/b', keyFile: '/k', deviceName: 'rune', ws: '0.0.0.0:4547' })).toThrow(/loopback/);
  });
});

describe('SoloistAudio', () => {
  it('finds soloist among the sink inputs and builds the HLS command for the sink monitor', () => {
    const listing = `Sink Input #12\n\tDriver: PipeWire\n\tProperties:\n\t\tapplication.name = "Firefox"\n\nSink Input #31\n\tProperties:\n\t\tapplication.name = "soloist"\n\t\tapplication.process.binary = "soloist"\n`;
    expect(soloistSinkInputs(listing)).toEqual(['31']);
    const args = hlsArgs('rune-phone', '/run/x', 256);
    expect(args).toContain('rune-phone.monitor');
    expect(args).toContain('-f');
    expect(args.join(' ')).toMatch(/-c:a aac -b:a 256k/);
    expect(args.join(' ')).toMatch(/hls_time 1/);
  });

  it('creates the silent sink once, moves soloist between the phone sink and the speakers, and runs the encoder only while a phone listens', async () => {
    const calls: string[] = [];
    let spawned = 0;
    const runner: AudioRunner = {
      run: async (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`);
        if (args[0] === 'list' && args[1] === 'short') return { ok: true, stdout: '58\talsa_output.x\tPipeWire\n' };
        if (args[0] === 'list') return { ok: true, stdout: 'Sink Input #7\n\tapplication.name = "soloist"\n' };
        if (args[0] === 'load-module') return { ok: true, stdout: '536870913\n' };
        return { ok: true, stdout: '' };
      },
      spawn: () => { spawned++; return { kill: () => true, on: () => undefined }; },
    };
    const dir = mkdtempSync(join(tmpdir(), 'rune-hls-'));
    let t = 0;
    const audio = new SoloistAudio({ runner, hlsDir: dir, now: () => t, idleMs: 1000 });
    expect(await audio.ensureSink()).toBe(true);
    expect(calls.some((c) => c.startsWith('pactl load-module module-null-sink sink_name=rune-phone'))).toBe(true);
    await audio.setOutput('pc');
    expect(calls.at(-1)).toBe('pactl move-sink-input 7 @DEFAULT_SINK@');
    expect(audio.listen()).toBeNull();
    expect(spawned).toBe(0);
    await audio.setOutput('phone');
    expect(calls.at(-1)).toBe('pactl move-sink-input 7 rune-phone');
    const first = audio.listen();
    expect(first?.gen).toBe(1);
    expect(spawned).toBe(1);
    expect(audio.playlist()).toBeNull(); // ffmpeg has written nothing yet
    mkdirSync(first!.dir, { recursive: true });
    writeFileSync(join(first!.dir, 'index.m3u8'), '#EXTM3U\n#EXTINF:1.0,\nseg00001.ts\n');
    writeFileSync(join(first!.dir, 'seg00001.ts'), 'x');
    expect(audio.playlist()).toContain('g1/seg00001.ts');
    expect(audio.segmentPath(1, 'seg00001.ts')).toBe(join(first!.dir, 'seg00001.ts'));
    expect(audio.segmentPath(1, '../etc/passwd')).toBeNull();
    audio.restart(); // a skip: a new program
    expect(spawned).toBe(2);
    expect(audio.listen()?.gen).toBe(2);
    await audio.close();
    expect(calls.at(-1)).toBe('pactl unload-module 536870913');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('createSoloist', () => {
  it('is on only when configured or installed, and its routes switch the output and guard the stream', async () => {
    expect(soloistEnabled(TEST_CONFIG, () => false)).toBe(false);
    expect(soloistEnabled(TEST_CONFIG, () => true)).toBe(true);
    expect(soloistEnabled({ ...TEST_CONFIG, soloist: { enabled: false } }, () => true)).toBe(false);

    const runner: AudioRunner = { run: async () => ({ ok: true, stdout: '' }), spawn: () => ({ kill: () => true, on: () => undefined }) };
    const dir = mkdtempSync(join(tmpdir(), 'rune-sol-'));
    const soloist = createSoloist(TEST_CONFIG, { loadItems, url: fake.url, runner, hlsDir: dir });
    await until(() => soloist.info().connected && soloist.info().loggedIn);
    expect(soloist.info()).toMatchObject({ id: 'soloist', output: 'pc', problem: null });

    const app = Fastify();
    soloist.registerRoutes(app);
    const status = await app.inject({ method: 'GET', url: '/soloist/status' });
    expect(status.json()).toMatchObject({ id: 'soloist', deviceName: 'rune' });
    const bad = await app.inject({ method: 'POST', url: '/soloist/output', payload: { output: 'tv' } });
    expect(bad.statusCode).toBe(400);
    const phone = await app.inject({ method: 'POST', url: '/soloist/output', payload: { output: 'phone' } });
    expect(phone.json().output).toBe('phone');
    const pc = await app.inject({ method: 'POST', url: '/soloist/output', payload: { output: 'pc' } });
    expect(pc.json().output).toBe('pc');
    const blocked = await app.inject({ method: 'GET', url: '/soloist/stream/live.m3u8' });
    expect(blocked.statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/soloist/stream/g1/seg00001.ts' })).statusCode).toBe(404);
    await app.close();
    await soloist.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

import Fastify from 'fastify';
