import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./tests/integration',testMatch:'s02-p04.spec.ts',workers:1,retries:0,timeout:180000,
  outputDir:'.runtime/p04-browser-results',reporter:'list',
  use:{baseURL:'https://localhost:5311',ignoreHTTPSErrors:false,trace:'off',video:'off',screenshot:'off',
    launchOptions:{executablePath:'C:/Users/Asus ExpertBook/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe'}},
});
