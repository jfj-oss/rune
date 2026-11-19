// End-to-end playback on REAL audio files, silently. A real rune server (real mpv on a null output, real scanner, real
// stream route) with a temp data dir on its own port, a library of tiny silent FLACs made with ffmpeg, and, for the
// browser zone, a headless Chromium (muted) driving the real web app. No Spotify, no sound, nothing outside the temp dir.
//
// What it guards (the things that kept breaking): play order, shuffle, skip/prev, repeat one/all, queue edits while
// playing, the end of the queue, two clients seeing one queue, a browser tab following the server queue, and a server
// restart resuming the queue.
import { rmSync } from 'node:fs';
import type { PlayerState } from '@liner/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWeb, haveAudioTools, startServer, until, type Server } from './rig.js';

process.env.LOG_LEVEL = 'silent';
const tools = haveAudioTools();

const titles = (s: PlayerState) => s.queue.map((q) => q.track.title);
const queueIds = (s: PlayerState) => s.queue.map((q) => q.queueId);
const current = (s: PlayerState) => s.queue[s.index]?.track.title;

describe.skipIf(!tools)('the pc zone, on real files (mpv on a null output)', () => {
  let srv: Server;
  let alpha: string[];
  let bravo: string[];
  let charlie: string[];
  const w = () => srv.watch('pc');

  beforeAll(async () => {
    srv = await startServer();
    alpha = srv.library.alpha.tracks.map((t) => t.id);
    bravo = srv.library.bravo.tracks.map((t) => t.id);
    charlie = srv.library.charlie.tracks.map((t) => t.id);
  }, 60_000);
  afterAll(async () => { await srv?.stop(); });

  /** A clean zone for each test: nothing queued, no shuffle, no repeat. */
  async function reset() {
    await srv.send('pc', { type: 'clear' });
    await srv.send('pc', { type: 'shuffle', on: false });
    await srv.send('pc', { type: 'repeat', mode: 'off' });
    await until('a stopped, empty zone', async () => (await srv.state('pc')).status === 'stopped');
  }

  it('plays an album in order, song after song, and stops at the end of the queue', { timeout: 40_000 }, async () => {
    await reset();
    const watcher = w();
    const from = watcher.mark();
    await srv.send('pc', { type: 'play', trackIds: alpha, startIndex: 0 });
    await watcher.waitFor('the whole album played and stopped', (s) => s.status === 'stopped' && s.index === 3, 30_000, from);
    expect(watcher.played(from)).toEqual(['A1', 'A2', 'A3', 'A4']);
    const end = await srv.state('pc');
    expect(end.status).toBe('stopped');
    expect(titles(end)).toEqual(['A1', 'A2', 'A3', 'A4']); // the queue is still there after its end
    expect(end.positionMs).toBe(0);
    // Play from the stopped end starts the last song again; nothing else moves.
    await srv.send('pc', { type: 'resume' });
    await until('the last song playing again', async () => (await srv.state('pc')).status === 'playing');
    expect(current(await srv.state('pc'))).toBe('A4');
    await srv.send('pc', { type: 'clear' });
  });

  it('skip and previous: next walks forward, previous within 3 s goes back, past the end stops', { timeout: 40_000 }, async () => {
    await reset();
    await srv.send('pc', { type: 'play', trackIds: alpha, startIndex: 0 });
    await until('A1 playing', async () => { const s = await srv.state('pc'); return s.status === 'playing' && current(s) === 'A1'; });
    expect(current(await srv.send('pc', { type: 'next' }))).toBe('A2');
    expect(current(await srv.send('pc', { type: 'next' }))).toBe('A3');
    await until('A3 playing', async () => (await srv.state('pc')).status === 'playing');
    expect(current(await srv.send('pc', { type: 'prev' }))).toBe('A2'); // under 3 s in: the song before
    expect(current(await srv.send('pc', { type: 'prev' }))).toBe('A1');
    expect(current(await srv.send('pc', { type: 'prev' }))).toBe('A1'); // nothing before the first: it starts over
    await srv.send('pc', { type: 'jump', index: 3 });
    await until('A4 playing', async () => { const s = await srv.state('pc'); return s.status === 'playing' && current(s) === 'A4'; });
    const past = await srv.send('pc', { type: 'next' });
    expect(past.status).toBe('stopped'); // no song after the last (repeat off)
    expect(past.queue).toHaveLength(4);
  });

  it('previous after 3 s into a song starts that song over instead of going back', { timeout: 40_000 }, async () => {
    await reset();
    await srv.send('pc', { type: 'play', trackIds: [...alpha.slice(0, 1), ...charlie], startIndex: 1 }); // A1, then the 12 s song
    await until('C1 playing', async () => { const s = await srv.state('pc'); return s.status === 'playing' && current(s) === 'C1'; });
    await srv.send('pc', { type: 'seek', positionMs: 6000 });
    const s = await srv.send('pc', { type: 'prev' });
    expect(current(s)).toBe('C1');
    const after = await until('C1 restarted', async () => { const x = await srv.state('pc'); return x.status === 'playing' && x.positionMs < 3000 ? x : undefined; });
    expect(current(after)).toBe('C1');
    await srv.send('pc', { type: 'clear' });
  });

  it('repeat one plays the same song again and again; repeat all comes back to the first after the last', { timeout: 40_000 }, async () => {
    await reset();
    const watcher = w();
    await srv.send('pc', { type: 'repeat', mode: 'one' });
    let from = watcher.mark();
    await srv.send('pc', { type: 'play', trackIds: alpha.slice(0, 2), startIndex: 0 });
    // A1 is 1.4 s long: in 5 s it must have started over at least twice, and never reached A2
    await until('A1 played over (position went back twice)', () => {
      let wraps = 0;
      const seen = watcher.states.slice(from).filter((s) => s.status === 'playing');
      for (let i = 1; i < seen.length; i++) if (seen[i]!.positionMs + 500 < seen[i - 1]!.positionMs) wraps++;
      return wraps >= 2;
    }, 15_000);
    expect(new Set(watcher.states.slice(from).map((s) => s.index))).toEqual(new Set([0]));
    // switching it off lets the song finish and the queue go on
    await srv.send('pc', { type: 'repeat', mode: 'off' });
    await watcher.waitFor('A2 reached', (s) => s.status === 'playing' && current(s) === 'A2', 15_000, from);

    await reset();
    await srv.send('pc', { type: 'repeat', mode: 'all' });
    from = watcher.mark();
    await srv.send('pc', { type: 'play', trackIds: alpha.slice(0, 2), startIndex: 0 });
    await until('A1, A2, A1 again', () => watcher.played(from).length >= 3, 20_000);
    expect(watcher.played(from).slice(0, 3)).toEqual(['A1', 'A2', 'A1']);
    await srv.send('pc', { type: 'repeat', mode: 'off' });
    await watcher.waitFor('the queue ends once repeat is off', (s) => s.status === 'stopped', 20_000, watcher.mark());
  });

  it('shuffle mixes the queue once; stepping through plays every song once; the order is stable across a reconnect', { timeout: 40_000 }, async () => {
    await reset();
    const all = [...alpha, ...bravo];
    let started: PlayerState | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      started = await srv.send('pc', { type: 'play', trackIds: all, startIndex: 0, shuffle: true });
      if (titles(started).join() !== ['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3'].join()) break;
    }
    expect(started!.shuffle).toBe(true);
    expect(started!.index).toBe(0);
    expect([...titles(started!)].sort()).toEqual(['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3']);
    expect(titles(started!).join()).not.toBe(['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3'].join()); // really mixed
    const order = titles(started!);
    const ids = queueIds(started!);

    // a second client, and a reconnect: the same order everywhere
    const other = srv.watch('pc');
    await until('the other client sees the queue', () => other.last());
    expect(titles(other.last()!)).toEqual(order);
    const reread = await srv.state('pc');
    expect(titles(reread)).toEqual(order);
    expect(queueIds(reread)).toEqual(ids);

    const heard: string[] = [current(started!)!];
    for (let i = 0; i < 6; i++) heard.push(current(await srv.send('pc', { type: 'next' }))!);
    expect(heard).toEqual(order); // each song once, in the order the queue shows
    expect(new Set(heard).size).toBe(7);
    expect((await srv.send('pc', { type: 'next' })).status).toBe('stopped');

    // turning it off keeps the order; turning it on mixes only what comes after the current song
    const off = await srv.send('pc', { type: 'shuffle', on: false });
    expect(titles(off)).toEqual(order);
    await srv.send('pc', { type: 'jump', index: 2 });
    const on = await srv.send('pc', { type: 'shuffle', on: true });
    expect(titles(on).slice(0, 3)).toEqual(order.slice(0, 3));
    expect([...titles(on)].sort()).toEqual([...order].sort());
    await srv.send('pc', { type: 'clear' });
  });

  it('with shuffle on, a new album starts at the chosen song and mixes the rest', { timeout: 20_000 }, async () => {
    await reset();
    await srv.send('pc', { type: 'shuffle', on: true });
    const s = await srv.send('pc', { type: 'play', trackIds: alpha, startIndex: 2 });
    expect(s.shuffle).toBe(true);
    expect(s.index).toBe(0);
    expect(current(s)).toBe('A3');
    expect([...titles(s)].sort()).toEqual(['A1', 'A2', 'A3', 'A4']);
    await srv.send('pc', { type: 'clear' });
  });

  it('queue edits during playback: play next, add, remove, move, remove the current song', { timeout: 60_000 }, async () => {
    await reset();
    const watcher = w();
    const from = watcher.mark();
    await srv.send('pc', { type: 'play', trackIds: alpha, startIndex: 0 });
    await until('A1 playing', async () => { const s = await srv.state('pc'); return s.status === 'playing' && current(s) === 'A1'; });

    let s = await srv.send('pc', { type: 'enqueue', trackIds: [bravo[0]!], next: true });
    expect(titles(s)).toEqual(['A1', 'B1', 'A2', 'A3', 'A4']);
    s = await srv.send('pc', { type: 'enqueue', trackIds: [bravo[1]!] });
    expect(titles(s)).toEqual(['A1', 'B1', 'A2', 'A3', 'A4', 'B2']);
    const a3 = s.queue.find((q) => q.track.title === 'A3')!.queueId;
    s = await srv.send('pc', { type: 'remove', queueId: a3 });
    expect(titles(s)).toEqual(['A1', 'B1', 'A2', 'A4', 'B2']);
    const a4 = s.queue.find((q) => q.track.title === 'A4')!.queueId;
    s = await srv.send('pc', { type: 'move', queueId: a4, toIndex: 1 });
    expect(titles(s)).toEqual(['A1', 'A4', 'B1', 'A2', 'B2']);
    expect(current(s)).toBe('A1');
    expect(s.status).toBe('playing'); // none of it interrupted the song

    await watcher.waitFor('the edited queue played to its end', (x) => x.status === 'stopped' && x.index === 4, 30_000, from);
    expect(watcher.played(from)).toEqual(['A1', 'A4', 'B1', 'A2', 'B2']);

    // removing the song that plays moves on to the next one
    await reset();
    await srv.send('pc', { type: 'play', trackIds: alpha.slice(0, 3), startIndex: 0 });
    await until('A1 playing', async () => { const x = await srv.state('pc'); return x.status === 'playing' && current(x) === 'A1'; });
    const first = (await srv.state('pc')).queue[0]!.queueId;
    s = await srv.send('pc', { type: 'remove', queueId: first });
    expect(titles(s)).toEqual(['A2', 'A3']);
    expect(current(s)).toBe('A2');
    await until('A2 playing', async () => { const x = await srv.state('pc'); return x.status === 'playing' && current(x) === 'A2'; });
    await srv.send('pc', { type: 'clear' });
  });

  it('two clients see one queue: what one does, the other sees, with the same ids and order', { timeout: 30_000 }, async () => {
    await reset();
    const one = srv.watch('pc');
    const two = srv.watch('pc');
    await srv.send('pc', { type: 'play', trackIds: [...alpha, ...bravo], startIndex: 1 });
    await until('both see the queue', () => one.last()?.queue.length === 7 && two.last()?.queue.length === 7);
    expect(queueIds(one.last()!)).toEqual(queueIds(two.last()!));
    await srv.send('pc', { type: 'next' });
    await until('both on A3', () => current(one.last()!) === 'A3' && current(two.last()!) === 'A3');
    const a = srv.watch('pc');
    await srv.send('pc', { type: 'enqueue', trackIds: [charlie[0]!] });
    await until('both see the new song', () => titles(one.last()!).at(-1) === 'C1' && titles(two.last()!).at(-1) === 'C1' && titles(a.last()!).at(-1) === 'C1');
    const rest = await srv.state('pc');
    for (const x of [one.last()!, two.last()!, a.last()!]) {
      expect(queueIds(x)).toEqual(queueIds(rest));
      expect(x.index).toBe(rest.index);
      expect(x.rev).toBe(rest.rev);
    }
    await srv.send('pc', { type: 'clear' });
  });

  it('a server restart resumes the queue: same songs, order, cursor and modes, paused and silent until Play', { timeout: 60_000 }, async () => {
    await reset();
    await srv.send('pc', { type: 'play', trackIds: [...alpha, ...bravo], startIndex: 0, shuffle: true });
    await srv.send('pc', { type: 'repeat', mode: 'all' });
    await srv.send('pc', { type: 'next' });
    await until('a song playing', async () => (await srv.state('pc')).status === 'playing');
    await srv.send('pc', { type: 'seek', positionMs: 500 });
    await srv.send('pc', { type: 'pause' });
    const before = await srv.state('pc');
    expect(before.status).toBe('paused');

    await srv.restart();
    const after = await srv.state('pc');
    expect(after.status).toBe('paused');
    expect(queueIds(after)).toEqual(queueIds(before));
    expect(titles(after)).toEqual(titles(before));
    expect(after.index).toBe(before.index);
    expect(after.shuffle).toBe(true);
    expect(after.repeat).toBe('all');
    expect(after.positionMs).toBeGreaterThanOrEqual(400);

    const watcher = srv.watch('pc');
    const from = watcher.mark();
    await srv.send('pc', { type: 'resume' });
    const resumedOn = current(before);
    await watcher.waitFor('the saved song playing again', (s) => s.status === 'playing' && current(s) === resumedOn, 15_000, from);
    // and the queue goes on from there
    const nextTitle = titles(before)[(before.index + 1) % 7];
    await watcher.waitFor('the next song after it', (s) => s.status === 'playing' && current(s) === nextTitle, 15_000, from);
    await srv.send('pc', { type: 'clear' });
  });
});

