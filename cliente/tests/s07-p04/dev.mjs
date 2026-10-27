import assert from 'node:assert/strict';
import {readFile,writeFile,appendFile,mkdir,lstat,realpath,rm,readdir} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {request} from 'node:https';
import {spawn,execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
const client=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),root=resolve(client,'..'),server=resolve(root,'servidor'),evidence=resolve(root,'../Construccion/Sprints/S07/Evidencias');
const {MongoClient}=await import(pathToFileURL(resolve(server,'node_modules/mongodb/lib/index.js')).href);
const {ApiClient}=await import(pathToFileURL(resolve(server,'dist-s07-p04/tests/helpers/client.js')).href);
const id='f7b2026a15c64d42a01c7c86',runId=randomUUID(),groupId=id+'-installed',database='caudelyx_s02_test_'+id,names=[database,database+'_external_mail',database+'_external_security'];
const folder=resolve(server,'.runtime/installed-tests',id),log=resolve(evidence,'S07-P04-RESOURCES.jsonl'),owner={task:'S07-P04',id,runId,nonce:randomUUID(),names,pid:process.pid};
const receipt=async record=>await appendFile(log,JSON.stringify({at:new Date().toISOString(),task:'S07-P04',runId,groupId,profile:'installed27017',...record})+'\n');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function bytes(path){let n=0;for(const e of await readdir(path,{withFileTypes:true})){const p=join(path,e.name),s=await lstat(p);assert.equal(s.isSymbolicLink(),false);n+=s.isDirectory()?await bytes(p):s.size;}return n;}
async function freePort(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const port=s.address().port;await new Promise(r=>s.close(r));assert.ok(![27017,27181,3001,3002,4001].includes(port));return port;}
const ports=[];while(ports.length<3){const port=await freePort();if(!ports.includes(port))ports.push(port);}
const [apiPort,uiPort,platformPort]=ports,origin='https://localhost:'+uiPort,uri='mongodb://127.0.0.1:27017';
await receipt({event:'reserved-before-create',databases:names,folder,port:27017,ports,budget:{groups:1,mongoStorageAndIndexBytes:262144000,controlBytes:125829120},mongoService:'existing, never stopped or reconfigured'});
await assert.rejects(lstat(folder),e=>e.code==='ENOENT');
await mkdir(join(folder,'tls'),{recursive:true});assert.equal(resolve(await realpath(folder)),folder);
await writeFile(join(folder,'p04-owner.json'),JSON.stringify(owner),{flag:'wx'});
const mongo=new MongoClient(uri,{family:4,serverSelectionTimeoutMS:3000});let live=null,cleanupAllowed=false;const runs=[],start=Date.now();
try{
 await mongo.connect();const hello=await mongo.db('admin').command({hello:1});assert.ok(hello.isWritablePrimary&&hello.setName);assert.equal(hello.setName,'rs0');
 for(const name of names)assert.equal((await mongo.db(name).listCollections().toArray()).length,0,'Pre-existing unknown database '+name);
 await receipt({event:'created',databases:names,folder,port:27017,ports,existingReplicaSet:hello.setName});
 await promisify(execFile)('C:/Program Files/Git/usr/bin/openssl.exe',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(folder,'tls/key.pem'),'-out',join(folder,'tls/cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,DNS:platform.localhost,IP:127.0.0.1'],{windowsHide:true});
 const cert=await readFile(join(folder,'tls/cert.pem'));
 const env={...process.env,CAUDELYX_MODE:'local-synthetic',MONGODB_URI:uri+'/?replicaSet='+hello.setName,CAUDELYX_DEV_TEST_ID:id,MONGODB_DATABASE:database,CAUDELYX_DEV_API_PORT:String(apiPort),CAUDELYX_DEV_UI_PORT:String(uiPort),CAUDELYX_DEV_PLATFORM_PORT:String(platformPort),CAUDELYX_DEV_BUILD_SCOPE:'S07-P04',CAUDELYX_DEV_SMOKE:'1'};
 class Client extends ApiClient{async call(method,path,body,headers={}){return await super.call(method,path,body,{Host:'localhost:'+uiPort,Origin:origin,...headers});}}
 const api=new Client(apiPort,cert),email='p04_dev_'+randomUUID()+'@example.test';
 const getUi=async()=>await new Promise((resolveUi,reject)=>{const req=request(origin,{ca:cert,servername:'localhost'},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolveUi({status:res.statusCode,body:b}));});req.on('error',reject);req.end();});
 let firstKeyHash;const probes=[];
 for(const iteration of [1,2]){
  const started=Date.now(),npm=resolve(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
  live=spawn(process.execPath,[npm,'run','dev'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});const ended=once(live,'exit');let output='',resolved=false;
  await receipt({event:'installed-npm-created',iteration,pid:live.pid,spawnfile:live.spawnfile,args:live.spawnargs,ownLiveHandle:true});
  const ready=new Promise((resolveReady,reject)=>{const timer=setTimeout(()=>reject(Error('npm dev readiness timeout')),90000);live.once('error',reject);live.once('exit',code=>{if(!resolved){clearTimeout(timer);reject(Error('npm dev exited before ready '+code));}});const data=b=>{console.log(b.toString());output+=b.toString();if(!resolved&&output.includes('S02 LOCAL SINTÉTICO:')){resolved=true;clearTimeout(timer);resolveReady();}};live.stdout.on('data',data);live.stderr.on('data',data);});
  const diagnostic=setInterval(()=>{void api.call('GET','/api/v1/auth/me').then(r=>{const row={status:r.status,code:r.body.error?.code??null};probes.push(row);if(probes.length===1||probes.at(-2)?.status!==row.status)console.log('DEV_HEALTH',JSON.stringify(row));}).catch(e=>{if(probes.length===0)console.log('DEV_HEALTH_TRANSPORT',e.code??e.message);});},1000);
  try{await ready;}finally{clearInterval(diagnostic);}
  const ui=await getUi();assert.equal(ui.status,200);assert.match(ui.body,/<html/);await api.refreshCsrf();
  if(iteration===1){
   assert.equal((await api.call('POST','/api/v1/auth/register',{mode:'PROFILE',email,password:'Synthetic installed P04 passphrase 13579',displayName:'Perfil sintético P04',privacyPolicyVersion:'synthetic-v1',acceptTerms:true})).status,200);
  }else{assert.equal((await api.call('GET','/api/v1/auth/me')).body.data.authState,'PENDING_EMAIL');}
  const user=await mongo.db(database).collection('identities').findOne({email});assert.ok(user);
  const keyHash=hash(await readFile(join(folder,'keys.json')));if(iteration===1)firstKeyHash=keyHash;else assert.equal(keyHash,firstKeyHash);
  const [code]=await ended;console.log(output);assert.equal(code,0);live=null;
  assert.equal((await mongo.db(database).collection('identities').findOne({email}))._id,user._id);
  const row={iteration,seconds:(Date.now()-started)/1000,uiHTTPS:200,registrationPreserved:true,keyringUnchanged:iteration===2,exit:code};runs.push(row);await receipt({event:'installed-npm-stopped',...row});
 }
 cleanupAllowed=true;
 await writeFile(resolve(evidence,'S07-P04-DEV.json'),JSON.stringify({task:'S07-P04',result:'PASS',runId,database,ports,replicaSet:'rs0',command:'npm run dev',mode:'two bounded smoke lifetimes with real HTTPS signup and persistent identity/cookie/keyring between restarts',runs,seconds:(Date.now()-start)/1000,ownerPersistentProfilesTouched:false},null,2));
}finally{
 if(live&&live.exitCode===null){await Promise.race([once(live,'exit'),new Promise((_,reject)=>setTimeout(()=>reject(Error('Own npm still active; retain exact group for diagnosis')),35000))]);live=null;}
 if(live&&live.exitCode!==null)live=null;
 if(!live){
  assert.equal(await readFile(join(folder,'p04-owner.json'),'utf8'),JSON.stringify(owner));assert.equal(resolve(await realpath(folder)),folder);assert.equal((await lstat(folder)).isSymbolicLink(),false);await bytes(folder);
  const stats=[];for(const name of names){const s=await mongo.db(name).command({dbStats:1});stats.push({name,dataSize:s.dataSize,storageSize:s.storageSize,indexSize:s.indexSize});}
  const controlBytes=await bytes(folder),mongoBytes=stats.reduce((n,r)=>n+r.storageSize+r.indexSize,0);assert.ok(controlBytes<=125829120&&mongoBytes<=262144000);
  await receipt({event:'cleanup-before',stats,controlBytes,mongoBytes,overBudget:false});
  for(const name of names){assert.ok(name===database||name===database+'_external_mail'||name===database+'_external_security');await mongo.db(name).dropDatabase();assert.equal((await mongo.db(name).listCollections().toArray()).length,0);}
  await mongo.close();await rm(folder,{recursive:true,force:false,maxRetries:3});await receipt({event:'cleanup-complete',databases:names,remaining:0,controlRemoved:true,ownedProcessesStopped:true,installedServiceUnchanged:true,successful:cleanupAllowed});
 }
}

