// GET /frame-ok?url= → { embeddable } — whether a page may be shown in an <iframe>
// inside rune (X-Frame-Options / CSP frame-ancestors). Lets the review preview open the
// original page in-app when the site allows it, and fall back to a new tab otherwise.
//
// The review/about sources are open-ended (Wikipedia, Pitchfork, Genius, AOTY and any
// page MusicBrainz links to), so instead of an allowlist this endpoint refuses anything
// that could reach the machine or its LAN/tailnet: IP literals and hostnames that
// resolve to loopback/private/link-local/CGNAT addresses, checked again on every
// redirect. The result cache is an LRU bounded to FRAME_CACHE_MAX entries.
import type { FastifyInstance } from 'fastify';
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

const DAY = 86_400_000;
/** At most this many cached answers; the oldest entry is dropped first. */
export const FRAME_CACHE_MAX = 500;
/** Redirects followed after the first request. */
const MAX_REDIRECTS = 3;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

export interface FrameCacheEntry {
  ok: boolean;
  at: number;
}
/** Exported for tests; entries are (normalised url → last answer). */
export const frameCache = new Map<string, FrameCacheEntry>();

export function embeddableFromHeaders(h: Headers): boolean {
  const xfo = (h.get('x-frame-options') ?? '').toLowerCase();
  if (xfo.includes('deny') || xfo.includes('sameorigin')) return false;
  const csp = (h.get('content-security-policy') ?? '').toLowerCase();
  const fa = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('frame-ancestors'));
  if (fa) {
    const sources = fa.split(/\s+/).slice(1);
    if (!sources.includes('*') && !sources.some((s) => s === 'https:' || s === 'https://*')) return false;
  }
  return true;
}

// ---------------------------------------------------------------- address policy

function ipv4Parts(ip: string): number[] | null {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

function isBlockedIPv4(ip: string): boolean {
  const p = ipv4Parts(ip);
  if (!p) return true;
  const [a, b, c] = p as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / tailnet 100.64.0.0/10
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** Expand an IPv6 address (any common form, incl. IPv4-mapped) to eight 16-bit groups. */
function expandIPv6(raw: string): number[] | null {
  let s = raw.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // Trailing dotted IPv4 (::ffff:127.0.0.1) → two hextets.
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const v4 = ipv4Parts(dotted[2]!);
    if (!v4) return null;
    s = `${dotted[1]}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string | undefined): number[] | null => {
    if (!part) return [];
    const groups = part.split(':');
    const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
    return out.every((n) => Number.isInteger(n)) ? out : null;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...Array<number>(missing).fill(0), ...tail];
}

function ipv4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function isBlockedIPv6(raw: string): boolean {
  const p = expandIPv6(raw);
  if (!p) return true;
  const [first, second] = p as [number, number, ...number[]];
  // ::ffff:0:0/96 (IPv4-mapped) and 64:ff9b::/96 (NAT64) embed an IPv4 address.
  const mapped = p.slice(0, 5).every((n) => n === 0) && p[5] === 0xffff;
  const nat64 = first === 0x0064 && second === 0xff9b && p.slice(2, 6).every((n) => n === 0);
  if (mapped || nat64) return isBlockedIPv4(ipv4FromGroups(p[6]!, p[7]!));
  // ::/96 (IPv4-compatible, including :: and ::1) likewise.
  if (p.slice(0, 6).every((n) => n === 0)) return isBlockedIPv4(ipv4FromGroups(p[6]!, p[7]!));
  if ((first & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return true; // multicast ff00::/8
  if (first === 0x2001 && second === 0x0db8) return true; // documentation 2001:db8::/32
  return false;
}

/** True for addresses a preview must never fetch (loopback, LAN, tailnet, link-local, …). */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedIPv4(address);
  if (family === 6) return isBlockedIPv6(address);
  return true; // not an IP at all
}

export interface FrameLookupAddress {
  address: string;
  family: number;
}

export interface FrameOptions {
  /** Injected in tests; defaults to global fetch. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Injected in tests; defaults to dns.lookup(all: true). */
  lookup?: (hostname: string) => Promise<FrameLookupAddress[]>;
}

class BlockedFrameUrl extends Error {}

function hostOf(raw: string): string {
  return raw.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

/** Resolve and vet one hop's URL; throws BlockedFrameUrl when it is not safe to fetch. */
async function assertAllowed(raw: string, lookupImpl: (host: string) => Promise<FrameLookupAddress[]>): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedFrameUrl('bad url');
  }
  if (url.protocol !== 'https:') throw new BlockedFrameUrl('https required');
  const host = hostOf(url.hostname);
  if (!host) throw new BlockedFrameUrl('empty host');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new BlockedFrameUrl('local host');
  }
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new BlockedFrameUrl('blocked address');
    return url;
  }
  const addresses = await lookupImpl(host);
  if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
    throw new BlockedFrameUrl('blocked address');
  }
  return url;
}

/** GET with manual redirects, re-vetting the host and its DNS answers on every hop. */
async function fetchGuarded(
  start: string,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  lookupImpl: (host: string) => Promise<FrameLookupAddress[]>,
): Promise<Response | null> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertAllowed(current, lookupImpl);
    const res = await fetchImpl(url.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: { 'user-agent': 'Mozilla/5.0 (rune frame check)' },
    });
    if (!REDIRECT_CODES.has(res.status)) return res;
    const location = res.headers.get('location');
    await res.body?.cancel().catch(() => undefined);
    if (!location || hop === MAX_REDIRECTS) return null;
    try {
      current = new URL(location, url).toString();
    } catch {
      return null;
    }
  }
  return null;
}

function cacheGet(url: string): FrameCacheEntry | undefined {
  const hit = frameCache.get(url);
  if (!hit) return undefined;
  if (Date.now() - hit.at >= DAY) {
    frameCache.delete(url);
    return undefined;
  }
  // Refresh insertion order so eviction is least-recently-used.
  frameCache.delete(url);
  frameCache.set(url, hit);
  return hit;
}

function cacheSet(url: string, ok: boolean): void {
  frameCache.delete(url);
  frameCache.set(url, { ok, at: Date.now() });
  while (frameCache.size > FRAME_CACHE_MAX) {
    const oldest = frameCache.keys().next().value;
    if (oldest === undefined) break;
    frameCache.delete(oldest);
  }
}

export function registerFrameRoutes(app: FastifyInstance, opts: FrameOptions = {}): void {
  const fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  const lookupImpl =
    opts.lookup ??
    (async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })) as FrameLookupAddress[]);

  app.get<{ Querystring: { url?: string } }>('/frame-ok', async (req, reply) => {
    const raw = req.query.url ?? '';
    let normalized: string;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:') throw new Error('scheme');
      normalized = url.toString();
    } catch {
      return reply.code(400).send({ error: 'https url required' });
    }
    const hit = cacheGet(normalized);
    if (hit) return { embeddable: hit.ok };

    let ok = false;
    try {
      const res = await fetchGuarded(normalized, fetchImpl, lookupImpl);
      if (res) {
        ok = res.ok && embeddableFromHeaders(res.headers);
        await res.body?.cancel().catch(() => undefined);
      }
    } catch (err) {
      if (err instanceof BlockedFrameUrl) return reply.code(400).send({ error: 'url not allowed' });
      ok = false;
    }
    cacheSet(normalized, ok);
    return { embeddable: ok };
  });
}
