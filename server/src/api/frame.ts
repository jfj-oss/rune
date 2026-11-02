// GET /frame-ok?url= → { embeddable } — whether a page may be shown in an <iframe>
// inside rune (X-Frame-Options / CSP frame-ancestors). Lets the review preview open the
// original page in-app when the site allows it, and fall back to a new tab otherwise.
import type { FastifyInstance } from 'fastify';

const cache = new Map<string, { ok: boolean; at: number }>();
const DAY = 86_400_000;

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

export function registerFrameRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { url?: string } }>('/frame-ok', async (req, reply) => {
    const url = req.query.url ?? '';
    if (!/^https:\/\//i.test(url)) return reply.code(400).send({ error: 'https url required' });
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < DAY) return { embeddable: hit.ok };
    let ok = false;
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'Mozilla/5.0 (rune frame check)' } });
      ok = res.ok && embeddableFromHeaders(res.headers);
      await res.body?.cancel().catch(() => undefined);
    } catch {
      ok = false;
    }
    cache.set(url, { ok, at: Date.now() });
    return { embeddable: ok };
  });
}
