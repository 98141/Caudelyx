import { defineConfig } from '@playwright/test';
import process from 'node:process';
if(process.env.P04_URL!=='https://localhost:47131'||!process.env.P04_OUTPUT||!process.env.P04_CONTROL||!process.env.P04_OWNER)throw Error('Exact P04 owned environment required');
export default defineConfig({testDir:'.',testMatch:'p04-e2e.spec.ts',timeout:180000,workers:1,retries:0,outputDir:process.env.P04_OUTPUT+'/playwright',reporter:'line',use:{baseURL:process.env.P04_URL,actionTimeout:15000,ignoreHTTPSErrors:true,launchOptions:{executablePath:'C:/Users/Asus ExpertBook/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe'},trace:'off',video:'off',screenshot:'off'}});
