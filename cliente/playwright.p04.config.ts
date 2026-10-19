import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({ ...base, testDir: './tests', timeout: 240000,
  // The original responsive spec writes historical P03 screenshots; P04 repeats its checks above without rewriting them.
  testMatch: ['**/e2e/access.spec.ts', '**/e2e/organization.spec.ts', '**/e2e/security.spec.ts', '**/integration/p04*.spec.ts'],
  use: { ...base.use, actionTimeout: 15000, navigationTimeout: 15000, launchOptions: {
    executablePath: process.env.CAUDELYX_CHROMIUM ?? 'C:/Users/Asus ExpertBook/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe',
  } },
});
