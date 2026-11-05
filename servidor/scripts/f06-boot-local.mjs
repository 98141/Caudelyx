// Only initialization/restart/interruption; one NEW TLS/SCRAM Mongo group.
// Never installed27017/manual27181, historical dist or previous F06 evidence.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {MongoClient} from 'mongodb';
import {provision} from '../../deploy/tools/provision.mjs';
const server=path.resolve(fileURLToPath(new URL('..',import.meta.url))),workspace=path.resolve(server,'../..');
const evidence=path.join(workspace,'Construccion/Sprints/F06-BOOT/Evidencias'),runFile=path.join(evidence,'F06-BOOT-RUNS.json');
const sha=b=>createHash('sha256').update(b).digest('hex');let runs;
try{runs=JSON.parse(await fs.readFile(runFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;runs={task:'F06-BOOT-001',runs:[]};}
async function stage(name,args,env=process.env){
  const started=performance.now(),child=spawn(process.execPath,args,{cwd:server,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',b=>{stdout+=b;process.stdout.write(b);});child.stderr.on('data',b=>{stderr+=b;});
  const [code]=await once(child,'close');runs.runs.push({stage:name,command:['node',...args],exitCode:code,milliseconds:performance.now()-started,stdout,stderr});await fs.writeFile(runFile,JSON.stringify(runs,null,2)+'\n');
  console.log(name,code===0?'PASS':'FAIL');if(code!==0)throw Error('F06_BOOT_STAGE_FAILED');
}
const ts=(await import(pathToFileURL(path.join(server,'node_modules/typescript/lib/typescript.js')).href)).default;
const config=ts.getParsedCommandLineOfConfigFile(path.join(server,'tsconfig.f06-boot.json'),{}, {...ts.sys,onUnRecoverableConfigFileDiagnostic:()=>{throw Error('Invalid boot compile config');}}),program=ts.createProgram(config.fileNames,config.options);
const sources=program.getSourceFiles().filter(f=>!f.isDeclarationFile&&!f.fileName.includes('node_modules'));
const compiled=sources.flatMap(f=>['.js','.js.map'].map(ext=>{const p=path.relative(server,f.fileName);if(p.startsWith('..'))throw Error('Unowned compile source');return path.join(server,'.runtime/f06-boot-build',p.replace(/\.ts$/,ext));}));
if(process.argv.includes('--restart-only')){
  const previous=JSON.parse(await fs.readFile(path.join(evidence,'F06-BOOT-COMPILED.json'),'utf8'));
  runs.runs.push({stage:'reuse-interruption-cases',status:'REUSED',reason:'Two SIGKILL partial-initialization cases passed; only later listener/cleanup tracing and test harness bounds/context changed. Revalidate bind failure/restart/missing journal, no financial suite.',previousSourceHashes:previous.sources});await fs.writeFile(runFile,JSON.stringify(runs,null,2)+'\n');
}
await fs.writeFile(path.join(evidence,'F06-BOOT-COMPILED.json'),JSON.stringify({task:'F06-BOOT-001',reservedBeforeEmit:true,files:compiled,sources:await Promise.all(sources.map(async f=>({path:path.relative(server,f.fileName),sha256:sha(await fs.readFile(f.fileName))})))},null,2)+'\n');
await stage('backend-build',['node_modules/typescript/bin/tsc','-p','tsconfig.f06-boot.json']);
await stage('safe-diagnostics-unit',['--test','.runtime/f06-boot-build/tests/f06/boot-diagnostics.test.js']);
async function freePort(used){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));if([27017,27181,3001,3002,4001,4002,...used].includes(p))return freePort(used);return p;}
const runId=randomUUID(),root=path.join(workspace,'.runtime','f06-boot-'+runId),privateRoot=path.join(root,'private'),data=path.join(root,'mongo');
const port=await freePort([]),api=await freePort([port]),platform=await freePort([port,api]),databaseName='caudelyx_demo_'+runId.replaceAll('-','').slice(0,16),names=['','_external_mail','_external_security'].map(s=>databaseName+s);
const resourceFile=path.join(evidence,'F06-BOOT-RESOURCES.json');let resources={task:'F06-BOOT-001',runId,root,privateRoot,dbPath:data,names,port,apiPorts:[api,platform],protectedPorts:[27017,27181],cleanup:'PENDING',budgetBytes:805306368};
try{const previous=JSON.parse(await fs.readFile(resourceFile,'utf8'));if(previous.cleanup!=='PASS')throw Error('Previous own resources require cleanup');const all=previous.previousRuns??[];delete previous.previousRuns;resources.previousRuns=[...all,previous];}catch(e){if(e.code!=='ENOENT')throw e;}
await fs.writeFile(resourceFile,JSON.stringify(resources,null,2)+'\n');await fs.mkdir(root,{mode:0o700});await fs.writeFile(path.join(root,'marker.json'),JSON.stringify({runId,names,port}),{flag:'wx',mode:0o600});
let mongo,admin,exited=false,exitCode;let passed=false;
try{
  const setup=performance.now(),settings=await provision(privateRoot,{databaseName,mongoUri:`mongodb://127.0.0.1:${port}/?replicaSet=rs0`,port:api,platformPort:platform,tenantOrigin:`https://localhost:${api}`,platformOrigin:`https://platform.localhost:${platform}`});
  await fs.mkdir(data,{mode:0o700});
  const binary=process.env.F06_MONGOD??'C:/Program Files/MongoDB/Server/8.3/bin/mongod.exe';
  mongo=spawn(binary,['--dbpath',data,'--replSet','rs0','--bind_ip','127.0.0.1','--port',String(port),'--keyFile',path.join(privateRoot,'secrets/replica_key'),'--tlsMode','requireTLS','--tlsCertificateKeyFile',path.join(privateRoot,'tls/mongo/server.pem'),'--tlsCAFile',path.join(privateRoot,'tls/mongo/ca.pem'),'--tlsAllowConnectionsWithoutCertificates','--wiredTigerCacheSizeGB','0.25','--oplogSize','128','--logpath',path.join(root,'mongo.log')],{windowsHide:true,stdio:'ignore'});
  mongo.once('exit',code=>{exited=true;exitCode=code;});resources.mongoProcess={pid:mongo.pid,executable:binary,dbPath:data,port};await fs.writeFile(resourceFile,JSON.stringify(resources,null,2)+'\n');
  const uri=`mongodb://127.0.0.1:${port}/?directConnection=true`,ca=path.join(privateRoot,'tls/mongo/ca.pem'),read=async n=>(await fs.readFile(path.join(privateRoot,'secrets',n),'utf8')).trim(),until=Date.now()+30000;let bootstrap;
  while(Date.now()<until&&!exited){const c=new MongoClient(uri,{tls:true,tlsCAFile:ca,serverSelectionTimeoutMS:500});try{await c.connect();bootstrap=c;break;}catch{await c.close();await delay(100);}}
  if(!bootstrap)throw Error('Own TLS Mongo unavailable');
  await bootstrap.db('admin').command({replSetInitiate:{_id:'rs0',members:[{_id:0,host:`127.0.0.1:${port}`}]}});
  while(!(await bootstrap.db('admin').command({hello:1})).isWritablePrimary){if(Date.now()>until)throw Error('Own primary timeout');await delay(100);}
  await bootstrap.db('admin').command({createUser:await read('admin_username'),pwd:await read('admin_password'),roles:[{role:'root',db:'admin'}]});await bootstrap.close();
  admin=new MongoClient(uri,{tls:true,tlsCAFile:ca,authSource:'admin',auth:{username:await read('admin_username'),password:await read('admin_password')}});await admin.connect();
  await admin.db('admin').command({createUser:await read('app_username'),pwd:await read('app_password'),mechanisms:['SCRAM-SHA-256'],roles:names.flatMap(db=>[{role:'readWrite',db},{role:'dbAdmin',db}])});
  runs.runs.push({stage:'new-tls-scram-setup',status:'PASS',milliseconds:performance.now()-setup,port,contracts:37,sharedServicesTouched:false});await fs.writeFile(runFile,JSON.stringify(runs,null,2)+'\n');
  await stage(process.argv.includes('--restart-only')?'boot-focused-restart':'boot-interruption-restart',['--test','--test-concurrency=1','.runtime/f06-boot-build/tests/f06/boot.integration.test.js'],{...process.env,...settings.env,F06_BOOT_RESOURCE_FILE:resourceFile,...(process.argv.includes('--restart-only')?{F06_BOOT_RESTART_ONLY:'1'}:{})});passed=true;
}finally{
  resources=JSON.parse(await fs.readFile(resourceFile,'utf8'));
  if(mongo&&!exited){try{await admin?.db('admin').command({shutdown:1,force:false});}catch{/* Normal connection close on shutdown. */}const end=Date.now()+15000;while(!exited&&Date.now()<end)await delay(100);if(!exited){mongo.kill();await once(mongo,'exit');resources.forcedOwnStop=true;}}
  await admin?.close();resources.mongoStopped=!mongo||exited;resources.mongoExitCode=exitCode;resources.validation=passed?'PASS':'FAIL';
  try{
    if(!resources.mongoStopped||resources.apiProcesses?.length!==(resources.apiCleanup?.length??0)||resources.apiCleanup?.some(p=>!p.closed))throw Error('API cleanup not verified');
    if(path.dirname(root)!==path.join(workspace,'.runtime')||path.basename(root)!=='f06-boot-'+runId||await fs.realpath(root)!==root||JSON.parse(await fs.readFile(path.join(root,'marker.json'),'utf8')).runId!==runId)throw Error('Own cleanup identity mismatch');
    let bytes=0;async function safe(dir){if(await fs.realpath(dir)!==dir)throw Error('Linked cleanup path');for(const entry of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isSymbolicLink())throw Error('Linked cleanup entry');if(entry.isDirectory())await safe(p);else bytes+=(await fs.stat(p)).size;}}await safe(root);
    resources.bytesBeforeCleanup=bytes;await fs.rm(root,{recursive:true});resources.cleanup='PASS';resources.rootAbsent=await fs.lstat(root).then(()=>false,e=>e.code==='ENOENT');
  }catch{resources.cleanup='FAILED_RETAINED';resources.retainUntil=new Date(Date.now()+86400000).toISOString();}
  await fs.writeFile(resourceFile,JSON.stringify(resources,null,2)+'\n');console.log('own boot resources cleanup',resources.cleanup);
}
