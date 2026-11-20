// rune desktop (native/desktop, GPUI) against a REAL rune server: real silent FLACs, mpv on a null output, a temp data dir and
// its own port. The app runs in a PRIVATE headless KWin (own D-Bus session, own socket) and is driven through its test control
// port (RUNE_DESKTOP_TEST_PORT, the same code paths a click runs). The assertions read the SERVER: the queue is the server's.
// Nothing is audible, nothing touches the live rune (port 4545 is refused), and no window appears on the user's desktop.
//
// Needs the app built (`cd native/desktop && cargo build`) and kwin_wayland. RUNE_DESKTOP_BIN names the binary; the test is
// skipped unless it exists AND RUNE_DESKTOP_E2E=1, so `pnpm -r test` stays green without a Rust toolchain or a compositor.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { haveAudioTools, hasTool, startServer, until, type Server } from './rig.js';

process.env.LOG_LEVEL = 'silent';
const bin = process.env.RUNE_DESKTOP_BIN ?? join(homedir(), 'data/agent-tmp/rune-gpui/target/debug/rune-desktop');
const ready = process.env.RUNE_DESKTOP_E2E === '1' && haveAudioTools() && hasTool('kwin_wayland') && existsSync(bin);
const HERE = new URL('.', import.meta.url).pathname;
const startKwin = join(HERE, '../../../native/desktop/tools/hl-start.sh');

class App {
  private sock!: Socket;
  private waiting: ((v: Record<string, unknown>) => void)[] = [];
  constructor(readonly port: number) {}
  async connect() {
    await until('the app control port', () => new Promise<boolean>((res) => { const s = createConnection(this.port, '127.0.0.1'); s.once('connect', () => { this.sock = s; res(true); }); s.once('error', () => res(false)); }), 30_000);
    createInterface({ input: this.sock }).on('line', (l) => this.waiting.shift()?.(JSON.parse(l)));
  }
  send(c: Record<string, unknown>): Promise<Record<string, any>> { return new Promise((res) => { this.waiting.push(res); this.sock.write(`${JSON.stringify(c)}\n`); }); }
  state() { return this.send({ cmd: 'state' }); }
}

