/* eslint-disable security/detect-non-literal-fs-filename -- Guarded P02-only outputs, exact compile config, no historical mutable runner invoked. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {projectRoot,assertWritable,writeOwn,appendOwn} from './s12-p02-guard.mjs';
const server=path.join(projectRoot,'Caudelyx/servidor'),e=path.join(projectRoot,'Construccion/Sprints/S12/Evidencias'),stage=process.argv[2];
const allowed=['guard','preflight','pure','types','lint','scan','finance','history','terms','privacy','lifecycle','capacity','dev','fixes'];
// No receipt/log/lock/directory is written before this guard and argument check.
await assertWritable(path.join(e,'S12-P02-RUNS.json'));if(!allowed.includes(stage))throw Error('INVALID_STAGE_NO_WRITES');
const lock=path.join(e,'S12-P02-ACTIVE.json'),nonce=randomUUID();await assertWritable(lock);const handle=await fs.open(lock,'wx');await handle.writeFile(JSON.stringify({pid:process.pid,nonce,stage}));await handle.close();
const started=performance.now(),logPath=path.join(e,'S12-P02-RUNS.json'),log=JSON.parse(await fs.readFile(logPath,'utf8'));
const record=async(phase,data)=>{log.runs.push({stage,phase,atUTC:new Date().toISOString(),...data});await writeOwn(logPath,JSON.stringify(log,null,2)+'\n');};
async function files(dir){const rows=[];for(const d of await fs.readdir(dir,{withFileTypes:true})){if(d.isSymbolicLink())throw Error('SOURCE_LINK_REFUSED');const p=path.join(dir,d.name);if(d.isDirectory())rows.push(...await files(p));else rows.push(p);}return rows;}
async function inputs(){const names=[...['s12-p02-runner.mjs','s12-p02-guard.mjs','s12-p02-guard.d.mts','installed-profile.mjs','installed-dev.mjs'].map(n=>path.join(server,'scripts',n)),...await files(path.join(server,'src')),...await files(path.join(server,'tests/s12-p02')),...await files(path.join(projectRoot,'Construccion/Sprints/S12/Contratos')),...['tsconfig.json','tsconfig.s12-p02.json','package.json','package-lock.json'].map(n=>path.join(server,n))];return Promise.all(names.sort().map(async p=>[path.relative(server,p).replaceAll(path.sep,'/'),createHash('sha256').update(await fs.readFile(p)).digest('hex')]));}
async function command(phase,args,binary=process.execPath){const start=performance.now(),child=spawn(binary,args,{cwd:server,env:{...process.env,PYTHONIOENCODING:'utf-8'},windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',v=>{stdout+=v;process.stdout.write(v);});child.stderr.on('data',v=>{stderr+=v;process.stderr.write(v);});const timer=setTimeout(()=>child.kill(),600000);const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});clearTimeout(timer);await record(phase,{argv:[binary,...args],durationMs:performance.now()-start,exitCode:code,stdout,stderr});await appendOwn(path.join(e,'S12-P02-COMMANDS.log'),JSON.stringify({phase,args,code})+'\n'+stdout+stderr+'\n');if(code!==0)throw Error('FAILED:'+phase);}
try{
 const before=await inputs(),key=createHash('sha256').update(JSON.stringify({node:process.version,inputs:before})).digest('hex');
 if(stage==='guard')await command('guard',['--test','tests/s12-p02/verifier.test.mjs']);
 else if(stage==='types')await command('types',['node_modules/typescript/bin/tsc','-p','tsconfig.s12-p02.json','--noEmit']);
 else if(stage==='lint')await command('lint',['node_modules/eslint/bin/eslint.js','src/modules/simulation','tests/s12-p02',...JSON.parse(await fs.readFile(path.join(e,'S12-P02-INPUTS.json'),'utf8')).livePaths.map(n=>path.relative(server,path.join(projectRoot,n))),'scripts/s12-p02-guard.mjs','scripts/s12-p02-runner.mjs','--max-warnings','0']);
 else if(stage==='scan')await command('scan',['scripts/security-scan.mjs']);
 else{
  const statePath=path.join(e,'S12-P02-BUILD-STATE.json');let state;try{state=JSON.parse(await fs.readFile(statePath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(state?.key!==key){const config=JSON.parse(await fs.readFile(path.join(server,'tsconfig.s12-p02.json'),'utf8'));if(config.compilerOptions.outDir!=='dist-s12-p02')throw Error('UNREGISTERED_COMPILER_OUTPUT');await assertWritable(path.join(server,'dist-s12-p02'));await command('build',['node_modules/typescript/bin/tsc','-p','tsconfig.s12-p02.json']);const outputs=await Promise.all((await files(path.join(server,'dist-s12-p02'))).sort().map(async p=>[path.relative(path.join(server,'dist-s12-p02'),p).replaceAll(path.sep,'/'),createHash('sha256').update(await fs.readFile(p)).digest('hex')]));state={key,node:process.version,inputs:before,outputs};await writeOwn(statePath,JSON.stringify(state,null,2)+'\n');await record('build-cache',{result:'BUILT',key});}
  else{for(const[n,h]of state.outputs)if(createHash('sha256').update(await fs.readFile(path.join(server,'dist-s12-p02',n))).digest('hex')!==h)throw Error('COMPILED_DRIFT');await record('build-cache',{result:'REUSED',key});}
  const names=stage==='preflight'?['preflight']:stage==='pure'?['engine','alerts']:stage==='fixes'?['fixes']:[stage];
  for(const name of names){const test=path.join(server,'dist-s12-p02/tests/s12-p02/'+name+'.test.js');if(!await fs.stat(test).then(()=>true,()=>false))throw Error('STAGE_NOT_IMPLEMENTED:'+name);const pattern=process.env['S12_TEST_PATTERN'];if(pattern!==undefined&&pattern.length>100)throw Error('INVALID_TEST_PATTERN');await command(name,['--test','--test-concurrency=1','--test-reporter=tap',...(pattern?['--test-name-pattern='+pattern]:[]),test]);}
  if(stage==='fixes'){await command('format-corpus',[path.join(e,'S12-P02-FORMAT-QA.mjs')]);await command('independent-format-oracle',['tests/s12-p02/formats-oracle.py'],path.join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'));}
 }
 if(JSON.stringify(await inputs())!==JSON.stringify(before))throw Error('SOURCE_CHANGED_DURING_RUN');await record('stage-total',{result:'PASS',sourceKey:key,durationMs:performance.now()-started});
}catch(error){await record('stage-total',{result:'FAIL',durationMs:performance.now()-started,error:String(error)});process.stderr.write(String(error.stack)+'\n');process.exitCode=1;}
finally{
 await writeOwn(path.join(e,'S12-P02-TIMINGS.json'),JSON.stringify({runs:log.runs.map(({stage,phase,durationMs,result,exitCode})=>({stage,phase,durationMs:durationMs??null,result:result??null,exitCode:exitCode??null})),note:'Stage total includes children. No double sum.'},null,2)+'\n');const own=JSON.parse(await fs.readFile(lock,'utf8'));if(own.pid!==process.pid||own.nonce!==nonce)throw Error('LOCK_OWNER_CHANGED');await assertWritable(lock);await fs.unlink(lock);
}
