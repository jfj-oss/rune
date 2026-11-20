// The rune mini panel's core (native/linux/core) against a REAL rune server: real silent FLACs, mpv on a null output, a
// temp data dir and its own port. The panel is run headless as `rune-mini-probe`: the same websocket reducer, command
// mapping and REST client the panel uses, with a line protocol on stdin/stdout instead of a window. Nothing is audible.
//
// Needs the probe built: `cd native/linux && cargo build -p rune-mini-core --bin rune-mini-probe`; RUNE_MINI_PROBE names it
// (default: the agent-tmp target dir). Skipped when it is not there, so `pnpm -r test` stays green without a Rust toolchain.
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { haveAudioTools, startServer, until, type Server } from './rig.js';

process.env.LOG_LEVEL = 'silent';
const probePath = process.env.RUNE_MINI_PROBE ?? join(homedir(), 'data/agent-tmp/rune-mini/target/debug/rune-mini-probe');
const ready = haveAudioTools() && existsSync(probePath);

interface View { conn: string; playing_playlist?: string | null; status?: string; index?: number; title?: string | null; queue?: string[]; queue_ids?: string[]; position_ms?: number; volume?: number; shuffle?: boolean; repeat?: string }

class Probe {
  readonly lines: Record<string, unknown>[] = [];
  private child: ChildProcessByStdio<Writable, Readable, null>;
  constructor(url: string, zone = 'pc') {
    this.child = spawn(probePath, [url, zone], { stdio: ['pipe', 'pipe', 'inherit'] });
    createInterface({ input: this.child.stdout }).on('line', (l) => { try { this.lines.push(JSON.parse(l)); } catch { /* not ours */ } });
  }
  view(): View | undefined { return [...this.lines].reverse().find((l) => 'view' in l)?.['view'] as View | undefined; }
  minis(): { id: string; name: string; color: number }[] | undefined { return ([...this.lines].reverse().find((l) => 'minis' in l)?.['minis']) as { id: string; name: string; color: number }[] | undefined; }
  sent(): unknown[] { return this.lines.filter((l) => 'sent' in l).map((l) => l['sent']); }
  cmd(c: Record<string, unknown>) { this.child.stdin.write(`${JSON.stringify(c)}\n`); }
  waitView(what: string, pred: (v: View) => boolean, ms = 10_000) { return until(`the panel to show ${what}`, () => { const v = this.view(); return v && pred(v) ? v : undefined; }, ms); }
  stop() { this.cmd({ cmd: 'quit' }); setTimeout(() => this.child.kill('SIGTERM'), 500).unref(); }
}

