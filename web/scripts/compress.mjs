// Post-build: write .br and .gz next to every text asset in dist/, so the server
// (@fastify/static preCompressed) sends them without compressing on each request.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const root = new URL('../dist', import.meta.url).pathname;
const TEXT = /\.(js|css|html|svg|json|webmanifest|txt|map)$/;
let files = 0, before = 0, after = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!TEXT.test(name)) continue;
    const buf = readFileSync(p);
    if (buf.length < 1024) continue;
    const br = brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length } });
    writeFileSync(p + '.br', br);
    writeFileSync(p + '.gz', gzipSync(buf, { level: 9 }));
    files++; before += buf.length; after += br.length;
  }
}
walk(root);
console.log(`compressed ${files} files: ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB (brotli)`);
