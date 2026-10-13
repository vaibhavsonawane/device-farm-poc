import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const pkg = (p: string) => fileURLToPath(new URL(`../../packages/${p}`, import.meta.url));
const target = process.env.DEVICELAB_API ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Workspace packages are consumed as TypeScript source.
    alias: {
      '@devicelab/shared-types': pkg('shared-types/src/index.ts'),
      '@devicelab/protocol': pkg('protocol/src/index.ts'),
      '@devicelab/ui': pkg('ui/src/index.ts'),
    },
    dedupe: ['react', 'react-dom', '@mui/material', '@emotion/react', '@emotion/styled', 'zod'],
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target, changeOrigin: false },
      '/socket.io': { target, ws: true },
      '/ws': { target, ws: true },
    },
  },
  preview: { port: 4173 },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