// ---------------------------------------------------------------------------------------------------- the browser

const E2E_CLIENT = 'e2eclient0001';
const ZONE = `browser:${E2E_CLIENT}`;

describe.skipIf(!tools)('the browser zone: a muted headless Chromium follows the server queue', () => {
  let srv: Server;
  let webDist: string;
  let browser: import('playwright-core').Browser | undefined;
  let chromiumFound = false;

  beforeAll(async () => {
    const { chromiumPath } = await import('./rig.js');
    const path = chromiumPath();
    chromiumFound = path !== null;
    if (!path) return;
    webDist = buildWeb();
    srv = await startServer({ webDist });
    const { chromium } = await import('playwright-core');
    // The GPU path the user always wants (never SwiftShader), muted, no keyring popups.
    browser = await chromium.launch({
      executablePath: path,
      headless: true,
      args: ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio',
        '--autoplay-policy=no-user-gesture-required', '--password-store=basic', '--use-mock-keychain'],
    });
  }, 90_000);
  afterAll(async () => {
    await browser?.close();
    await srv?.stop();
    if (webDist) rmSync(webDist, { recursive: true, force: true });
  });

  /** The page's own audio elements, as the app made them, and the stream requests it made. */
  const INIT = `
    window.__media = new Set();
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { window.__media.add(this); return orig.apply(this, arguments); };
  `;
  async function openPage(ctx: import('playwright-core').BrowserContext, path = '/') {
    const page = await ctx.newPage();
    const streams: string[] = [];
    page.on('request', (r) => { const m = /\/api\/stream\/([^?]+)/.exec(r.url()); if (m && r.method() === 'GET') { const id = decodeURIComponent(m[1]!); if (streams.at(-1) !== id) streams.push(id); } });
    await page.goto(`${srv.base}${path}`);
    return { page, streams };
  }
  const sounding = (page: import('playwright-core').Page) =>
    page.evaluate(() => [...((window as unknown as { __media: Set<HTMLAudioElement> }).__media ?? [])].filter((m) => !m.paused && !m.ended && m.currentTime >= 0 && m.src).map((m) => decodeURIComponent(m.src.split('/api/stream/')[1]!.split('?')[0]!)));
  async function newContext() {
    const ctx = await browser!.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(`try { localStorage.setItem('rune.client', '${E2E_CLIENT}'); localStorage.setItem('rune.zone', JSON.stringify('${ZONE}')); } catch (e) {}\n${INIT}`);
    return ctx;
  }
  const idOf = (title: string) => srv.library.byTitle.get(title)!;

  it('a page opened while the zone plays takes it over and plays the queue through, song after song, then stops', { timeout: 60_000 }, async () => {
    if (!chromiumFound) return; // no Chromium on this machine
    const ctx = await newContext();
    const watcher = srv.watch(ZONE);
    const from = watcher.mark();
    await srv.send(ZONE, { type: 'play', trackIds: ['A1', 'A2', 'B1'].map(idOf), startIndex: 0 });
    const { page, streams } = await openPage(ctx);
    await watcher.waitFor('the tab started A1', (s) => s.status === 'playing' && current(s) === 'A1', 20_000, from);
    expect(await until('the tab sounding A1', async () => { const m = await sounding(page); return m.length ? m : undefined; })).toEqual([idOf('A1')]);
    await watcher.waitFor('the end of the queue', (s) => s.status === 'stopped' && s.index === 2, 30_000, from);
    expect(watcher.played(from)).toEqual(['A1', 'A2', 'B1']);
    expect(streams).toEqual(['A1', 'A2', 'B1'].map(idOf)); // the tab fetched exactly the server's songs, in order
    expect(await sounding(page)).toEqual([]);
    await ctx.close();
  });

  it('Play pressed in the page sounds that album; pause, resume, next, seek and a shuffle from the server reach the tab', { timeout: 60_000 }, async () => {
    if (!chromiumFound) return;
    await srv.send(ZONE, { type: 'clear' });
    const ctx = await newContext();
    const { page, streams } = await openPage(ctx, `/album/${encodeURIComponent(srv.library.alpha.id)}`);
    const watcher = srv.watch(ZONE);
    const from = watcher.mark();
    await page.locator('button.btn--primary', { hasText: 'Play' }).first().click();
    await watcher.waitFor('A1 playing', (s) => s.status === 'playing' && current(s) === 'A1', 20_000, from);
    expect(await until('the tab sounding A1', async () => { const m = await sounding(page); return m.length ? m : undefined; })).toEqual([idOf('A1')]);

    await srv.send(ZONE, { type: 'pause' });
    await until('the tab silent', async () => (await sounding(page)).length === 0);
    await srv.send(ZONE, { type: 'resume' });
    await until('the tab sounding again', async () => (await sounding(page)).length === 1);

    await srv.send(ZONE, { type: 'next' });
    expect(await until('the tab on A2', async () => { const m = await sounding(page); return m[0] === idOf('A2') ? m : undefined; })).toEqual([idOf('A2')]);
    expect(streams.slice(0, 2)).toEqual([idOf('A1'), idOf('A2')]);

    // the server edits the queue (shuffle mixes what comes after A2): the tab follows the new order
    const s = await srv.send(ZONE, { type: 'shuffle', on: true });
    const order = titles(s).slice(s.index);
    const mark = watcher.mark();
    await watcher.waitFor('the end of the mixed queue', (x) => x.status === 'stopped', 30_000, mark);
    expect(watcher.played(mark).slice(0, order.length)).toEqual(order.slice(watcher.played(mark)[0] === order[0] ? 0 : 1));
    await ctx.close();
  });

  it('two tabs of one browser: only one sounds the zone', { timeout: 60_000 }, async () => {
    if (!chromiumFound) return;
    await srv.send(ZONE, { type: 'clear' });
    const ctx = await newContext();
    await srv.send(ZONE, { type: 'play', trackIds: [idOf('C1')], startIndex: 0 });
    const first = await openPage(ctx);
    await until('the first tab sounding', async () => (await sounding(first.page)).length === 1);
    const second = await openPage(ctx);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await sounding(first.page)).length + (await sounding(second.page)).length).toBe(1);
    expect((await srv.state(ZONE)).status).toBe('playing');
    await srv.send(ZONE, { type: 'clear' });
    await ctx.close();
  });
});
