import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      // The api/* functions run on Vercel, not in the local dev server. Proxy
      // /api requests to the deployed app so local development exercises the
      // exact same code paths (and edge caches) as production.
      '/api': {
        target: 'https://livewave-sigma.vercel.app',
        changeOrigin: true,
      },
    },
  },
});
