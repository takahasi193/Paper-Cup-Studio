import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

const rawPort = Number(process.env.PORT);
const apiPort = Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : 3100;
const apiHost = process.env.HOST?.trim() || '127.0.0.1';
const apiTarget = `http://${apiHost}:${apiPort}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/health': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
});
