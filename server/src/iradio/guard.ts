// Address policy for radio station URLs. A station URL is user-supplied data (a favourite can be
// added with any `station.url`), and the server fetches it, streams it back to browsers and hands it
// to mpv, so it gets the same policy api/frame.ts applies to review previews: http(s) only, and
// never loopback / private / link-local / tailnet addresses, checked on the URL, on every redirect
// and again on the address the connection actually resolves to.
import { lookup as dnsLookup } from 'node:dns/promises';
import { lookup as dnsLookupCb, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { isBlockedAddress } from '../api/frame.js';

export interface GuardAddress {
  address: string;
  family: number;
}

export interface StreamGuard {
  /** Tests only: skip the address policy (the URL must still be http or https). */
  allowPrivate?: boolean;
  /** Tests only: replaces DNS (all addresses of a hostname). */
  lookup?: (hostname: string) => Promise<GuardAddress[]>;
}

/** A station URL that fails the policy. Stored stations that hit this stop playing; they are not deleted. */
export class StationUrlBlockedError extends Error {
  constructor(reason: string) {
    super(`This station's stream address is not allowed (${reason})`);
    this.name = 'StationUrlBlockedError';
  }
}

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

function isLocalName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local');
}

/**
 * Checks that need no network: absolute http(s) URL, no credentials, no loopback/private literal.
 * Returns the parsed URL; throws StationUrlBlockedError.
 */
export function checkStationUrlSyntax(raw: unknown, guard: StreamGuard = {}): URL {
  if (typeof raw !== 'string' || !raw.trim()) throw new StationUrlBlockedError('no address');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new StationUrlBlockedError('not an absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new StationUrlBlockedError('only http and https are allowed');
  }
  if (url.username || url.password) throw new StationUrlBlockedError('credentials in the address');
  const host = hostOf(url);
  if (!host) throw new StationUrlBlockedError('empty host');
  if (guard.allowPrivate) return url;
  if (isLocalName(host)) throw new StationUrlBlockedError('local host');
  if (isIP(host) && isBlockedAddress(host)) throw new StationUrlBlockedError('private or loopback address');
  return url;
}

/** Full check for one hop: syntax plus every address the hostname resolves to. */
export async function assertStationUrl(raw: unknown, guard: StreamGuard = {}): Promise<URL> {
  const url = checkStationUrlSyntax(raw, guard);
  if (guard.allowPrivate) return url;
  const host = hostOf(url);
  if (isIP(host)) return url;
  let addresses: GuardAddress[];
  try {
    addresses = guard.lookup ? await guard.lookup(host) : await dnsLookup(host, { all: true });
  } catch {
    throw new StationUrlBlockedError('host could not be resolved');
  }
  if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
    throw new StationUrlBlockedError('private or loopback address');
  }
  return url;
}

/** True when the URL passes the offline checks (used when a station is added). */
export function isAcceptableStationUrl(raw: unknown, guard: StreamGuard = {}): boolean {
  try {
    checkStationUrlSyntax(raw, guard);
    return true;
  } catch {
    return false;
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A `lookup` for net/tls/undici connects that resolves the name itself and refuses the connection
 * when any answer is a blocked address, so the address actually dialled is the one that was checked.
 */
export function guardedLookup(guard: StreamGuard = {}) {
  return (hostname: string, options: { all?: boolean; family?: number } | number | undefined, callback: LookupCallback): void => {
    const opts = typeof options === 'object' && options ? options : {};
    const resolve = guard.lookup
      ? guard.lookup(hostname)
      : new Promise<GuardAddress[]>((res, rej) =>
          dnsLookupCb(hostname, { all: true, ...(opts.family ? { family: opts.family } : {}) }, (err, list) =>
            err ? rej(err) : res(list),
          ),
        );
    resolve.then(
      (list) => {
        if (!guard.allowPrivate && (list.length === 0 || list.some((a) => isBlockedAddress(a.address)))) {
          callback(new StationUrlBlockedError('private or loopback address') as NodeJS.ErrnoException, '');
          return;
        }
        if (opts.all) callback(null, list as LookupAddress[]);
        else callback(null, list[0]!.address, list[0]!.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, ''),
    );
  };
}

/** fetch() whose connections are made through guardedLookup (undici), for station streams and logos. */
export function createGuardedFetch(guard: StreamGuard = {}): typeof fetch {
  const agent = new Agent({ connect: { lookup: guardedLookup(guard) as never } });
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as never, { ...(init as object), dispatcher: agent } as never)) as unknown as typeof fetch;
}
