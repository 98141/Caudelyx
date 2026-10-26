import {defineConfig} from 'vitest/config';import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],envDir:false,test:{environment:'jsdom',setupFiles:['./tests/setup.ts','./tests/mej-c1/setup.ts'],include:['tests/mej-c1/**/*.test.tsx','tests/mej/regressions/finance-*.test.tsx'],globals:false}});
