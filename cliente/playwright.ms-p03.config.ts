import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/ms-p03',
  testMatch: '**/*.spec.ts',
  timeout: 180000,
  expect: { timeout: 10000 },
  outputDir: '../../Construccion/Sprints/MODO-SIMPLE/Evidencias/MS-P03-playwright-output',
  fullyParallel: false,
  workers: 1,
  retries: 0,
    use: {
    browserName: 'chromium',
    channel: 'chrome',
    baseURL: 'http://127.0.0.1:5373',
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
    actionTimeout: 15000,
    navigationTimeout: 20000,
  },
  webServer: {
    command: 'npx vite --config vite.ms-p03.config.ts --host 127.0.0.1 --port 5373 --strictPort',
    url: 'http://127.0.0.1:5373',
    reuseExistingServer: false,
    timeout: 120000,
  },
});
