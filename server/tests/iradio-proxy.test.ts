// Browser-zone proxy tests against a fake Icecast/SHOUTcast server.
//
// Deliberately uses real sockets (app.listen + fetch) because the proxy streams
// live bytes; the recorded radio-browser fixture is still network-free.
import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import { openDb, type Db } from '../src/db/index.js';
import {
  createIradio,
  registerRadioStationRoutes,
  type Iradio,
} from '../src/iradio/index.js';
import { resetPlayedState } from '../src/iradio/playback.js';
import { getStationRow, upsertStation } from '../src/iradio/store.js';
import type { RadioBrowserStation } from '../src/iradio/types.js';
import { createFixtureFetch, testConfig, type FixtureFetch } from './iradio-support.js';

const CHUNK = Buffer.alloc(1024, 0xaa);

interface FakeHttpServer {
  url: string;
  close(): Promise<void>;
}

async function startHttpServer(): Promise<FakeHttpServer> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    switch (url.pathname) {
      case '/stream': {
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'icy-name': 'Fake Radio' });
        const timer = setInterval(() => res.write(CHUNK), 10);
        res.on('close', () => clearInterval(timer));
        return;
      }
      case '/listen.pls':
        res.writeHead(200, { 'content-type': 'audio/x-scpls' });
        res.end('[playlist]\nFile1=/stream\nNumberOfEntries=1\n');
        return;
      case '/listen.m3u':
        res.writeHead(200, { 'content-type': 'audio/x-mpegurl' });
        res.end('#EXTM3U\n#EXTINF:-1,Fake Radio\n/stream\n');
        return;
      case '/noext':
        res.writeHead(200, { 'content-type': 'audio/x-scpls' });
        res.end('[playlist]\nFile1=/stream\nNumberOfEntries=1\n');
        return;
      case '/hls.m3u8':
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10,\n/seg.ts\n');
        return;
      case '/redirect':
        res.writeHead(302, { location: '/stream' });
        res.end();
        return;
      case '/error':
        res.writeHead(500);
        res.end('broken');
        return;
      default:
        res.writeHead(404);
        res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no server address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** SHOUTcast v1: a non-HTTP "ICY 200 OK" status line. */
async function startIcyServer(): Promise<FakeHttpServer> {
  const timers = new Set<NodeJS.Timeout>();
  const server = net.createServer((socket) => {
    socket.once('data', () => {
      socket.write('ICY 200 OK\r\ncontent-type: audio/mpeg\r\nicy-name: Icy Test\r\n\r\n');
      const timer = setInterval(() => {
        if (!socket.destroyed) socket.write(CHUNK);
      }, 10);
      timers.add(timer);
      const stop = (): void => {
        clearInterval(timer);
        timers.delete(timer);
      };
      socket.on('close', stop);
      socket.on('error', stop);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no server address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const timer of timers) clearInterval(timer);
      timers.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface Ctx {
  dir: string;
  db: Db;
  cfg: Config;
  fixtures: FixtureFetch;
  iradio: Iradio;
  app: FastifyInstance;
  base: string;
}

let ctx: Ctx | undefined;
const servers: FakeHttpServer[] = [];

async function setup(): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'liner-iradio-proxy-'));
  const db = openDb(':memory:');
  const cfg = testConfig(dir);
  const fixtures = createFixtureFetch();
  // mediaFetch stays real (global fetch) so it can reach the local fake servers.
  const iradio = createIradio(db, cfg, {
    baseUrl: 'https://radio.test',
    fetchImpl: fixtures.fetchImpl,
    minRequestIntervalMs: 0,
  });
  const app = Fastify({ logger: false, forceCloseConnections: true });
  registerRadioStationRoutes(app, iradio);
  await app.ready();
  const base = await app.listen({ port: 0, host: '127.0.0.1' });
  ctx = { dir, db, cfg, fixtures, iradio, app, base };
  return ctx;
}

function addStation(db: Db, uuid: string, url: string): string {
  upsertStation(db, {
    stationuuid: uuid,
    name: `Fake ${uuid.slice(0, 4)}`,
    url,
    url_resolved: url,
    favicon: '',
    tags: 'test',
    country: 'Testland',
    countrycode: 'TL',
    language: 'english',
    codec: 'MP3',
    bitrate: 128,
    votes: 10,
    clickcount: 0,
    clicktrend: 0,
    lastcheckok: 1,
  } as RadioBrowserStation);
  return `rs:${uuid}`;
}

interface StreamResult {
  status: number;
  headers: Headers;
  bytes: number;
  text: string;
}

/** Read a live response for `ms`, then abort (server-side streams never end). */
async function readFor(url: string, ms: number): Promise<StreamResult> {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body!.getReader();
  const chunks: Buffer[] = [];
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(Buffer.from(value));
    }
  } catch {
    // abort races are expected
  }
  controller.abort();
  const body = Buffer.concat(chunks);
  return { status: res.status, headers: res.headers, bytes: body.length, text: body.toString('utf8') };
}

