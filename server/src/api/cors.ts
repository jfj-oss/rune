// Narrow CORS for Megatron's "Play into call" rune tab.
//
// Megatron runs in a browser tab on another origin (http://127.0.0.1:7420 or a
// Tauri webview). It only reads: search, album/playlist details, cover art and
// the audio stream. Nothing else is exposed, no credentials are allowed, and an
// origin that is not named here gets no CORS headers at all (the browser then
// refuses to read the response, exactly as before this file existed).
//
// rune has no authentication of its own, so there is no auth route to allow.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';

/** Megatron's browser version, and the desktop app's webview origins. */
export const DEFAULT_CORS_ORIGINS = [
  'http://127.0.0.1:7420',
  'tauri://localhost',
  'http://tauri.localhost',
];

interface AllowedRoute {
  /** Matched against the path only (query string stripped). */
  path: RegExp;
  /** Methods the route answers; GET routes also answer HEAD (Fastify adds it). */
  methods: string[];
}

/**
 * The only routes Megatron needs. Keep this list narrow: everything else in
 * rune (player control, settings, Spotify, scans, the websocket) stays
 * unreachable from another origin.
 *
 * The album and playlist detail routes are needed after a search hit: playing
 * an album or a playlist requires its ordered track list.
 */
const ALLOWED_ROUTES: AllowedRoute[] = [
  { path: /^\/api\/search$/, methods: ['GET', 'HEAD'] },
  { path: /^\/api\/albums\/[^/]+$/, methods: ['GET', 'HEAD'] },
  { path: /^\/api\/playlists$/, methods: ['GET', 'HEAD'] },
  { path: /^\/api\/playlists\/[^/]+$/, methods: ['GET', 'HEAD'] },
  { path: /^\/api\/stream\/[^/]+$/, methods: ['GET', 'HEAD'] },
  { path: /^\/api\/cover\/[^/]+$/, methods: ['GET', 'HEAD'] },
];

/** Response headers a cross-origin reader may inspect (seek, gain, length). */
export const CORS_EXPOSE_HEADERS = 'Content-Range, Accept-Ranges, Content-Length, X-Rune-Gain-Db';

function pathOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

function routeFor(url: string): AllowedRoute | undefined {
  const path = pathOf(url);
  return ALLOWED_ROUTES.find((r) => r.path.test(path));
}

function allowedOrigins(cfg: Config): Set<string> {
  return new Set([...DEFAULT_CORS_ORIGINS, ...(cfg.corsOrigins ?? [])]);
}

/**
 * Add CORS headers for an allowed origin on an allowed route. Headers are put
 * on the raw response so they survive the stream route's `reply.hijack()` +
 * `writeHead()` path (a hijacked reply never runs onSend hooks).
 */
function applyCors(
  req: FastifyRequest,
  reply: FastifyReply,
  origins: Set<string>,
  route: AllowedRoute,
): void {
  const origin = req.headers.origin;
  // Vary on every probe: a shared cache must never reuse one origin's answer
  // for another's.
  reply.raw.setHeader('Vary', 'Origin');
  if (!origin || !origins.has(origin)) return;

  reply.raw.setHeader('Access-Control-Allow-Origin', origin);
  if (req.method === 'OPTIONS') {
    reply.raw.setHeader('Access-Control-Allow-Methods', route.methods.join(', '));
    // Range is the only request header Megatron sends that is not CORS-safelisted.
    reply.raw.setHeader('Access-Control-Allow-Headers', 'Range');
    reply.raw.setHeader('Access-Control-Max-Age', '600');
    return;
  }
  reply.raw.setHeader('Access-Control-Expose-Headers', CORS_EXPOSE_HEADERS);
}

/**
 * Register the CORS hook. Call before other route registration. A wildcard
 * OPTIONS route is registered as well because Fastify only runs onRequest
 * hooks for a matched route; without it a preflight would be a 404.
 */
export function registerCors(app: FastifyInstance, cfg: Config): void {
  const origins = allowedOrigins(cfg);

  app.addHook('onRequest', async (req, reply) => {
    const route = routeFor(req.url);
    if (!route) return;
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') return;
    applyCors(req, reply, origins, route);
    if (req.method === 'OPTIONS') {
      // Preflight: never touch the handler, always answer empty.
      reply.code(204).send();
      return reply;
    }
  });

  // Belt and braces: match every OPTIONS request so the hook above runs even
  // for paths Fastify has no GET route for.
  app.options('/*', async (_req, reply) => reply.code(204).send());
}
