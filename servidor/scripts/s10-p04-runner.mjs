// New P04 output roots; immutable historical runner core is read-only.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {command,listFiles,ensureBuild} from './s09-runner-core.mjs';
const server=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),root=path.resolve(server,'../..'),e=path.join(root,'Construccion/Sprints/S10/Evidencias'),filename=path.join(e,'S10-P04-SERVER-RUNS.json'),stage=process.argv[2]??'preflight',start=performance.now();
try{await fs.stat(path.join(e,'S10-P04-HASHES.json'));throw Error('Frozen P04; new version required');}catch(x){if(x.code!=='ENOENT')throw x;}
let log;try{log=JSON.parse(await fs.readFile(filename,'utf8'));}catch(x){if(x.code!=='ENOENT')throw x;log={task:'S10-P04',author:'Codex',runs:[]};}
const record=async value=>{log.runs.push({stage,atUTC:new Date().toISOString(),...value});await fs.writeFile(filename,JSON.stringify(log,null,2)+'\n');};
const run=async(phase,argv)=>{const result=await command(argv,{cwd:server,timeoutMs:600000});await record({phase,...result});if(result.exitCode!==0||result.timedOut||result.outputOverflow)throw Error('COMMAND_FAILED:'+phase);};
try{
 const inputs=[];for(const[d,extensions]of [['src',['.ts']],['tests/s10-p04',['.ts','.mjs']],['node_modules',['.js','.mjs','.cjs','.ts','.json']]])inputs.push(...await listFiles(path.join(server,d),{extensions,exclude:['.git','.cache']}));
 const parsed=ts.getParsedCommandLineOfConfigFile(path.join(server,'tsconfig.s10-p04.json'),{},{...ts.sys,onUnRecoverableConfigFileDiagnostic:()=>{throw Error('Invalid configuration');}});if(!parsed)throw Error('Invalid config');inputs.push(...ts.createProgram(parsed.fileNames,parsed.options).getSourceFiles().map(f=>path.resolve(f.fileName)));
 inputs.push(...(await listFiles(path.join(root,'Construccion/Sprints'),{extensions:['.json','.yaml','.md']})).filter(p=>p.split(path.sep).includes('Contratos')),...await listFiles(path.join(server,'dist-s09-backend/src/modules/obligations'),{extensions:['.js']}));inputs.push(...['package.json','package-lock.json','tsconfig.json','tsconfig.s10-p04.json','scripts/s10-p04-runner.mjs','scripts/s09-runner-core.mjs','scripts/installed-dev.mjs','scripts/installed-profile.mjs','tsconfig.local.json','dist-s09-backend/src/shared/errors.js'].map(p=>path.join(server,p)));
 const build=await ensureBuild({root:server,output:path.join(server,'dist-s10-p04'),inputs,metadata:{task:'S10-P04',node:process.version,platform:process.platform,arch:process.arch,config:'tsconfig.s10-p04.json'},compile:()=>run('tsc',[process.execPath,'node_modules/typescript/bin/tsc','-p','tsconfig.s10-p04.json'])});await record({phase:'exact-input-build',...build});
 if(stage==='preflight')for(const file of ['preflight','unit'])await run(file,[process.execPath,'--test','--test-reporter=tap','dist-s10-p04/tests/s10-p04/'+file+'.test.js']);
 else if(['integration','restore'].includes(stage))await run(stage,[process.execPath,'--test','--test-reporter=tap','--test-concurrency=1','dist-s10-p04/tests/s10-p04/'+stage+'.test.js']);else if(stage!=='build')throw Error('Unknown stage');
 await record({phase:'stage-total',durationMs:performance.now()-start,result:'PASS'});console.log(JSON.stringify({stage,result:'PASS',durationMs:performance.now()-start}));
}catch(x){await record({phase:'stage-total',durationMs:performance.now()-start,result:'FAIL',message:x.message});console.error(x.message);process.exitCode=1;}
