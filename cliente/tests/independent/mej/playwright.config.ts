import { defineConfig } from '@playwright/test';
// MEJ-5 reviewer config (Claude). Only the own HTTPS fixture started by the MEJ-5 server test; never 3001/3002/4001/27017/27181.
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const origin = env['MEJ5_URL'];
if (!origin || !env['MEJ5_CONTROL'] || !env['MEJ5_NONCE'] || !env['MEJ5_OUTPUT'] || !env['MEJ5_EVIDENCE']) throw Error('Own MEJ-5 fixture required; no owner fallback');
const url = new URL(origin);
if (url.protocol !== 'https:' || url.hostname !== 'localhost' || !url.port || ['3001', '3002', '4001', '27017', '27181'].includes(url.port)) throw Error('Protected or unknown UI profile');
export default defineConfig({
  testDir: '.', testMatch: 'review.spec.ts', workers: 1, retries: 0, fullyParallel: false, timeout: 420000, reporter: 'line',
  outputDir: env['MEJ5_OUTPUT'] + '/playwright',
  use: { baseURL: origin, actionTimeout: 20000, navigationTimeout: 30000, ignoreHTTPSErrors: true, trace: 'off', video: 'off', screenshot: 'off', locale: 'es-CO', timezoneId: 'America/Bogota',
    launchOptions: { executablePath: 'C:/Users/Asus ExpertBook/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe' } },
});
