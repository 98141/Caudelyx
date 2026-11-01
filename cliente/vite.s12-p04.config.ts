import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import https from 'node:https';
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';
export default defineConfig(({command})=>{
 const dir=process.env.CAUDELYX_DEV_TLS_DIRECTORY;
 const tls=command==='serve'&&dir?{cert:readFileSync(resolve(dir,'cert.pem')),key:readFileSync(resolve(dir,'key.pem'))}:undefined;
 return{plugins:[react()],cacheDir:resolve('.cache-s12-p04'),build:{outDir:'dist-s12-p04',emptyOutDir:false},server:tls?{host:'localhost',strictPort:true,https:tls,proxy:{'/api':{target:`https://127.0.0.1:${process.env.CAUDELYX_DEV_API_PORT}`,changeOrigin:false,secure:true,agent:new https.Agent({ca:tls.cert,servername:'localhost'})}}}:undefined};
});
