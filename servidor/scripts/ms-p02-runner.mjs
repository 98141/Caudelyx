/* eslint-disable security/detect-non-literal-fs-filename -- Input paths come from this package's exact reservation; output writes always pass assertWritable. No HTTP path or historical runner. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {root,evidence,assertWritable,writeOwn} from './ms-p02-guard.mjs';
const stage=process.argv[2],server=path.join(root,'Caudelyx/servidor');
if(!['types','pure','lint','native','history','flows','restore','payments','queries','entry'].includes(stage))throw Error('INVALID_STAGE_NO_WRITES');
await assertWritable(path.join(evidence,'MS-P02-RUNS.json'));
const runsPath=path.join(evidence,'MS-P02-RUNS.json'),log=JSON.parse(await fs.readFile(runsPath,'utf8'));
const start=performance.now();
async function command(phase,args){
 const begun=performance.now(),child=spawn(process.execPath,args,{cwd:server,env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
 child.stdout.on('data',x=>{stdout+=x;process.stdout.write(x);});child.stderr.on('data',x=>{stderr+=x;process.stderr.write(x);});
 const timer=setTimeout(()=>child.kill(),960000);let code;
 try{code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});}finally{clearTimeout(timer);}
 log.runs.push({stage,phase,argv:[process.execPath,...args],atUTC:new Date().toISOString(),durationMs:performance.now()-begun,exitCode:code,stdout,stderr});await writeOwn(runsPath,JSON.stringify(log,null,2)+'\n');
 if(code!==0)throw Error('MS_P02_STAGE_FAILED:'+phase);
}
async function digestInputs(){
 const doc=JSON.parse(await fs.readFile(path.join(evidence,'MS-P02-INPUTS.json'),'utf8'));
 return Promise.all(doc.compileSources.map(async p=>[p,createHash('sha256').update(await fs.readFile(path.join(root,p))).digest('hex')]));
}
try{
 const inputs=await digestInputs(),key=createHash('sha256').update(JSON.stringify({node:process.version,inputs})).digest('hex');
 if(stage==='types')await command('types',['node_modules/typescript/bin/tsc','-p','tsconfig.ms-p02.json','--noEmit']);
 else if(stage==='lint'){
  const doc=JSON.parse(await fs.readFile(path.join(evidence,'MS-P02-INPUTS.json'),'utf8')),files=[];
  for(const p of doc.reservedPaths)if(p.startsWith('Caudelyx/servidor/')&&/\.(?:ts|mjs)$/.test(p)&&await fs.stat(path.join(root,p)).then(()=>true,e=>{if(e.code!=='ENOENT')throw e;return false;}))files.push(path.relative(server,path.join(root,p)));
  await command('lint',['node_modules/eslint/bin/eslint.js',...files,'--max-warnings','0']);
 }
 else{
  const statePath=path.join(evidence,'MS-P02-COMPILED-INPUTS.json');let state;try{state=JSON.parse(await fs.readFile(statePath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(state?.key!==key){
   const plan=JSON.parse(await fs.readFile(path.join(evidence,'MS-P02-INPUTS.json'),'utf8'));for(const p of plan.compiledPaths)await assertWritable(path.join(root,p));
   await command('build',['node_modules/typescript/bin/tsc','-p','tsconfig.ms-p02.json']);
   const outputs=await Promise.all(plan.compiledPaths.map(async p=>[p,createHash('sha256').update(await fs.readFile(path.join(root,p))).digest('hex')]));state={key,node:process.version,inputs,outputs};await writeOwn(statePath,JSON.stringify(state,null,2)+'\n');
  }else for(const[p,h]of state.outputs)if(createHash('sha256').update(await fs.readFile(path.join(root,p))).digest('hex')!==h)throw Error('COMPILED_DRIFT');
  await command(stage,['--test','--test-concurrency=1','--test-reporter=tap','dist-ms-p02/tests/ms-p02/'+(stage==='pure'?'engine':stage)+'.test.js']);
 }
 if(JSON.stringify(inputs)!==JSON.stringify(await digestInputs()))throw Error('INPUT_CHANGED_DURING_RUN');
 log.runs.push({stage,phase:'stage-total',result:'PASS',durationMs:performance.now()-start,key});
}catch(e){log.runs.push({stage,phase:'stage-total',result:'FAIL',durationMs:performance.now()-start,error:String(e)});process.exitCode=1;}
finally{await writeOwn(runsPath,JSON.stringify(log,null,2)+'\n');await writeOwn(path.join(evidence,'MS-P02-TIMINGS.json'),JSON.stringify({phases:log.runs.map(({stage,phase,durationMs,result,exitCode})=>({stage,phase,durationMs,result,exitCode})),note:'Stage totals include children; do not sum them twice.'},null,2)+'\n');}
