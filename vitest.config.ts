import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Resolve the same virtual registration module used by the production app;
  // individual tests can still mock the hook's service-worker state.
  plugins: [VitePWA({ registerType: 'prompt' })],
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    coverage: { reporter: ['text', 'html'], include: ['utils/**/*.ts', 'services/**/*.ts'] },
  },
});
