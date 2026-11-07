import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

/** One id per build: baked into the page and written to dist/build-id.txt, so the server's websocket hello can tell a
 *  tab from an older build to reload. */
const BUILD_ID = `${Date.now().toString(36)}`;
const buildId = (): Plugin => ({
  name: 'rune-build-id',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'build-id.txt', source: `${BUILD_ID}\n` });
  },
});

const target = 'http://127.0.0.1:4545';
const proxy = {
  '/api/ws': { target: 'ws://127.0.0.1:4545', ws: true },
  '/api': { target, changeOrigin: false },
};

export default defineConfig({
  plugins: [react(), buildId()],
  define: { __RUNE_BUILD__: JSON.stringify(BUILD_ID) },
  server: { host: true, port: 5173, proxy },
  preview: { host: true, port: 4173, proxy },
  build: { sourcemap: false, chunkSizeWarningLimit: 700 },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
