import Fastify from 'fastify';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { registerJsonCompression } from '../src/api/compress.js';

async function app() {
  const a = Fastify();
  registerJsonCompression(a);
  a.get('/big', async () => ({ items: Array.from({ length: 200 }, (_, i) => ({ id: `la:${i}`, title: 'Album title here' })) }));
  a.get('/small', async () => ({ ok: true }));
  a.get('/text', async (_q, r) => r.type('text/plain').send('x'.repeat(5000)));
  await a.ready();
  return a;
}

describe('JSON compression', () => {
  it('brotli or gzip for big JSON, depending on accept-encoding; round-trips', async () => {
    const a = await app();
    const br = await a.inject({ url: '/big', headers: { 'accept-encoding': 'gzip, deflate, br' } });
    expect(br.headers['content-encoding']).toBe('br');
    expect(JSON.parse(brotliDecompressSync(br.rawPayload).toString()).items).toHaveLength(200);
    const gz = await a.inject({ url: '/big', headers: { 'accept-encoding': 'gzip' } });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(gunzipSync(gz.rawPayload).toString()).items).toHaveLength(200);
    expect(gz.rawPayload.length).toBeLessThan(2000);
  });
  it('leaves small JSON, non-JSON and clients without compression alone', async () => {
    const a = await app();
    expect((await a.inject({ url: '/small', headers: { 'accept-encoding': 'br' } })).headers['content-encoding']).toBeUndefined();
    expect((await a.inject({ url: '/text', headers: { 'accept-encoding': 'br' } })).headers['content-encoding']).toBeUndefined();
    const plain = await a.inject({ url: '/big' });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.json().items).toHaveLength(200);
  });
});
