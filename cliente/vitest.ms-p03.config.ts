import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: '.cache-ms-p03',
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: './tests/setup.ts',
    globals: false,
    include: ['tests/ms-p03/**/*.test.ts', 'tests/ms-p03/**/*.test.tsx'],
  },
});
