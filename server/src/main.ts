// rune server entry point.
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { buildApp } from './api/server.js';

const cfg = loadConfig();
const db = openDb(join(cfg.dataDir, 'liner.db'));
// A silent/secondary instance (RUNE_NO_SCAN=1) also skips the watcher and the
// nightly backups: both are real background work against the user's library.
const background = process.env.RUNE_NO_SCAN !== '1';
const { app, shutdown } = await buildApp(db, cfg, {
  pcZone: process.env.RUNE_NO_PC !== '1',
  scanOnStart: background,
  watch: background && process.env.RUNE_NO_WATCH !== '1',
  backups: background && process.env.RUNE_NO_BACKUPS !== '1',
  // Phase 0: MPRIS + PipeWire + Connect side by side in spotify-watch.jsonl (listens only).
  spotifyWatch: background && process.env.RUNE_NO_SPOTIFY_WATCH !== '1',
  // Phase 2: HORSE is read over MPRIS, not GET /me/player (config spotify.mprisReads: false turns it off).
  mpris: background && process.env.RUNE_NO_MPRIS !== '1',
});
const host = process.env.RUNE_HOST ?? '0.0.0.0';
await app.listen({ port: cfg.port, host });

// shutdown() closes the Db last, after the WAL checkpoint and every module.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void shutdown(sig).finally(() => process.exit(0));
  });
}
