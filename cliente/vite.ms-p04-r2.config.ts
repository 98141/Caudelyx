import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';
export default defineConfig({plugins:[react()],build:{outDir:'dist-ms-p04-r2',emptyOutDir:false,rollupOptions:{output:{entryFileNames:'assets/app.js',assetFileNames:(a)=>a.names.some(n=>n.endsWith('.css'))?'assets/app.css':'assets/[name][extname]',inlineDynamicImports:true}}}});
