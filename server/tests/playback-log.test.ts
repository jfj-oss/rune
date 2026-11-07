import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlayerState } from '@liner/shared';
import { buildApp } from '../src/api/server.js';
import { openDb } from '../src/db/index.js';
import { ensureSpotifySchema } from '../src/spotify/schema.js';
import { SIM_DEVICE, TEST_CONFIG, fakeFetch, jsonResponse, playbackState, sampleTrack } from './spotify-helpers.js';
import { createPlaybackLog, parseMprisStatus, parseMprisTrackId, parseStreams, PLAYBACK_LOG_FILE, startsSound, type PlaybackProbe } from '../src/play/playbackLog.js';

process.env.LOG_LEVEL = 'silent';

// Shaped like the real output of busctl --json=short and pactl --format=json.
const STATUS = '{"type":"s","data":"Playing"}\n';
const METADATA = JSON.stringify({ type: 'a{sv}', data: {
  'mpris:trackid': { type: 's', data: '/com/spotify/track/abc123XYZ' },
  'xesam:title': { type: 's', data: 'SECRET TITLE' },
  'xesam:artist': { type: 'as', data: ['SECRET ARTIST'] },
} });
const volume = (p: string) => ({ 'front-left': { value: 1, value_percent: p, db: '0 dB' }, 'front-right': { value: 1, value_percent: p, db: '0 dB' } });
const SINKS = JSON.stringify([
  { index: 54, name: 'alsa_output.usb-Topping_E30', mute: false, volume: volume('90%') },
  { index: 60, name: 'other', mute: true, volume: volume('10%') },
]);
const INPUTS = JSON.stringify([
  { index: 1, sink: 54, corked: false, mute: false, volume: volume('100%'), properties: { 'application.name': 'mpv', 'media.name': 'SECRET TITLE' } },
  { index: 2, sink: 54, corked: false, mute: true, volume: volume('35%'), properties: { 'application.name': 'spotify', 'media.name': 'SECRET TITLE' } },
]);

const probeAll: PlaybackProbe = async (command, args) => {
  if (command === 'busctl') return args.at(-1) === 'Metadata' ? METADATA : STATUS;
  return args.at(-1) === 'sinks' ? SINKS : INPUTS;
};

const zoneState = (over: Partial<PlayerState> = {}): PlayerState => ({
  zone: 'spotify:dev', status: 'playing', index: 0, positionMs: 5000, volume: 62, shuffle: false, repeat: 'off', updatedAt: 1,
  queue: [{ queueId: 'q', album: { id: 'a', title: 'SECRET ALBUM' }, track: { id: 'sp:abc123XYZ', albumId: 'a', source: 'spotify', title: 'SECRET TITLE', artists: [], disc: 1, number: 1, durationMs: 1000 } }],
  ...over,
});

describe('reading the PC', () => {
  it('takes only the id from the MPRIS metadata', () => {
    expect(parseMprisTrackId(METADATA)).toBe('sp:abc123XYZ');
    expect(parseMprisTrackId(JSON.stringify({ data: { 'mpris:trackid': { data: 'spotify:track:abc' } } }))).toBe('sp:abc');
    expect(parseMprisTrackId(JSON.stringify({ data: { 'mpris:trackid': { data: '/org/mpris/MediaPlayer2/TrackList/NoTrack title here' } } }))).toBeNull();
    expect(parseMprisTrackId(null)).toBeNull();
    expect(parseMprisTrackId('not json')).toBeNull();
    expect(parseMprisStatus(STATUS)).toBe('Playing');
  });

  it('finds the Spotify stream and its sink', () => {
    expect(parseStreams(INPUTS, SINKS)).toEqual([{ sink: 'alsa_output.usb-Topping_E30', muted: true, volume: 35, corked: false, sinkMuted: false, sinkVolume: 90 }]);
  });

  it('tells no stream from PipeWire not answering', () => {
    expect(parseStreams('[]', SINKS)).toEqual([]);
    expect(parseStreams(null, null)).toBeNull();
  });

  it('counts only commands that start sound', () => {
    expect(startsSound({ type: 'play', trackIds: ['sp:a'] })).toBe(true);
    expect(startsSound({ type: 'play', trackIds: ['sp:a'], paused: true })).toBe(false);
    expect(startsSound({ type: 'resume' })).toBe(true);
    expect(startsSound({ type: 'pause' })).toBe(false);
    expect(startsSound({ type: 'volume', volume: 10 })).toBe(false);
  });
});

