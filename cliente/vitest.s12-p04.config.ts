import {defineConfig} from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],cacheDir:'.cache-s12-p04',test:{environment:'jsdom',setupFiles:'./tests/setup.ts',globals:false,include:['tests/s12-p04/**/*.test.tsx']}});
