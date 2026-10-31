import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const server=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),root=path.resolve(server,'../..'),e=path.join(root,'Construccion/Sprints/S11/Evidencias'),stage=process.argv[2]??'preflight';
if(!['preflight','unit','focal','integration','capacity','lifecycle','privacy','lint','types','verifier','scan'].includes(stage))throw Error('Invalid stage');
try{await fs.stat(path.join(e,'S11-P02-HASHES.json'));throw Error('Frozen candidate: new version required');}catch(err){if(err.code!=='ENOENT')throw err;}
const logPath=path.join(e,'S11-P02-RUNS.json'),log=JSON.parse(await fs.readFile(logPath,'utf8')),started=performance.now();
const record=async(phase,detail)=>{log.runs.push({stage,phase,atUTC:new Date().toISOString(),...detail});await fs.writeFile(logPath,JSON.stringify(log,null,2)+'\n');};
async function command(phase,args){
 const t=performance.now();const child=spawn(process.execPath,args,{cwd:server,windowsHide:true,env:process.env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';const timer=setTimeout(()=>child.kill(),600000);
 child.stdout.on('data',b=>{stdout+=b.toString();process.stdout.write(b);});child.stderr.on('data',b=>{stderr+=b.toString();process.stderr.write(b);});const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});clearTimeout(timer);
 await record(phase,{argv:[process.execPath,...args],durationMs:performance.now()-t,exitCode:code,stdout,stderr});await fs.appendFile(path.join(e,'S11-P02-COMMANDS.log'),JSON.stringify({phase,args,exitCode:code})+'\n'+stdout+stderr+'\n');if(code!==0)throw Error('FAILED:'+phase);return stdout;
}
async function files(dir){let result=[];for(const d of await fs.readdir(dir,{withFileTypes:true})){if(d.isSymbolicLink())throw Error('Unexpected link in sources');const p=path.join(dir,d.name);if(d.isDirectory())result.push(...await files(p));else result.push(p);}return result;}
try{
 const inputFiles=async()=>[...await files(path.join(server,'src')),...await files(path.join(server,'tests/s11-p02')),...(await files(path.join(root,'Construccion/Sprints/S11/Contratos'))).filter(p=>p.endsWith('.json')),path.join(server,'tsconfig.json'),path.join(server,'tsconfig.s11-p02.json'),path.join(server,'package.json'),path.join(server,'package-lock.json'),path.join(server,'tests/helpers/client.ts')];
 const fingerprint=async()=>await Promise.all((await inputFiles()).sort().map(async p=>[path.relative(server,p).replaceAll(path.sep,'/'),createHash('sha256').update(await fs.readFile(p)).digest('hex')]));
 const inputs=await fingerprint(),stable=async()=>{if(JSON.stringify(await fingerprint())!==JSON.stringify(inputs))throw Error('SOURCE_CHANGED_DURING_RUN');};
 const key=createHash('sha256').update(JSON.stringify({node:process.version,inputs})).digest('hex'),statePath=path.join(e,'S11-P02-BUILD-STATE.json');let state;try{state=JSON.parse(await fs.readFile(statePath,'utf8'));}catch(err){if(err.code!=='ENOENT')throw err;}
 if(stage==='scan')await command('scan',['scripts/security-scan.mjs']);
 else if(stage==='types')await command('types',['node_modules/typescript/bin/tsc','-p','tsconfig.s11-p02.json','--noEmit']);
 else if(stage==='lint'){const pre=JSON.parse(await fs.readFile(path.join(e,'S11-P02-PREIMAGES.json'),'utf8')),paths=Object.keys(pre).filter(p=>p.startsWith('Caudelyx/servidor/src/')).map(p=>p.slice('Caudelyx/servidor/'.length));await command('lint',['node_modules/eslint/bin/eslint.js','src/modules/exchange','src/modules/lending/historical.ts','tests/s11-p02',...paths,'--max-warnings','0']);}
 else{
  if(state?.key!==key){await command('build',['node_modules/typescript/bin/tsc','-p','tsconfig.s11-p02.json']);await stable();const out=await files(path.join(server,'dist-s11-p02'));state={format:'S11_COMPILED_INPUTS_V1',key,node:process.version,metadata:{config:'tsconfig.s11-p02.json',sourceKey:key},inputs,outputs:await Promise.all(out.sort().map(async p=>[path.relative(path.join(server,'dist-s11-p02'),p).replaceAll(path.sep,'/'),createHash('sha256').update(await fs.readFile(p)).digest('hex')]))};await fs.writeFile(statePath,JSON.stringify(state,null,2)+'\n');await record('build-cache',{result:'BUILT',key});}
  else{for(const[name,digest]of state.outputs)if(createHash('sha256').update(await fs.readFile(path.join(server,'dist-s11-p02',name))).digest('hex')!==digest)throw Error('Compiled output drift');await record('build-cache',{result:'REUSED',key,assumptions:'Exact src/test/config/lock inputs unchanged; installed dependency verification expanded at final seal; no library installation.'});}
  const tests=stage==='preflight'?['preflight','parser','formats']:stage==='unit'?['parser','formats','storage','historical']:stage==='focal'||stage==='integration'?['integration']:stage==='privacy'?['privacy']:stage==='lifecycle'?['lifecycle']:stage==='capacity'?['capacity']:[];
  for(const test of tests)await command(test,['--test','--test-concurrency=1','--test-reporter=tap','dist-s11-p02/tests/s11-p02/'+test+'.test.js']);
  if(stage==='verifier')await command('verifier',['--test','tests/s11-p02/verifier.test.mjs']);
 }
 await stable();await record('stage-total',{result:'PASS',sourceKey:key,durationMs:performance.now()-started});
}catch(err){await record('stage-total',{result:'FAIL',durationMs:performance.now()-started,message:err.message});process.stderr.write(err.stack+'\n');process.exitCode=1;}
finally{await fs.writeFile(path.join(e,'S11-P02-TIMINGS.json'),JSON.stringify({task:'S11-P02',runs:log.runs.map(({stage,phase,durationMs,result,exitCode})=>({stage,phase,durationMs:durationMs??null,result:result??null,exitCode:exitCode??null})),note:'Stage totals include child phases; do not sum overlaps. All FAIL retained; initial reads/coding not timed per file.'},null,2)+'\n');}