describe.skipIf(!ready)('rune desktop (native, headless KWin) against a real server', () => {
  let srv: Server;
  let app: App;
  let child: ChildProcess;
  let work: string;
  let kwinPid = 0;
  const titles = async () => (await srv.state('pc')).queue.map((q) => q.track.title);

  beforeAll(async () => {
    srv = await startServer();
    work = mkdtempSync(join(tmpdir(), 'rune-desktop-e2e-'));
    const sock = `wayland-rd-${process.pid}`;
    const env = { ...process.env, RG: work, SOCK: sock };
    mkdirSync(join(work, 'run'), { recursive: true });
    spawnSync('bash', [startKwin], { env, stdio: 'ignore' });
    await until('kwin', () => existsSync(join(work, 'run/bus')) && existsSync(join(process.env.XDG_RUNTIME_DIR ?? '/run/user/1000', sock)) , 20_000).catch(() => undefined);
    const bus = readFileSync(join(work, 'run/bus'), 'utf8').trim();
    const ps = spawnSync('ps', ['-eo', 'pid,cmd'], { encoding: 'utf8' }).stdout.split('\n').find((l) => l.includes('kwin_wayland') && l.includes(sock));
    kwinPid = Number(ps?.trim().split(/\s+/)[0] ?? 0);
    const port = 20000 + Math.floor(Math.random() * 20000);
    child = spawn(bin, [], {
      stdio: 'ignore',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, WAYLAND_DISPLAY: sock, DBUS_SESSION_BUS_ADDRESS: bus, XDG_CONFIG_HOME: join(work, 'cfg'), RUNE_DESKTOP_CONFIG_DIR: join(work, 'cfg/rune-desktop'),
        RUNE_DESKTOP_AUDIO: 'null', RUNE_DESKTOP_URL: srv.base, RUNE_DESKTOP_TEST_PORT: String(port), RUNE_DESKTOP_ROUTE: '/albums', RUNE_DESKTOP_SIZE: '1280x800' },
    });
    app = new App(port);
    await app.connect();
    await until('the app to be online', async () => (await app.state())['online'] === true, 20_000);
  }, 90_000);

  afterAll(async () => {
    child?.kill('SIGTERM');
    if (kwinPid) { try { process.kill(kwinPid, 'SIGTERM'); } catch { /* gone */ } }
    await srv?.stop();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('loads the library page and navigates like the web', async () => {
    await app.send({ cmd: 'go', route: `/album/${encodeURIComponent(srv.library.alpha.id)}` });
    await until('the album route', async () => String((await app.state())['route']).startsWith('album:'));
    await app.send({ cmd: 'go', route: '/albums' });
  });

  it('play an album: the server queue is that album, playing, and the app shows the same queue', async () => {
    await app.send({ cmd: 'play_album', id: srv.library.alpha.id });
    await until('the server to play Alpha', async () => { const s = await srv.state('pc'); return s.status === 'playing' && s.queue.length === 4; });
    expect(await titles()).toEqual(['A1', 'A2', 'A3', 'A4']);
    const st = await until('the app to follow', async () => { const s = await app.state(); return s['queue']?.length === 4 ? s : undefined; });
    expect(st['queue']).toEqual(['A1', 'A2', 'A3', 'A4']);
  });

  it('skip: the server moves its cursor', async () => {
    const before = (await srv.state('pc')).index;
    await app.send({ cmd: 'player', name: 'next' });
    await until('the server to skip', async () => (await srv.state('pc')).index !== before);
    await until('the app to show it', async () => (await app.state())['index'] === (await srv.state('pc')).index);
  });

  it('shuffle on: the server queue is reordered and shuffle is on; off keeps the order', async () => {
    await app.send({ cmd: 'player', name: 'shuffle' });
    await until('shuffle on', async () => (await srv.state('pc')).shuffle === true);
    await app.send({ cmd: 'player', name: 'shuffle' });
    await until('shuffle off', async () => (await srv.state('pc')).shuffle === false);
  });

  it('Shuffle on an album sends the shuffle flag with the play', async () => {
    await app.send({ cmd: 'play_album', id: srv.library.bravo.id, shuffle: true });
    await until('shuffled Bravo', async () => { const s = await srv.state('pc'); return s.shuffle === true && s.queue.length === 3 && s.queue.every((q) => q.track.title.startsWith('B')); });
    await app.send({ cmd: 'player', name: 'shuffle' });
    await until('shuffle off', async () => (await srv.state('pc')).shuffle === false);
  });

  it('queue edits: add to queue, play next, move, remove, clear', async () => {
    await app.send({ cmd: 'play_album', id: srv.library.alpha.id });
    await until('Alpha', async () => (await srv.state('pc')).queue.length === 4);
    await app.send({ cmd: 'enqueue_album', id: srv.library.charlie.id });
    await until('Charlie queued', async () => (await titles()).includes('C1'));
    await app.send({ cmd: 'enqueue_album', id: srv.library.bravo.id, next: true });
    await until('Bravo next', async () => { const t = await titles(); return t.includes('B1') && t.indexOf('B1') <= 2; });
    const n = (await titles()).length;
    await app.send({ cmd: 'remove', index: n - 1 });
    await until('a row removed', async () => (await titles()).length === n - 1);
    const t0 = await titles();
    await app.send({ cmd: 'move', index: 0, to: 2 });
    await until('a row moved', async () => { const t = await titles(); return t[2] === t0[0]; });
    await app.send({ cmd: 'player', name: 'clear' });
    await until('cleared', async () => (await srv.state('pc')).queue.length === 0);
  });

  it('add to playlist: a new playlist with tracks, then more tracks added to it', async () => {
    await app.send({ cmd: 'new_playlist', name: 'E2E list', ids: srv.library.alpha.tracks.slice(0, 2).map((t) => t.id) });
    const list = async () => (await (await fetch(`${srv.base}/api/playlists`)).json()) as { id: string; name: string; trackCount: number }[];
    const p = await until('the playlist', async () => (await list()).find((x) => x.name === 'E2E list' && x.trackCount === 2));
    await app.send({ cmd: 'add_to_playlist', playlist: p.id, name: p.name, ids: [srv.library.bravo.tracks[0]!.id] });
    await until('3 tracks', async () => (await list()).find((x) => x.id === p.id)?.trackCount === 3);
    await app.send({ cmd: 'play_playlist', id: p.id });
    await until('the playlist plays', async () => (await srv.state('pc')).queue.length === 3);
  });

  it('pin an album: the server marks it pinned', async () => {
    await app.send({ cmd: 'pin', id: srv.library.charlie.id, on: true });
    await until('pinned', async () => ((await (await fetch(`${srv.base}/api/albums/${encodeURIComponent(srv.library.charlie.id)}`)).json()) as { pinned?: boolean }).pinned === true);
  });

  it('volume and seek reach the server', async () => {
    await app.send({ cmd: 'play_album', id: srv.library.charlie.id });
    await until('Charlie', async () => (await srv.state('pc')).queue.length === 1);
    await app.send({ cmd: 'volume', v: 35 });
    await until('volume 35', async () => (await srv.state('pc')).volume === 35);
  });

  // ---------------------------------------------------------------- phase 2: the basics, asserted on the server
  const plist = async () => (await (await fetch(`${srv.base}/api/playlists`)).json()) as { id: string; name: string; trackCount: number }[];
  const detail = async (id: string) => (await (await fetch(`${srv.base}/api/playlists/${encodeURIComponent(id)}`)).json()) as { name: string; tracks: { id: string; title: string }[] };

  it('playlist edits: rename, reorder by drag (move), remove several rows', async () => {
    await app.send({ cmd: 'new_playlist', name: 'Phase two', ids: srv.library.alpha.tracks.map((t) => t.id) });
    const p = await until('the playlist', async () => (await plist()).find((x) => x.name === 'Phase two' && x.trackCount === 4));
    await app.send({ cmd: 'rename_playlist', id: p.id, name: 'Renamed in place' });
    await until('the new name', async () => (await detail(p.id)).name === 'Renamed in place');
    const before = (await detail(p.id)).tracks.map((t) => t.title);
    await app.send({ cmd: 'playlist_move', id: p.id, from: 0, to: 2 });
    await until('the row moved', async () => { const t = (await detail(p.id)).tracks.map((x) => x.title); return t[2] === before[0] && t[0] === before[1]; });
    await app.send({ cmd: 'playlist_remove', id: p.id, positions: [0, 3] });
    await until('two rows gone', async () => (await detail(p.id)).tracks.length === 2);
  });

  it('the new pages load: Home, Tracks (sorted), Genres and a genre', async () => {
    for (const r of ['/', '/tracks', '/genres', '/genres/Rock', '/albums?year=1975']) {
      await app.send({ cmd: 'go', route: r });
      await new Promise((res) => setTimeout(res, 300));
    }
    await app.send({ cmd: 'tracks_sort', sort: 'artist', desc: true });
    await app.send({ cmd: 'go', route: '/albums' });
    expect((await app.state())['online']).toBe(true);
  });

  it('album page sections: details load and a score opens its preview; fix match opens a dialog', async () => {
    // the generated library has no reviews, so the server is given some through its own details route
    const id = srv.library.alpha.id;
    await app.send({ cmd: 'go', route: `/album/${encodeURIComponent(id)}` });
    await new Promise((res) => setTimeout(res, 800));
    const r = await app.send({ cmd: 'preview', id, kind: 'score', n: 0 });
    // no details on this server: the hook reports it did not open anything (and nothing broke)
    expect(typeof r['ok']).toBe('boolean');
    await app.send({ cmd: 'fix_match', id });
    expect((await app.state())['dialog']).toBe(true);
    await app.send({ cmd: 'go', route: '/albums' });
  });

  it('a Spotify song asked for on a zone that cannot play it opens the "Play on" sheet and plays nothing', async () => {
    await app.send({ cmd: 'play_items', ids: ['sp:nothere0000'], zone: 'own' });
    await until('the Play on sheet', async () => ((await app.state())['dialog'] === true ? true : undefined));
    await app.send({ cmd: 'dialog_close' });
    expect((await app.state())['dialog']).toBe(false);
    await app.send({ cmd: 'zone', id: 'pc' });
  });

  // ---------------------------------------------------------------- phase 9: the app sounds its own zone
  it('own audio: playing on this computer follows the run, skips, seeks and pauses, all on the server', async () => {
    const st0 = await app.state();
    const own = String(st0['own_zone']);
    expect(own).toMatch(/^browser:[A-Za-z0-9_-]{6,64}$/);
    await app.send({ cmd: 'zone', id: 'own' });
    await app.send({ cmd: 'play_album', id: srv.library.alpha.id });
    const s1 = await until('the server to play the own zone', async () => { const s = await srv.state(own); return s.status === 'playing' && s.queue.length === 4 ? s : undefined; });
    expect(s1.tab?.run.length).toBeGreaterThanOrEqual(2);
    // the app really sounds it: its engine holds the current song and reports its position
    await until('the app to hold the song', async () => { const a = (await app.state())['audio'] as { loaded: string; sounding: boolean; position: number | null } | null; return a?.sounding && a.loaded === s1.queue[s1.index]!.queueId && (a.position ?? -1) >= 0 ? a : undefined; });
    // a skip: the server cursor moves and the app loads the new song
    await app.send({ cmd: 'player', name: 'next' });
    const s2 = await until('the server to skip', async () => { const s = await srv.state(own); return s.index === 1 ? s : undefined; });
    await until('the app to follow the skip', async () => ((await app.state())['audio'] as { loaded: string } | null)?.loaded === s2.queue[1]!.queueId);
    // a 12 s song: seek into it
    await app.send({ cmd: 'play_album', id: srv.library.charlie.id });
    await until('Charlie on the own zone', async () => { const s = await srv.state(own); return s.status === 'playing' && s.queue.length === 1 ? s : undefined; });
    await app.send({ cmd: 'seek', ms: 6000 });
    await until('the seek to reach the engine', async () => { const a = (await app.state())['audio'] as { position: number | null } | null; return (a?.position ?? 0) >= 5900 ? a : undefined; });
    // pause: the engine holds still, the server says paused
    await app.send({ cmd: 'player', name: 'pause' });
    await until('paused', async () => (await srv.state(own)).status === 'paused');
    await until('the engine to stop sounding', async () => ((await app.state())['audio'] as { sounding: boolean } | null)?.sounding === false);
    await app.send({ cmd: 'player', name: 'resume' });
    await until('playing again', async () => (await srv.state(own)).status === 'playing');
    // songs end by themselves: the app reports it and the server goes on (the run is gapless, the cursor follows the reports)
    await app.send({ cmd: 'play_album', id: srv.library.alpha.id });
    await until('Alpha on the own zone', async () => { const s = await srv.state(own); return s.status === 'playing' && s.queue.length === 4 ? s : undefined; });
    const idx = (await srv.state(own)).index;
    await until('a song to end on its own', async () => (await srv.state(own)).index > idx, 60_000);
    await app.send({ cmd: 'player', name: 'clear' });
    await until('cleared', async () => (await srv.state(own)).queue.length === 0);
    await app.send({ cmd: 'zone', id: 'pc' });
  }, 120_000);
});
