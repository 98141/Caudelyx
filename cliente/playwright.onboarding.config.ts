import { defineConfig } from '@playwright/test';
import current from './playwright.p04-v2.config';

export default defineConfig({
  ...current,
  testMatch: [
    '**/e2e/access.spec.ts',
    '**/e2e/organization.spec.ts',
    '**/e2e/security.spec.ts',
    '**/integration/p04*.spec.ts',
    '**/e2e/p04-v2-pagination.spec.ts',
    '**/e2e/onboarding.spec.ts',
  ],
});
