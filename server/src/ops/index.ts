// Operational endpoints/helpers (worker R). The main session wires these:
//
//   import { createLibraryWatcher } from './watch/index.js';
//   import { createBackupService, registerOpsRoutes, createShutdownHandler } from './ops/index.js';
//
//   const watcher = createLibraryWatcher({ roots: cfg.libraryRoots, onChange: () => void runScan() });
//   await watcher.start();
//   const backups = createBackupService(db, { dataDir: cfg.dataDir });
//   backups.start();
//   registerOpsRoutes(app, {
//     version: '0.1.0',
//     db,
//     library: () => ({ roots: watcher.status(), lastScanAt: lastScanFinishedAt }),
//     mpv: () => ({ pid: pc?.mpvPid(), alive: pc?.mpvPid() !== undefined }),
//     spotify: async () => ({ connected: (await spotify?.auth.status())?.connected ?? false }),
//     jobs: () => ({ matching: scanning !== null, details: detailsRunning }),
//   });
//   const shutdown = createShutdownHandler({
//     watcher,
//     flushDb: () => Promise.all([scanning ?? null, backups.idle()]),
//     mpv: pc,
//     db,
//     extra: [{ name: 'backups-stop', run: () => backups.stop() }],
//   });
//   for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void shutdown(sig));
export * from './backup.js';
export * from './health.js';
export * from './shutdown.js';
