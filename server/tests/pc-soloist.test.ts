// Spotify on the "Linux PC speakers" zone through Spotify Soloist (soloist/pcRoute.ts, soloist/output.ts, the /zones
// entry and the speaker guard), against the fake Soloist (tests/soloist-fake.ts), a fake mpv socket and, where Spotify
// is "connected", a fake Web API. The real Soloist binary, the real app and the network are never touched.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlayerState } from '@liner/shared';
import { openDb, type Db } from '../src/db/index.js';
import { buildApp } from '../src/api/server.js';
import type { Config } from '../src/config.js';
import type { AudioRunner } from '../src/soloist/audio.js';
import type { ChildLike } from '../src/soloist/supervisor.js';
import { pcSpotifyRoute, soloistFallbackNotice } from '../src/soloist/pcRoute.js';
import { ensureSpotifySchema } from '../src/spotify/schema.js';
import { startFakeMpvSocket, type FakeMpvSocket } from './support/fake-mpv-socket.js';
import { fakeFetch, jsonResponse, SIM_DEVICE } from './spotify-helpers.js';
import { FakeSoloist, until } from './soloist-fake.js';

process.env.LOG_LEVEL = 'silent';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock('node:child_process', async (orig) => ({ ...(await orig<typeof import('node:child_process')>()), spawn: (...a: unknown[]) => mocks.spawn(...a), execFile: (...a: unknown[]) => mocks.execFile(...a) }));

const child = () => { const c = new EventEmitter() as EventEmitter & Record<string, unknown>; Object.assign(c, { pid: 1, stderr: new EventEmitter(), exitCode: null, signalCode: null, kill: () => true }); return c; };
const MYPC = { ...SIM_DEVICE, id: 'mypc1', name: 'MYPC' };

function seedLibrary(file: string): Db {
  const db = openDb(file);
  db.prepare("INSERT INTO artists (id, name) VALUES ('ar:a', 'Artist A')").run();
  db.prepare("INSERT INTO albums (id, source, title, artist_id, year, genres, added_at) VALUES ('la:a', 'local', 'Album A', 'ar:a', 1990, '[]', 0)").run();
  const add = db.prepare("INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms, path, format) VALUES (?, 'la:a', 'local', ?, 1, ?, 200000, ?, 'flac')");
  for (let i = 1; i <= 3; i++) add.run(`l:${i}`, `Song ${i}`, i, `/tmp/music/${i}.flac`);
  return db;
}

/** pactl/ffmpeg that never run: the phone sink exists, Soloist has one stream, moves are recorded. */
function fakeAudio() {
  const moves: string[] = [];
  const runner: AudioRunner = {
    run: async (cmd, args) => {
      if (cmd === 'pactl' && args[0] === 'list' && args[1] === 'short') return { ok: true, stdout: '7\trune-phone\tPipeWire\ts16le 2ch 44100Hz\tRUNNING\n' };
      if (cmd === 'pactl' && args[0] === 'list' && args[1] === 'sink-inputs') return { ok: true, stdout: 'Sink Input #41\n\tProperties:\n\t\tapplication.name = "soloist"\n' };
      if (cmd === 'pactl' && args[0] === 'move-sink-input') moves.push(String(args[2]));
      return { ok: true, stdout: '' };
    },
    spawn: () => ({ kill: () => true, on: () => undefined }),
  };
  return { runner, moves };
}

interface FakeChild extends ChildLike { exit(code: number | null): void }
const makeChild = (): FakeChild => {
  const handlers: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  return { pid: 1, kill: () => true, on(event: string, fn: never) { if (event === 'exit') handlers.push(fn); return this; }, exit(code) { for (const h of handlers) h(code, null); } } as FakeChild;
};

interface BootOptions {
  serverQueue?: boolean;
  /** A Spotify account with the MYPC app as a device, over a fake Web API. */
  spotify?: boolean;
  /** A supervised fake process (for the expired / not-installed states) instead of a bare connection to the fake. */
  supervised?: { exists: boolean };
}

