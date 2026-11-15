// The phone's HLS stream of Soloist: what the phone is handed must be valid HLS with a cushion of segments, on every
// new program (a play, skip or seek starts one). ffmpeg and pactl are fakes; nothing is encoded and nothing sounds.
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { SoloistAudio, hlsArgs, phonePlaylist, type AudioRunner } from '../src/soloist/audio.js';
import { createSoloist } from '../src/soloist/index.js';
import { TEST_CONFIG } from './spotify-helpers.js';
import { FakeSoloist, until } from './soloist-fake.js';

const head = (target: number, seq = 0) => `#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:${target}\n#EXT-X-MEDIA-SEQUENCE:${seq}\n#EXT-X-INDEPENDENT-SEGMENTS\n`;
const list = (target: number, durations: number[], seq = 0) =>
  head(target, seq) + durations.map((d, i) => `#EXTINF:${d.toFixed(6)},\nseg${String(seq + i).padStart(5, '0')}.ts\n`).join('');

/** The rules a live playlist must keep for Safari to play it (RFC 8216 4.3.3.1 and 6.2.1). */
function check(text: string): { target: number; durations: number[]; uris: string[] } {
  const targets = [...text.matchAll(/^#EXT-X-TARGETDURATION:(.*)$/gm)].map((m) => m[1]!);
  expect(targets.length).toBe(1);
  expect(targets[0]).toMatch(/^[1-9]\d*$/); // a whole number, never 0
  const target = Number(targets[0]);
  const durations = [...text.matchAll(/^#EXTINF:([\d.]+)/gm)].map((m) => Number(m[1]));
  for (const d of durations) expect(Math.round(d)).toBeLessThanOrEqual(target);
  const uris = text.split('\n').filter((l) => l && !l.startsWith('#'));
  expect(uris.length).toBe(durations.length);
  for (const u of uris) expect(u).toMatch(/^g\d+\/seg\d{5}\.ts$/);
  expect(text.startsWith('#EXTM3U')).toBe(true);
  expect(text).not.toMatch(/#EXT-X-ENDLIST/); // live
  return { target, durations, uris };
}

describe('phonePlaylist: what the phone is handed is always valid HLS', () => {
  it('the playlist that broke the phone (one 0.3 s segment under TARGETDURATION:0) is never served', () => {
    // What ffmpeg wrote at the start of every program before: seen on the iPhone as NotSupportedError, 28 times.
    expect(phonePlaylist(list(0, [0.319]), 1)).toBeNull();
    expect(phonePlaylist(list(0, [0.320089, 0.2997]), 1)).toBeNull();
    // Even when such a list is long enough to serve, the target is put right.
    const fixed = phonePlaylist(list(0, [0.32, 0.3, 0.3, 0.3, 0.3, 0.3]), 4)!;
    expect(check(fixed).target).toBe(1);
  });

  it('waits for a cushion: three segments and more than a second of sound', () => {
    expect(phonePlaylist('', 1)).toBeNull();
    expect(phonePlaylist(head(1), 1)).toBeNull();
    expect(phonePlaylist(list(1, [0.509]), 1)).toBeNull();
    expect(phonePlaylist(list(1, [0.509, 0.503]), 1)).toBeNull();
    expect(phonePlaylist(list(1, [0.3, 0.3, 0.3]), 1)).toBeNull(); // three segments, but under 1.2 s
    const ready = phonePlaylist(list(1, [0.509, 0.503, 0.507]), 7)!;
    const c = check(ready);
    expect(c.uris).toEqual(['g7/seg00000.ts', 'g7/seg00001.ts', 'g7/seg00002.ts']);
    // A segment that ffmpeg listed but whose line is half written is not served either.
    expect(phonePlaylist(`${list(1, [0.5, 0.5])}#EXTINF:0.5,\n`, 1)).toBeNull();
  });

  it('the target duration is the same from a program\'s first playlist to its last, and across programs', () => {
    const targets = new Set<number>();
    for (const gen of [1, 2, 3]) {
      for (let n = 3; n <= 12; n++) targets.add(check(phonePlaylist(list(1, Array.from({ length: n }, (_, i) => (i % 2 ? 0.4914 : 0.5129)), n), gen)!).target);
    }
    expect([...targets]).toEqual([1]);
    // ffmpeg's real output for these arguments (measured on the silent sink): 0.49–0.51 s segments under target 1.
    const real = phonePlaylist(list(1, [0.5091, 0.503167, 0.506922, 0.488811, 0.511711, 0.4921]), 2)!;
    expect(check(real).durations.length).toBe(6);
    // A segment that came out long is still within the target the playlist states.
    expect(check(phonePlaylist(list(1, [0.5, 1.7, 0.5]), 1)!).target).toBe(2);
    // No target line at all (never seen): one is added.
    expect(check(phonePlaylist('#EXTM3U\n#EXTINF:0.5,\nseg00001.ts\n#EXTINF:0.5,\nseg00002.ts\n#EXTINF:0.5,\nseg00003.ts\n', 1)!).target).toBe(1);
  });

  it('the encoder writes equal half-second segments: none of the short first segments that made the target 0', () => {
    const args = hlsArgs('rune-phone', '/run/x', 256).join(' ');
    expect(args).toMatch(/-hls_time 0\.5 /);
    expect(args).not.toMatch(/hls_init_time/);
    expect(args).toMatch(/-i rune-phone\.monitor/); // the silent sink's monitor: nothing here is ever heard on the PC
    expect(args).toMatch(/omit_endlist/);
  });
});

describe('SoloistAudio: programs for the phone', () => {
  const setup = () => {
    const spawned: { args: string[]; killed: boolean }[] = [];
    const runner: AudioRunner = {
      run: async () => ({ ok: true, stdout: '' }),
      spawn: (_c, args) => { const p = { args, killed: false }; spawned.push(p); return { kill: () => { p.killed = true; return true; }, on: () => undefined }; },
    };
    const dir = mkdtempSync(join(tmpdir(), 'rune-hls-'));
    const clock = { t: 1000 };
    const logs: string[] = [];
    const audio = new SoloistAudio({ runner, hlsDir: dir, now: () => clock.t, log: (_o, m) => logs.push(m) });
    const write = (gen: number, text: string) => { mkdirSync(join(dir, `g${gen}`), { recursive: true }); writeFileSync(join(dir, `g${gen}`, 'index.m3u8'), text); };
    return { spawned, dir, clock, logs, audio, write, done: async () => { await audio.close(); rmSync(dir, { recursive: true, force: true }); } };
  };

  it('a new program after a skip is not served until it is playable, and then names its own segments', async () => {
    const t = setup();
    await t.audio.setOutput('phone');
    expect(t.audio.playlist()).toBeNull();
    t.write(1, list(1, [0.5, 0.5, 0.5, 0.5]));
    expect(check(t.audio.playlist()!).uris[0]).toBe('g1/seg00000.ts');
    t.audio.restart(); // the skip
    expect(t.spawned.length).toBe(2);
    expect(t.spawned[0]!.killed).toBe(true);
    // The old program's playlist is gone with it, and the new one starts empty: nothing half-made reaches the phone.
    expect(t.audio.playlist()).toBeNull();
    t.write(2, list(1, [0.5]));
    expect(t.audio.playlist()).toBeNull();
    t.write(2, list(1, [0.5, 0.5]));
    expect(t.audio.playlist()).toBeNull();
    t.write(2, list(1, [0.5, 0.5, 0.5]));
    expect(check(t.audio.playlist()!).uris).toEqual(['g2/seg00000.ts', 'g2/seg00001.ts', 'g2/seg00002.ts']);
    await t.done();
  });

  it('an encoder that stands still while the phone keeps asking is started again, once per five seconds at most', async () => {
    const t = setup();
    await t.audio.setOutput('phone');
    t.audio.playlist();
    t.write(1, list(1, [0.319])); // one segment, then nothing more (seen live: 13 s without a second segment)
    for (let i = 0; i < 30; i++) { t.clock.t += 150; expect(t.audio.playlist()).toBeNull(); }
    expect(t.spawned.length).toBe(1); // 4.5 s: still given time
    for (let i = 0; i < 10; i++) { t.clock.t += 150; t.audio.playlist(); }
    expect(t.spawned.length).toBe(2);
    expect(t.spawned[0]!.killed).toBe(true);
    expect(t.logs.join('\n')).toMatch(/stood still/);
    // The new one works: it is served and left alone for as long as its playlist keeps moving.
    for (let i = 0; i < 100; i++) {
      t.clock.t += 500;
      t.write(2, list(1, [0.5, 0.5, 0.5, 0.5], i));
      expect(check(t.audio.playlist()!).uris[0]).toMatch(/^g2\//);
    }
    expect(t.spawned.length).toBe(2);
    // One that never writes anything at all is retried at that calm pace, not faster.
    t.audio.restart();
    const before = t.spawned.length;
    for (let i = 0; i < 100; i++) { t.clock.t += 150; t.audio.playlist(); } // 15 s
    expect(t.spawned.length - before).toBeLessThanOrEqual(3);
    expect(t.spawned.length - before).toBeGreaterThanOrEqual(2);
    await t.done();
  });
});

describe('GET /soloist/stream/live.m3u8', () => {
  it('holds the request until the program is playable, and answers 503 (retry) instead of a broken playlist', async () => {
    const fake = new FakeSoloist();
    await fake.start();
    const runner: AudioRunner = { run: async () => ({ ok: true, stdout: '' }), spawn: () => ({ kill: () => true, on: () => undefined }) };
    const dir = mkdtempSync(join(tmpdir(), 'rune-hls-'));
    const soloist = createSoloist(TEST_CONFIG, { loadItems: () => [], url: fake.url, runner, hlsDir: dir });
    await until(() => soloist.info().connected);
    const app = Fastify();
    soloist.registerRoutes(app);
    await soloist.setOutput('phone');

    // ffmpeg's first playlists of a program arrive while the phone already waits for the answer.
    const pending = app.inject({ method: 'GET', url: '/soloist/stream/live.m3u8' });
    await new Promise((r) => setTimeout(r, 200));
    mkdirSync(join(dir, 'g1'), { recursive: true });
    writeFileSync(join(dir, 'g1', 'index.m3u8'), list(0, [0.319]));
    await new Promise((r) => setTimeout(r, 400));
    writeFileSync(join(dir, 'g1', 'index.m3u8'), list(1, [0.509, 0.503, 0.507]));
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.apple.mpegurl');
    expect(check(res.body).uris.length).toBe(3);

    await app.close();
    await soloist.close();
    await fake.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});
