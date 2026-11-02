import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const target = 'http://127.0.0.1:4545';
const proxy = {
  '/api/ws': { target: 'ws://127.0.0.1:4545', ws: true },
  '/api': { target, changeOrigin: false },
};

export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173, proxy },
  preview: { host: true, port: 4173, proxy },
  build: { sourcemap: false, chunkSizeWarningLimit: 700 },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
