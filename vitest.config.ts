import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

// Node 25+ ships a native global `localStorage` that is undefined unless
// --localstorage-file is set, and it shadows jsdom's implementation — every
// test touching storage then fails. Opt out of Node's version so jsdom's wins.
// (The flag only exists on Node 22.4+, so older Nodes must not receive it.)
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const nodeHasWebStorage = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 4);

export default defineConfig({
  // Resolve the same virtual registration module used by the production app;
  // individual tests can still mock the hook's service-worker state.
  plugins: [VitePWA({ registerType: 'prompt' })],
  test: {
    environment: 'jsdom',
    execArgv: nodeHasWebStorage ? ['--no-experimental-webstorage'] : [],
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    coverage: { reporter: ['text', 'html'], include: ['utils/**/*.ts', 'services/**/*.ts'] },
  },
});
