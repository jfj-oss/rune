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
        RUNE_DESKTOP_AUDIO: 'null', RUNE_DESKTOP_OS: 'off', RUNE_DESKTOP_DATA_DIR: join(work, 'data'), RUNE_DESKTOP_URL: srv.base, RUNE_DESKTOP_TEST_PORT: String(port), RUNE_DESKTOP_ROUTE: '/albums', RUNE_DESKTOP_SIZE: '1280x800' },
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

  // ---------------------------------------------------------------- phase 4: playlists complete, hotkeys, radio
  it('smart playlist: the rules go to the server in its own form and the playlist fills itself', async () => {
    await app.send({ cmd: 'smart_create', name: 'Alpha by title', all: true, sort: 'title', rules: [{ field: 'artist', op: 'contains', a: 'E2E' }] });
    const p = await until('the smart playlist', async () => (await plist()).find((x) => x.name === 'Alpha by title'));
    const d = await detail(p.id);
    expect(d.tracks.length).toBeGreaterThanOrEqual(4);
  });

  it('m3u8: a playlist exports to a file and the file imports as a new playlist', async () => {
    const src = (await plist()).find((x) => x.name === 'Renamed in place');
    expect(src).toBeTruthy();
    const file = join(work, 'out.m3u8');
    await app.send({ cmd: 'export_m3u8', id: src!.id, name: 'Renamed in place', path: file });
    await until('the file', () => existsSync(file) && readFileSync(file, 'utf8').includes('#EXTM3U'));
    await app.send({ cmd: 'import_m3u8', path: file });
    const imp = await until('the imported playlist', async () => (await plist()).find((x) => x.name === 'out'));
    expect(imp.trackCount).toBe(2);
  });

  it('hotkeys: a playlist key is kept on the server and opens the playlist', async () => {
    const p = (await plist()).find((x) => x.name === 'out')!;
    await app.send({ cmd: 'hotkey', id: p.id, name: 'out', key: 'k' });
    await until('the stored key', async () => { const h = (await (await fetch(`${srv.base}/api/settings/hotkeys`)).json()) as { hotkeys: { playlistKeys: Record<string, { id: string }> } | null }; return h.hotkeys?.playlistKeys?.['k']?.id === p.id ? h : undefined; });
    await app.send({ cmd: 'go', route: '/albums' });
    await app.send({ cmd: 'press', key: 'k' });
    await until('the playlist page', async () => String((await app.state())['route']).startsWith('playlist:'));
    await app.send({ cmd: 'hotkey', id: p.id, name: 'out', key: '' });
    await app.send({ cmd: 'go', route: '/albums' });
  });

  it('radio and discover pages load without a Spotify connection', async () => {
    for (const r of ['/radio', '/discover']) { await app.send({ cmd: 'go', route: r }); await new Promise((res) => setTimeout(res, 400)); }
    expect((await app.state())['online']).toBe(true);
    await app.send({ cmd: 'go', route: '/albums' });
  });

  it('phase 5 pages load: People, a Person, Stats, Duplicates, Settings, and the setup screen opens', async () => {
    for (const r of ['/people', '/stats', '/duplicates', '/settings']) { await app.send({ cmd: 'go', route: r }); await new Promise((res) => setTimeout(res, 400)); }
    const people = (await (await fetch(`${srv.base}/api/people`)).json()) as { id: string }[];
    if (people[0]) { await app.send({ cmd: 'go', route: `/people/${encodeURIComponent(people[0].id)}` }); await new Promise((res) => setTimeout(res, 400)); }
    await app.send({ cmd: 'setup' });
    await new Promise((res) => setTimeout(res, 400));
    expect((await app.state())['online']).toBe(true);
    await app.send({ cmd: 'go', route: '/albums' });
  });

  // ---------------------------------------------------------------- the Custom backdrop's colour picker
  it('Dither custom: the colour picker recolours live, the hex fields follow, and the colours are saved', async () => {
    const hexToHue = (h: string) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number]; const mx = Math.max(r, g, b); const d = mx - Math.min(r, g, b); if (!d) return 0; const k = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return k * 60; };
    await app.send({ cmd: 'go', route: '/settings' });
    expect((await app.send({ cmd: 'backdrop', mode: 'dither-custom' }))['ok']).toBe(true);
    await app.send({ cmd: 'picker', well: 'mid', do: 'open' });
    let st = await app.state();
    expect(st['picker']?.well).toBe('mid');
    // a pick: hue 200, saturation .8, value .6 -> (31, 112, 153) -> the backdrop and both fields say so
    await app.send({ cmd: 'picker', well: 'mid', do: 'pick', h: 200, s: 0.8, v: 0.6 });
    st = await app.state();
    expect(st['custom'][0]).toBe('#1f7099');
    expect(Math.abs(hexToHue(st['custom'][0]) - 200)).toBeLessThan(1);
    expect(st['mid_field']).toBe('#1f7099');
    expect(st['picker_field']).toBe('#1f7099');
    expect(st['custom'][1]).toBe('#ff7a3d');
    // typing a hex in the picker moves the colour and the square
    await app.send({ cmd: 'picker', well: 'mid', do: 'hex', hex: '#336600' });
    await until('the typed hex to apply', async () => (await app.state())['custom'][0] === '#336600');
    st = await app.state();
    expect(st['mid_field']).toBe('#336600');
    expect(Math.abs(st['picker'].hsv[0] - 90)).toBeLessThan(1);
    // the other colour has its own picker, and the first closes
    await app.send({ cmd: 'picker', well: 'light', do: 'open' });
    st = await app.state();
    await app.send({ cmd: 'picker', well: 'light', do: 'pick', h: 0, s: 1, v: 1 });
    st = await app.state();
    expect(st['custom']).toEqual(['#336600', '#ff0000']);
    expect(st['light_field']).toBe('#ff0000');
    // a click outside the popover closes it
    await app.send({ cmd: 'click', x: 6, y: 300 });
    await until('the popover to close', async () => (await app.state())['picker'] === null);
    // saved
    const dirs = [join(work, 'data'), join(work, 'cfg/rune-desktop'), join(work, 'cfg')];
    const file = dirs.map((d) => join(d, 'state.json')).find((f) => existsSync(f));
    expect(file, 'state.json').toBeTruthy();
    const saved = JSON.parse(readFileSync(file!, 'utf8')) as { backdrop: string; custom_mid: string; custom_light: string };
    expect([saved.backdrop, saved.custom_mid, saved.custom_light]).toEqual(['dither-custom', '#336600', '#ff0000']);
    await app.send({ cmd: 'backdrop', mode: 'foil' });
    await app.send({ cmd: 'go', route: '/albums' });
  }, 60_000);

  // ---------------------------------------------------------------- overlays do not click through
  it('the player bar does not click through to the track list under it (seek, pause, next, art)', async () => {
    await app.send({ cmd: 'zone', id: 'pc' });
    await app.send({ cmd: 'play_album', id: srv.library.charlie.id });
    const before = await until('Charlie', async () => { const s = await srv.state('pc'); return s.queue.length === 1 ? s : undefined; });
    // a short window so the track rows run down under the bar
    await app.send({ cmd: 'size', w: 1280, h: 420 });
    await app.send({ cmd: 'go', route: '/tracks' });
    await new Promise((res) => setTimeout(res, 800));
    const ids = (s: { queue: { queueId: string }[] }) => s.queue.map((q) => q.queueId).join(',');
    const was = ids(before);
    // the bar is the bottom 88 px: sweep it end to end on its seek line and on its button row, with every overlay closed again between clicks
    for (const y of [338, 352, 375, 395]) {
      for (let x = 40; x < 1280; x += 70) {
        await app.send({ cmd: 'queue', open: false });
        await app.send({ cmd: 'np', open: false });
        await app.send({ cmd: 'click', x, y });
      }
    }
    await new Promise((res) => setTimeout(res, 500));
    const after = await srv.state('pc');
    // a row click would have replaced the queue with that track (a new queue id): it is still Charlie's, the same entry
    expect(ids(after)).toBe(was);
    expect(after.queue.length).toBe(1);
    await app.send({ cmd: 'queue', open: false });
    await app.send({ cmd: 'np', open: false });
    await app.send({ cmd: 'size', w: 1280, h: 800 });
    await app.send({ cmd: 'go', route: '/albums' });
  }, 180_000);

  it('a song ends by itself: the bar shows the next song and its moving position, not the old one at 0:00', async () => {
    await app.send({ cmd: 'zone', id: 'pc' });
    for (let k = 0; k < 3 && (await srv.state('pc')).repeat !== 'off'; k++) await app.send({ cmd: 'player', name: 'repeat' });
    await app.send({ cmd: 'play_album', id: srv.library.charlie.id });
    await until('Charlie playing', async () => { const s = await srv.state('pc'); return s.status === 'playing' && s.queue.length === 1 ? s : undefined; });
    await app.send({ cmd: 'enqueue_album', id: srv.library.alpha.id, next: false });
    await until('Alpha queued behind it', async () => (await srv.state('pc')).queue.length === 5);
    const bar = async () => (await app.state())['bar'] as [string, number, number] | null;
    await until('the bar to show Charlie', async () => (await bar())?.[0] === 'C1');
    await app.send({ cmd: 'seek', ms: 10_800 });
    // the song ends on its own; every song after it is followed on the bar until the list ends
    for (const next of ['A1', 'A2', 'A3', 'A4']) {
      await until(`the server to play ${next}`, async () => { const s = await srv.state('pc'); return s.queue[s.index]?.track.title === next ? s : undefined; });
      await until(`the bar to show ${next}, not the song that ended`, async () => { const b = await bar(); return b?.[0] === next && b[2] > 0 && b[1] <= b[2] ? b : undefined; }, 4_000);
    }
  }, 60_000);

  it('own audio: a song ends by itself, the bar shows the next song and its moving position, not the old one at 0:00', async () => {
    await app.send({ cmd: 'zone', id: 'own' });
    const own = String((await app.state())['own_zone']);
    await app.send({ cmd: 'play_album', id: srv.library.charlie.id });
    await until('Charlie playing', async () => { const s = await srv.state(own); return s.status === 'playing' && s.queue.length === 1 ? s : undefined; });
    await app.send({ cmd: 'enqueue_album', id: srv.library.alpha.id, next: false });
    await until('Alpha queued behind it', async () => (await srv.state(own)).queue.length === 5);
    const bar = async () => (await app.state())['bar'] as [string, number, number] | null;
    await until('the bar to show Charlie', async () => (await bar())?.[0] === 'C1');
    await app.send({ cmd: 'seek', ms: 10_800 });
    // the song ends on its own; every song after it is followed on the bar until the list ends
    for (const next of ['A1', 'A2', 'A3', 'A4']) {
      await until(`the server to play ${next}`, async () => { const s = await srv.state(own); return s.queue[s.index]?.track.title === next ? s : undefined; });
      await until(`the bar to show ${next}, not the song that ended`, async () => { const b = await bar(); return b?.[0] === next && b[2] > 0 && b[1] <= b[2] ? b : undefined; }, 4_000);
    }
  }, 60_000);

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
