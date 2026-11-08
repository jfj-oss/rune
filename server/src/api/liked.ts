// Liked Songs heart state + like/unlike.
//
// "Is it liked?" is answered from the locally synced Liked Songs table (playlist
// 'pl:sp:liked'), never from Spotify: the daily request budget is too tight for a
// GET /me/tracks/contains per track. Writes go to Spotify in batches of 50 and
// mirror the change into that table, so the heart and the Liked Songs page agree
// immediately; the next sync confirms them.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/index.js';
import type { SpotifyTrack } from '../spotify/api.js';
import { ensureSpotifyLibrarySchema } from '../spotify/library-schema.js';
import {
  SpotifyReconnectNeeded,
  likedTrackIds,
  setTracksLiked,
} from '../spotify/library.js';

export interface LikedWriteApi {
  request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
  tracks(ids: string[]): Promise<SpotifyTrack[]>;
}

export interface LikedRouteDeps {
  api: LikedWriteApi;
  connected(): Promise<boolean>;
  grantedScopes(): string[];
  /** Called after a write that really changed something (the owner's action is his). */
  onChange?(): void;
}

const MAX_IDS = 500;
const WRITE_SCOPE = 'user-library-modify';

/** `?ids=a,b` or `{ ids: [...] }` → a de-duplicated list of track ids. */
function parseIds(value: unknown): string[] {
  const raw =
    typeof value === 'string'
      ? value.split(',')
      : Array.isArray(value)
        ? value.filter((x): x is string => typeof x === 'string')
        : [];
  return [...new Set(raw.map((id) => id.trim()).filter(Boolean))];
}

function badRequest(reply: FastifyReply, error: string) {
  return reply.code(400).send({ error });
}

export function registerLikedRoutes(r: FastifyInstance, db: Db, deps?: LikedRouteDeps): void {
  ensureSpotifyLibrarySchema(db); // idempotent

  // Batch state for a handful of tracks (a row, a queue page, the player bar).
  // Pure SQLite: no Spotify request, however often the UI asks.
  r.get<{ Querystring: { ids?: string } }>('/tracks/liked', async (req, reply) => {
    const ids = parseIds(req.query.ids);
    if (ids.length === 0) return badRequest(reply, 'ids required');
    if (ids.length > MAX_IDS) return badRequest(reply, `at most ${MAX_IDS} ids`);
    const liked = new Set(likedTrackIds(db, ids));
    return { liked: Object.fromEntries(ids.map((id) => [id, liked.has(id)])) };
  });

  async function write(
    liked: boolean,
    body: { ids?: unknown } | undefined,
    reply: FastifyReply,
  ) {
    if (!deps) return badRequest(reply, 'not_connected');
    const ids = parseIds(body?.ids);
    if (!ids.some((id) => id.startsWith('sp:'))) return badRequest(reply, 'ids required (sp: track ids)');
    if (ids.length > MAX_IDS) return badRequest(reply, `at most ${MAX_IDS} ids`);
    if (!(await deps.connected())) return badRequest(reply, 'not_connected');
    if (!deps.grantedScopes().includes(WRITE_SCOPE)) {
      return badRequest(reply, new SpotifyReconnectNeeded().message);
    }
    try {
      const result = await setTracksLiked(deps.api, db, ids, liked);
      if (result.changed > 0) deps.onChange?.();
      return result;
    } catch (err) {
      const status = (err as { status?: number }).status;
      const retryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs;
      r.log.warn({ err, liked, count: ids.length }, 'updating Liked Songs failed');
      // 429 is the shared client's lockout/rate-limit: say how long to wait when known.
      if (status === 429) {
        return reply.code(429).send({
          error: 'Spotify is busy (rate limit) — try again in a few minutes',
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        });
      }
      if (status === 403) {
        return reply.code(502).send({ error: 'Spotify refused the change — reconnect Spotify if this keeps happening' });
      }
      return reply.code(502).send({ error: 'Spotify refused the change' });
    }
  }

  r.post<{ Body: { ids?: unknown } }>('/tracks/liked', async (req, reply) => write(true, req.body, reply));
  r.delete<{ Body: { ids?: unknown } }>('/tracks/liked', async (req, reply) => write(false, req.body, reply));
}
