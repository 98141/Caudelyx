import { defineConfig } from '@playwright/test';
import base from './playwright.p04.config';

export default defineConfig({
  ...base,
  timeout: 600000,
  testMatch: [
    '**/e2e/access.spec.ts',
    '**/e2e/organization.spec.ts',
    '**/e2e/security.spec.ts',
    '**/integration/p04*.spec.ts',
    '**/e2e/p04-v2-pagination.spec.ts',
  ],
});