describe('the playback log', () => {
  let dir: string;
  const lines = () => readFileSync(join(dir, PLAYBACK_LOG_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rune-playback-log-'));
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('samples 5 s after a start, with ids and levels and no track text', async () => {
    const log = createPlaybackLog({ dataDir: dir, probe: probeAll });
    log.started({ zone: 'spotify:dev', state: () => zoneState() });
    await vi.advanceTimersByTimeAsync(4999);
    expect(existsSync(join(dir, PLAYBACK_LOG_FILE))).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(lines()).toEqual([{
      at: new Date(1_800_000_005_000).toISOString(),
      zone: 'spotify:dev', trackId: 'sp:abc123XYZ', status: 'playing', connectVolume: 62,
      mpris: { status: 'Playing', trackId: 'sp:abc123XYZ' },
      streams: [{ sink: 'alsa_output.usb-Topping_E30', muted: true, volume: 35, corked: false, sinkMuted: false, sinkVolume: 90 }],
    }]);
    expect(readFileSync(join(dir, PLAYBACK_LOG_FILE), 'utf8')).not.toContain('SECRET');
    log.close();
  });

  it('asks the PC with read-only commands only', async () => {
    const asked: string[] = [];
    const log = createPlaybackLog({ dataDir: dir, probe: async (c, a) => { asked.push(`${c} ${a.join(' ')}`); return null; } });
    log.started({ zone: 'spotify:dev', state: () => zoneState() });
    await vi.advanceTimersByTimeAsync(5000);
    expect(asked).toHaveLength(4);
    for (const a of asked) expect(a).toMatch(/^(busctl --user --json=short get-property |pactl --format=json list )/);
    log.close();
  });

  it('still writes what it knows when nothing can be asked', async () => {
    const log = createPlaybackLog({ dataDir: dir, probe: async () => null });
    log.started({ zone: 'spotify:dev', state: () => zoneState() });
    await vi.advanceTimersByTimeAsync(5000);
    expect(lines()[0]).toMatchObject({ trackId: 'sp:abc123XYZ', connectVolume: 62, mpris: null, streams: null });
    log.close();
  });

  it('a quick run of skips gives one sample, of the last song', async () => {
    const log = createPlaybackLog({ dataDir: dir, probe: probeAll });
    const first = vi.fn(() => zoneState());
    log.started({ zone: 'spotify:dev', state: first });
    await vi.advanceTimersByTimeAsync(3000);
    log.started({ zone: 'spotify:dev', state: () => zoneState({ status: 'paused' }) });
    await vi.advanceTimersByTimeAsync(5000);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ status: 'paused' });
    expect(first).not.toHaveBeenCalled();
    log.close();
  });

  it('rotates: the file stays small and one old copy is kept', async () => {
    const file = join(dir, PLAYBACK_LOG_FILE);
    writeFileSync(file, 'x'.repeat(512 * 1024 - 10));
    const log = createPlaybackLog({ dataDir: dir, probe: probeAll });
    log.started({ zone: 'spotify:dev', state: () => zoneState() });
    await vi.advanceTimersByTimeAsync(5000);
    expect(statSync(`${file}.1`).size).toBe(512 * 1024 - 10);
    expect(statSync(file).size).toBeLessThan(1000);
    expect(lines()).toHaveLength(1);
    log.close();
  });

  it('close cancels a waiting sample', async () => {
    const log = createPlaybackLog({ dataDir: dir, probe: probeAll });
    log.started({ zone: 'spotify:dev', state: () => zoneState() });
    log.close();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(existsSync(join(dir, PLAYBACK_LOG_FILE))).toBe(false);
  });
});

describe('the player route', () => {
  it('a Spotify start is sampled; a paused start and a refused one are not', { timeout: 20_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'rune-playback-route-'));
    const db = openDb(':memory:');
    ensureSpotifySchema(db);
    db.prepare(
      `INSERT INTO spotify_auth (id, access_token, refresh_token, token_type, scope, expires_at, user_name, user_product, updated_at)
       VALUES (1, 'access', 'refresh', 'Bearer', '', ?, NULL, NULL, 0)`,
    ).run(Date.now() + 3_600_000);
    let refuse = false;
    const { fetch } = fakeFetch((url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.pathname === '/v1/me/player/devices') return jsonResponse(200, { devices: [SIM_DEVICE] });
      if (method === 'GET' && url.pathname === '/v1/me/player/queue') return jsonResponse(200, { currently_playing: null, queue: [] });
      if (method === 'GET' && url.pathname === '/v1/me/player') return jsonResponse(200, playbackState(sampleTrack('t1')));
      if (method === 'GET' && url.pathname.startsWith('/v1/tracks/')) return jsonResponse(200, sampleTrack('t1'));
      if (method === 'PUT' && url.pathname === '/v1/me/player/play') return refuse ? jsonResponse(404, { error: 'no device' }) : new Response(null, { status: 204 });
      if (method === 'PUT' && url.pathname === '/v1/me/player/pause') return new Response(null, { status: 204 });
      return jsonResponse(404, { error: `unexpected ${method} ${url.pathname}` });
    });
    const dataDir = join(root, 'data');
    const asked: string[] = [];
    const built = await buildApp(db, { ...TEST_CONFIG, dataDir }, {
      pcZone: false, scanOnStart: false, spotifySyncOnStart: false, webDist: join(root, 'no-web-dist'),
      spotifyOptions: { fetch, endpoints: { api: 'http://api.test/v1', accounts: 'http://accounts.test' } },
      playbackProbe: async (c) => { asked.push(c); return null; },
    });
    const post = (payload: object) => built.app.inject({ method: 'POST', url: '/api/player/spotify:dev1', payload });
    const file = join(dataDir, PLAYBACK_LOG_FILE);
    try {
      expect((await post({ type: 'play', trackIds: ['sp:t1'], paused: true })).statusCode).toBe(200);
      refuse = true;
      expect((await post({ type: 'play', trackIds: ['sp:t1'] })).statusCode).not.toBe(200);
      await new Promise((r) => setTimeout(r, 5300));
      expect(asked).toEqual([]);
      expect(existsSync(file)).toBe(false);
      refuse = false;
      expect((await post({ type: 'play', trackIds: ['sp:t1'] })).statusCode).toBe(200);
      await vi.waitFor(() => expect(existsSync(file)).toBe(true), { timeout: 7000 });
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ zone: 'spotify:dev1', trackId: 'sp:t1', mpris: null, streams: null });
    } finally {
      await built.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
