// Entry point. src/api/server.ts (main session) wires scanner/matcher/zones into Fastify.
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { join } from 'node:path';

const cfg = loadConfig();
const db = openDb(join(cfg.dataDir, 'liner.db'));
console.log('liner db ready', db.name, 'roots', cfg.libraryRoots);
