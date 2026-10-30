import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],build:{outDir:'dist-s10-p04',emptyOutDir:false},server:{host:'localhost',strictPort:true}});
