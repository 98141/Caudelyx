import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: '.cache-ms-p04-r2',
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: './tests/setup.ts',
    globals: false,
    cache: false,
    include: ['tests/ms-p04-r2/**/*.test.ts', 'tests/ms-p04-r2/**/*.test.tsx'],
  },
});
