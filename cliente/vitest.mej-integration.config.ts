import {defineConfig} from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],envDir:false,test:{environment:'jsdom',setupFiles:['./tests/setup.ts','./tests/mej/setup.ts'],globals:false,include:['tests/mej/**/*.test.tsx']}});
