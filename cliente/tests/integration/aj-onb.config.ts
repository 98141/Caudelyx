import { defineConfig } from '@playwright/test';
const origin=process.env.AJ_ONB_4_URL;
if(!origin)throw Error('Own AJ4 fixture required; no owner fallback');
const url=new URL(origin);
if(url.protocol!=='https:'||url.hostname!=='localhost'||!url.port||['27017','27181','3001','4001'].includes(url.port))throw Error('Protected or unknown UI profile');
if(!process.env.AJ_ONB_4_OUTPUT)throw Error('Registered own output directory required');
export default defineConfig({testDir:'.',testMatch:'aj-onb.spec.ts',timeout:180000,workers:1,retries:0,fullyParallel:false,outputDir:process.env.AJ_ONB_4_OUTPUT+'/playwright',reporter:'line',use:{baseURL:origin,ignoreHTTPSErrors:true,launchOptions:{executablePath:'C:/Users/Asus ExpertBook/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe'},trace:'off',video:'off',screenshot:'off'}});
