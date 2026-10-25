// S05-P04 version of S05 installed-profile harness. Own random group per execution; historical receipts untouched.
/* eslint-disable security/detect-non-literal-fs-filename -- Exact registered test paths, never HTTP input. */
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile, rm, lstat, realpath, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer, request as httpsRequest } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { MongoClient } from 'mongodb';
import { generate } from 'otplib';
import { Database } from '../../src/shared/database.js';
import { Sessions } from '../../src/modules/sessions/service.js';
import { SyntheticMessaging } from '../../src/modules/messaging/service.js';
import { IdentityService } from '../../src/modules/identity/service.js';
import { PasswordHasher } from '../../src/modules/identity/password.js';
import { RestoreController } from '../../src/shared/restore.js';
import { attachRuntime } from '../../src/shared/runtime.js';
import { createApp } from '../../src/app.js';
import { loadSyntheticKeys } from '../../src/shared/keys.js';
import { ApiClient } from '../helpers/client.js';

const id=randomBytes(12).toString('hex');
const root=resolve('.runtime'),folder=join(root,'installed-tests',id);
const databaseName='caudelyx_s02_test_'+id;
const names=[databaseName,databaseName+'_external_mail',databaseName+'_external_security'];
const evidenceRoot=resolve('../../Construccion/Sprints/S05/Evidencias');
const replay=process.env['S05_P04_REPLAY'];
if(replay!==undefined&&!/^[a-f0-9]{24}$/.test(replay))throw Error('A fresh24-hex replay identifier is required');
export const evidenceDirectory=replay?join(evidenceRoot,'S05-P04-REPLAY-'+replay):evidenceRoot;
const log=join(evidenceDirectory,'S05-P04-RESOURCES.jsonl');
let replayPrepared=false;
const servers:ReturnType<typeof createServer>[]=[];
const clients:Database[]=[];
export const password='Frase de prueba sintetica larga 9871236450';
const receipt=async(record:Record<string,unknown>)=>await appendFile(log,JSON.stringify({at:new Date().toISOString(),task:'S05-P04',...record})+'\n');
export function assertOwnUri(uri:string){const u=new URL(uri);if(u.protocol!=='mongodb:'||u.hostname!=='127.0.0.1'||u.port!=='27017'||u.username||u.password||!['','/'].includes(u.pathname)||[...u.searchParams.keys()].some(k=>k!=='replicaSet'))throw Error('Protected/unknown Mongo profile');}
async function size(path:string):Promise<number>{let n=0;for(const e of await readdir(path,{withFileTypes:true})){const p=join(path,e.name),s=await lstat(p);if(s.isSymbolicLink())throw Error('Refuse linked controls');n+=e.isDirectory()?await size(p):s.size;}return n;}
async function removeOwn(path:string){
  if(![folder].includes(resolve(path))||resolve(await realpath(path))!==resolve(path)||(await lstat(path)).isSymbolicLink())throw Error('Unowned control path');
  if(resolve(await realpath(root))!==root)throw Error('Linked runtime root');
  await size(path);await rm(path,{recursive:true,force:false,maxRetries:3});
}
export async function operationsProfile(){
  if(replay&&!replayPrepared){await mkdir(evidenceDirectory);replayPrepared=true;}
  if(!replay&&await lstat(join(evidenceRoot,'S05-P04-HASHES.json')).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))throw Error('Frozen P04 evidence: use S05_P04_REPLAY with a fresh24-hex identifier');
  const port=27017;
  await receipt({event:'reserved-before-create',runId:id,ownerPid:process.pid,port,databases:names,folder,applicationPorts:[47231,47232,47233],budget:{groups:1,mongoBytes:134217728,controlBytes:16777216}});
  await mkdir(root,{recursive:true});
  if(resolve(await realpath(root))!==root||(await lstat(root)).isSymbolicLink())throw Error('Linked runtime parent');
  const parent=resolve(folder,'..');await mkdir(parent,{recursive:true});
  if(resolve(await realpath(parent))!==parent||(await lstat(parent)).isSymbolicLink())throw Error('Linked installed-test parent');
  await mkdir(folder);
  const owner={id,pid:process.pid,nonce:randomUUID(),names,port};await writeFile(join(folder,'owner.json'),JSON.stringify(owner),{flag:'wx'});
  const replica={uri:'mongodb://127.0.0.1:27017'};
  let control:MongoClient|undefined;
  let ownsDatabases=false;
  let disposed=false;
  let liveLeases=0;
  const closeConsumers=async()=>{for(const server of servers.splice(0))await new Promise<void>(r=>server.close(()=>r()));for(const db of clients.splice(0))await db.close();};
  const dispose=async()=>{
    if(disposed)return;
    if(liveLeases){await receipt({event:'cleanup-blocked-live-lease',runId:id});throw Error('Own fixture lease is live');}
    try{
      if(JSON.stringify(JSON.parse(await readFile(join(folder,'owner.json'),'utf8')))!==JSON.stringify(owner))throw Error('Ownership changed');
      await closeConsumers();
      for(const entry of await readdir(folder))if(entry.endsWith('.lock')){
        const lock=JSON.parse(await readFile(join(folder,entry),'utf8')) as {pid?:number};
        if(!lock.pid)throw Error('Unknown process lock');
        try{process.kill(lock.pid,0);throw Error('Live profile process');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}
      }
      const stats=[];
      if(control&&ownsDatabases){
        const foreign=await control.db('admin').aggregate([
          {$currentOp:{allUsers:true,idleConnections:true,idleSessions:true}},
          {$match:{'clientMetadata.application.name':{$ne:'S05_P04_CLEANUP'},$or:[{'command.$db':{$in:names}},{$expr:{$in:[{$arrayElemAt:[{$split:[{$ifNull:['$ns','']},'.']},0]},names]}}]}},
          {$project:{_id:0,active:1}}
        ]).toArray();
        if(foreign.length)throw Error('Unclosed or unknown fixture consumer');
        for(const name of names){const s=await control.db(name).command({dbStats:1});stats.push({name,dataSize:s['dataSize'],storageSize:s['storageSize'],indexSize:s['indexSize']});}
        const controlBytes=await size(folder),mongoBytes=stats.reduce((n,r)=>n+Number(r.storageSize)+Number(r.indexSize),0);
        await receipt({event:'cleanup-before',stats,controlBytes,mongoBytes,overBudget:mongoBytes>134217728||controlBytes>16777216});
        for(const name of names)await control.db(name).dropDatabase();
        const remaining=await control.db('admin').command({listDatabases:1,nameOnly:true,filter:{name:{$in:names}}});
        if((remaining['databases'] as unknown[]).length)throw Error('Test databases remain');
        await control.close();control=undefined;
      }
      if(control){await control.close();control=undefined;}
      await removeOwn(folder);disposed=true;await receipt({event:'cleanup-complete',databases:names,remaining:0,controlRemoved:true,sharedMongoUntouched:true});
    }catch(error){await receipt({event:'cleanup-failed',reason:String(error).slice(0,200),retainUntil:new Date(Date.now()+86400000).toISOString()});throw error;}
  };
  try{
    assertOwnUri(replica.uri);
    control=new MongoClient(replica.uri,{appName:'S05_P04_CLEANUP',serverSelectionTimeoutMS:3000});await control.connect();
    const hello=await control.db('admin').command({hello:1});
    if(typeof hello['setName']!=='string'||!hello['isWritablePrimary'])throw Error('Installed replica set unavailable');
    replica.uri+='/?replicaSet='+encodeURIComponent(hello['setName']);
    const existing=await control.db('admin').command({listDatabases:1,nameOnly:true,filter:{name:{$in:names}}});
    if((existing['databases'] as unknown[]).length)throw Error('Refuse adopting pre-existing group');
    ownsDatabases=true;
    await receipt({event:'created',databases:names,port,folder});
    const fixture=async(options:{failSetup?:boolean}={})=>{
      await closeConsumers();
      const prior=[];
      for(const name of names){const s=await control!.db(name).command({dbStats:1});prior.push({name,dataSize:s['dataSize'],storageSize:s['storageSize'],indexSize:s['indexSize']});}
      const controlBytes=await size(folder),mongoBytes=prior.reduce((n,r)=>n+Number(r.storageSize)+Number(r.indexSize),0);
      await receipt({event:'reuse-before',stats:prior,controlBytes,mongoBytes});
      if(mongoBytes>134217728||controlBytes>16777216)throw Error('Own resource budget exceeded');
      for(const name of names)await control!.db(name).dropDatabase();
      for(const e of await readdir(folder))if(e!=='owner.json'&&e!=='tls'){
        const p=join(folder,e),s=await lstat(p);if(s.isDirectory()||s.isSymbolicLink())throw Error('Unexpected test control');await rm(p);
      }
      await receipt({event:'group-reused',databases:names});
      const database=new Database(replica!.uri,databaseName);clients.push(database);await database.connect();
      if(options.failSetup){await database.close();clients.splice(clients.indexOf(database),1);await receipt({event:'partial-setup-failure-consumer-closed'});throw Error('Injected own partial setup failure');}
      const clock={value:Math.floor(Date.now()/30000)*30000+1000,open:true},now=()=>clock.value;
      const keys=await loadSyntheticKeys(join(folder,'keys.json'));
      const restore=new RestoreController(database,join(folder,`gate-${databaseName}.json`),keys.journal);await restore.initialize();
      const sessions=new Sessions(database,now),messages=new SyntheticMessaging(database,keys.mail,now);
      const identity=new IdentityService(database,sessions,messages,new PasswordHasher(),()=>clock.open&&restore.isOpen(),now);await identity.initialize();
      const config={mongoUri:replica!.uri,databaseName,port:47232,tenantOrigin:'https://localhost:47231',platformOrigin:'https://platform.localhost:47233'};
      const runtime=await attachRuntime(identity,keys,config);
      const signup=async()=>{
        const anonymous=await sessions.issue('TENANT','P',null),email=randomUUID()+'@example.test';
        const registered=await identity.register('TENANT',randomUUID(),{email,displayName:'Persona sintética',privacyPolicyVersion:'synthetic-v1',password},anonymous.context);
        if(!registered.issued)throw Error('No basic session');
        await identity.dispatchMail();const subject=(await identity.identities.findOne({email}))!;
        const mail=[...messages.inbox.values()].find(m=>m.subjectId===subject._id&&m.purpose==='ACTIVATION');if(!mail)throw Error('No activation');
        return{email,anonymous,registered,issued:registered.issued,subject,token:mail.token};
      };
      const actor=async()=>{
        const a=await signup();const confirmed=await identity.confirmEmail(a.issued.context,{purpose:'ACTIVATION',token:a.token});
        const context=confirmed.issued.context;const enrollment=await runtime.totp.enroll(context,'Prueba',password);
        const secret=new URL(enrollment.provisioningUri).searchParams.get('secret')!;
        const completed=await runtime.totp.confirm(context,enrollment.enrollmentId,await generate({secret,epoch:Math.floor(now()/1000)}));
        if(!completed.issued)throw Error('No strong session');return{email:a.email,secret,issued:completed.issued};
      };
      type Actor=Awaited<ReturnType<typeof actor>>;
      const proof=async(a:Actor,purpose:string,command?:Record<string,unknown>,resourceId?:string)=>{
        await identity.reauthenticate(a.issued.context,{password,purpose,...(command?{command}:{}),...(resourceId?{resourceId}:{})});clock.value+=30000;
        a.issued=(await runtime.totp.authenticate(a.issued.context,await generate({secret:a.secret,epoch:Math.floor(now()/1000)}),purpose,resourceId??null)).issued;return a.issued;
      };
      const https=async()=>{
        await mkdir(join(folder,'tls'),{recursive:true});
        await promisify(execFile)('C:/Program Files/Git/usr/bin/openssl.exe',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(folder,'tls/key.pem'),'-out',join(folder,'tls/cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,DNS:platform.localhost,IP:127.0.0.1'],{windowsHide:true});
        const cert=await readFile(join(folder,'tls/cert.pem')),key=await readFile(join(folder,'tls/key.pem'));
        const reserved={port:47232};await receipt({event:'https-reserved-before-listen',port:reserved.port});
        const server=createServer({cert,key},createApp({identity,config}));servers.push(server);server.listen(reserved.port,'127.0.0.1');await once(server,'listening');
        const a=server.address();if(!a||typeof a==='string')throw Error('No HTTPS listener');
        await receipt({event:'https-created',port:a.port});return{client:new ApiClient(a.port,cert),port:a.port,cert};
      };
      const proxy=async(backend:{port:number;cert:Buffer})=>{
        const key=await readFile(join(folder,'tls/key.pem')),server=createServer({key,cert:backend.cert},(req,res)=>{
          const forwarded=httpsRequest({host:'127.0.0.1',port:backend.port,servername:'localhost',ca:backend.cert,method:req.method,path:req.url,headers:req.headers},upstream=>{res.writeHead(upstream.statusCode??503,upstream.headers);upstream.pipe(res);});forwarded.on('error',()=>{res.statusCode=503;res.end();});req.pipe(forwarded);
        });
        await receipt({event:'proxy-reserved-before-listen',port:0,backendPort:backend.port});servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');const a=server.address();if(!a||typeof a==='string')throw Error('No own proxy port');await receipt({event:'proxy-created',port:a.port});return{port:a.port,cert:backend.cert};
      };
      return{database,clock,now,keys,restore,sessions,messages,identity,runtime,config,signup,actor,proof,https,proxy};
    };
    return{id,fixture,dispose,folder,names,port,uri:replica.uri,closeConsumers,receipt,hold:()=>{liveLeases++;let active=true;return()=>{if(active){liveLeases--;active=false;}};}};
  }catch(error){await dispose();throw error;}
}
export type LendingFixture=Awaited<ReturnType<Awaited<ReturnType<typeof operationsProfile>>['fixture']>>;