const dirs: string[] = [];
const fakes: FakeSoloist[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(o: BootOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pc-soloist-')); dirs.push(dir);
  const db = seedLibrary(join(dir, 'liner.db'));
  const web = join(dir, 'web'); mkdirSync(web);
  writeFileSync(join(web, 'build-id.txt'), 'build-1\n');
  const fake = new FakeSoloist(); fakes.push(fake);
  await fake.start();
  let mpvSocket!: Promise<FakeMpvSocket>;
  const mpvState = { idle: false };
  mocks.spawn.mockImplementation((cmd: string) => {
    if (cmd !== 'mpv') throw new Error('nothing else runs in this test');
    mpvSocket = startFakeMpvSocket(join(dir, 'mpv.sock'), (c) => ({ error: 'success', data: c[0] === 'get_property' && c[1] === 'idle-active' ? mpvState.idle : null }));
    return child();
  });
  mocks.execFile.mockImplementation((...a: unknown[]) => { const cb = a.at(-1); if (typeof cb === 'function') (cb as (e: Error) => void)(new Error('no')); });
  const audio = fakeAudio();
  const spawned: FakeChild[] = [];
  const cfg: Config = {
    libraryRoots: [], dataDir: dir, port: 0, audioDevice: 'null', userAgent: 't', normalize: 'album', pcSpotifyDevice: 'MYPC',
    spotify: { serverQueue: o.serverQueue === true },
    ...(o.spotify ? { spotifyClientId: 'client-abc' } : {}),
  };
  let devicesCalls = 0;
  if (o.spotify) {
    ensureSpotifySchema(db);
    db.prepare("INSERT INTO spotify_auth (id, access_token, refresh_token, token_type, scope, expires_at, user_name, user_product, updated_at) VALUES (1, 'access', 'refresh', 'Bearer', '', ?, NULL, NULL, 0)").run(Date.now() + 3_600_000);
  }
  const { fetch } = fakeFetch((url) => {
    if (url.pathname === '/v1/me/player/devices') { devicesCalls++; return jsonResponse(200, { devices: [MYPC] }); }
    return jsonResponse(204, '');
  });
  const { app, shutdown } = await buildApp(db, cfg, {
    pcZone: true, scanOnStart: false, watch: false, backups: false, webDist: web, spotifySyncOnStart: false,
    ...(o.spotify ? { spotifyOptions: { fetch, endpoints: { api: 'http://api.test/v1', accounts: 'http://accounts.test' } } } : {}),
    soloist: {
      url: fake.url, runner: audio.runner, hlsDir: join(dir, 'hls'),
      ...(o.supervised ? { spawn: () => { const c = makeChild(); spawned.push(c); return c; }, exists: () => o.supervised!.exists, readKey: () => 'k' } : {}),
    },
  });
  await app.ready();
  const mpv = await mpvSocket;
  const status = async () => (await app.inject({ url: '/api/soloist/status' })).json() as { run: string; connected: boolean; loggedIn: boolean; available: boolean; output: string };
  if (o.supervised?.exists) await until(() => spawned.length > 0);
  if (!o.supervised) await vi.waitFor(async () => expect((await status()).available).toBe(true));
  const zones = async () => (await app.inject({ url: '/api/zones' })).json() as { id: string; kind: string; spotifyEngine?: string; spotifyZone?: string; spotifyNotice?: string; spotifyDeviceId?: string; soloist?: boolean }[];
  const pcEntry = async () => (await zones()).find((z) => z.id === 'pc')!;
  const send = (zone: string, payload: object) => app.inject({ method: 'POST', url: `/api/player/${zone}`, payload });
  const state = async (zone = 'pc') => (await app.inject({ url: `/api/player/${zone}` })).json() as PlayerState;
  const mpvCommands = () => mpv.received.map((r) => r.command ?? []);
  const loads = () => mpvCommands().filter((c) => c[0] === 'loadfile').map((c) => String(c[1]));
  const mpvPaused = () => mpvCommands().some((c) => c[0] === 'set_property' && c[1] === 'pause' && c[2] === true);
  const close = async () => { await mpv.close(); await shutdown('test').catch(() => undefined); };
  return { app, db, fake, audio, spawned, status, zones, pcEntry, send, state, loads, mpvPaused, mpvCommands, devices: () => devicesCalls, close };
}

describe('pcSpotifyRoute: Soloist first, the app when it cannot play, with the reason', () => {
  const ok = { run: 'running', connected: true, loggedIn: true } as const;
  it('sends Spotify songs to Soloist whenever it is running, connected and signed in', () => {
    expect(pcSpotifyRoute(ok, null, false)).toEqual({ engine: 'soloist', zone: 'soloist', notice: null });
    expect(pcSpotifyRoute(ok, 'spotify:mypc1', true)).toEqual({ engine: 'soloist', zone: 'soloist', notice: null });
    expect(soloistFallbackNotice(ok)).toBeNull();
  });
  it('without Soloist the app route is what it was', () => {
    expect(pcSpotifyRoute(undefined, 'spotify:mypc1', true)).toEqual({ engine: 'app', zone: 'spotify:mypc1', notice: null });
    expect(pcSpotifyRoute(undefined, null, true)).toEqual({ engine: 'app', zone: null, notice: null });
    expect(pcSpotifyRoute(undefined, null, false)).toEqual({ engine: null, zone: null, notice: null });
  });
  it('names each reason in one line and never lets an expiry pass in silence', () => {
    const cases: [Parameters<typeof soloistFallbackNotice>[0], RegExp][] = [
      [{ run: 'expired', connected: false, loggedIn: false }, /needs updating.*using the Spotify app/],
      [{ run: 'no-binary', connected: false, loggedIn: false }, /not installed/],
      [{ run: 'no-key', connected: false, loggedIn: false }, /no API key/],
      [{ run: 'crashed', connected: false, loggedIn: false }, /crashed/],
      [{ run: 'off', connected: false, loggedIn: false }, /switched off/],
      [{ run: 'running', connected: false, loggedIn: false }, /not running yet/],
      [{ run: 'running', connected: true, loggedIn: false }, /not signed in/],
    ];
    for (const [s, re] of cases) {
      expect(soloistFallbackNotice(s)).toMatch(re);
      expect(pcSpotifyRoute(s, 'spotify:mypc1', true)).toMatchObject({ engine: 'app', zone: 'spotify:mypc1' });
      expect(pcSpotifyRoute(s, null, true)).toMatchObject({ engine: 'app', zone: null });
      // No Spotify account for the app either: nothing can play, but the reason still travels.
      expect(pcSpotifyRoute(s, null, false).engine).toBeNull();
      expect(pcSpotifyRoute(s, null, false).notice).toMatch(re);
    }
  });
});

describe('the pc zone with Soloist as its Spotify engine (tab-driven queue)', () => {
  it('GET /zones names Soloist as the player and lists the Soloist zone once', { timeout: 20000 }, async () => {
    const t = await boot();
    const pc = await t.pcEntry();
    expect(pc).toMatchObject({ spotifyEngine: 'soloist', spotifyZone: 'soloist' });
    expect(pc.spotifyNotice).toBeUndefined();
    expect(pc.spotifyDeviceId).toBeUndefined(); // no Spotify account: no app device, and none needed
    expect((await t.zones()).filter((z) => z.soloist)).toHaveLength(1);
    await t.close();
  });

  it('a Spotify song for the PC goes straight to Soloist: play, pause, seek, volume and now-playing all work', { timeout: 20000 }, async () => {
    const t = await boot();
    const res = await t.send('soloist', { type: 'play', trackIds: ['sp:a', 'sp:b'], startIndex: 0 });
    expect(res.statusCode).toBe(200);
    await until(() => t.fake.item === 'spotify:track:a');
    expect(t.fake.commands.some((c) => c.command === 'play' && c.uri === 'spotify:track:a')).toBe(true);
    expect(t.loads()).toEqual([]); // mpv was never involved
    // Songs rune never stored are named from Soloist's own events (no Web API lookup).
    await vi.waitFor(async () => expect((await t.state('soloist')).queue[0]?.track.title).toBe('Song a'));
    await t.send('soloist', { type: 'pause' });
    await until(() => t.fake.status === 'paused');
    expect((await t.state('soloist')).status).toBe('paused');
    await t.send('soloist', { type: 'seek', positionMs: 30_000 });
    expect(t.fake.positionMs).toBe(30_000);
    await t.send('soloist', { type: 'volume', volume: 35 });
    expect(t.fake.volume).toBe(35);
    await t.send('soloist', { type: 'resume' });
    await until(() => t.fake.status === 'playing');
    await t.send('soloist', { type: 'next' });
    await until(() => t.fake.item === 'spotify:track:b');
    expect((await t.state('soloist')).index).toBe(1);
    await t.close();
  });

  it('one speaker: Soloist starting pauses mpv, and mpv starting pauses Soloist (on the PC speakers only)', { timeout: 20000 }, async () => {
    const t = await boot();
    await t.send('pc', { type: 'play', trackIds: ['l:1'], startIndex: 0 });
    expect((await t.state('pc')).status).toBe('playing');
    expect(t.mpvPaused()).toBe(false);
    await t.send('soloist', { type: 'play', trackIds: ['sp:a'], startIndex: 0 });
    await vi.waitFor(() => expect(t.mpvPaused()).toBe(true));

    // The other way round: Soloist sounding, mpv starts.
    await until(() => t.fake.status === 'playing');
    const pausesBefore = t.fake.commands.filter((c) => c.command === 'pause').length;
    await t.send('pc', { type: 'resume' });
    await until(() => t.fake.commands.filter((c) => c.command === 'pause').length > pausesBefore);
    expect(t.fake.status).toBe('paused');

    // Streaming to the phone is not the speakers: mpv and Soloist may both play then.
    await app(t).inject({ method: 'POST', url: '/api/soloist/output', payload: { output: 'phone' } });
    await t.send('soloist', { type: 'resume' });
    await until(() => t.fake.status === 'playing');
    const pausesAfter = t.fake.commands.filter((c) => c.command === 'pause').length;
    await t.send('pc', { type: 'pause' });
    await t.send('pc', { type: 'resume' });
    await new Promise((r) => setTimeout(r, 150));
    expect(t.fake.commands.filter((c) => c.command === 'pause').length).toBe(pausesAfter);
    await t.close();
  });
});

const app = (t: { app: Awaited<ReturnType<typeof boot>>['app'] }) => t.app;

describe('falling back to the Spotify app, with the reason', () => {
  it('Soloist not signed in: the app route, and the notice says so', { timeout: 20000 }, async () => {
    const t = await boot({ spotify: true });
    expect(await t.pcEntry()).toMatchObject({ spotifyEngine: 'soloist', spotifyZone: 'soloist', spotifyDeviceId: 'mypc1' });
    t.fake.setLoggedIn(false);
    await vi.waitFor(async () => expect((await t.status()).loggedIn).toBe(false));
    const pc = await t.pcEntry();
    expect(pc).toMatchObject({ spotifyEngine: 'app', spotifyZone: 'spotify:mypc1', spotifyDeviceId: 'mypc1' });
    expect(pc.spotifyNotice).toMatch(/not signed in.*using the Spotify app/);
    await t.close();
  });

  it('Soloist gone (crashed, not connected): the app route with the notice', { timeout: 20000 }, async () => {
    const t = await boot({ spotify: true });
    await t.fake.stop();
    await vi.waitFor(async () => expect((await t.status()).connected).toBe(false));
    const pc = await t.pcEntry();
    expect(pc).toMatchObject({ spotifyEngine: 'app', spotifyZone: 'spotify:mypc1' });
    expect(pc.spotifyNotice).toMatch(/not running yet/);
    await t.close();
  });

  it('the build expired (exit code 10): never silent — the notice says to update, and the app plays meanwhile', { timeout: 20000 }, async () => {
    const t = await boot({ spotify: true, supervised: { exists: true } });
    await until(() => t.spawned.length === 1);
    await vi.waitFor(async () => expect((await t.status()).available).toBe(true));
    expect((await t.pcEntry()).spotifyEngine).toBe('soloist');
    t.spawned[0]!.exit(10);
    await vi.waitFor(async () => expect((await t.status()).run).toBe('expired'));
    const pc = await t.pcEntry();
    expect(pc).toMatchObject({ spotifyEngine: 'app', spotifyZone: 'spotify:mypc1' });
    expect(pc.spotifyNotice).toMatch(/needs updating/);
    expect(t.spawned).toHaveLength(1); // no restart loop on an expired build
    await t.close();
  });

  it('not installed: the app route with the notice', { timeout: 20000 }, async () => {
    const t = await boot({ spotify: true, supervised: { exists: false } });
    await vi.waitFor(async () => expect((await t.status()).run).toBe('no-binary'));
    const pc = await t.pcEntry();
    expect(pc).toMatchObject({ spotifyEngine: 'app', spotifyZone: 'spotify:mypc1' });
    expect(pc.spotifyNotice).toMatch(/not installed/);
    await t.close();
  });

  it('the Soloist path makes no Spotify Web API devices call', { timeout: 20000 }, async () => {
    const t = await boot({ spotify: true });
    await t.pcEntry(); // the zone list itself reads the devices once (as before); the play below must not
    const before = t.devices();
    await t.send('soloist', { type: 'play', trackIds: ['sp:a', 'sp:b'], startIndex: 0 });
    await until(() => t.fake.item === 'spotify:track:a');
    await t.send('soloist', { type: 'pause' });
    await t.send('soloist', { type: 'resume' });
    await t.send('soloist', { type: 'next' });
    await until(() => t.fake.item === 'spotify:track:b');
    await app(t).inject({ method: 'POST', url: '/api/soloist/output', payload: { output: 'pc' } });
    expect(t.devices()).toBe(before);
    await t.close();
  });
});

describe('the server-owned pc queue with Soloist', () => {
  it('plays Spotify songs on Soloist and local songs on mpv in one mixed queue, Soloist first', { timeout: 20000 }, async () => {
    const t = await boot({ serverQueue: true });
    expect(await t.pcEntry()).toMatchObject({ serverQueue: true, spotifyEngine: 'soloist', spotifyZone: 'soloist' });
    const res = await t.send('pc', { type: 'play', trackIds: ['sp:a', 'sp:b', 'l:1'], startIndex: 0 });
    expect(res.statusCode).toBe(200);
    await until(() => t.fake.item === 'spotify:track:a');
    await vi.waitFor(async () => expect(await t.state()).toMatchObject({ status: 'playing', output: 'spotify', index: 0 }));
    expect((await t.state()).signalPath).toEqual(['Spotify', 'Soloist on the PC', 'PipeWire']);
    expect(t.loads()).toEqual([]);
    // Soloist queues the next song itself; its natural end moves the cursor without a word from the page.
    await until(() => t.fake.queue.includes('spotify:track:b'));
    t.fake.finishTrack();
    await vi.waitFor(async () => expect((await t.state()).index).toBe(1));
    // Controls on the pc zone drive Soloist.
    await t.send('pc', { type: 'pause' });
    await until(() => t.fake.status === 'paused');
    expect((await t.state()).status).toBe('paused');
    await t.send('pc', { type: 'resume' });
    await until(() => t.fake.status === 'playing');
    await t.send('pc', { type: 'seek', positionMs: 20_000 });
    expect(t.fake.positionMs).toBe(20_000);
    await t.send('pc', { type: 'volume', volume: 40 });
    await until(() => t.fake.volume === 40);
    // The last Spotify song ends: the queue goes on with the local song on mpv, and Soloist is cleared.
    t.fake.finishTrack();
    await vi.waitFor(async () => expect(t.loads()).toEqual(['/tmp/music/1.flac']));
    await vi.waitFor(async () => expect((await t.state()).output).toBe('mpv'));
    expect(t.fake.status).not.toBe('playing');
    await t.close();
  });

  it('autoplay after the run\'s last Spotify song: the queue goes on with its local song and Soloist is silenced, not followed', { timeout: 20000 }, async () => {
    const t = await boot({ serverQueue: true });
    t.fake.autoplay = ['spotify:track:x1'];
    await t.send('pc', { type: 'play', trackIds: ['sp:a', 'l:1'], startIndex: 0 });
    await until(() => t.fake.item === 'spotify:track:a');
    await vi.waitFor(async () => expect(await t.state()).toMatchObject({ status: 'playing', output: 'spotify', index: 0 }));
    // Spotify's autoplay takes Soloist on to x1: for the server-owned queue that is the end of its song.
    t.fake.finishTrack();
    await until(() => t.fake.item === 'spotify:track:x1');
    await vi.waitFor(async () => expect(t.loads()).toEqual(['/tmp/music/1.flac']));
    await vi.waitFor(async () => expect((await t.state()).output).toBe('mpv'));
    expect((await t.state()).index).toBe(1);
    // The queue never sounds a song it did not choose: Soloist was cleared (paused) for the local song.
    await until(() => t.fake.status !== 'playing');
    expect((await t.state('soloist')).queue.map((q) => q.track.id)).toEqual([]);
    await t.close();
  });

  it('a song a Spotify app starts mid-run parks the queue (takeover), and the Soloist zone shows that song', { timeout: 20000 }, async () => {
    const t = await boot({ serverQueue: true });
    await t.send('pc', { type: 'play', trackIds: ['sp:a', 'sp:b'], startIndex: 0 });
    await until(() => t.fake.item === 'spotify:track:a');
    await vi.waitFor(async () => expect(await t.state()).toMatchObject({ status: 'playing', output: 'spotify' }));
    await until(() => t.fake.queue.includes('spotify:track:b'));
    t.fake.takeOver('spotify:track:zzz');
    await vi.waitFor(async () => expect((await t.state()).hold?.reason).toBe('takeover'));
    expect(t.fake.item).toBe('spotify:track:zzz'); // the user's song keeps playing
    const sz = await t.state('soloist');
    expect(sz.status).toBe('playing');
    expect(sz.queue[sz.index]).toMatchObject({ track: { id: 'sp:zzz', title: 'Song zzz' } });
    await t.close();
  });

  it('a Spotify song while Soloist streams to the phone: the sound comes back to the PC speakers', { timeout: 20000 }, async () => {
    const t = await boot({ serverQueue: true });
    await app(t).inject({ method: 'POST', url: '/api/soloist/output', payload: { output: 'phone' } });
    expect((await t.status()).output).toBe('phone');
    await t.send('pc', { type: 'play', trackIds: ['sp:a'], startIndex: 0 });
    await until(() => t.fake.item === 'spotify:track:a');
    expect((await t.status()).output).toBe('pc');
    expect(t.audio.moves.at(-1)).toBe('@DEFAULT_SINK@');
    await t.close();
  });

  it('Soloist not signed in and no Spotify account: the song waits with the reason', { timeout: 20000 }, async () => {
    const t = await boot({ serverQueue: true });
    t.fake.setLoggedIn(false);
    await vi.waitFor(async () => expect((await t.status()).loggedIn).toBe(false));
    await t.send('pc', { type: 'play', trackIds: ['sp:a', 'l:1'], startIndex: 0 });
    const s = await t.state();
    expect(s.status).toBe('paused');
    expect(s.hold?.reason).toBe('spotify-unavailable');
    expect(s.hold?.message).toMatch(/not signed in/);
    expect(t.fake.commands.some((c) => c.command === 'play')).toBe(false);
    expect(t.loads()).toEqual([]);
    await t.close();
  });
});
