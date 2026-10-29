/* eslint-disable security/detect-non-literal-fs-filename -- Artifact names and workspace roots are fixed here; runtime controls use registered ownership/containment/lease checks in core. */
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {VERSION,hash,listFiles,command,ensureBuild,withRun} from './s09-runner-core.mjs';

const server=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),root=path.resolve(server,'../..');
const evidence=path.join(root,'Construccion/Sprints/S09/Evidencias');
const evidenceFile=name=>path.join(evidence,'S09-P02-'+name);
const read=async name=>JSON.parse(await fs.readFile(evidenceFile(name),'utf8'));
const save=async(name,value)=>fs.writeFile(evidenceFile(name),JSON.stringify(value,null,2)+'\n');
const stage=process.argv[2]??'preflight';
const stages=new Set(['preflight','build','unit','compare','lint','focal','integration','stress']);
if(!stages.has(stage))throw Error('UNKNOWN_STAGE');
try{await fs.stat(evidenceFile('HASHES.json'));throw Error('FROZEN_PACKAGE_USE_NEW_VERSION');}
catch(error){if(error.code!=='ENOENT')throw error;}
const runs=await read('RUNS.json').catch(error=>{if(error.code==='ENOENT')return{task:'S09-P02',runnerVersion:VERSION,runs:[],comparisons:[]};throw error;});
const resources=await read('RESOURCES.json').catch(error=>{if(error.code==='ENOENT')return{task:'S09-P02',mongoConnections:0,databasesCreated:0,databasesDeleted:0,appProcessesStarted:0,groups:[],note:'Filesystem runner controls only; Mongo teardown/financial runtime not validated.'};throw error;});
const runId=randomUUID(),controlRoot=path.join(server,'.runtime/s09-runner'),started=performance.now();
let error;
const log=async(phase,row)=>{
  const record={runId,stage,phase,atUTC:new Date().toISOString(),...row};runs.runs.push(record);
  await save('RUNS.json',runs);
  if(row.stdout||row.stderr)await fs.appendFile(evidenceFile('COMMANDS.log'),'\n'+JSON.stringify({runId,phase,argv:row.argv,cwd:row.cwd,exitCode:row.exitCode})+'\n'+(row.stdout??'')+(row.stderr??''));
  return record;
};
const exec=async(phase,argv,extra={})=>{
  const result=await command(argv,{cwd:server,...extra});await log(phase,result);
  if(result.exitCode!==0||result.timedOut||result.outputOverflow)throw Error('COMMAND_FAILED:'+phase);
  return result;
};
const compileInputs=async()=>{
  const config=JSON.parse(await fs.readFile(path.join(server,'tsconfig.s09-runner.json'),'utf8'));
  const product=config.files.map(p=>path.join(server,p));
  const actual=await listFiles(path.join(server,'src'),{extensions:['.ts']});
  if(JSON.stringify(product.map(p=>path.resolve(p)).sort())!==JSON.stringify(actual.sort()))throw Error('SOURCE_LIST_CHANGED_REQUIRES_NEW_FROZEN_CONFIG');
  const toolFiles=await listFiles(path.join(server,'node_modules'),{extensions:['.js','.cjs','.mjs','.ts','.json'],exclude:['.cache','.git']});
  const contracts=await listFiles(path.join(root,'Construccion/Sprints'),{extensions:['.json','.yaml','.md']});
  const runtimeContracts=contracts.filter(p=>p.split(path.sep).includes('Contratos'));
  return[...product,...toolFiles,...runtimeContracts,
    path.join(server,'tsconfig.json'),path.join(server,'tsconfig.s09-runner.json'),path.join(server,'package.json'),path.join(server,'package-lock.json'),
    path.join(server,'scripts/s09-runner.mjs'),path.join(server,'scripts/s09-runner-core.mjs'),
    path.join(server,'tests/s09-runner/runner.test.mjs'),path.join(server,'tests/s09-runner/preflight.test.mjs')];
};
const build=async(force=false)=>{
  const t=performance.now(),inputs=await compileInputs();await log('build-input-enumeration',{durationMs:performance.now()-t,inputCount:inputs.length});
  const result=await ensureBuild({root:server,output:path.join(server,'dist-s09-runner'),inputs,
    metadata:{nodeVersion:process.version,platform:process.platform,arch:process.arch,compilerFlags:['-p','tsconfig.s09-runner.json'],fixture:'runner-controls-only-no-mongo',configVersion:1},always:force,
    compile:async()=>exec('typescript-build',[process.execPath,'node_modules/typescript/bin/tsc','-p','tsconfig.s09-runner.json'])});
  await log('build-result',result);return result;
};
const testCoverage=stdout=>({tests:Number(stdout.match(/# tests (\d+)/)?.[1]??0),pass:Number(stdout.match(/# pass (\d+)/)?.[1]??0),fail:Number(stdout.match(/# fail (\d+)/)?.[1]??0),skipped:Number(stdout.match(/# skipped (\d+)/)?.[1]??0),cancelled:Number(stdout.match(/# cancelled (\d+)/)?.[1]??0),names:[...stdout.matchAll(/# Subtest: (.+)/g)].map(x=>x[1])});
const testCommand=file=>[process.execPath,'--test','--test-reporter=tap','--test-concurrency=1',file];
try{
  const plan={phase:'planned',runId,folder:path.join(controlRoot,runId),pid:process.pid,owner:'CODEX/S09-P02',mongoNames:[],createdAt:new Date().toISOString()};
  resources.groups.push(plan);await save('RESOURCES.json',resources);
  await withRun(controlRoot,async owner=>{
    const env={...process.env,CAUDELYX_S09_RUN_FOLDER:owner.folder};
    const gates=JSON.parse(await fs.readFile(path.join(evidence,'S09-P01-v1-GATES.json'),'utf8'));
    if(['focal','integration','stress'].includes(stage)&&!gates.readyForFinancialBackend)throw Error('P01_PREBACKEND_REVIEW_REQUIRED');
    await exec('preflight',testCommand('tests/s09-runner/preflight.test.mjs'),{env});
    if(stage==='build')await build();
    if(stage==='lint')await exec('runner-lint',[process.execPath,'node_modules/eslint/bin/eslint.js','scripts/s09-runner.mjs','scripts/s09-runner-core.mjs','tests/s09-runner','--max-warnings','0']);
    if(stage==='unit')await exec('runner-unit',testCommand('tests/s09-runner/runner.test.mjs'),{env});
    if(stage==='compare'){
      const beforeStart=performance.now(),beforeBuild=await build(true);
      const before=await exec('before-same-focal',testCommand('tests/s09-runner/runner.test.mjs'),{env});
      const beforeMs=performance.now()-beforeStart;
      const afterStart=performance.now(),afterBuild=await build();
      const after=await exec('after-same-focal',testCommand('tests/s09-runner/runner.test.mjs'),{env});
      const afterMs=performance.now()-afterStart,a=testCoverage(before.stdout),b=testCoverage(after.stdout);
      if(JSON.stringify(a)!==JSON.stringify(b)||!a.tests||a.fail||!afterBuild.cached||beforeBuild.key!==afterBuild.key)throw Error('INCOMPARABLE_OR_FAILED_FOCAL');
      runs.comparisons.push({runId,scope:'REAL_TYPESCRIPT_COMPILATION_PLUS_IDENTICAL_RUNNER_TESTS_NOT_FINANCIAL_BACKEND',beforeMs,afterMs,differenceMs:beforeMs-afterMs,speedupRatio:beforeMs/afterMs,measuredImprovement:afterMs<beforeMs,beforeBuild,afterBuild,coverage:a,caseIdentity:hash(JSON.stringify(a)),note:'Sequential wall measurements include enumeration/hash/build/cache verification and same controls-only focal. Nested compiler/tests timings are already included. No S9 product speedup asserted.'});
      await save('RUNS.json',runs);
    }
  },async receipt=>{
    resources.groups.push({...receipt,atUTC:new Date().toISOString()});await save('RESOURCES.json',resources);
    await log(receipt.phase==='created'?'setup-controls':'cleanup-controls',{durationMs:receipt.durationMs,result:'PASS'});
  },runId);
}catch(e){error=e;await log('FAILED',{message:e.message,result:'FAIL'});}
finally{
  resources.remainingControlFolders=[];
  for(const group of resources.groups.filter(x=>x.phase==='planned')){
    try{await fs.stat(group.folder);resources.remainingControlFolders.push(group.folder);}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  await save('RESOURCES.json',resources);
  await log('stage-total',{durationMs:performance.now()-started,result:error?'FAIL':'PASS',financialRuntimeExecuted:false});
  await save('TEST-TIMINGS.json',{task:'S09-P02',source:'S09-P02-RUNS.json',runs:runs.runs.map(({runId,stage,phase,durationMs,compilerMs,exitCode,result,cached})=>({runId,stage,phase,durationMs:durationMs??null,compilerMs:compilerMs??null,exitCode:exitCode??null,result:result??null,cached:cached??null})),comparisons:runs.comparisons,notExecuted:{mongoSetupMs:null,seedMs:null,mongoVerificationMs:null,financialCasesMs:null,mongoCleanupMs:null},note:'Nested timings overlap; do not add phase and stage durations as elapsed. Filesystem setup/cleanup measured separately. Financial backend and Mongo timings unknown.'});
}
if(error){console.error(error.message);process.exitCode=1;}else console.log(JSON.stringify({stage,result:'PASS',runId,remainingOwnedControls:resources.remainingControlFolders.length,financialRuntimeExecuted:false}));
