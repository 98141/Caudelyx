import { defineConfig } from '@playwright/test';

const baseURL = process.env.MEJ3_BASE_URL;
if (baseURL && /:(27017|27181)(\/|$)/.test(baseURL)) throw new Error('Puerto persistente del propietario');

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'mej.spec.ts',
  timeout: 180000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: './.runtime/playwright-mej3',
  reporter: [['list']],
  use: {
    baseURL: baseURL || 'http://127.0.0.1:9',
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
});
