// Shared helpers for the radio tests: replays the recorded radio-browser
// fixtures and serves a tiny PNG for logo tests. No network.
import { readFileSync } from 'node:fs';
import type { Config } from '../src/config.js';
import type { RadioBrowserStation } from '../src/iradio/types.js';

const FIXTURES = new URL('./fixtures/iradio/', import.meta.url);

export function loadFixture<T>(relative: string): T {
  return JSON.parse(readFileSync(new URL(relative, FIXTURES), 'utf8')) as T;
}

export interface RecordedCall {
  url: URL;
  userAgent: string | null;
}

export interface FixtureFetch {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
  clickCalls: string[];
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** fetch() replacement that answers from the recorded fixtures. */
export function createFixtureFetch(): FixtureFetch {
  const calls: RecordedCall[] = [];
  const clickCalls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
    );
    const headers = new Headers(init?.headers);
    calls.push({ url, userAgent: headers.get('user-agent') });

    if (url.pathname === '/json/servers') return jsonResponse(loadFixture('servers.json'));

    if (url.pathname === '/json/stations/search') {
      const name = url.searchParams.get('name') ?? '';
      const file = /bbc/i.test(name) ? 'search-bbc.json' : 'search-jazz.json';
      return jsonResponse(loadFixture<RadioBrowserStation[]>(file));
    }

    const byUuid = /^\/json\/stations\/byuuid\/(.+)$/.exec(url.pathname);
    if (byUuid) {
      try {
        return jsonResponse(loadFixture(`byuuid/${decodeURIComponent(byUuid[1]!)}.json`));
      } catch {
        return jsonResponse([]);
      }
    }

    const click = /^\/json\/url\/(.+)$/.exec(url.pathname);
    if (click) {
      clickCalls.push(decodeURIComponent(click[1]!));
      return jsonResponse({ ok: true, message: 'retrieved station url' });
    }

    return jsonResponse({ error: 'not found' }, 404);
  }) as typeof fetch;
  return { fetchImpl, calls, clickCalls };
}

/** 1×1 transparent PNG. */
export const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

export function imageFetch(contentType = 'image/png'): typeof fetch {
  return (async () =>
    new Response(PNG_BYTES, {
      status: 200,
      headers: { 'content-type': contentType, 'content-length': String(PNG_BYTES.length) },
    })) as typeof fetch;
}

export function testConfig(dataDir: string): Config {
  return {
    libraryRoots: [],
    dataDir,
    port: 0,
    audioDevice: 'null',
    userAgent: 'Liner/0.1 ( test )',
  };
}

/** Flatten metadata into the fixture station array used by tests. */
export function stationById(stations: RadioBrowserStation[], id: string): RadioBrowserStation {
  const uuid = id.startsWith('rs:') ? id.slice(3) : id;
  const station = stations.find((s) => s.stationuuid === uuid);
  if (!station) throw new Error(`fixture station ${uuid} not found`);
  return station;
}
