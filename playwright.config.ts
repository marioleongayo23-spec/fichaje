import { defineConfig, devices } from '@playwright/test';
import { stack } from './tests/e2e/support/backend';

// Real-browser tests against the local Supabase stack, the real H4 gateway and
// the H5 signer. No traces, screenshots or videos: artefacts could otherwise
// capture synthetic PINs or credentials shown on screen.
const { url, publishable } = stack();
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.e2e.ts',
  outputDir: 'test-results/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
    trace: 'off', screenshot: 'off', video: 'off',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    // Flows marked @desktop-only (single-run backend contracts) are not repeated.
    { name: 'mobile', use: { ...devices['Pixel 5'] }, grepInvert: /@desktop-only/ },
  ],
  webServer: {
    command: 'npm run build && npx vite preview --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    timeout: 180_000,
    reuseExistingServer: false,
    env: {
      VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: publishable,
      FICHAJE_KIOSK_GATEWAY_TARGET: 'http://127.0.0.1:8765', FICHAJE_EXPORT_LINK_TARGET: 'http://127.0.0.1:8000',
    },
  },
});
