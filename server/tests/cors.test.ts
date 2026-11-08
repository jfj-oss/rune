// The narrow CORS allowance Megatron's "Play into call" tab depends on.
//
// Real Fastify app, real routes and the real stream route (which hijacks the
// reply and writes its own headers). Only the library and cover files are fake.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/server.js';
import { openDb, type Db } from '../src/db/index.js';
import { ensureSpotifyLibrarySchema } from '../src/spotify/library-schema.js';
import type { Config } from '../src/config.js';

process.env.LOG_LEVEL = 'silent';

const MEGATRON = 'http://127.0.0.1:7420';
const TAURI = 'tauri://localhost';
const TAURI_HTTP = 'http://tauri.localhost';
const CONFIGURED = 'http://192.168.1.50:7420';
const OTHER = 'http://evil.example';

let root: string;
let db: Db;
let app: FastifyInstance;
let closeApp: () => Promise<void>;

const ALBUM = 'la:cors';
const TRACK = 'l:cors';
const WAV_BYTES = 200;

function wav(size = WAV_BYTES): Buffer {
  // Not a playable file; the stream route only checks that it exists and sends
  // bytes, which is all a Range test needs.
  const b = Buffer.alloc(size);
  b.write('RIFF', 0);
  b.write('WAVE', 8);
  return b;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'liner-cors-test-'));
  const dataDir = join(root, 'data');
  const libraryDir = join(root, 'library');
  mkdirSync(join(dataDir, 'covers'), { recursive: true });
  mkdirSync(libraryDir, { recursive: true });

  const cover = join(dataDir, 'covers', 'cover.png');
  // 1×1 transparent PNG.
  writeFileSync(
    cover,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  const audio = join(libraryDir, 'track.wav');
  writeFileSync(audio, wav());

  db = openDb(':memory:');
  ensureSpotifyLibrarySchema(db);
  db.prepare('INSERT INTO artists (id, name, sort_name, mbid, image_path) VALUES (?, ?, NULL, NULL, NULL)').run(
    'ar:cors',
    'CORS Artist',
  );
  db.prepare(
    `INSERT INTO albums (id, source, title, artist_id, year, release_date, label, genres, format, folder_path, cover_path, mb_release_id, match_confidence, added_at, in_library)
     VALUES (?, 'local', 'CORS Album', 'ar:cors', 2024, NULL, NULL, '[]', 'FLAC', NULL, ?, NULL, NULL, 1, 1)`,
  ).run(ALBUM, cover);
  db.prepare(
    `INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms, path, cue_start_ms, cue_end_ms, format, sample_rate, bit_depth, bitrate_kbps, spotify_uri)
     VALUES (?, ?, 'local', 'CORS Track', 1, 1, 2000, ?, NULL, NULL, 'FLAC', 44100, 16, NULL, NULL)`,
  ).run(TRACK, ALBUM, audio);

  const cfg: Config = {
    libraryRoots: [libraryDir],
    dataDir,
    port: 0,
    audioDevice: 'pipewire',
    userAgent: 'Liner test',
    corsOrigins: [CONFIGURED],
  };
  const built = await buildApp(db, cfg, {
    pcZone: false,
    scanOnStart: false,
    spotifySyncOnStart: false,
    webDist: join(root, 'no-web-dist'),
  });
  app = built.app;
  closeApp = built.close;
});

afterAll(async () => {
  await closeApp?.();
  db?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('CORS for Megatron', () => {
  it('allows the browser origin on the routes Megatron needs', async () => {
    for (const url of [
      '/api/search?q=x',
      `/api/albums/${encodeURIComponent(ALBUM)}`,
      '/api/playlists',
      `/api/stream/${encodeURIComponent(TRACK)}`,
      `/api/cover/${encodeURIComponent(ALBUM)}?size=full`,
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: { origin: MEGATRON } });
      expect(res.statusCode, url).toBeLessThan(500);
      expect(res.headers['access-control-allow-origin'], url).toBe(MEGATRON);
      expect(res.headers.vary, url).toContain('Origin');
      expect(res.headers['access-control-expose-headers'], url).toContain('Content-Range');
    }
  });

  it('allows both Tauri webview origins and origins from config', async () => {
    for (const origin of [TAURI, TAURI_HTTP, CONFIGURED]) {
      const res = await app.inject({ method: 'GET', url: '/api/search?q=x', headers: { origin } });
      expect(res.headers['access-control-allow-origin'], origin).toBe(origin);
    }
  });

  it('sends no CORS headers to an origin that is not allowed', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/search?q=x', headers: { origin: OTHER } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-expose-headers']).toBeUndefined();
  });

  it('stays out of routes Megatron does not need', async () => {
    for (const url of ['/api/scan', '/api/zones', '/api/settings/ambient', '/api/client-log']) {
      const res = await app.inject({ method: 'GET', url, headers: { origin: MEGATRON } });
      expect(res.headers['access-control-allow-origin'], url).toBeUndefined();
    }
  });

  it('answers a preflight for the stream with Range allowed', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: `/api/stream/${encodeURIComponent(TRACK)}`,
      headers: {
        origin: MEGATRON,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'range',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(MEGATRON);
    expect(res.headers['access-control-allow-methods']).toContain('GET');
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain('range');
  });

  it('does not answer a preflight from an unknown origin with CORS headers', async () => {
    const res = await app.inject({ method: 'OPTIONS', url: '/api/search?q=x', headers: { origin: OTHER } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves a byte range with CORS, for seeking', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/stream/${encodeURIComponent(TRACK)}`,
      headers: { origin: MEGATRON, range: 'bytes=10-19' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['access-control-allow-origin']).toBe(MEGATRON);
    expect(res.headers['access-control-expose-headers']).toContain('Content-Range');
    expect(res.headers['access-control-expose-headers']).toContain('Accept-Ranges');
    expect(res.headers['content-range']).toBe(`bytes 10-19/${WAV_BYTES}`);
    expect(res.rawPayload.length).toBe(10);
  });
});