describe.skipIf(!ready)('rune mini (headless) against a real server', () => {
  let srv: Server;
  let probe: Probe;
  let alpha: string[];
  let bravo: string[];
  let charlie: string[];
  const titles = async () => (await srv.state('pc')).queue.map((q) => q.track.title);

  beforeAll(async () => {
    srv = await startServer();
    alpha = srv.library.alpha.tracks.map((t) => t.id);
    bravo = srv.library.bravo.tracks.map((t) => t.id);
    charlie = srv.library.charlie.tracks.map((t) => t.id);
    probe = new Probe(srv.base);
    await until('the probe to be ready', () => probe.lines.some((l) => l['ready']));
    await probe.waitView('online', (v) => v.conn === 'Online');
  }, 60_000);
  afterAll(async () => { probe?.stop(); await srv?.stop(); });

  it('a change made on the server reaches the panel (play, queue, volume, shuffle)', { timeout: 30_000 }, async () => {
    await srv.send('pc', { type: 'play', trackIds: [...alpha, ...bravo], startIndex: 0, paused: true });
    const v = await probe.waitView('the queue', (x) => (x.queue?.length ?? 0) === 7 && x.status === 'paused');
    expect(v.queue).toEqual(['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3']);
    expect(v.title).toBe('A1');
    await srv.send('pc', { type: 'volume', volume: 33 });
    await probe.waitView('volume 33', (x) => x.volume === 33);
    await srv.send('pc', { type: 'repeat', mode: 'all' });
    await probe.waitView('repeat all', (x) => x.repeat === 'all');
    await srv.send('pc', { type: 'repeat', mode: 'off' });
    await probe.waitView('repeat off', (x) => x.repeat === 'off');
  });

  it('the panel\'s commands move the server: next, prev, jump, seek, volume, repeat, shuffle', { timeout: 40_000 }, async () => {
    await srv.send('pc', { type: 'clear' });
    await srv.send('pc', { type: 'play', trackIds: [...alpha, ...charlie], startIndex: 0, paused: true });
    await probe.waitView('A1 paused', (x) => x.title === 'A1' && x.status === 'paused' && (x.queue?.length ?? 0) === 5);

    probe.cmd({ cmd: 'next' });
    await until('the server on A2', async () => (await srv.state('pc')).queue[(await srv.state('pc')).index]?.track.title === 'A2');
    await probe.waitView('A2 in the panel', (x) => x.title === 'A2');
    probe.cmd({ cmd: 'prev' });
    await probe.waitView('A1 again', (x) => x.title === 'A1');
    expect((await srv.state('pc')).index).toBe(0);

    probe.cmd({ cmd: 'jump', index: 4 });
    await probe.waitView('C1 current', (x) => x.title === 'C1');
    expect((await srv.state('pc')).index).toBe(4);

    probe.cmd({ cmd: 'seek_to', ms: 6000 });
    const seeked = await until('the server seeked', async () => { const s = await srv.state('pc'); return s.positionMs >= 5900 && s.positionMs < 9000 ? s : undefined; });
    expect(seeked.queue[seeked.index]?.track.title).toBe('C1');
    probe.cmd({ cmd: 'view' });
    await probe.waitView('the position near 6 s', (x) => (x.position_ms ?? 0) >= 5900);

    probe.cmd({ cmd: 'volume', v: 55 });
    await until('volume 55', async () => (await srv.state('pc')).volume === 55);

    probe.cmd({ cmd: 'repeat' });
    await until('repeat all', async () => (await srv.state('pc')).repeat === 'all');
    probe.cmd({ cmd: 'repeat' });
    await until('repeat one', async () => (await srv.state('pc')).repeat === 'one');
    probe.cmd({ cmd: 'repeat' });
    await until('repeat off', async () => (await srv.state('pc')).repeat === 'off');

    probe.cmd({ cmd: 'shuffle' });
    await until('shuffle on', async () => (await srv.state('pc')).shuffle === true);
    await probe.waitView('shuffle in the panel', (x) => x.shuffle === true);
    probe.cmd({ cmd: 'shuffle' });
    await until('shuffle off', async () => (await srv.state('pc')).shuffle === false);
  });

  it('play/pause toggles the real player', { timeout: 30_000 }, async () => {
    await srv.send('pc', { type: 'clear' });
    await srv.send('pc', { type: 'play', trackIds: charlie, startIndex: 0 });
    await probe.waitView('playing', (x) => x.status === 'playing');
    probe.cmd({ cmd: 'play_pause' });
    await until('paused', async () => (await srv.state('pc')).status === 'paused');
    await probe.waitView('paused in the panel', (x) => x.status === 'paused');
    probe.cmd({ cmd: 'play_pause' });
    await until('playing again', async () => (await srv.state('pc')).status === 'playing');
    await srv.send('pc', { type: 'pause' });
  });

  it('queue edits: reorder and remove go to the server and come back', { timeout: 30_000 }, async () => {
    await srv.send('pc', { type: 'clear' });
    await srv.send('pc', { type: 'play', trackIds: [...alpha, ...bravo], startIndex: 0, paused: true });
    const v = await probe.waitView('the 7-song queue', (x) => (x.queue?.length ?? 0) === 7 && x.title === 'A1');
    const ids = v.queue_ids!;
    probe.cmd({ cmd: 'move', queue_id: ids[6], to: 1 });
    await until('B3 moved to the second place', async () => (await titles())[1] === 'B3');
    expect(await titles()).toEqual(['A1', 'B3', 'A2', 'A3', 'A4', 'B1', 'B2']);
    await probe.waitView('the new order in the panel', (x) => x.queue?.[1] === 'B3');
    probe.cmd({ cmd: 'remove', queue_id: ids[1] });
    await until('A2 removed', async () => !(await titles()).includes('A2'));
    await probe.waitView('A2 gone from the panel', (x) => !x.queue?.includes('A2') && x.queue?.length === 6);
    expect(probe.sent().length).toBeGreaterThan(5);
  });

  it('number keys: 1 previous song (always), 2 restart, 3 next, 4 skip 20 %', { timeout: 60_000 }, async () => {
    // the library's only long song (12 s), three times over, so there is time to be well past the 3 s mark
    const idx = async () => (await srv.state('pc')).index;
    const pos = async () => (await srv.state('pc')).positionMs;
    await srv.send('pc', { type: 'clear' });
    await srv.send('pc', { type: 'play', trackIds: [...charlie, ...charlie, ...charlie], startIndex: 1 });
    await probe.waitView('the 3-song queue playing', (x) => x.status === 'playing' && (x.queue?.length ?? 0) === 3 && x.index === 1);
    const dur = (await srv.state('pc')).queue[1]!.track.durationMs;
    expect(dur).toBeGreaterThan(10_000);
    // key 1: well past 3 s, a plain "previous" would only restart this song; key 1 goes back a song
    probe.cmd({ cmd: 'seek_to', ms: 6000 });
    await until('6 s in', async () => ((await pos()) >= 5900 ? true : undefined));
    probe.cmd({ cmd: 'key', name: '1' });
    await until('the first song current', async () => ((await idx()) === 0 ? true : undefined));
    expect(probe.sent().at(-1)).toEqual({ type: 'prev', force: true });
    // key 2 starts it again
    probe.cmd({ cmd: 'seek_to', ms: 6000 });
    await until('6 s in again', async () => ((await pos()) >= 5900 ? true : undefined));
    probe.cmd({ cmd: 'key', name: '2' });
    await until('back at the start', async () => ((await idx()) === 0 && (await pos()) < 1500 ? true : undefined));
    // key 4 skips a fifth of the song
    probe.cmd({ cmd: 'key', name: '4' });
    await until('about 20 % in', async () => { const p = await pos(); return (await idx()) === 0 && p >= 0.2 * dur - 1500 && p <= 0.2 * dur + 2500 ? true : undefined; });
    // key 3 is the next song
    probe.cmd({ cmd: 'key', name: '3' });
    await until('the second song current', async () => ((await idx()) === 1 ? true : undefined));
    // a skip that would pass the end goes to the next song
    probe.cmd({ cmd: 'seek_to', ms: dur - 3000 });
    await until('near the end', async () => ((await idx()) === 1 && (await pos()) >= dur - 3100 ? true : undefined));
    probe.cmd({ cmd: 'key', name: '4' });
    await until('the third song current', async () => ((await idx()) === 2 ? true : undefined));
    await srv.send('pc', { type: 'pause' });
  });

  it('playlist dots: the choice reaches the panel live, a click shuffle-plays that playlist on the zone, the ring follows it', { timeout: 60_000 }, async () => {
    const post = async (path: string, body: unknown) => (await (await fetch(`${srv.base}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as { id: string };
    const mine = await post('/playlists', { name: 'Mini Mix' });
    const other = await post('/playlists', { name: 'Other Mix' });
    await post(`/playlists/${encodeURIComponent(mine.id)}/tracks`, { trackIds: [...alpha, ...bravo] });
    await post(`/playlists/${encodeURIComponent(other.id)}/tracks`, { trackIds: charlie });
    expect(await probe.minis()).toEqual([]);

    // choose two through the API: the probe is told by the websocket push and reads the list
    for (const id of [mine.id, other.id]) expect((await fetch(`${srv.base}/api/mini/playlists/${encodeURIComponent(id)}`, { method: 'PUT' })).status).toBe(200);
    await until('the panel to show both dots', () => (probe.minis()?.length === 2 ? true : undefined));
    expect(probe.minis()!.map((p) => p.name)).toEqual(['Mini Mix', 'Other Mix']);
    expect(new Set(probe.minis()!.map((p) => p.color)).size).toBe(2);

    // a click on dot 0 starts that playlist shuffled
    await srv.send('pc', { type: 'clear' });
    probe.cmd({ cmd: 'playlist', index: 0 });
    const s = await until('the server to have the shuffled queue', async () => { const st = await srv.state('pc'); return st.queue.length === 7 && st.shuffle ? st : undefined; });
    expect(new Set(s.queue.map((q) => q.track.title))).toEqual(new Set(['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3']));
    expect(s.status).toBe('playing');
    const v = await probe.waitView('the ring on dot 0', (x) => x.playing_playlist === mine.id && (x.queue?.length ?? 0) === 7);
    expect(v.shuffle).toBe(true);
    expect(probe.sent()).toContainEqual({ playlist: mine.id });

    // Shift+2 does the same for the second dot, and the ring moves
    probe.cmd({ cmd: 'key', name: '2', shift: true });
    await until('the other playlist queued', async () => (await srv.state('pc')).queue.length === charlie.length);
    await probe.waitView('the ring on dot 1', (x) => x.playing_playlist === other.id);
    // a key beyond the list sends nothing (and a bare 5 is not a key at all)
    probe.cmd({ cmd: 'key', name: '5', shift: true });
    await until('nothing sent for key 5', () => (probe.sent().at(-1) === null ? true : undefined));
    // changing the queue by hand takes the ring away
    await srv.send('pc', { type: 'clear' });
    await probe.waitView('no ring after the queue changed', (x) => x.playing_playlist == null);

    // removing one in big rune reaches the panel at once; a playlist deleted in rune is skipped
    await fetch(`${srv.base}/api/mini/playlists/${encodeURIComponent(mine.id)}`, { method: 'DELETE' });
    await until('one dot left', () => (probe.minis()?.length === 1 ? true : undefined));
    expect(probe.minis()![0]!.id).toBe(other.id);
    await fetch(`${srv.base}/api/playlists/${encodeURIComponent(other.id)}`, { method: 'DELETE' });
    expect(((await (await fetch(`${srv.base}/api/mini/playlists`)).json()) as { playlists: unknown[] }).playlists).toEqual([]);
    await srv.send('pc', { type: 'pause' });
  });

  it('a server restart: the panel shows offline, then reconnects by itself', { timeout: 60_000 }, async () => {
    await srv.restart();
    await probe.waitView('online again after the restart', (x) => x.conn === 'Online', 30_000);
    await srv.send('pc', { type: 'clear' });
    await srv.send('pc', { type: 'play', trackIds: bravo, startIndex: 1, paused: true });
    await probe.waitView('B2 after the reconnect', (x) => x.title === 'B2');
    expect(probe.lines.some((l) => (l['view'] as View | undefined)?.conn.startsWith('Offline'))).toBe(true);
  });
});
