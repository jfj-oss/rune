// Spotify on a phone through Soloist on the PC (phoneSoloist.ts): the browser zone's Spotify half on a handheld.
// Fake soloist zone (what the server's SoloistZone reports), fake <audio> element, fake output switch; nothing real.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ZoneInfo } from '../lib/types';
import { PhoneSoloistEngine, phoneSoloistRoute, type StreamElement } from './phoneSoloist';
import { FakeZone, mkTrack } from './testkit';

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
