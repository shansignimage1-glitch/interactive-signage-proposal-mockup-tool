import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(() => {
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [
        react(), tailwindcss(),
        VitePWA({
          registerType: 'autoUpdate',
          includeAssets: ['icon.svg'],
          manifest: {
            name: 'SignagePro', short_name: 'SignagePro',
            description: 'Offline-first signage proposal and measurement tool',
            theme_color: '#111827', background_color: '#030712', display: 'standalone',
            start_url: '/', scope: '/', orientation: 'any',
            icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
          },
          workbox: {
            navigateFallback: '/index.html',
            // Firebase's same-origin Safari redirect helper must always reach
            // Vercel's reverse proxy. Never let the PWA navigation fallback
            // replace /__/auth/handler with the SignagePro app shell.
            navigateFallbackDenylist: [/^\/__\/auth\//],
            globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
            maximumFileSizeToCacheInBytes: 1_500_000,
            cleanupOutdatedCaches: true,
          },
        }),
      ],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      },
      build: {
        rollupOptions: {
          output: {
            // Split heavy, rarely-changing vendor code into its own cacheable
            // chunks instead of one 1.3MB+ bundle — browsers can cache these
            // separately from app code that changes every deploy.
            manualChunks: {
              firebase: ['firebase/app', 'firebase/auth', 'firebase/firestore', 'firebase/storage'],
              'lucide-react': ['lucide-react'],
            },
          },
        },
      },
    };
});
