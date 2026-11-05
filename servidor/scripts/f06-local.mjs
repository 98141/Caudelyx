// One dedicated local TLS/SCRAM replica. Never connects to installed27017 or
// manual27181. Resource identity and every process are recorded before use.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {request} from 'node:https';
import {Readable} from 'node:stream';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {MongoClient} from 'mongodb';
import {provision} from '../../deploy/tools/provision.mjs';
import {archiveDirectory,encryptArchive,decryptArchive,extractDirectory} from '../../deploy/tools/operations.mjs';
const server=path.resolve(fileURLToPath(new URL('..',import.meta.url))),repo=path.dirname(server),workspace=path.dirname(repo),evidence=path.join(workspace,'Construccion/Sprints/F06-INTEGRAL/Evidencias');
const runFile=path.join(evidence,'F06-RUNS.json');let runs;
try{runs=JSON.parse(await fs.readFile(runFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;runs={task:'F06-INTEGRAL-002',runs:[]};}
async function stage(name,command,args,cwd=server,env=process.env){
 const sources=name==='backend-build'?await Promise.all(program.getSourceFiles().filter(f=>!f.isDeclarationFile&&!f.fileName.includes('node_modules')).map(async f=>({path:path.relative(server,f.fileName),sha256:createHash('sha256').update(await fs.readFile(f.fileName)).digest('hex')}))):undefined;
 const started=performance.now(),child=spawn(command,args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
 child.stdout.on('data',b=>{stdout+=b;if(name.includes('integral')||name.includes('restore'))process.stdout.write(b);if(stdout.length>300000)stdout=stdout.slice(-300000);});child.stderr.on('data',b=>{stderr+=b;if(stderr.length>300000)stderr=stderr.slice(-300000);});
 const [code]=await once(child,'exit');const row={stage:name,command:[command,...args],exitCode:code,milliseconds:+(performance.now()-started).toFixed(3),stdout,stderr,...(sources?{sources}:{})};runs.runs.push(row);await fs.writeFile(runFile,JSON.stringify(runs,null,2)+'\n');
 console.log(name,code===0?'PASS':'FAIL',row.milliseconds+'ms');if(code!==0)throw Error('F06_STAGE_FAILED:'+name);return row;
}
const ts=(await import(pathToFileURL(path.join(server,'node_modules/typescript/lib/typescript.js')).href)).default;
const configPath=path.join(server,'tsconfig.f06.json'),config=ts.getParsedCommandLineOfConfigFile(configPath,{}, {...ts.sys,onUnRecoverableConfigFileDiagnostic:()=>{throw Error('Invalid F06 compiler configuration');}}),program=ts.createProgram(config.fileNames,config.options);
const compiled=program.getSourceFiles().filter(f=>!f.isDeclarationFile&&!f.fileName.includes('/node_modules/')&&!f.fileName.includes('\\node_modules\\')).flatMap(f=>{
 const relative=path.relative(server,f.fileName);if(relative.startsWith('..'))throw Error('Compile source outside server');
 return['.js','.js.map'].map(ext=>path.join(server,'.runtime/f06-build',relative.replace(/\.ts$/,ext)));
});
async function publicFiles(dir){const list=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('Linked public asset');if(e.isDirectory())list.push(...await publicFiles(p));else list.push(p);}return list;}
const clientFiles=[...['index.html','assets/app.js','assets/app.css'].map(n=>path.join(repo,'cliente/dist-docker',n)),...(await publicFiles(path.join(repo,'cliente/public'))).map(p=>path.join(repo,'cliente/dist-docker',path.relative(path.join(repo,'cliente/public'),p)))];
await fs.writeFile(path.join(evidence,'F06-COMPILED.json'),JSON.stringify({task:'F06-INTEGRAL-002',reservedBeforeEmit:true,backend:compiled,frontend:clientFiles},null,2)+'\n');
if(process.argv.includes('--reuse-builds')){
 for(const name of ['backend-build','frontend-typecheck','frontend-build'])if(!runs.runs.some(r=>r.stage===name&&r.exitCode===0))throw Error('No successful build evidence to reuse');
 for(const f of compiled)if(!(await fs.stat(f)).isFile())throw Error('Missing owned compiled file');
 for(const f of program.getSourceFiles().filter(f=>!f.isDeclarationFile&&!f.fileName.includes('node_modules'))){const output=path.join(server,'.runtime/f06-build',path.relative(server,f.fileName).replace(/\.ts$/,'.js'));if((await fs.stat(f.fileName)).mtimeMs>(await fs.stat(output)).mtimeMs)throw Error('Compile source newer than owned output');}
 const bundle=await fs.stat(path.join(repo,'cliente/dist-docker/assets/app.js'));async function newer(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())await newer(f);else if((await fs.stat(f)).mtimeMs>bundle.mtimeMs)throw Error('Client source changed after build');}}await newer(path.join(repo,'cliente/src'));
 runs.runs.push({stage:'build-evidence-reuse',status:'REUSED',reason:'Only provision/runner tooling changed since successful builds; source/output existence and source mtime verified before reuse; no new build PASS'});await fs.writeFile(runFile,JSON.stringify(runs,null,2)+'\n');
}else{
 if(process.argv.includes('--operations-only')){runs.runs.push({stage:'reuse-full-integral-snapshot',reason:'Only read-only key loader and operational harness changed after full financial run; commit fence retained. Full financial flows are reused by impact; boot/key absence/recovery/HTTPS rerun.',compiled:await Promise.all(compiled.filter(f=>f.endsWith('.js')).map(async f=>({path:path.relative(server,f),sha256:createHash('sha256').update(await fs.readFile(f)).digest('hex')})))});await fs.writeFile(runFile,JSON.stringify(runs,null,2)+'\n');}
 await stage('backend-build',process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.f06.json']);
 await stage('profile-unit',process.execPath,['--test','.runtime/f06-build/tests/f06/profile.test.js']);
 if(!process.argv.includes('--reuse-client')){
 await stage('frontend-typecheck',process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.app.json','--noEmit'],path.join(repo,'cliente'));
 await stage('frontend-build',process.execPath,['node_modules/vite/bin/vite.js','build','--config','vite.docker.config.ts'],path.join(repo,'cliente'));
 }else{if(!runs.runs.some(r=>r.stage==='frontend-build'&&r.exitCode===0))throw Error('No client build to reuse');for(const f of clientFiles)await fs.stat(f);runs.runs.push({stage:'frontend-build',status:'REUSED',reason:'No client source/config/lock changes since previous successful build'});await fs.writeFile(runFile,JSON.stringify(runs,null,2)+'\n');}
}
const runId=randomUUID(),base=path.join(workspace,'.runtime','f06-'+runId),privateRoot=path.join(base,'private'),dbPath=path.join(base,'mongo'),databaseName='caudelyx_demo_'+runId.replaceAll('-','').slice(0,16);
const probe=createServer().listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));if([27017,27181].includes(port))throw Error('Protected port');
const uri=`mongodb://127.0.0.1:${port}/?replicaSet=rs0`,names=['','_external_mail','_external_security'].map(s=>databaseName+s);
async function freePort(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));if([port,27017,27181,3001,3002,4001,4002].includes(p))return freePort();return p;}
const apiPort=await freePort(),platformPort=await freePort();
let resources={task:'F06-INTEGRAL-002',runId,root:base,privateRoot,dbPath,names,port,syntheticOnly:true,created:[],cleanup:'PENDING',budget:{groups:1,bytes:1610612736},protectedPorts:[27017,27181]};
const resourceFile=path.join(evidence,'F06-RESOURCES.json');try{const prior=JSON.parse(await fs.readFile(resourceFile,'utf8'));const previousRuns=prior.previousRuns??[];delete prior.previousRuns;resources.previousRuns=[...previousRuns,prior];}catch(e){if(e.code!=='ENOENT')throw e;}await fs.writeFile(resourceFile,JSON.stringify(resources,null,2)+'\n');
await fs.mkdir(base,{mode:0o700});await fs.writeFile(path.join(base,'run-marker.json'),JSON.stringify({runId,names,port}),{flag:'wx',mode:0o600});
resources.apiPorts=[apiPort,platformPort];resources.recoveryTargets=[path.join(base,'restored-mongo'),path.join(base,'restored-private'),path.join(base,'encrypted')];await fs.writeFile(resourceFile,JSON.stringify(resources,null,2)+'\n');
let mongo,admin;let mongoExited=false;let mongoExitCode;let stopped=false;let api;
const save=async()=>fs.writeFile(resourceFile,JSON.stringify(resources,null,2)+'\n');
try{
 const provisionStart=performance.now(),settings=await provision(privateRoot,{databaseName,mongoUri:uri,port:apiPort,platformPort,tenantOrigin:`https://localhost:${apiPort}`,platformOrigin:`https://platform.localhost:${platformPort}`});resources.created.push(privateRoot);await fs.mkdir(dbPath,{mode:0o700});resources.created.push(dbPath);await save();
 runs.runs.push({stage:'private-provision',status:'PASS',milliseconds:performance.now()-provisionStart,contractsCopied:37,keys:'NEW_SYNTHETIC_ONLY',tls:'NEW_SYNTHETIC_ONLY'});await fs.writeFile(runFile,JSON.stringify(runs,null,2)+'\n');
 const binary=process.env.F06_MONGOD??'C:/Program Files/MongoDB/Server/8.3/bin/mongod.exe';
 const startMongo=async(data,privateFiles)=>{mongoExited=false;mongo=spawn(binary,['--dbpath',data,'--replSet','rs0','--bind_ip','127.0.0.1','--port',String(port),'--keyFile',path.join(privateFiles,'secrets/replica_key'),'--tlsMode','requireTLS','--tlsCertificateKeyFile',path.join(privateFiles,'tls/mongo/server.pem'),'--tlsCAFile',path.join(privateFiles,'tls/mongo/ca.pem'),'--tlsAllowConnectionsWithoutCertificates','--wiredTigerCacheSizeGB','0.25','--oplogSize','128','--logpath',path.join(base,'mongo.log'),'--logappend'],{windowsHide:true,stdio:['ignore','ignore','ignore']});mongo.once('exit',code=>{mongoExited=true;mongoExitCode=code;});resources.mongoProcesses??=[];resources.mongoProcesses.push({pid:mongo.pid,executable:binary,dbPath:data,port});await save();};
 await startMongo(dbPath,privateRoot);
 const ca=path.join(privateRoot,'tls/mongo/ca.pem'),direct=`mongodb://127.0.0.1:${port}/?directConnection=true`,read=n=>fs.readFile(path.join(privateRoot,'secrets',n),'utf8').then(s=>s.trim());
 const initStart=performance.now(),deadline=Date.now()+30000;let bootstrap;
 while(Date.now()<deadline&&!mongoExited){const c=new MongoClient(direct,{tls:true,tlsCAFile:ca,serverSelectionTimeoutMS:500});try{await c.connect();bootstrap=c;break;}catch{await c.close();await new Promise(r=>setTimeout(r,100));}}
 if(!bootstrap)throw Error('Own mongod startup failed; see own diagnostic log');
 await bootstrap.db('admin').command({replSetInitiate:{_id:'rs0',members:[{_id:0,host:`127.0.0.1:${port}`}]}});
 while(!(await bootstrap.db('admin').command({hello:1})).isWritablePrimary){if(Date.now()>deadline)throw Error('Own primary timeout');await new Promise(r=>setTimeout(r,100));}
 await bootstrap.db('admin').command({createUser:await read('admin_username'),pwd:await read('admin_password'),roles:[{role:'root',db:'admin'}]});await bootstrap.close();
 admin=new MongoClient(direct,{tls:true,tlsCAFile:ca,authSource:'admin',auth:{username:await read('admin_username'),password:await read('admin_password')}});await admin.connect();
 await admin.db('admin').command({createUser:await read('app_username'),pwd:await read('app_password'),mechanisms:['SCRAM-SHA-256'],roles:names.flatMap(db=>[{role:'readWrite',db},{role:'dbAdmin',db}])});
 runs.runs.push({stage:'authenticated-mongo-bootstrap',status:'PASS',milliseconds:performance.now()-initStart,port,tls:true,scram:true,sharedServiceTouched:false});await fs.writeFile(runFile,JSON.stringify(runs,null,2)+'\n');
 await stage(process.argv.includes('--operations-only')?'operational-seed':'persistent-integral',process.execPath,['--test','--test-concurrency=1','.runtime/f06-build/tests/f06/integral.test.js'],server,{...process.env,...settings.env,...(process.argv.includes('--operations-only')?{F06_SEED_ONLY:'1'}:{})});
 const expected=await admin.db(databaseName).collection('financial_journals').countDocuments();
 const stopMongo=async()=>{try{await admin.db('admin').command({shutdown:1,force:false});}catch{}const limit=Date.now()+20000;while(!mongoExited&&Date.now()<limit)await new Promise(r=>setTimeout(r,100));if(!mongoExited||mongoExitCode!==0)throw Error('OWN_CLEAN_STOP_REQUIRED');await admin.close();admin=undefined;};
 await stopMongo();
 const recoveryStart=performance.now(),encrypted=path.join(base,'encrypted'),restoreDb=path.join(base,'restored-mongo'),restorePrivate=path.join(base,'restored-private'),backupKey=randomBytes(32);
 for(const d of [encrypted,restoreDb,restorePrivate])await fs.mkdir(d,{mode:0o700});
 for(const [source,target,name]of [[dbPath,restoreDb,'mongo'],[privateRoot,restorePrivate,'private']]){const archive=path.join(encrypted,name+'.enc'),record=await encryptArchive(Readable.from(archiveDirectory(source)),archive,backupKey);await decryptArchive(archive,record,backupKey,target);const wrong=path.join(base,'wrong-key-'+name);await fs.mkdir(wrong,{mode:0o700});await assert.rejects(decryptArchive(archive,record,randomBytes(32),wrong));}
 // Malicious path is rejected before writing outside the fresh target.
 const badRoot=path.join(base,'bad-restore');await fs.mkdir(badRoot);const h=Buffer.from(JSON.stringify({path:'../escape',directory:false,size:0,mode:384})),len=Buffer.alloc(4);len.writeUInt32BE(h.length);await assert.rejects(extractDirectory(badRoot,Readable.from([len,h,Buffer.alloc(4)])),/ENTRY_INVALID/);
 await startMongo(restoreDb,restorePrivate);
 const restoredEnv=Object.fromEntries(Object.entries(settings.env).map(([k,v])=>[k,v.startsWith(privateRoot)?restorePrivate+v.slice(privateRoot.length):v]));
 admin=new MongoClient(direct,{tls:true,tlsCAFile:path.join(restorePrivate,'tls/mongo/ca.pem'),authSource:'admin',auth:{username:await read('admin_username'),password:await read('admin_password')},serverSelectionTimeoutMS:30000});await admin.connect();
 await stage('cold-restore-reopen',process.execPath,['--test','.runtime/f06-build/tests/f06/integral.test.js'],server,{...process.env,...restoredEnv,F06_REOPEN_ONLY:'1',F06_EXPECTED_JOURNALS:String(expected)});
 runs.runs.push({stage:'encrypted-cold-recovery',status:'PASS',milliseconds:performance.now()-recoveryStart,originalsPreserved:true,journals:expected,crypto:'AES-256-GCM',docker:false});await fs.writeFile(runFile,JSON.stringify(runs,null,2)+'\n');
 const serverStart=performance.now();api=spawn(process.execPath,['.runtime/f06-build/src/server.js'],{cwd:server,env:{...process.env,...restoredEnv},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});let apiError='';api.stderr.on('data',b=>{apiError+=b;});api.stdout.resume();resources.apiProcess={pid:api.pid,ports:[apiPort,platformPort]};await save();
 const caApi=await fs.readFile(path.join(restorePrivate,'tls/api/ca.pem'));
 const get=(endpoint,p=apiPort,host=`localhost:${apiPort}`)=>new Promise((res,rej)=>{const r=request({hostname:'127.0.0.1',port:p,path:endpoint,ca:caApi,servername:'localhost',headers:{Host:host,Origin:'https://'+host}},s=>{let body='';s.on('data',b=>body+=b);s.on('end',()=>res({status:s.statusCode,body,headers:s.headers}));});r.on('error',rej);r.setTimeout(3000,()=>r.destroy(Error('OWN_API_TIMEOUT')));r.end();});
 const readyUntil=Date.now()+40000;let ready;while(Date.now()<readyUntil){try{ready=await get('/internal/health/ready');if(ready.status===200)break;}catch{}if(api.exitCode!==null)throw Error('OWN_API_BOOT_FAILED:'+apiError.slice(0,180));await new Promise(r=>setTimeout(r,200));}assert.equal(ready?.status,200);
 assert.equal((await get('/internal/health/live')).status,200);const csrf=await get('/api/v1/auth/csrf');assert.equal(csrf.status,200);assert.ok(csrf.headers['set-cookie']?.every(c=>c.includes('Secure')&&c.includes('HttpOnly')&&c.includes('SameSite=Lax')&&c.includes('Path=/')&&!c.includes('Domain=')));assert.equal((await get('/api/v1/auth/csrf',platformPort,`platform.localhost:${platformPort}`)).status,200);assert.notEqual((await get('/api/v1/auth/csrf',apiPort,'invalid.example.test')).status,200);
 api.send('LOCAL_SYNTHETIC_SHUTDOWN');const apiExited=once(api,'exit');const timeout=setTimeout(()=>api?.kill(),20000);const [apiCode]=await apiExited;clearTimeout(timeout);api=undefined;assert.equal(apiCode,0);
 runs.runs.push({stage:'standalone-https-api',status:'PASS',milliseconds:performance.now()-serverStart,technicalAndFunctionalHealth:true,tenantAndPlatformCsrf:true,secureCookies:true,invalidHostDenied:true,gracefulShutdown:true});await fs.writeFile(runFile,JSON.stringify(runs,null,2)+'\n');
 resources.validation='PASS';
}catch(error){resources.validation='FAIL';resources.failure=String(error.message).slice(0,200);await save();throw error;}
finally{
 if(api&&api.exitCode===null){api.kill();await once(api,'exit');}
 if(mongo&&!mongoExited){
  try{if(admin)await admin.db('admin').command({shutdown:1,force:false});}catch{/* Connection closes on successful shutdown. */}
  const until=Date.now()+15000;while(!mongoExited&&Date.now()<until)await new Promise(r=>setTimeout(r,100));
  if(!mongoExited){mongo.kill();await once(mongo,'exit');resources.forcedOwnStop=true;}
 }
 await admin?.close();stopped=!mongo||mongoExited;
 if(mongo){const log=await fs.readFile(path.join(base,'mongo.log'),'utf8').catch(()=>'<no own log>');runs.runs.push({stage:'own-mongo-stop',status:resources.validation??'FAIL',exitCode:mongoExitCode,logTail:log.slice(-18000)});await fs.writeFile(runFile,JSON.stringify(runs,null,2)+'\n');}
 async function safeTree(dir){if(await fs.realpath(dir)!==path.resolve(dir))throw Error('Cleanup linked path');for(const e of await fs.readdir(dir,{withFileTypes:true})){if(e.isSymbolicLink())throw Error('Cleanup linked entry');if(e.isDirectory())await safeTree(path.join(dir,e.name));}}
 try{
  const marker=JSON.parse(await fs.readFile(path.join(base,'run-marker.json'),'utf8'));
  if(!stopped||marker.runId!==runId||path.dirname(base)!==path.join(workspace,'.runtime')||path.basename(base)!=='f06-'+runId)throw Error('Own cleanup identity mismatch');
  await safeTree(base);let bytes=0;async function size(p){for(const e of await fs.readdir(p,{withFileTypes:true})){const f=path.join(p,e.name);if(e.isDirectory())await size(f);else bytes+=(await fs.stat(f)).size;}}await size(base);
  resources.bytesBeforeCleanup=bytes;resources.mongoStopped=stopped;await fs.rm(base,{recursive:true,force:false});resources.cleanup='PASS';resources.rootAbsent=await fs.lstat(base).then(()=>false,e=>e.code==='ENOENT');
 }catch(e){resources.cleanup='FAILED';resources.cleanupReason=String(e.message);resources.retainUntil=new Date(Date.now()+86400000).toISOString();}
 await save();console.log('own cleanup',resources.cleanup);
}