/** Read a finite response to completion. */
async function readAll(url: string): Promise<StreamResult> {
  const res = await fetch(url);
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes: body.length, text: body.toString('utf8') };
}

afterEach(async () => {
  resetPlayedState();
  if (ctx) {
    await ctx.app.close();
    ctx.db.close();
    rmSync(ctx.dir, { recursive: true, force: true });
    ctx = undefined;
  }
  while (servers.length > 0) await servers.pop()!.close();
});

async function fakeServer(): Promise<FakeHttpServer> {
  const server = await startHttpServer();
  servers.push(server);
  return server;
}

describe('browser-zone stream proxy', () => {
  it('proxies a plain Icecast stream with playable headers', async () => {
    const { app, db, base, fixtures } = await setup();
    const server = await fakeServer();
    const id = addStation(db, '00000000-0000-0000-0000-000000000001', `${server.url}/stream`);

    const result = await readFor(`${base}/radio/${id}/stream`, 300);
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toBe('audio/mpeg');
    expect(result.headers.get('accept-ranges')).toBe('none');
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.bytes).toBeGreaterThan(1000);

    // A stream request is a real play: the click endpoint is hit once.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fixtures.clickCalls).toEqual(['00000000-0000-0000-0000-000000000001']);
    void app;
  });

  it('serves the same bytes over HTTP from our origin (mixed-content safe)', async () => {
    const { db, base } = await setup();
    const server = await fakeServer();
    // Upstream is plain HTTP (what an HTTPS page cannot play directly).
    const id = addStation(db, '00000000-0000-0000-0000-000000000002', `${server.url}/stream`);
    const result = await readFor(`${base}/radio/${id}/stream`, 200);
    expect(result.status).toBe(200);
    expect(result.headers.get('location')).toBeNull();
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('resolves a .pls playlist to the first stream and caches it', async () => {
    const { db, base } = await setup();
    const server = await fakeServer();
    const id = addStation(db, '00000000-0000-0000-0000-000000000003', `${server.url}/listen.pls`);

    const result = await readFor(`${base}/radio/${id}/stream`, 300);
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toBe('audio/mpeg');
    expect(result.bytes).toBeGreaterThan(1000);
    expect(getStationRow(db, id)?.stream_url).toBe(`${server.url}/stream`);
  });

  it('resolves a .m3u playlist to the first stream', async () => {
    const { db, base } = await setup();
    const server = await fakeServer();
    const id = addStation(db, '00000000-0000-0000-0000-000000000004', `${server.url}/listen.m3u`);
    const result = await readFor(`${base}/radio/${id}/stream`, 300);
    expect(result.status).toBe(200);
    expect(result.bytes).toBeGreaterThan(1000);
    expect(getStationRow(db, id)?.stream_url).toBe(`${server.url}/stream`);
  });

  it('sniffs an extensionless playlist response', async () => {
    const { db, base } = await setup();
    const server = await fakeServer();
    const id = addStation(db, '00000000-0000-0000-0000-000000000005', `${server.url}/noext`);
    const result = await readFor(`${base}/radio/${id}/stream`, 300);
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toBe('audio/mpeg');
    expect(result.bytes).toBeGreaterThan(1000);
  });

  it('passes HLS (.m3u8) playlists through instead of unwrapping them', async () => {
    const { db, base } = await setup();
    const server = await fakeServer();
    const id = addStation(db, '00000000-0000-0000-0000-000000000006', `${server.url}/hls.m3u8`);
    const result = await readAll(`${base}/radio/${id}/stream`);
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    expect(result.text).toContain('#EXTM3U');
    expect(result.text).toContain('/seg.ts');
  });

  it('follows an upstream redirect', async () => {
    const { db, base } = await setup();
    const server = await fakeServer();
    const id = addStation(db, '00000000-0000-0000-0000-000000000007', `${server.url}/redirect`);
    const result = await readFor(`${base}/radio/${id}/stream`, 300);
    expect(result.status).toBe(200);
    expect(result.bytes).toBeGreaterThan(1000);
  });

  it('proxies a SHOUTcast v1 ICY stream (non-HTTP status line)', async () => {
    const { db, base } = await setup();
    const server = await startIcyServer();
    servers.push(server);
    const id = addStation(db, '00000000-0000-0000-0000-000000000008', `${server.url}/icy`);
    const result = await readFor(`${base}/radio/${id}/stream`, 400);
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toBe('audio/mpeg');
    expect(result.headers.get('icy-name')).toBe('Icy Test');
    expect(result.bytes).toBeGreaterThan(1000);
  });

  it('502s when the upstream stream is broken', async () => {
    const { app, db, base } = await setup();
    const server = await fakeServer();
    const id = addStation(db, '00000000-0000-0000-0000-000000000009', `${server.url}/error`);
    const res = await fetch(`${base}/radio/${id}/stream`);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain('500');
    void app;
  });
});
