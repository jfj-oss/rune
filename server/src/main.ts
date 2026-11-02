// rune server entry point.
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { buildApp } from './api/server.js';

const cfg = loadConfig();
const db = openDb(join(cfg.dataDir, 'liner.db'));
const { app, close } = await buildApp(db, cfg, {
  pcZone: process.env.RUNE_NO_PC !== '1',
  scanOnStart: process.env.RUNE_NO_SCAN !== '1',
});
const host = process.env.RUNE_HOST ?? '0.0.0.0';
await app.listen({ port: cfg.port, host });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void close().finally(() => {
      db.close();
      process.exit(0);
    });
  });
}
