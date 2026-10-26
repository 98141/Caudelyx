import {defineConfig} from '@playwright/test';
const url=process.env.MEJC1_BASE_URL,folder=process.env.MEJC1_FOLDER;
if(!url||!folder)throw Error('MEJC1 requires its already reserved isolated owner fixture; no default service');
const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.hostname!=='localhost'||!parsed.port||['27017','27181','3001','4001'].includes(parsed.port)||!folder.replaceAll('\\','/').endsWith('/.runtime/mej-c1-c1a726f0b18a445baa0d2391'))throw Error('Protected or unknown MEJC1 profile');
export default defineConfig({testDir:'./tests/e2e',testMatch:'mej-c1.spec.ts',workers:1,fullyParallel:false,retries:0,timeout:240000,reporter:'list',outputDir:folder+'/playwright',use:{baseURL:url,actionTimeout:12000,navigationTimeout:20000,ignoreHTTPSErrors:true,screenshot:'off',trace:'off',video:'off',launchOptions:{executablePath:'C:/Users/Asus ExpertBook/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe'}}});
