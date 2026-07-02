import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react(), tailwindcss()],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
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
              firebase: ['firebase/compat/app', 'firebase/compat/auth', 'firebase/compat/firestore', 'firebase/compat/storage'],
              genai: ['@google/genai'],
              'lucide-react': ['lucide-react'],
            },
          },
        },
      },
    };
});
