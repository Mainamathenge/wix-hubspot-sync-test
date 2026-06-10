import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dashboard is a small React app served by Express under /dashboard.
export default defineConfig({
  plugins: [react()],
  root: 'src/dashboard',
  base: '/dashboard/',
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    // `npm run dev:dashboard` proxies API calls to the Express server on :3000.
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
});
