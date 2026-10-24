/* eslint-disable security/detect-non-literal-fs-filename -- Exact registered test paths, never HTTP input. */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile, rm, lstat, realpath, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer as probe } from 'node:net';
import { createServer } from 'node:https';
import { execFile, spawn } from 'node:child_process';
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
import { startReplicaSet } from './replica-set.js';
import { ApiClient } from './client.js';

const id='f1c904a223104e58b0c40202';
const uuid='f1c904a2-2310-4e58-b0c4-020200000002';
const root=resolve('.runtime'),folder=join(root,'s04-p02',id),mongoFolder=join(root,'manual-test-'+uuid);
const databaseName='caudelyx_s04_p02_'+id;
const names=[databaseName,databaseName+'_external_mail',databaseName+'_external_security'];
const log=resolve('../../Construccion/Sprints/S04/Evidencias/S04-P02-RESOURCES.jsonl');
const servers:ReturnType<typeof createServer>[]=[];
const clients:Database[]=[];
export const password='Frase de prueba sintetica larga 9871236450';
const receipt=async(record:Record<string,unknown>)=>await appendFile(log,JSON.stringify({at:new Date().toISOString(),task:'S04-P02',...record})+'\n');
export function assertOwnUri(uri:string){const u=new URL(uri);if(u.hostname!=='127.0.0.1'||!u.port||['27017','27181'].includes(u.port)||u.searchParams.get('replicaSet')!=='caudelyx-manual')throw Error('Protected/unknown Mongo profile');}
async function size(path:string):Promise<number>{let n=0;for(const e of await readdir(path,{withFileTypes:true})){const p=join(path,e.name),s=await lstat(p);if(s.isSymbolicLink())throw Error('Refuse linked controls');n+=e.isDirectory()?await size(p):s.size;}return n;}
async function removeOwn(path:string){
  if(![folder,mongoFolder].includes(resolve(path))||resolve(await realpath(path))!==resolve(path)||(await lstat(path)).isSymbolicLink())throw Error('Unowned control path');
  if(resolve(await realpath(root))!==root)throw Error('Linked runtime root');
  await size(path);await rm(path,{recursive:true,force:false,maxRetries:3});
}
export async function lendingProfile(){
  const portProbe=probe().listen(0,'127.0.0.1');await once(portProbe,'listening');const address=portProbe.address();
  if(!address||typeof address==='string'||[27017,27181].includes(address.port))throw Error('Protected test port');
  const port=address.port;await new Promise<void>(r=>portProbe.close(()=>r()));
  await receipt({event:'reserved-before-create',runId:id,ownerPid:process.pid,port,databases:names,folder,mongoFolder,budget:{groups:1,mongoBytes:134217728,controlBytes:16777216}});
  await mkdir(root,{recursive:true});await mkdir(resolve(folder,'..'),{recursive:true});await mkdir(folder);
  const owner={id,pid:process.pid,nonce:randomUUID(),names,port};await writeFile(join(folder,'owner.json'),JSON.stringify(owner),{flag:'wx'});
  let replica:Awaited<ReturnType<typeof startReplicaSet>>|undefined;
  let control:MongoClient|undefined;
  let disposed=false;
  let liveLeases=0;
  const closeConsumers=async()=>{for(const server of servers.splice(0))await new Promise<void>(r=>server.close(()=>r()));for(const db of clients.splice(0))await db.close();};
  const dispose=async()=>{
    if(disposed)return;
    if(liveLeases){await receipt({event:'cleanup-blocked-live-lease',runId:id});throw Error('Own fixture lease is live');}
    try{
      if(JSON.stringify(JSON.parse(await readFile(join(folder,'owner.json'),'utf8')))!==JSON.stringify(owner))throw Error('Ownership changed');
      await closeConsumers();
      const stats=[];
      if(control){
        const topology=await control.db('admin').command({getCmdLineOpts:1});
        const parsed=topology['parsed'] as {storage?:{dbPath?:string}};
        if(!parsed.storage?.dbPath||resolve(parsed.storage.dbPath)!==mongoFolder)throw Error('Unknown Mongo process');
        const foreign=await control.db('admin').aggregate([
          {$currentOp:{allUsers:true,idleConnections:true,idleSessions:true}},
          {$match:{'clientMetadata.application.name':{$ne:'S04_P02_CLEANUP'},$or:[{'command.$db':{$in:names}},{$expr:{$in:[{$arrayElemAt:[{$split:[{$ifNull:['$ns','']},'.']},0]},names]}}]}},
          {$project:{_id:0,active:1}}
        ]).toArray();
        if(foreign.length)throw Error('Unclosed or unknown fixture consumer');
        for(const name of names){const s=await control.db(name).command({dbStats:1});stats.push({name,dataSize:s['dataSize'],storageSize:s['storageSize'],indexSize:s['indexSize']});}
        const controlBytes=await size(folder),dbPathBytes=await size(mongoFolder),mongoBytes=stats.reduce((n,r)=>n+Number(r.storageSize)+Number(r.indexSize),0);
        await receipt({event:'cleanup-before',stats,controlBytes,dbPathBytes,mongoBytes,overBudget:mongoBytes>134217728||controlBytes>16777216});
        for(const name of names)await control.db(name).dropDatabase();
        const remaining=await control.db('admin').command({listDatabases:1,nameOnly:true,filter:{name:{$in:names}}});
        if((remaining['databases'] as unknown[]).length)throw Error('Test databases remain');
        await control.close();control=undefined;
      }
      await replica?.stop();
      try{await removeOwn(mongoFolder);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      await removeOwn(folder);disposed=true;await receipt({event:'cleanup-complete',databases:names,remaining:0,controlRemoved:true,mongoProcessStopped:true});
    }catch(error){await receipt({event:'cleanup-failed',reason:String(error).slice(0,200),retainUntil:new Date(Date.now()+86400000).toISOString()});throw error;}
  };
  try{
    replica=await startReplicaSet({manualProfile:'test-'+uuid,port});assertOwnUri(replica.uri);
    control=new MongoClient(replica.uri,{appName:'S04_P02_CLEANUP'});await control.connect();
    await receipt({event:'created',databases:names,port,folder,mongoFolder});
    const fixture=async(options:{failSetup?:boolean}={})=>{
      await closeConsumers();
      const prior=[];
      for(const name of names){const s=await control!.db(name).command({dbStats:1});prior.push({name,dataSize:s['dataSize'],storageSize:s['storageSize'],indexSize:s['indexSize']});}
      const controlBytes=await size(folder),mongoBytes=prior.reduce((n,r)=>n+Number(r.storageSize)+Number(r.indexSize),0);
      await receipt({event:'reuse-before',stats:prior,controlBytes,mongoBytes});
      if(mongoBytes>134217728||controlBytes>16777216)throw Error('Own resource budget exceeded');
      for(const name of names)await control!.db(name).dropDatabase();
      for(const e of await readdir(folder))if(e!=='owner.json'){
        const p=join(folder,e),s=await lstat(p);if(s.isDirectory()||s.isSymbolicLink())throw Error('Unexpected test control');await rm(p);
      }
      await receipt({event:'group-reused',databases:names});
      const database=new Database(replica!.uri,databaseName);clients.push(database);await database.connect();
      if(options.failSetup){await database.close();clients.splice(clients.indexOf(database),1);await receipt({event:'partial-setup-failure-consumer-closed'});throw Error('Injected own partial setup failure');}
      const clock={value:Math.floor(Date.now()/30000)*30000+1000,open:true},now=()=>clock.value;
      const keys={version:1 as const,mail:randomBytes(32),totp:randomBytes(32),journal:randomBytes(32),cursor:randomBytes(32)};
      const restore=new RestoreController(database,join(folder,'gate.json'),keys.journal);await restore.initialize();
      const sessions=new Sessions(database,now),messages=new SyntheticMessaging(database,keys.mail,now);
      const identity=new IdentityService(database,sessions,messages,new PasswordHasher(),()=>clock.open&&restore.isOpen(),now);await identity.initialize();
      const config={mongoUri:replica!.uri,databaseName,port:0,tenantOrigin:'https://localhost:0',platformOrigin:'https://platform.localhost:0'};
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
        await promisify(execFile)('C:/Program Files/Git/usr/bin/openssl.exe',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(folder,'key.pem'),'-out',join(folder,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,DNS:platform.localhost,IP:127.0.0.1'],{windowsHide:true});
        const cert=await readFile(join(folder,'cert.pem')),key=await readFile(join(folder,'key.pem'));
        const reservation=probe().listen(0,'127.0.0.1');await once(reservation,'listening');const reserved=reservation.address();
        if(!reserved||typeof reserved==='string'||[27017,27181,port].includes(reserved.port))throw Error('Protected HTTPS port');
        await new Promise<void>(r=>reservation.close(()=>r()));await receipt({event:'https-reserved-before-listen',port:reserved.port});
        const server=createServer({cert,key},createApp({identity,config}));servers.push(server);server.listen(reserved.port,'127.0.0.1');await once(server,'listening');
        const a=server.address();if(!a||typeof a==='string')throw Error('No HTTPS listener');config.tenantOrigin='https://localhost:'+a.port;config.platformOrigin='https://platform.localhost:'+a.port;
        await receipt({event:'https-created',port:a.port});return{client:new ApiClient(a.port,cert),port:a.port,cert};
      };
      return{database,clock,now,keys,restore,sessions,messages,identity,runtime,config,signup,actor,proof,https};
    };
    const peerRead=async(token:string,now:number)=>{
      const source=`import {Database} from './dist/src/shared/database.js';import {Sessions} from './dist/src/modules/sessions/service.js';
      const input=await new Promise(r=>process.once('message',r));const url=new URL(input.uri);
      if(url.hostname!=='127.0.0.1'||['27017','27181'].includes(url.port)||url.searchParams.get('replicaSet')!=='caudelyx-manual')throw Error('Protected peer profile');
      const db=new Database(input.uri,input.name);await db.connect();try{const sessions=new Sessions(db,()=>input.now);const c=await sessions.find(input.token,'TENANT');process.send({kind:c?.kind??null,pid:process.pid});}finally{await db.close();process.disconnect();}`;
      const child=spawn(process.execPath,['--input-type=module','-e',source],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
      await receipt({event:'peer-created',pid:child.pid,port});
      const exited=once(child,'exit');let timeout:ReturnType<typeof setTimeout>|undefined;
      try{
        const result=new Promise<{kind:string|null;pid:number}>((resolveMessage,reject)=>{child.once('message',m=>resolveMessage(m as {kind:string|null;pid:number}));child.once('error',reject);child.once('exit',code=>{if(code!==0)reject(Error('Own peer failed'));});timeout=setTimeout(()=>reject(Error('Peer timeout')),15000);});
        child.send({uri:replica!.uri,name:databaseName,now,token});const message=await result;await exited;return message;
      }finally{clearTimeout(timeout);if(child.exitCode===null&&!child.killed){child.kill();await exited;}await receipt({event:'peer-stopped',pid:child.pid});}
    };
    return{fixture,dispose,folder,names,port,uri:replica.uri,peerRead,hold:()=>{liveLeases++;let active=true;return()=>{if(active){liveLeases--;active=false;}};}};
  }catch(error){await dispose();throw error;}
}
export type LendingFixture=Awaited<ReturnType<Awaited<ReturnType<typeof lendingProfile>>['fixture']>>;
