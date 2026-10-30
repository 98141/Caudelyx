// Exact new P04 output and input catalogs; historical build roots are untouched.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {command,listFiles,ensureBuild} from '../../servidor/scripts/s09-runner-core.mjs';
const client=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),root=path.resolve(client,'../..'),e=path.join(root,'Construccion/Sprints/S10/Evidencias'),filename=path.join(e,'S10-P04-CLIENT-RUNS.json'),stage=process.argv[2]??'preflight',start=performance.now();
try{await fs.stat(path.join(e,'S10-P04-HASHES.json'));throw Error('Frozen P04; new version required');}catch(x){if(x.code!=='ENOENT')throw x;}
let log;try{log=JSON.parse(await fs.readFile(filename,'utf8'));}catch(x){if(x.code!=='ENOENT')throw x;log={task:'S10-P04',author:'Codex',runs:[]};}
const record=async value=>{log.runs.push({stage,atUTC:new Date().toISOString(),...value});await fs.writeFile(filename,JSON.stringify(log,null,2)+'\n');};
const run=async(phase,argv)=>{const result=await command(argv,{cwd:client,timeoutMs:600000});await record({phase,...result});if(result.exitCode!==0||result.timedOut||result.outputOverflow)throw Error('COMMAND_FAILED:'+phase);};
try{
 if(stage==='preflight')await run('types',[process.execPath,'node_modules/typescript/bin/tsc','-p','tsconfig.s10-p04.json','--noEmit']);
 else if(stage==='components')await run('components',[process.execPath,'node_modules/vitest/vitest.mjs','run','tests/lending/wealth.test.tsx','tests/s10-p04/components.test.tsx','-t','S10-P04|separa el libre|no consulta el negocio']);
 else if(stage==='lint')await run('lint',[process.execPath,'node_modules/eslint/bin/eslint.js','src/features/lending/Wealth.tsx','src/features/lending/WealthOperations.tsx','tests/s10-p04','scripts/s10-p04-runner.mjs','--max-warnings','0']);
 else if(stage==='build'){
  const dirs=[['src',['.ts','.tsx','.css','.svg']],['tests/s10-p04',['.mjs','.tsx']],['node_modules',['.js','.mjs','.cjs','.ts','.json','.exe','.node','.wasm']],['public',['.png','.svg','.jpg','.webp','.ico']]],inputs=[];
  for(const[d,extensions]of dirs)inputs.push(...await listFiles(path.join(client,d),{extensions,exclude:['.git','.cache']}));
  inputs.push(...['package.json','package-lock.json','tsconfig.app.json','tsconfig.s10-p04.json','vite.s10-p04.config.ts','index.html','scripts/s10-p04-runner.mjs'].map(p=>path.join(client,p)),path.join(root,'Caudelyx/servidor/scripts/s09-runner-core.mjs'));
  const build=await ensureBuild({root:client,output:path.join(client,'dist-s10-p04'),inputs,metadata:{task:'S10-P04',node:process.version,platform:process.platform,arch:process.arch,config:'vite.s10-p04.config.ts'},compile:()=>run('vite',[process.execPath,'node_modules/vite/bin/vite.js','build','--config','vite.s10-p04.config.ts'])});await record({phase:'exact-input-build',...build});
 }else if(['e2e','dev'].includes(stage))await run(stage,[process.execPath,`tests/s10-p04/${stage==='e2e'?'walk':'dev'}.mjs`]);else throw Error('Unknown stage');
 await record({phase:'stage-total',durationMs:performance.now()-start,result:'PASS'});console.log(JSON.stringify({stage,result:'PASS',durationMs:performance.now()-start}));
}catch(x){await record({phase:'stage-total',durationMs:performance.now()-start,result:'FAIL',message:x.message});console.error(x.message);process.exitCode=1;}
