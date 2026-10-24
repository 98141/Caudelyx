import { defineConfig } from '@playwright/test';
// S04-P05 reviewer config (Claude). Own profile ports 5381/5481/5382; TLS verified by the Windows store (no ignoreHTTPSErrors).
// Test output goes to the reviewer scratchpad (outside the repository); no trace/video/screenshots with credentials.
export default defineConfig({
  testDir: '.', testMatch: 'journey-review.spec.ts', workers: 1, retries: 0, timeout: 900000, reporter: 'line',
  outputDir: 'C:/Users/ASUSEX~1/AppData/Local/Temp/claude/C--Users-Asus-ExpertBook-Desktop-Desarrollo-MBT-Prestamos/1ca5deb0-39ff-4dd2-9bbe-dda97062e35a/scratchpad/s04p05-playwright',
  use: { baseURL: 'https://localhost:5381', ignoreHTTPSErrors: false, trace: 'off', video: 'off', screenshot: 'off', locale: 'es-CO',
    launchOptions: { executablePath: 'C:/Users/Asus ExpertBook/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe' } },
});
