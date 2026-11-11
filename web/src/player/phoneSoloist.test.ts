// Spotify on a phone through Soloist on the PC (phoneSoloist.ts): the browser zone's Spotify half on a handheld.
// Fake soloist zone (what the server's SoloistZone reports), fake <audio> element, fake output switch; nothing real.
import type { Track } from '@liner/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ZoneInfo } from '../lib/types';
import type { Engine } from './engine';
import { HybridEngine } from './hybrid';
import { LocalBackend } from './local';
import { PhoneSoloistEngine, phoneSoloistRoute, type StreamElement } from './phoneSoloist';
import { FakeZone, mkItem, mkTrack } from './testkit';

const flush = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

class FakeEl implements StreamElement {
  src = '';
  paused = true;
  loads = 0;
  plays: string[] = [];
  private handlers = new Map<string, () => void>();
  play() { this.paused = false; this.plays.push(this.src); return Promise.resolve(); }
  pause() { this.paused = true; }
  load() { this.loads++; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
  addEventListener(type: string, fn: () => void) { this.handlers.set(type, fn); }
  fire(type: string) { this.handlers.get(type)?.(); }
}

/** The phone's own player for local files, as far as the hand-over needs it. */
class FakeLocal implements Engine {
  loaded: string[] = [];
  stopped = 0;
  private endedFn = () => {};
  load(track: Track) { this.loaded.push(track.id); }
  play() {}
  pause() {}
  seek() {}
  setVolume() {}
  position() { return null; }
  stop() { this.stopped++; }
  onEnded(fn: () => void) { this.endedFn = fn; }
  onError() {}
  end() { this.endedFn(); }
}

function setup() {
  const zone = new FakeZone('soloist');
  zone.soloist = true;
  zone.connected = () => true;
  const el = new FakeEl();
  const outputs: string[] = [];
  const notice = vi.fn();
  let problem: string | null = null;
  const engine = new PhoneSoloistEngine(zone, {
    element: () => el,
    toPhone: async () => { outputs.push(`phone@${zone.log.length}`); zone.setOutput('phone'); return { problem }; },
    notice,
    retryMs: { error: 0, stalled: 0 },
  }, { pollMs: 60_000, startTimeoutMs: 5000 });
  const ended = vi.fn(), sync = vi.fn(), err = vi.fn(), volume = vi.fn();
  engine.onEnded(ended); engine.onSync(sync); engine.onError(err); engine.onVolume(volume);
  return { zone, el, outputs, engine, notice, ended, sync, err, volume, setProblem: (p: string | null) => { problem = p; } };
}
const S = (n: number) => mkTrack(`sp:${n}`, 'spotify');
const L = (n: number) => mkTrack(`l:${n}`, 'local');

let live: { stop(): void }[] = [];
afterEach(() => { for (const x of live.splice(0)) x.stop(); });

describe('phoneSoloistRoute: can this phone hear Spotify through Soloist?', () => {
  const PC_SOLOIST: ZoneInfo = { id: 'pc', name: 'PC', kind: 'pc', spotifyEngine: 'soloist', spotifyZone: 'soloist' };
  const PC_APP: ZoneInfo = { id: 'pc', name: 'PC', kind: 'pc', spotifyEngine: 'app', spotifyNotice: 'Soloist needs updating (its build expired) — using the Spotify app' };
  const SOLOIST_DOWN: ZoneInfo = { id: 'soloist', name: 'Spotify (Soloist)', kind: 'spotify', soloist: true, output: 'pc', available: false, problem: 'Soloist is not running yet — try again in a moment', notice: 'Soloist is not running yet — using the Spotify app' };
  it('yes while the server names Soloist as the pc zone’s engine (the Soloist entry is folded away then)', () => {
    expect(phoneSoloistRoute([PC_SOLOIST, { id: 'browser', name: 'This iPhone', kind: 'browser' }])).toEqual({ available: true, notice: null });
  });
  it('no, with the one-line reason in the PC’s words, when Soloist cannot play', () => {
    expect(phoneSoloistRoute([PC_APP, SOLOIST_DOWN])).toEqual({ available: false, notice: 'Soloist is not running yet — using the Spotify app' });
    expect(phoneSoloistRoute([PC_APP])).toEqual({ available: false, notice: PC_APP.spotifyNotice });
  });
  it('no, and nothing to say, when Soloist is not part of this rune (the app route is the only one, as before)', () => {
    expect(phoneSoloistRoute([{ id: 'pc', name: 'PC', kind: 'pc' }])).toEqual({ available: false, notice: null });
  });
  it('a server without a pc zone: the Soloist entry speaks for itself', () => {
    expect(phoneSoloistRoute([{ ...SOLOIST_DOWN, available: true, problem: undefined, notice: undefined }]).available).toBe(true);
  });
});

describe('PhoneSoloistEngine', () => {
  it('a Spotify song: Soloist’s sound goes to the phone first, then the song plays on the soloist zone, and the element joins the program — no Connect device, no volume push', async () => {
    const { zone, el, outputs, engine } = setup();
    live.push(engine);
    zone.state = { ...zone.state, volume: 55 };
    engine.load(S(1), 0, true);
    await flush();
    expect(outputs).toEqual(['phone@0']); // before anything was sent to the zone
    expect(zone.log).toEqual(['play:sp:1@0']); // no volume command: Soloist keeps its own level
    expect(el.src).toMatch(/\/api\/soloist\/stream\/live\.m3u8\?t=/);
    expect(el.paused).toBe(false);
    expect(el.loads).toBe(1);
  });

  it('pause and resume pause and resume the element; a seek is a new program, so the element reloads', async () => {
    const { zone, el, engine } = setup();
    live.push(engine);
    engine.load(S(1), 0, true);
    await flush();
    engine.pause();
    await flush();
    expect(zone.log.at(-1)).toBe('pause');
    expect(el.paused).toBe(true);
    engine.play();
    await flush();
    expect(zone.log.at(-1)).toBe('resume');
    expect(el.paused).toBe(false);
    const loads = el.loads;
    engine.seek(30_000);
    await flush();
    expect(zone.log.at(-1)).toBe('seek:30000');
    expect(el.loads).toBe(loads + 1);
    expect(el.paused).toBe(false);
  });

  it('a stalled or errored element rejoins the program while the song plays (the program it had ended: a skip)', async () => {
    const { el, engine } = setup();
    live.push(engine);
    engine.load(S(1), 0, true);
    await flush();
    const loads = el.loads;
    el.fire('stalled');
    await flush();
    expect(el.loads).toBe(loads + 1);
    engine.pause();
    await flush();
    el.fire('error');
    await flush();
    expect(el.loads).toBe(loads + 1); // paused: nothing to rejoin
  });

  it('Soloist’s level is the slider’s: adopted on the first state, and a slider move sends it', async () => {
    const { zone, engine, volume } = setup();
    live.push(engine);
    zone.state = { ...zone.state, volume: 40 };
    engine.load(S(1), 0, true);
    await flush();
    expect(volume).toHaveBeenCalledWith(40);
    engine.setVolume(25);
    await flush();
    expect(zone.log.at(-1)).toBe('volume:25');
  });

  it('a problem switching the output is told, and the song is still tried', async () => {
    const { zone, engine, notice, setProblem } = setup();
    live.push(engine);
    setProblem('Soloist is not signed in to Spotify — pair it once (soloist --pair), then try again');
    engine.load(S(1), 0, true);
    await flush();
    expect(notice).toHaveBeenCalledWith(expect.stringMatching(/not signed in/));
    expect(zone.log).toContain('play:sp:1@0');
  });

  it('the PC takes Soloist back (its own song, sound on the speakers): the element goes silent and nothing is sent to pause the PC', async () => {
    const { zone, el, engine, sync } = setup();
    live.push(engine);
    engine.load(S(1), 0, true);
    await flush();
    zone.progress(20_000);
    expect(el.src).not.toBe('');
    // The PC's page: output back to the speakers, then its own queue.
    zone.setOutput('pc');
    const before = zone.log.length;
    await zone.send({ type: 'play', trackIds: ['sp:9'], startIndex: 0 });
    await flush();
    expect(el.src).toBe('');
    expect(sync).toHaveBeenLastCalledWith(expect.any(Number), false); // the phone's queue shows paused
    engine.pause();
    engine.stop();
    await flush();
    expect(zone.log.slice(before)).toEqual(['play:sp:9@0']); // not a word to the PC's playback
  });

  it('Spotify’s autoplay after our last song still streams here: stopping the queue pauses Soloist', async () => {
    const { zone, el, engine, ended } = setup();
    live.push(engine);
    engine.load(S(1), 0, true);
    await flush();
    zone.progress(199_000);
    zone.autoplay('sp:x1');
    await flush();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(el.src).toBe(''); // not our song
    engine.pause(); // what the queue does at its end
    await flush();
    expect(zone.log.at(-1)).toBe('pause');
  });
});

describe('the phone’s queue over the hybrid engine (local files here, Spotify through Soloist)', () => {
  function queue() {
    const s = setup();
    const local = new FakeLocal();
    const notice = vi.fn();
    const b = new LocalBackend('browser', new HybridEngine(local, s.engine), undefined, notice);
    live.push({ stop: () => b.dispose() });
    return { ...s, local, b, notice };
  }
  const play = (tracks: Track[], startIndex = 0) => ({ type: 'play' as const, trackIds: tracks.map((t) => t.id), startIndex });

  it('a run of Spotify songs goes to Soloist together; when it moves on to the next, the queue follows without a new play and the element keeps the program', async () => {
    const { zone, el, b } = queue();
    const tracks = [S(1), S(2), S(3)];
    await b.send(play(tracks), tracks.map(mkItem));
    await flush();
    expect(zone.log).toEqual(['play:sp:1,sp:2,sp:3@0']);
    const loads = el.loads;
    zone.progress(198_000);
    zone.moveOn(); // Soloist went on to sp:2 by itself (gapless)
    await flush();
    expect(b.state.index).toBe(1);
    expect(b.state.status).toBe('playing');
    expect(zone.log).toEqual(['play:sp:1,sp:2,sp:3@0']); // nothing re-sent
    expect(el.loads).toBe(loads); // same program, no reload
    expect(el.paused).toBe(false);
  });

  it('mixed queue: a local file plays here, the Spotify song after it through Soloist, the local one after that here again — Soloist silenced in between', async () => {
    const { zone, el, b, local, outputs } = queue();
    const tracks = [L(1), S(1), L(2)];
    await b.send(play(tracks), tracks.map(mkItem));
    await flush();
    expect(local.loaded).toEqual(['l:1']);
    expect(zone.log).toEqual([]);
    expect(outputs).toEqual([]);
    local.end();
    await flush();
    expect(b.state.index).toBe(1);
    expect(outputs).toEqual(['phone@0']);
    expect(zone.log).toEqual(['play:sp:1@0']); // only the Spotify run (one song) goes to Soloist
    expect(el.src).not.toBe('');
    zone.progress(199_000);
    zone.finish(); // Soloist went idle
    await flush();
    expect(b.state.index).toBe(2);
    expect(local.loaded).toEqual(['l:1', 'l:2']);
    expect(el.src).toBe('');
    expect(zone.log.filter((l) => l.startsWith('play'))).toEqual(['play:sp:1@0']);
  });

  it('Next during a Spotify run restarts Soloist on the chosen song (a new program the element joins)', async () => {
    const { zone, el, b } = queue();
    const tracks = [S(1), S(2)];
    await b.send(play(tracks), tracks.map(mkItem));
    await flush();
    const plays = el.plays.length;
    await b.send({ type: 'next' });
    await flush();
    expect(zone.log.filter((l) => l.startsWith('play'))).toEqual(['play:sp:1,sp:2@0', 'play:sp:2@0']);
    expect(el.plays.length).toBe(plays + 1); // joined the new program once
    expect(el.src).not.toBe('');
    expect(el.paused).toBe(false);
  });

  it('the slider shows Soloist’s level while a Spotify song sounds, and moves it', async () => {
    const { zone, b } = queue();
    zone.state = { ...zone.state, volume: 35 };
    await b.send(play([S(1)]), [mkItem(S(1))]);
    await flush();
    expect(b.state.volume).toBe(35);
    await b.send({ type: 'volume', volume: 60 });
    await flush();
    expect(zone.log.at(-1)).toBe('volume:60');
  });
});
