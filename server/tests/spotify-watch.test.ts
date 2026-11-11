import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlayerState } from '@liner/shared';
import { createSpotifyWatch, parseMonitorLine, parsePosition, SPOTIFY_WATCH_FILE, type WatchChild } from '../src/play/spotifyWatch.js';

// Shaped like real `gdbus monitor` output from the Spotify flatpak.
const CHANGED =
  "/org/mpris/MediaPlayer2: org.freedesktop.DBus.Properties.PropertiesChanged ('org.mpris.MediaPlayer2.Player', " +
  "{'PlaybackStatus': <'Playing'>, 'Metadata': <{'mpris:trackid': <'/com/spotify/track/3TDPmzKGcEY8JEMfJEeQYx'>, " +
  "'mpris:length': <uint64 231000000>, 'xesam:title': <'SECRET TITLE'>, 'xesam:artist': <['SECRET ARTIST']>}>}, @as [])";
const PAUSED = "/org/mpris/MediaPlayer2: org.freedesktop.DBus.Properties.PropertiesChanged ('org.mpris.MediaPlayer2.Player', {'PlaybackStatus': <'Paused'>}, @as [])";
const SEEKED = '/org/mpris/MediaPlayer2: org.mpris.MediaPlayer2.Player.Seeked (int64 61500000,)';

const volume = (p: string) => ({ 'front-left': { value_percent: p }, 'front-right': { value_percent: p } });
const SINKS = JSON.stringify([{ index: 54, name: 'alsa_output.usb-Topping_E30', mute: false, volume: volume('90%') }]);
const INPUTS = (corked: boolean) =>
  JSON.stringify([{ index: 2, sink: 54, corked, mute: false, volume: volume('100%'), properties: { 'application.name': 'spotify', 'media.name': 'SECRET TITLE' } }]);

class FakeChild implements WatchChild {
  lines: ((l: string) => void)[] = [];
  exits: (() => void)[] = [];
  killed = false;
  onLine(fn: (l: string) => void) { this.lines.push(fn); }
  onExit(fn: () => void) { this.exits.push(fn); }
  kill() { this.killed = true; }
  say(l: string) { for (const f of this.lines) f(l); }
  die() { for (const f of this.exits) f(); }
}

const connectState = (over: Partial<PlayerState> = {}): PlayerState => ({
  zone: 'spotify:mypc', status: 'playing', index: 0, positionMs: 1234, volume: 70, shuffle: false, repeat: 'off', updatedAt: 1,
  queue: [{ queueId: 'q', album: { id: 'a', title: 'SECRET ALBUM' }, track: { id: 'sp:abc', albumId: 'a', source: 'spotify', title: 'SECRET TITLE', artists: [], disc: 1, number: 1, durationMs: 1000 } }],
  ...over,
});

describe('reading gdbus monitor', () => {
  it('takes the status, the id and the length, never the title', () => {
    expect(parseMonitorLine(CHANGED)).toEqual({ ev: 'signal', status: 'Playing', trackId: 'sp:3TDPmzKGcEY8JEMfJEeQYx', lengthMs: 231000 });
    expect(JSON.stringify(parseMonitorLine(CHANGED))).not.toContain('SECRET');
    expect(parseMonitorLine(PAUSED)).toEqual({ ev: 'signal', status: 'Paused' });
  });
  it('reads Seeked, the app coming and going, and ignores the rest', () => {
    expect(parseMonitorLine(SEEKED)).toEqual({ ev: 'seeked', positionMs: 61500 });
    expect(parseMonitorLine('The name org.mpris.MediaPlayer2.spotify is owned by :1.264')).toEqual({ ev: 'owner', owned: true });
    expect(parseMonitorLine('The name org.mpris.MediaPlayer2.spotify does not have an owner')).toEqual({ ev: 'owner', owned: false });
    expect(parseMonitorLine('Monitoring signals on object /org/mpris/MediaPlayer2 owned by org.mpris.MediaPlayer2.spotify')).toBeNull();
  });
  it('an ad or no track has no id', () => {
    expect(parseMonitorLine(CHANGED.replace('/com/spotify/track/3TDPmzKGcEY8JEMfJEeQYx', '/com/spotify/ad/xyz'))?.trackId).toBeNull();
  });
  it('reads busctl Position in ms', () => {
    expect(parsePosition('{"type":"x","data":12500000}')).toBe(12500);
    expect(parsePosition(null)).toBeNull();
  });
});

