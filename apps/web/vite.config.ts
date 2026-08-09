import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the client talks to the API through Vite's proxy, so the browser
// only ever sees one origin and CORS never enters the picture. In production nginx
// plays the same role (see apps/web/nginx.conf).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
