import { defineConfig } from '@playwright/test';

const baseURL = process.env.MEJR2_BASE_URL;
if (!baseURL || !baseURL.startsWith('https://localhost:')) throw new Error('MEJ-R2 exige el HTTPS propio de esta corrida');
if (/:(27017|27181)(\/|$)/.test(baseURL)) throw new Error('Puerto persistente del propietario');

export default defineConfig({
  testDir: '.',
  testMatch: 'review.spec.ts',
  timeout: 240000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: process.env.MEJR2_OUTPUT,
  reporter: [['list']],
  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    launchOptions: {
      executablePath: 'C:/Users/Asus ExpertBook/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
    },
  },
});
