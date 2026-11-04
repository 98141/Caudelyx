import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist-ms-p03',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5373,
    strictPort: true,
  },
});
