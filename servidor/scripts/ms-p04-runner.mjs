/* eslint-disable security/detect-non-literal-fs-filename -- Input paths come from this package's exact reservation; output writes always pass assertWritable. No HTTP path or historical runner. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {root,evidence,assertWritable,writeOwn} from './ms-p04-guard.mjs';
const stage=process.argv[2],server=path.join(root,'Caudelyx/servidor');
if(!['types','lint','integration','reference','browser','security','restore','queries','client-types','client-tests','client-build','client-lint'].includes(stage))throw Error('INVALID_STAGE_NO_WRITES');
await assertWritable(path.join(evidence,'MS-P04-RUNS.json'));
const runsPath=path.join(evidence,'MS-P04-RUNS.json'),log=JSON.parse(await fs.readFile(runsPath,'utf8'));
const start=performance.now();let toolControl;
if(stage==='client-tests'){
 const id=randomBytes(12).toString('hex'),folder=path.join(server,'.runtime','ms-p04-'+id),runId=randomUUID();await assertWritable(path.join(evidence,'MS-P04-RESOURCES.jsonl'));await fs.appendFile(path.join(evidence,'MS-P04-RESOURCES.jsonl'),JSON.stringify({at:new Date().toISOString(),task:'MS-P04',event:'reserved-before-create',resourceKind:'tool-cache',runId,groupId:id,ownerPid:process.pid,folder,databases:[],budget:{controlBytes:125829120},reason:'Own Vitest TMP/TEMP, no Mongo or persistent profile'})+'\n');
 if(await fs.stat(folder).then(()=>true,e=>{if(e.code!=='ENOENT')throw e;return false;}))throw Error('OWN_TOOL_CONTROL_EXISTS');await fs.mkdir(folder);toolControl={folder,id,runId};
}
async function command(phase,args,cwd=server){
 const begun=performance.now(),child=spawn(process.execPath,args,{cwd,env:{...process.env,...(toolControl?{TMP:toolControl.folder,TEMP:toolControl.folder}:{})},windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
 child.stdout.on('data',x=>{stdout+=x;process.stdout.write(x);});child.stderr.on('data',x=>{stderr+=x;process.stderr.write(x);});
 const timer=setTimeout(()=>child.kill(),960000);let code;
 try{code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});}finally{clearTimeout(timer);}
 log.runs.push({stage,phase,argv:[process.execPath,...args],atUTC:new Date().toISOString(),durationMs:performance.now()-begun,exitCode:code,stdout,stderr});await writeOwn(runsPath,JSON.stringify(log,null,2)+'\n');
 if(code!==0)throw Error('MS_P04_STAGE_FAILED:'+phase);
}
async function digestInputs(){
 const doc=JSON.parse(await fs.readFile(path.join(evidence,'MS-P04-INPUTS.json'),'utf8'));
 return Promise.all((stage.startsWith('client-')?doc.clientSources:doc.compileSources).map(async p=>[p,createHash('sha256').update(await fs.readFile(path.join(root,p))).digest('hex')]));
}
try{
 const inputs=await digestInputs(),key=createHash('sha256').update(JSON.stringify({node:process.version,inputs})).digest('hex');
 if(stage==='types')await command('types',['node_modules/typescript/bin/tsc','-p','tsconfig.ms-p04.json','--noEmit']);
 else if(stage.startsWith('client-')){
  const cwd=path.join(root,'Caudelyx/cliente');
  if(stage==='client-types')await command(stage,['node_modules/typescript/bin/tsc','-p','tsconfig.ms-p04.json','--noEmit'],cwd);
  else if(stage==='client-lint'){const doc=JSON.parse(await fs.readFile(path.join(evidence,'MS-P04-INPUTS.json'),'utf8'));const files=doc.reservedPaths.filter(p=>p.startsWith('Caudelyx/cliente/')&&/\.(?:tsx?|mjs)$/.test(p)).map(p=>path.relative(cwd,path.join(root,p)));await command(stage,['node_modules/eslint/bin/eslint.js',...files,'--max-warnings','0'],cwd);}
  else if(stage==='client-tests')await command(stage,['node_modules/vitest/vitest.mjs','run','--config','vitest.ms-p04.config.ts','--configLoader','runner','--no-cache'],cwd);
  else{const doc=JSON.parse(await fs.readFile(path.join(evidence,'MS-P04-INPUTS.json'),'utf8'));for(const p of doc.clientOutputs)await assertWritable(path.join(root,p));await command(stage,['node_modules/vite/bin/vite.js','build','--config','vite.ms-p04.config.ts','--configLoader','native'],cwd);const outputs=await Promise.all(doc.clientOutputs.map(async p=>[p,createHash('sha256').update(await fs.readFile(path.join(root,p))).digest('hex')]));await writeOwn(path.join(evidence,'MS-P04-COMPILED-INPUTS.json'),JSON.stringify({...JSON.parse(await fs.readFile(path.join(evidence,'MS-P04-COMPILED-INPUTS.json'),'utf8').catch(e=>{if(e.code!=='ENOENT')throw e;return'{}';})),client:{key,node:process.version,inputs,outputs}},null,2)+'\n');}
 }
 else if(stage==='lint'){
  const doc=JSON.parse(await fs.readFile(path.join(evidence,'MS-P04-INPUTS.json'),'utf8')),files=[];
  for(const p of doc.reservedPaths)if(p.startsWith('Caudelyx/servidor/')&&/\.(?:ts|mjs)$/.test(p)&&await fs.stat(path.join(root,p)).then(()=>true,e=>{if(e.code!=='ENOENT')throw e;return false;}))files.push(path.relative(server,path.join(root,p)));
  await command('lint',['node_modules/eslint/bin/eslint.js',...files,'--max-warnings','0']);
 }
 else{
  const statePath=path.join(evidence,'MS-P04-COMPILED-INPUTS.json');let state;try{state=JSON.parse(await fs.readFile(statePath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(state?.server?.key!==key){
   const plan=JSON.parse(await fs.readFile(path.join(evidence,'MS-P04-INPUTS.json'),'utf8'));for(const p of plan.serverOutputs)await assertWritable(path.join(root,p));
   await command('build',['node_modules/typescript/bin/tsc','-p','tsconfig.ms-p04.json']);
   const outputs=await Promise.all(plan.serverOutputs.map(async p=>[p,createHash('sha256').update(await fs.readFile(path.join(root,p))).digest('hex')]));state={...state,server:{key,node:process.version,inputs,outputs}};await writeOwn(statePath,JSON.stringify(state,null,2)+'\n');
  }else for(const[p,h]of state.server.outputs)if(createHash('sha256').update(await fs.readFile(path.join(root,p))).digest('hex')!==h)throw Error('COMPILED_DRIFT');
  await command(stage,['--test','--test-concurrency=1','--test-reporter=tap','dist-ms-p04/tests/ms-p04/'+stage+'.test.js']);
 }
 if(JSON.stringify(inputs)!==JSON.stringify(await digestInputs()))throw Error('INPUT_CHANGED_DURING_RUN');
 log.runs.push({stage,phase:'stage-total',result:'PASS',durationMs:performance.now()-start,key});
}catch(e){log.runs.push({stage,phase:'stage-total',result:'FAIL',durationMs:performance.now()-start,error:String(e)});process.exitCode=1;}
finally{if(toolControl){const p=await fs.realpath(toolControl.folder);if(p!==toolControl.folder||path.dirname(p)!==path.join(server,'.runtime')||(await fs.lstat(p)).isSymbolicLink())throw Error('OWN_TOOL_CLEANUP_PATH');await fs.rm(p,{recursive:true,force:false});await fs.appendFile(path.join(evidence,'MS-P04-RESOURCES.jsonl'),JSON.stringify({at:new Date().toISOString(),task:'MS-P04',event:'cleanup-complete',resourceKind:'tool-cache',groupId:toolControl.id,runId:toolControl.runId,folder:p,controlRemoved:true,databases:[],absenceVerified:true,remaining:0,sharedMongoServiceUnchanged:true})+'\n');}await writeOwn(runsPath,JSON.stringify(log,null,2)+'\n');await writeOwn(path.join(evidence,'MS-P04-TIMINGS.json'),JSON.stringify({phases:log.runs.map(({stage,phase,durationMs,result,exitCode})=>({stage,phase,durationMs,result,exitCode})),note:'Stage totals include children; do not sum them twice.'},null,2)+'\n');}
