// /api/discover/* routes. Registered from src/api/server.ts under /api.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DiscoverModule } from './service.js';
import { DiscoverNotFoundError } from './service.js';

export function registerDiscoverRoutes(app: FastifyInstance, discover: DiscoverModule): void {
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/discover/track/:id/similar',
    async (req, reply) => {
      const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
      try {
        return await discover.similar(req.params.id, {
          ...(Number.isFinite(limit) ? { limit } : {}),
        });
      } catch (err) {
        return replyError(reply, req.log, err);
      }
    },
  );

  app.get<{ Querystring: { limit?: string; refresh?: string } }>('/discover/new', async (req, reply) => {
    const raw = req.query.limit === undefined ? undefined : Number(req.query.limit);
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    try {
      return await discover.feed({
        ...(Number.isFinite(raw) ? { limit: raw } : {}),
        refresh,
      });
    } catch (err) {
      return replyError(reply, req.log, err);
    }
  });

  app.post<{ Body: { trackId?: unknown } }>('/discover/dismiss', async (req, reply) => {
    const trackId = req.body?.trackId;
    if (typeof trackId !== 'string' || !trackId.trim()) {
      return reply.code(400).send({ error: 'trackId required' });
    }
    try {
      await discover.dismiss(trackId);
      return { ok: true };
    } catch (err) {
      return replyError(reply, req.log, err);
    }
  });
}

function replyError(reply: FastifyReply, log: FastifyInstance['log'], err: unknown) {
  if (err instanceof DiscoverNotFoundError) {
    return reply.code(404).send({ error: 'not found' });
  }
  log.warn({ err }, 'discover request failed');
  return reply.code(502).send({ error: err instanceof Error ? err.message : 'discover failed' });
}
