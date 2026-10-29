/* eslint-disable security/detect-non-literal-fs-filename -- Fixed new P02-v2 artifact/output roots. Cache deletes only its registered output list via reviewed containment guards. */
import ts from 'typescript';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {command,listFiles,ensureBuild,fileHash,VERSION} from './s09-runner-core.mjs';
const server=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),root=path.resolve(server,'../..'),e=path.join(root,'Construccion/Sprints/S09/Evidencias');
const artifact=name=>path.join(e,'S09-P02-v2-'+name),stage=process.argv[2]??'preflight';
if(!['preflight','unit','focal','integration','stress','lint','types'].includes(stage))throw Error('Unknown stage');
try{await fs.stat(artifact('HASHES.json'));throw Error('Frozen v2; create a new candidate');}catch(err){if(err.code!=='ENOENT')throw err;}
const gates=JSON.parse(await fs.readFile(artifact('GATES.json'),'utf8'));if(!gates.financialImplementationAuthorized||!gates.prebackendHoldOverriddenByOwner)throw Error('Explicit owner authorization missing');
let log;try{log=JSON.parse(await fs.readFile(artifact('RUNS.json'),'utf8'));}catch(err){if(err.code!=='ENOENT')throw err;log={task:'S09-P02-v2',runs:[]};}
const start=performance.now();
const record=async(phase,result)=>{log.runs.push({stage,phase,atUTC:new Date().toISOString(),...result});await fs.writeFile(artifact('RUNS.json'),JSON.stringify(log,null,2)+'\n');if(result.stdout||result.stderr)await fs.appendFile(artifact('COMMANDS.log'),'\n'+JSON.stringify({phase,argv:result.argv,exitCode:result.exitCode})+'\n'+(result.stdout??'')+(result.stderr??''));};
const exec=async(phase,argv,options={})=>{const result=await command(argv,{cwd:server,timeoutMs:600000,...options});await record(phase,result);if(result.exitCode!==0||result.timedOut||result.outputOverflow)throw Error('COMMAND_FAILED:'+phase);return result;};
try{
 const sources=await listFiles(path.join(server,'src'),{extensions:['.ts']}),tests=await listFiles(path.join(server,'tests/s09-backend'),{extensions:['.ts']}),tools=await listFiles(path.join(server,'node_modules'),{extensions:['.js','.mjs','.cjs','.ts','.json'],exclude:['.git','.cache']}),allContracts=(await listFiles(path.join(root,'Construccion/Sprints'),{extensions:['.json','.yaml','.md']})).filter(p=>p.split(path.sep).includes('Contratos'));
 const parsed=ts.getParsedCommandLineOfConfigFile(path.join(server,'tsconfig.s09-backend.json'),{},{...ts.sys,onUnRecoverableConfigFileDiagnostic:()=>{throw Error('Invalid compiler configuration');}});if(!parsed)throw Error('Compiler configuration unavailable');const transitive=ts.createProgram(parsed.fileNames,parsed.options).getSourceFiles().map(f=>path.resolve(f.fileName));
 const inputs=[...transitive,...sources,...tests,...tools,...allContracts,path.join(server,'package-lock.json'),path.join(server,'package.json'),path.join(server,'tsconfig.json'),path.join(server,'tsconfig.s09-backend.json'),fileURLToPath(import.meta.url),path.join(server,'scripts/s09-runner-core.mjs')];
 const output=path.join(server,'dist-s09-backend'),marker=path.join(output,'.s09-build.json');
 try{await fs.stat(marker);}catch(err){if(err.code!=='ENOENT')throw err;try{const files=await listFiles(output);await record('unvalidated-initial-compiler-output-inventory',{files:files.length,reason:'Earlier explicitly invoked tsc into new reserved output reported unit typing errors. Output not reusable; register exact list for safe rebuild.'});await fs.writeFile(marker,JSON.stringify({version:VERSION,key:'UNVALIDATED_INITIAL_COMPILER_OUTPUT',outputs:await Promise.all(files.map(async p=>[path.relative(output,p).replaceAll(path.sep,'/'),await fileHash(p)]))}));}catch(missing){if(missing.code!=='ENOENT')throw missing;}}
 const build=await ensureBuild({root:server,output,inputs,metadata:{node:process.version,platform:process.platform,arch:process.arch,config:'tsconfig.s09-backend.json',flags:[],sourceFiles:sources.map(p=>path.relative(server,p)),testFiles:tests.map(p=>path.relative(server,p))},compile:async()=>exec('build',[process.execPath,'node_modules/typescript/bin/tsc','-p','tsconfig.s09-backend.json'])});await record('compiled-input-verification',build);
 const test=file=>exec(stage,[process.execPath,'--test','--test-reporter=tap','--test-concurrency=1','dist-s09-backend/tests/s09-backend/'+file+'.test.js']);
 if(stage==='preflight'){await test('preflight');await test('unit');}
 else if(stage==='unit')await test('unit');
 else if(['focal','integration'].includes(stage))await test('integration');
 else if(stage==='stress')await test('stress');
 else if(stage==='lint')await exec('lint',[process.execPath,'node_modules/eslint/bin/eslint.js','src/modules/obligations','tests/s09-backend','scripts/s09-backend-runner.mjs','--max-warnings','0']);
 await record('stage-total',{durationMs:performance.now()-start,result:'PASS'});console.log(JSON.stringify({stage,result:'PASS',cachedBuild:build.cached,durationMs:performance.now()-start}));
}catch(error){await record('stage-total',{durationMs:performance.now()-start,result:'FAIL',message:error.message});console.error(error.message);process.exitCode=1;}
finally{await fs.writeFile(artifact('TEST-TIMINGS.json'),JSON.stringify({task:'S09-P02-v2',runs:log.runs.map(({phase,stage,durationMs,durationSeconds,result,exitCode,cached,compilerMs})=>({phase,stage,durationMs:durationMs??(durationSeconds===undefined?null:durationSeconds*1000),result:result??null,exitCode:exitCode??null,cached:cached??null,compilerMs:compilerMs??null})),note:'Stage durations include nested build/commands; do not sum overlaps. Initial uninstrumented reads and coding time not measured.'},null,2)+'\n');}
