import { beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  embeddableFromHeaders,
  frameCache,
  FRAME_CACHE_MAX,
  isBlockedAddress,
  registerFrameRoutes,
  type FrameOptions,
} from '../src/api/frame.js';

const h = (o: Record<string, string>) => new Headers(o);

describe('embeddableFromHeaders', () => {
  it('blocks X-Frame-Options and restrictive frame-ancestors', () => {
    expect(embeddableFromHeaders(h({ 'x-frame-options': 'DENY' }))).toBe(false);
    expect(embeddableFromHeaders(h({ 'x-frame-options': 'SAMEORIGIN' }))).toBe(false);
    expect(embeddableFromHeaders(h({ 'content-security-policy': "default-src 'self'; frame-ancestors 'self'" }))).toBe(false);
  });
  it('allows pages without restrictions or with frame-ancestors *', () => {
    expect(embeddableFromHeaders(h({}))).toBe(true);
    expect(embeddableFromHeaders(h({ 'content-security-policy': 'frame-ancestors *' }))).toBe(true);
  });
});

describe('isBlockedAddress', () => {
  it('flags loopback, private, link-local, CGNAT/tailnet and mapped addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '100.127.255.254',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fd12::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::7f00:1',
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });
  it('lets public addresses through', () => {
    for (const ip of ['93.184.216.34', '1.1.1.1', '2606:2800:220:1:248:1893:25c8:1946']) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });
});

// ---------------------------------------------------------------- route

const body = (status: number, headers: Record<string, string> = {}): Response =>
  new Response(status >= 300 && status < 400 ? null : '', { status, headers });

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

async function makeApp(opts: FrameOptions): Promise<FastifyInstance> {
  const app = Fastify();
  registerFrameRoutes(app, opts);
  await app.ready();
  return app;
}

function check(app: FastifyInstance, url: string) {
  return app.inject({ method: 'GET', url: `/frame-ok?url=${encodeURIComponent(url)}` });
}

describe('GET /frame-ok', () => {
  beforeEach(() => frameCache.clear());

  it('refuses IP literals, localhost and local names without fetching or resolving', async () => {
    const fetched: string[] = [];
    const app = await makeApp({
      fetch: async (url) => {
        fetched.push(url);
        return body(200);
      },
      lookup: async () => {
        throw new Error('DNS must not be used for literals/local names');
      },
    });
    const urls = [
      'https://127.0.0.1/',
      'https://10.0.0.1/',
      'https://172.16.0.1/',
      'https://192.168.1.1/',
      'https://169.254.169.254/latest/meta-data',
      'https://100.64.0.1/',
      'https://100.127.255.254/',
      'https://0.0.0.0/',
      'https://224.0.0.1/',
      'https://localhost/',
      'https://foo.localhost/',
      'https://printer.local/',
      'https://[::1]/',
      'https://[fd12::1]/',
      'https://[fe80::1]/',
      'https://[::ffff:127.0.0.1]/',
      'https://[::ffff:7f00:1]/',
      'https://[::]/',
    ];
    for (const url of urls) {
      const res = await check(app, url);
      expect(res.statusCode, url).toBe(400);
      expect(res.json(), url).toEqual({ error: 'url not allowed' });
    }
    expect(fetched).toEqual([]);
    expect(frameCache.size).toBe(0);
    await app.close();
  });

  it('refuses a hostname that resolves to a private, link-local or tailnet address', async () => {
    const fetched: string[] = [];
    const app = await makeApp({
      fetch: async (url) => {
        fetched.push(url);
        return body(200);
      },
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '100.64.0.7', family: 4 },
      ],
    });
    const res = await check(app, 'https://internal.example/');
    expect(res.statusCode).toBe(400);
    expect(fetched).toEqual([]);
    await app.close();
  });

  it('checks public https hosts with manual redirects and reports embeddable', async () => {
    const inits: RequestInit[] = [];
    const app = await makeApp({
      fetch: async (_url, init) => {
        inits.push(init);
        return body(200);
      },
      lookup: publicLookup,
    });
    const res = await check(app, 'https://example.com/review');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ embeddable: true });
    expect(inits).toHaveLength(1);
    expect(inits[0]!.redirect).toBe('manual');
    await app.close();
  });

  it('honours X-Frame-Options / CSP from the final response', async () => {
    const app = await makeApp({
      fetch: async () => body(200, { 'x-frame-options': 'DENY' }),
      lookup: publicLookup,
    });
    expect((await check(app, 'https://example.com/blocked')).json()).toEqual({ embeddable: false });
    await app.close();
  });

  it('refuses a redirect to a private address', async () => {
    const fetched: string[] = [];
    const app = await makeApp({
      fetch: async (url) => {
        fetched.push(url);
        return body(302, { location: 'https://169.254.169.254/' });
      },
      lookup: publicLookup,
    });
    const res = await check(app, 'https://example.com/redirect');
    expect(res.statusCode).toBe(400);
    expect(fetched).toHaveLength(1); // the second hop was vetted before fetching
    await app.close();
  });

  it('follows at most three redirects', async () => {
    let hops = 0;
    const three = await makeApp({
      fetch: async () => {
        hops++;
        return hops <= 3 ? body(302, { location: `https://example.com/hop${hops}` }) : body(200);
      },
      lookup: publicLookup,
    });
    expect((await check(three, 'https://example.com/start')).json()).toEqual({ embeddable: true });
    expect(hops).toBe(4); // original + 3 redirects
    await three.close();

    hops = 0;
    const four = await makeApp({
      fetch: async () => {
        hops++;
        return body(302, { location: `https://example.com/hop${hops}` });
      },
      lookup: publicLookup,
    });
    expect((await check(four, 'https://example.com/start-four')).json()).toEqual({ embeddable: false });
    expect(hops).toBe(4); // the fourth redirect is not followed
    await four.close();
  });

  it('reuses cached answers and bounds the cache', async () => {
    let calls = 0;
    const app = await makeApp({
      fetch: async () => {
        calls++;
        return body(200);
      },
      lookup: publicLookup,
    });
    await check(app, 'https://example.com/same');
    await check(app, 'https://example.com/same');
    expect(calls).toBe(1);

    for (let i = 0; i < FRAME_CACHE_MAX + 10; i++) await check(app, `https://example.com/page${i}`);
    expect(frameCache.size).toBe(FRAME_CACHE_MAX);
    await app.close();
  });
});
