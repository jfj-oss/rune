import type { FastifyInstance } from 'fastify';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

/** Bodies smaller than this are sent as they are (compressing them saves nothing worth the CPU). */
const MIN_BYTES = 1024;

/**
 * Compress JSON API replies (album lists, playlists, search: often 10–200 KB, very repetitive) for clients
 * that accept it. Streams (audio, images, files) are left alone. Brotli at a fast level, else gzip.
 */
export function registerJsonCompression(app: FastifyInstance): void {
  app.addHook('onSend', async (req, reply, payload) => {
    if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return payload;
    if (reply.getHeader('content-encoding')) return payload;
    const type = String(reply.getHeader('content-type') ?? '');
    if (!type.includes('json')) return payload;
    const size = Buffer.byteLength(payload);
    if (size < MIN_BYTES) return payload;
    const accept = String(req.headers['accept-encoding'] ?? '');
    let out: Buffer;
    let encoding: string;
    if (/\bbr\b/.test(accept)) {
      out = brotliCompressSync(payload, { params: { [constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_SIZE_HINT]: size } });
      encoding = 'br';
    } else if (/\bgzip\b/.test(accept)) {
      out = gzipSync(payload, { level: 5 });
      encoding = 'gzip';
    } else return payload;
    reply.header('content-encoding', encoding);
    reply.header('vary', 'accept-encoding');
    reply.removeHeader('content-length');
    return out;
  });
}
