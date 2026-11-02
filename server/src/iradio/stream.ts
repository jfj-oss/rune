// Stream resolution and the browser-zone proxy.
//
// The browser never talks to a station directly: mixed content (an HTTPS Liner
// page + an HTTP station), CORS, and ICY/SHOUTcast quirks all go away when the
// server fetches the stream and re-serves the bytes from our own origin. The same
// helper resolves .pls/.m3u playlists to the first real stream URL.
import net from 'node:net';
import tls from 'node:tls';
import { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { getStationRow, saveStreamUrl } from './store.js';
import type { RadioStation } from './types.js';

export interface MediaDeps {
  userAgent: string;
  fetchImpl: typeof fetch;
}

const TEXT_TIMEOUT_MS = 10_000;
const MAX_PLAYLIST_BYTES = 256 * 1024;
const MAX_REDIRECTS = 5;

// ------------------------------------------------------------------ playlist

export type PlaylistKind = 'pls' | 'm3u';

/** URL-based detection. .m3u8 is HLS and must be passed through untouched. */
export function playlistKind(url: string): PlaylistKind | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return undefined;
  }
  if (pathname.endsWith('.pls')) return 'pls';
  if (pathname.endsWith('.m3u')) return 'm3u';
  return undefined;
}

/** First playable URL in a PLS body. */
export function parsePls(text: string): string | undefined {
  const entries: { order: number; url: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*File(\d*)\s*=\s*(.+?)\s*$/i.exec(line);
    if (!match) continue;
    const url = cleanUrl(match[2] ?? '');
    if (!url) continue;
    entries.push({ order: match[1] ? Number(match[1]) : entries.length + 1, url });
  }
  entries.sort((a, b) => a.order - b.order);
  return entries[0]?.url;
}

/** First non-comment, non-empty URL in an M3U body. */
export function parseM3u(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const url = cleanUrl(trimmed);
    if (url) return url;
  }
  return undefined;
}

/** Parse a playlist body, returning an absolute http(s) URL when possible. */
export function parsePlaylist(
  text: string,
  baseUrl: string,
  kind: PlaylistKind | undefined = playlistKind(baseUrl),
): string | undefined {
  // Servers without a .pls/.m3u extension are sniffed from the body.
  const effective = kind ?? (/^\s*\[playlist\]|^\s*File\d*\s*=/im.test(text) ? 'pls' : 'm3u');
  const raw = effective === 'pls' ? parsePls(text) : parseM3u(text);
  if (!raw) return undefined;
  try {
    const resolved = new URL(raw, baseUrl).toString();
    return /^https?:\/\//i.test(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Follow .pls/.m3u indirection (at most three hops). URLs that are not playlist
 * files are returned unchanged without a network request.
 */
export async function resolvePlaylistUrl(
  url: string,
  deps: MediaDeps,
  depth = 0,
): Promise<string> {
  if (depth >= 3 || !playlistKind(url)) return url;
  const text = await fetchText(url, deps).catch(() => undefined);
  if (!text) return url;
  const next = parsePlaylist(text, url);
  if (!next || next === url) return url;
  return resolvePlaylistUrl(next, deps, depth + 1);
}

/** Resolve (and remember) the direct stream URL stored for a station. */
export async function resolveStationStreamUrl(
  db: Db,
  station: RadioStation,
  deps: MediaDeps,
): Promise<string> {
  const row = getStationRow(db, station.id);
  if (!row) return station.urlResolved ?? station.url;
  if (row.stream_url) return row.stream_url;
  const base = row.url_resolved || row.url;
  let resolved = base;
  try {
    resolved = await resolvePlaylistUrl(base, deps);
  } catch {
    resolved = base;
  }
  if (resolved !== base) saveStreamUrl(db, station.id, resolved);
  return resolved;
}

async function fetchText(url: string, deps: MediaDeps): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEXT_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await deps.fetchImpl(url, {
      headers: {
        'User-Agent': deps.userAgent,
        Accept: 'audio/x-scpls,audio/x-mpegurl,audio/mpegurl,text/plain,*/*',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) return undefined;
    const length = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(length) && length > MAX_PLAYLIST_BYTES) return undefined;
    const text = await res.text();
    return text.length > MAX_PLAYLIST_BYTES ? undefined : text;
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------- upstream

export interface UpstreamStream {
  status: number;
  headers: Record<string, string>;
  body: Readable;
  url: string;
}

const MEDIA_HEADERS = (userAgent: string): Record<string, string> => ({
  'User-Agent': userAgent,
  Accept: '*/*',
  'Icy-MetaData': '0',
});

/**
 * Open an audio stream. Normal HTTP servers go through fetch; SHOUTcast v1
 * servers answer with a non-HTTP status line ("ICY 200 OK") that undici rejects,
 * so those fall back to a small raw HTTP/1.0 client.
 */
export async function openUpstream(
  url: string,
  deps: MediaDeps,
  signal?: AbortSignal,
): Promise<UpstreamStream> {
  try {
    const res = await deps.fetchImpl(url, {
      headers: MEDIA_HEADERS(deps.userAgent),
      redirect: 'follow',
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`upstream HTTP ${res.status}`);
    return {
      status: res.status,
      headers: headersToObject(res.headers),
      body: Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      url: res.url || url,
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    return openIcyUpstream(url, deps, signal);
  }
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

async function openIcyUpstream(
  url: string,
  deps: MediaDeps,
  signal: AbortSignal | undefined,
  depth = 0,
): Promise<UpstreamStream> {
  if (depth > MAX_REDIRECTS) throw new Error('too many upstream redirects');
  const target = new URL(url);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`unsupported stream protocol ${target.protocol}`);
  }
  const secure = target.protocol === 'https:';
  const port = target.port ? Number(target.port) : secure ? 443 : 80;
  const socket = secure
    ? tls.connect({ host: target.hostname, port, servername: target.hostname })
    : net.connect({ host: target.hostname, port });
  socket.setNoDelay(true);

  return new Promise<UpstreamStream>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(err);
    };
    const cleanup = (): void => {
      socket.removeAllListeners();
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => fail(new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });

    const request =
      `GET ${target.pathname || '/'}${target.search} HTTP/1.0\r\n` +
      `Host: ${target.host}\r\n` +
      `User-Agent: ${deps.userAgent}\r\n` +
      'Accept: */*\r\n' +
      'Icy-MetaData: 0\r\n' +
      'Connection: close\r\n\r\n';

    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const headEnd = buffered.indexOf('\r\n\r\n');
      if (headEnd < 0) {
        if (buffered.length > 64 * 1024) fail(new Error('stream response header too large'));
        return;
      }
      socket.removeListener('data', onData);
      const head = buffered.subarray(0, headEnd).toString('latin1');
      const rest = buffered.subarray(headEnd + 4);
      buffered = Buffer.alloc(0);

      const lines = head.split('\r\n');
      const statusLine = lines.shift() ?? '';
      const statusMatch = /^(?:ICY|HTTP\/\d(?:\.\d)?)\s+(\d{3})/i.exec(statusLine);
      if (!statusMatch) {
        fail(new Error(`not an HTTP/ICY stream (${statusLine.slice(0, 40)})`));
        return;
      }
      const status = Number(statusMatch[1]);
      const headers: Record<string, string> = {};
      for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon <= 0) continue;
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }

      if (status >= 300 && status < 400 && headers.location) {
        const next = new URL(headers.location, target).toString();
        cleanup();
        socket.destroy();
        settled = true;
        resolve(openIcyUpstream(next, deps, signal, depth + 1));
        return;
      }
      if (status < 200 || status >= 300) {
        fail(new Error(`upstream HTTP ${status}`));
        return;
      }
      if ((headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) {
        // ICY servers use HTTP/1.0 semantics; refuse rather than emit framing bytes.
        fail(new Error('chunked ICY streams are unsupported'));
        return;
      }

      settled = true;
      const body = new Readable({ read() {} });
      signal?.removeEventListener('abort', onAbort);
      const onSocketError = (err: Error): void => {
        body.destroy(err);
      };
      socket.on('error', onSocketError);
      socket.on('end', () => body.push(null));
      socket.on('close', () => body.push(null));
      signal?.addEventListener('abort', () => socket.destroy(), { once: true });
      if (rest.length > 0) body.push(rest);
      socket.on('data', (c: Buffer) => body.push(c));
      resolve({ status, headers, body, url });
    };

    socket.on('error', (err) => fail(err));
    socket.on('data', onData);
    const onConnected = (): void => {
      socket.write(request);
    };
    if (secure) socket.once('secureConnect', onConnected);
    else socket.once('connect', onConnected);
  });
}

