import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';
export default defineConfig({plugins:[react()],build:{outDir:'dist-s06-p04',emptyOutDir:false,rollupOptions:{output:{entryFileNames:'assets/app.js',chunkFileNames:'assets/chunk-[name].js',assetFileNames:'assets/[name][extname]'}}}});
