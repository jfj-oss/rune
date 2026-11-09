// Radio station URLs are user data: only public http(s) may be stored or streamed. Covers the
// favourites route, the stream proxy, redirects, DNS answers (including a rebind between check and
// connect), the raw-TCP ICY fallback, and that a stored bad favourite is kept but never played.
import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { createIradio, registerRadioStationRoutes, StationUrlBlockedError } from '../src/iradio/index.js';
import { checkStationUrlSyntax, createGuardedFetch, isAcceptableStationUrl } from '../src/iradio/guard.js';
import { resolveRadioStreamUrlForTrack } from '../src/iradio/playback.js';
import { openUpstream } from '../src/iradio/stream.js';
import { upsertStation } from '../src/iradio/store.js';
import type { RadioBrowserStation } from '../src/iradio/types.js';
import { createFixtureFetch, testConfig } from './iradio-support.js';

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];
const LOOPBACK = [{ address: '127.0.0.1', family: 4 }];

function station(uuid: string, url: string): RadioBrowserStation {
  return { stationuuid: uuid, name: `S ${uuid}`, url, url_resolved: url, codec: 'MP3', bitrate: 128 } as RadioBrowserStation;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function listenHttp(): Promise<{ port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.end('INTERNAL-SECRET');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { port: (server.address() as net.AddressInfo).port, hits };
}

async function listenTcp(): Promise<{ port: number; connections: { n: number } }> {
  const connections = { n: 0 };
  const server = net.createServer((socket) => {
    connections.n++;
    socket.end('ICY 200 OK\r\n\r\nSECRET');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { port: (server.address() as net.AddressInfo).port, connections };
}

describe('station URL syntax policy', () => {
  it('accepts public http and https', () => {
    expect(isAcceptableStationUrl('https://radio.example.org/live.mp3')).toBe(true);
    expect(isAcceptableStationUrl('http://93.184.216.34:8000/stream')).toBe(true);
  });

  it.each([
    '/etc/hostname',
    'file:///etc/passwd',
    'ftp://example.org/x',
    'rtsp://example.org/x',
    'javascript:alert(1)',
    'http://user:pw@example.org/x',
    'http://localhost/x',
    'http://radio.localhost/x',
    'http://nas.local/x',
    'http://127.0.0.1:4545/api/spotify/token',
    'http://10.0.0.5/x',
    'http://192.168.1.2/x',
    'http://100.64.1.2/x',
    'http://169.254.169.254/latest',
    'http://[::1]/x',
    'http://[fd00::1]/x',
    'http://[::ffff:127.0.0.1]/x',
    '',
    undefined,
    42,
  ])('rejects %s', (url) => {
    expect(() => checkStationUrlSyntax(url)).toThrow(StationUrlBlockedError);
  });
});

describe('POST /radio/favourites', () => {
  async function app(): Promise<{ app: FastifyInstance; db: Db }> {
    const db = openDb(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'rune-radio-guard-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const iradio = createIradio(db, testConfig(dir), {
      baseUrl: 'https://radio.test',
      fetchImpl: createFixtureFetch().fetchImpl,
      minRequestIntervalMs: 0,
    });
    const fastify = Fastify({ logger: false });
    registerRadioStationRoutes(fastify, iradio);
    await fastify.ready();
    cleanups.push(() => fastify.close());
    return { app: fastify, db };
  }

  it.each(['/etc/hostname', 'file:///etc/hostname', 'http://127.0.0.1:4545/admin', 'http://192.168.0.9/x'])(
    'refuses to store %s',
    async (url) => {
      const { app: a, db } = await app();
      const res = await a.inject({
        method: 'POST',
        url: '/radio/favourites',
        payload: { station: station('11111111-1111-1111-1111-111111111111', url) },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/not allowed/);
      expect((db.prepare('SELECT count(*) n FROM radio_stations').get() as { n: number }).n).toBe(0);
    },
  );

  it('refuses a bad url_resolved as well', async () => {
    const { app: a } = await app();
    const bad = { ...station('22222222-2222-2222-2222-222222222222', 'https://radio.example.org/x'), url_resolved: 'file:///etc/passwd' };
    const res = await a.inject({ method: 'POST', url: '/radio/favourites', payload: { station: bad } });
    expect(res.statusCode).toBe(400);
  });

  it('still stores a normal public station', async () => {
    const { app: a } = await app();
    const res = await a.inject({
      method: 'POST',
      url: '/radio/favourites',
      payload: { station: station('33333333-3333-3333-3333-333333333333', 'https://radio.example.org/live.mp3') },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().favourite).toBe(true);
  });
});

describe('stored favourites that fail the policy', () => {
  it('stop playing with a clear error, are not contacted, and are not deleted', async () => {
    const target = await listenHttp();
    const db = openDb(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'rune-radio-guard-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const cfg = testConfig(dir);
    const iradio = createIradio(db, cfg, {
      baseUrl: 'https://radio.test',
      fetchImpl: createFixtureFetch().fetchImpl,
      minRequestIntervalMs: 0,
    });
    const id = upsertStation(db, station('44444444-4444-4444-4444-444444444444', `http://127.0.0.1:${target.port}/admin?x=1`));
    const fileId = upsertStation(db, station('55555555-5555-5555-5555-555555555555', '/etc/hostname'));
    db.prepare('UPDATE radio_stations SET favourite = 1').run();
    const fastify = Fastify({ logger: false });
    registerRadioStationRoutes(fastify, iradio);
    await fastify.ready();
    cleanups.push(() => fastify.close());

    for (const sid of [id, fileId]) {
      const res = await fastify.inject({ method: 'GET', url: `/radio/${sid}/stream` });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toMatch(/not allowed/);
      await expect(resolveRadioStreamUrlForTrack(db, cfg, sid)).rejects.toBeInstanceOf(StationUrlBlockedError);
    }
    expect(target.hits).toEqual([]);
    const list = await fastify.inject({ method: 'GET', url: '/radio/favourites' });
    expect(list.json()).toHaveLength(2);
  });
});

describe('openUpstream address policy', () => {
  const deps = (fetchImpl: typeof fetch, lookup: (h: string) => Promise<{ address: string; family: number }[]> = async () => PUBLIC) => ({
    userAgent: 't',
    fetchImpl,
    guard: { lookup },
  });

  it('refuses a hostname that resolves to loopback', async () => {
    let called = 0;
    const f = (async () => {
      called++;
      return new Response('x');
    }) as typeof fetch;
    await expect(openUpstream('http://radio.example/s', deps(f, async () => LOOPBACK))).rejects.toBeInstanceOf(
      StationUrlBlockedError,
    );
    expect(called).toBe(0);
  });

  it('refuses a redirect to a loopback address', async () => {
    const urls: string[] = [];
    const f = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:4545/api/spotify/token' } });
    }) as typeof fetch;
    await expect(openUpstream('http://radio.example/s', deps(f))).rejects.toBeInstanceOf(StationUrlBlockedError);
    expect(urls).toEqual(['http://radio.example/s']);
  });

  it('refuses a redirect to a name that resolves privately', async () => {
    const f = (async () =>
      new Response(null, { status: 301, headers: { location: 'http://internal.example/x' } })) as typeof fetch;
    const lookup = async (h: string) => (h === 'internal.example' ? [{ address: '10.1.2.3', family: 4 }] : PUBLIC);
    await expect(openUpstream('http://radio.example/s', deps(f, lookup))).rejects.toBeInstanceOf(StationUrlBlockedError);
  });

  it('refuses a rebind between the check and the connection (fetch path)', async () => {
    const target = await listenHttp();
    let calls = 0;
    const lookup = async () => (++calls === 1 ? PUBLIC : LOOPBACK);
    const guard = { lookup };
    const guarded = createGuardedFetch(guard);
    await expect(
      openUpstream(`http://rebind.example:${target.port}/s`, { userAgent: 't', fetchImpl: guarded, guard }),
    ).rejects.toBeInstanceOf(StationUrlBlockedError);
    expect(target.hits).toEqual([]);
  });

  it('applies the policy to the raw-TCP ICY fallback, including a rebind', async () => {
    const target = await listenTcp();
    let calls = 0;
    // 1st answer: fetchFollow's check; 2nd: the ICY hop's check; 3rd: the connection itself.
    const lookup = async () => (++calls <= 2 ? PUBLIC : LOOPBACK);
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(
      openUpstream(`http://icy.example:${target.port}/s`, { userAgent: 't', fetchImpl: failing, guard: { lookup } }),
    ).rejects.toBeInstanceOf(StationUrlBlockedError);
    expect(target.connections.n).toBe(0);
  });

  it('does not use the ICY fallback to reach a loopback literal', async () => {
    const target = await listenTcp();
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(
      openUpstream(`http://127.0.0.1:${target.port}/s`, { userAgent: 't', fetchImpl: failing }),
    ).rejects.toBeInstanceOf(StationUrlBlockedError);
    expect(target.connections.n).toBe(0);
  });
});
