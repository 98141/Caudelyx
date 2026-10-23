import { defineConfig } from '@playwright/test';
// S02-P05 reviewer config (Claude). Own profile ports 5331/5431/5332; TLS verified by the Windows store (no ignoreHTTPSErrors).
export default defineConfig({
  testDir: './tests/independent/s02', testMatch: 'finance.spec.ts', workers: 1, retries: 0, timeout: 900000,
  outputDir: '.runtime/p05-browser-results', reporter: 'line',
  use: { baseURL: 'https://localhost:5331', ignoreHTTPSErrors: false, trace: 'off', video: 'off', screenshot: 'off', locale: 'es-CO',
    launchOptions: { executablePath: 'C:/Users/Asus ExpertBook/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe' } },
});
