// HTTP routes for internet radio. Registered with the /api prefix by the main
// session via registerRadioStationRoutes(app, iradio).
import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { proxyRadioStream } from './stream.js';
import type { AddFavouriteInput, RadioSearchParams, RadioSort } from './types.js';
import type { Iradio } from './index.js';

type Query = Record<string, string | string[] | undefined>;

const SORTS: readonly RadioSort[] = ['votes', 'clickcount', 'name', 'bitrate'];

function qv(query: Query, key: string): string | undefined {
  const value = query[key];
  return Array.isArray(value) ? value[0] : value;
}

function searchParams(query: Query): RadioSearchParams {
  const sortRaw = qv(query, 'sort')?.toLowerCase();
  const text = (key: string): string | undefined => {
    const value = qv(query, key)?.trim();
    return value ? value : undefined;
  };
  const q = text('q');
  const tag = text('tag');
  const country = text('country');
  const language = text('language');
  const limit = qv(query, 'limit');
  const offset = qv(query, 'offset');
  return {
    ...(q ? { q } : {}),
    ...(tag ? { tag } : {}),
    ...(country ? { country } : {}),
    ...(language ? { language } : {}),
    ...(sortRaw && (SORTS as readonly string[]).includes(sortRaw) ? { sort: sortRaw as RadioSort } : {}),
    ...(limit ? { limit: Number(limit) } : {}),
    ...(offset ? { offset: Number(offset) } : {}),
  };
}

/** Mount the radio routes (no /api prefix — the caller adds it). */
export function registerRadioStationRoutes(app: FastifyInstance, iradio: Iradio): void {
  app.get<{ Querystring: Query }>('/radio/stations', async (req, reply) => {
    try {
      return await iradio.search(searchParams(req.query ?? {}));
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.get('/radio/favourites', async () => iradio.favourites());

  app.post<{ Body: AddFavouriteInput }>('/radio/favourites', async (req, reply) => {
    const body = (req.body ?? {}) as AddFavouriteInput;
    try {
      const station = await iradio.addFavourite(body);
      if (!station) return reply.code(404).send({ error: 'station not found' });
      return station;
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Querystring: Query; Body: AddFavouriteInput | null }>(
    '/radio/favourites',
    async (req, reply) => {
      const id =
        qv(req.query ?? {}, 'id') ??
        req.body?.id ??
        req.body?.stationuuid ??
        req.body?.station?.stationuuid ??
        req.body?.station?.id;
      if (!id || typeof id !== 'string') {
        return reply.code(400).send({ error: 'id required' });
      }
      const removed = iradio.removeFavourite(id);
      if (!removed) return reply.code(404).send({ error: 'station not found' });
      return { removed: true };
    },
  );

  // HEAD is registered explicitly below (headers only); Fastify would otherwise
  // auto-generate it from this GET and open a real upstream stream.
  app.get<{ Params: { id: string } }>(
    '/radio/:id/stream',
    { exposeHeadRoute: false },
    async (req, reply) => {
      const station = await iradio.station(req.params.id).catch(() => undefined);
      if (!station) return reply.code(404).send({ error: 'not found' });
      try {
        const url = await iradio.streamUrl(station);
        await proxyRadioStream(req, reply, url, {
          ...iradio.mediaDeps(),
          // The browser is now playing the station; count the click.
          onPlayed: () => {
            void iradio.markPlayed(station.id).catch(() => undefined);
          },
        });
        return reply;
      } catch (err) {
        if (!reply.sent) return reply.code(502).send({ error: (err as Error).message });
        return reply;
      }
    },
  );

  app.head<{ Params: { id: string } }>('/radio/:id/stream', async (req, reply) => {
    const station = await iradio.station(req.params.id).catch(() => undefined);
    if (!station) return reply.code(404).send({ error: 'not found' });
    reply.header('content-type', 'audio/mpeg');
    reply.header('cache-control', 'no-store');
    reply.header('accept-ranges', 'none');
    return reply.send();
  });

  app.get<{ Params: { id: string } }>('/radio/:id/logo', async (req, reply) => {
    const logo = await iradio.logo(req.params.id);
    if (!logo) return reply.code(404).send({ error: 'no logo' });
    return sendLogo(reply, logo);
  });

  app.get<{ Params: { id: string } }>('/radio/:id', async (req, reply) => {
    const station = await iradio.station(req.params.id).catch(() => undefined);
    return station ?? reply.code(404).send({ error: 'not found' });
  });
}

function sendLogo(reply: FastifyReply, logo: { path: string; mime: string }): FastifyReply {
  reply.header('content-type', logo.mime);
  reply.header('cache-control', 'public, max-age=86400');
  return reply.send(createReadStream(logo.path));
}
