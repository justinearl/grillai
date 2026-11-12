import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = process.env.GRILLAI_PORT ?? '4477';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: { proxy: { '/api': `http://127.0.0.1:${apiPort}` } },
  test: { root: '.', include: ['tests/**/*.test.ts'] },
} as never);
