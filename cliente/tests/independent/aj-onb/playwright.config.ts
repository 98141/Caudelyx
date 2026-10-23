import { defineConfig } from '@playwright/test';
// AJ-ONB-5 reviewer config (Claude). Only the own HTTPS fixture started by the AJ-ONB-5 server test; never 3001/4001/27017/27181.
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const origin = env['AJ5_URL'];
if (!origin || !env['AJ5_CONTROL'] || !env['AJ5_NONCE'] || !env['AJ5_OUTPUT']) throw Error('Own AJ-ONB-5 fixture required; no owner fallback');
const url = new URL(origin);
if (url.protocol !== 'https:' || url.hostname !== 'localhost' || !url.port || ['3001', '3002', '4001', '27017', '27181'].includes(url.port)) throw Error('Protected or unknown UI profile');
export default defineConfig({
  testDir: '.', testMatch: 'aj-onb-review.spec.ts', workers: 1, retries: 0, fullyParallel: false, timeout: 240000, reporter: 'line',
  outputDir: env['AJ5_OUTPUT'] + '/playwright',
  use: { baseURL: origin, ignoreHTTPSErrors: true, trace: 'off', video: 'off', screenshot: 'off', locale: 'es-CO',
    launchOptions: { executablePath: 'C:/Users/Asus ExpertBook/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe' } },
});
