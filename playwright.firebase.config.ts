import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /(?:firebase-cloud-sync\.spec|firebase-site-survey\.firebase)\.ts/,
  // The Xplore regression uploads/restores a 60,000-point project, holds the
  // cloud status for 12 seconds, then opens clean iPad and desktop contexts.
  // WebKit on loaded Windows hosts can legitimately take more than four minutes.
  timeout: 480_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4174',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{
    name: 'iphone-firebase-webkit',
    use: { ...devices['iPhone 13'], browserName: 'webkit' },
  }],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4174',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    timeout: 120_000,
    env: { VITE_FIREBASE_EMULATORS: 'true' },
  },
});
