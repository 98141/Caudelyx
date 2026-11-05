import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

// Build only: no TLS files, dev proxy, local .env or historical output.
export default defineConfig({
  plugins: [react()],
  envDir: false,
  define: {'import.meta.env.VITE_CAUDELYX_MODE': JSON.stringify('local-synthetic')},
  build: {outDir: 'dist-docker', emptyOutDir: true, sourcemap: false,
    rollupOptions:{output:{inlineDynamicImports:true,entryFileNames:'assets/app.js',assetFileNames:asset=>asset.names.some(n=>n.endsWith('.css'))?'assets/app.css':'assets/[name][extname]'}}},
});