describe('the spotify watch', () => {
  let dir: string;
  let kids: Map<string, FakeChild[]>;
  let asked: string[];
  let corked: boolean;
  const lines = () => readFileSync(join(dir, SPOTIFY_WATCH_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const start = () =>
    createSpotifyWatch({
      dataDir: dir,
      positionEveryMs: 10_000,
      spawn: (c, a) => {
        const k = new FakeChild();
        kids.set(c, [...(kids.get(c) ?? []), k]);
        asked.push(`spawn ${c} ${a.join(' ')}`);
        return k;
      },
      probe: async (c, a) => {
        asked.push(`${c} ${a.join(' ')}`);
        if (c === 'busctl') return a.at(-1) === 'Position' ? '{"type":"x","data":5000000}' : '{"type":"s","data":"Paused"}';
        return a.at(-1) === 'sinks' ? SINKS : INPUTS(corked);
      },
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rune-spotify-watch-'));
    kids = new Map();
    asked = [];
    corked = true;
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('logs MPRIS, the stream and the Connect zone side by side, ids only', async () => {
    const w = start();
    await vi.advanceTimersByTimeAsync(10);
    corked = false;
    kids.get('gdbus')![0]!.say(CHANGED);
    kids.get('pactl')![0]!.say("Event 'change' on sink-input #2");
    kids.get('pactl')![0]!.say("Event 'change' on sink-input #2");
    w.connect(connectState());
    await vi.advanceTimersByTimeAsync(300);
    const got = lines();
    expect(got[0]).toMatchObject({ src: 'mpris', ev: 'position', status: 'Paused', positionMs: 5000 });
    expect(got[1]).toMatchObject({ src: 'stream', streams: [{ corked: true, sink: 'alsa_output.usb-Topping_E30' }] });
    expect(got.find((e) => e.ev === 'signal')).toMatchObject({ status: 'Playing', trackId: 'sp:3TDPmzKGcEY8JEMfJEeQYx', lengthMs: 231000, positionMs: 5000 });
    expect(got.find((e) => e.src === 'connect')).toMatchObject({ zone: 'spotify:mypc', status: 'playing', trackId: 'sp:abc', positionMs: 1234, volume: 70 });
    // two events, one sample, and only because something changed
    expect(got.filter((e) => e.src === 'stream')).toHaveLength(2);
    expect(got.filter((e) => e.src === 'stream')[1]).toMatchObject({ streams: [{ corked: false }] });
    expect(readFileSync(join(dir, SPOTIFY_WATCH_FILE), 'utf8')).not.toContain('SECRET');
    w.close();
  });

  it('reads the position every 10 s only while MPRIS says Playing', async () => {
    const w = start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lines().filter((e) => e.ev === 'position')).toHaveLength(1);
    kids.get('gdbus')![0]!.say(CHANGED);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lines().filter((e) => e.ev === 'position')).toHaveLength(4);
    kids.get('gdbus')![0]!.say(PAUSED);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lines().filter((e) => e.ev === 'position')).toHaveLength(4);
    w.close();
  });

  it('only listens: read-only commands, and nothing is sent to the app', async () => {
    const w = start();
    kids.get('gdbus')![0]!.say(CHANGED);
    kids.get('pactl')![0]!.say("Event 'new' on sink-input #2");
    await vi.advanceTimersByTimeAsync(60_000);
    for (const a of asked) {
      expect(a).toMatch(/^(spawn gdbus monitor --session --dest org\.mpris\.MediaPlayer2\.spotify |spawn pactl subscribe$|busctl --user --json=short get-property |pactl --format=json list )/);
    }
    w.close();
  });

  it('a Connect state that did not change is not logged again unless playing', async () => {
    const w = start();
    w.connect(connectState({ status: 'paused' }));
    w.connect(connectState({ status: 'paused', updatedAt: 9 }));
    w.connect(connectState({ status: 'paused', volume: 20 }));
    await vi.advanceTimersByTimeAsync(10);
    expect(lines().filter((e) => e.src === 'connect').map((e) => e.volume)).toEqual([70, 20]);
    w.close();
  });

  it('restarts a listener that died, and close stops everything', async () => {
    const w = start();
    kids.get('gdbus')![0]!.die();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(kids.get('gdbus')).toHaveLength(2);
    w.close();
    expect(kids.get('gdbus')![1]!.killed).toBe(true);
    expect(kids.get('pactl')![0]!.killed).toBe(true);
    kids.get('gdbus')![1]!.die();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(kids.get('gdbus')).toHaveLength(2);
  });

  it('writes nothing after close', async () => {
    const w = start();
    w.close();
    w.connect(connectState());
    await vi.advanceTimersByTimeAsync(1000);
    expect(existsSync(join(dir, SPOTIFY_WATCH_FILE))).toBe(false);
  });
});
