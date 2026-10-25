import { defineConfig } from '@playwright/test';
// S05-P05-v2 reviewer config (Claude). Own profile ports 5391/5491/5392; TLS verified by the Windows store (no ignoreHTTPSErrors).
// Test output goes to the reviewer scratchpad (outside the repository); no trace/video. One evidence screenshot is written by the spec.
export default defineConfig({
  testDir: '.', testMatch: /(review|historical-[a-z-]+)\.spec\.ts$/, workers: 1, retries: 0, timeout: 900000, reporter: 'line',
  outputDir: 'C:/Users/ASUSEX~1/AppData/Local/Temp/claude/C--Users-Asus-ExpertBook-Desktop-Desarrollo-MBT-Prestamos/1ca5deb0-39ff-4dd2-9bbe-dda97062e35a/scratchpad/s05p05-playwright',
  use: { baseURL: 'https://localhost:5391', ignoreHTTPSErrors: false, trace: 'off', video: 'off', screenshot: 'off', locale: 'es-CO',
    launchOptions: { executablePath: 'C:/Users/Asus ExpertBook/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe' } },
});