// -------------------------------------------------------------------- proxy

export interface ProxyDeps extends MediaDeps {
  /** Called once the upstream stream is open (radio-browser click counter). */
  onPlayed?: () => void;
}

/**
 * Proxy a station stream to the browser. Resolves playlist wrappers first, then
 * pipes the live bytes; aborting the reply aborts the upstream request.
 */
export async function proxyRadioStream(
  req: FastifyRequest,
  reply: FastifyReply,
  url: string,
  deps: ProxyDeps,
): Promise<void> {
  const controller = new AbortController();
  reply.raw.on('close', () => controller.abort());

  let upstream = await openUpstream(url, deps, controller.signal);
  // Some servers omit a .pls/.m3u extension but answer with a playlist.
  for (let hop = 0; hop < 3 && isPlaylistResponse(upstream); hop++) {
    const text = await readSmall(upstream.body, MAX_PLAYLIST_BYTES);
    const next = parsePlaylist(text, upstream.url);
    if (!next) break;
    upstream = await openUpstream(next, deps, controller.signal);
  }

  reply.code(upstream.status >= 200 && upstream.status < 300 ? 200 : upstream.status);
  reply.header('content-type', upstream.headers['content-type'] ?? 'audio/mpeg');
  reply.header('cache-control', 'no-store');
  reply.header('accept-ranges', 'none');
  reply.header('access-control-allow-origin', '*');
  // nginx / tailscale proxies should not buffer a live stream.
  reply.header('x-accel-buffering', 'no');
  if (upstream.headers['icy-name']) reply.header('icy-name', upstream.headers['icy-name']);
  deps.onPlayed?.();
  reply.send(upstream.body);
}

/** HLS playlists (.m3u8) are passed through; only plain playlists are unwrapped. */
function isPlaylistResponse(upstream: UpstreamStream): boolean {
  const type = (upstream.headers['content-type'] ?? '').toLowerCase();
  if (type.includes('vnd.apple.mpegurl')) return false;
  let pathname = '';
  try {
    pathname = new URL(upstream.url).pathname.toLowerCase();
  } catch {
    // ignore
  }
  if (pathname.endsWith('.m3u8')) return false;
  return (
    type.includes('scpls') ||
    type.includes('mpegurl') ||
    type.includes('x-playlist') ||
    type.includes('audio/x-mpegurl')
  );
}

function readSmall(stream: Readable, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > limit) {
        stream.destroy();
        reject(new Error('playlist too large'));
        return;
      }
      chunks.push(buf);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function cleanUrl(raw: string): string | undefined {
  let value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value.length > 0 ? value : undefined;
}
