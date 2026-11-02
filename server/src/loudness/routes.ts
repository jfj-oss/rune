// PlayerState-independent normalisation setting.
//
// Routes are registered without the /api prefix by convention: the caller adds
// it, i.e. registerLoudnessRoutes(r, loudness) inside the /api register scope
// exposes GET/POST /api/settings/normalize.
import type { FastifyInstance } from 'fastify';
import type { NormalizeMode } from '../config.js';
import { isNormalizeMode } from './gain.js';

/** The subset of the loudness service the settings route needs. */
export interface LoudnessController {
  mode(): NormalizeMode;
  setMode(mode: NormalizeMode): NormalizeMode;
}

interface NormalizeBody {
  mode?: unknown;
}

export function registerLoudnessRoutes(app: FastifyInstance, loudness: LoudnessController): void {
  app.get('/settings/normalize', async () => ({ mode: loudness.mode() }));

  app.post<{ Body: NormalizeBody }>('/settings/normalize', async (request, reply) => {
    const mode = request.body?.mode;
    if (!isNormalizeMode(mode)) {
      return reply.code(400).send({ error: "mode must be one of 'off', 'track', 'album'" });
    }
    const saved = loudness.setMode(mode);
    return { mode: saved };
  });
}
