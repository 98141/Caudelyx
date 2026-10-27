/* eslint-disable security/detect-non-literal-fs-filename -- Exact registered test paths, never HTTP input. */
import {purposeClass} from '../../src/modules/sessions/work-policy.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile, rm, lstat, realpath, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer as probe } from 'node:net';
import { createServer } from 'node:https';
import {request as httpsRequest} from 'node:https';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import {fileURLToPath} from 'node:url';
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
import { startReplicaSet } from '../helpers/replica-set.js';
import { ApiClient } from '../helpers/client.js';

const id='f7b2026a15c64d42a01c7c86';
const uuid='f7b2026a-15c6-4d42-a01c-7c86ecb80704';
const root=resolve('.runtime'),folder=join(root,'s07-p04-'+id),mongoFolder=join(root,'manual-test-'+uuid);
const databaseName='caudelyx_s07_p04_'+id;
const names=[databaseName,databaseName+'_external_mail',databaseName+'_external_security'];
const log=resolve('../../Construccion/Sprints/S07/Evidencias/S07-P04-RESOURCES.jsonl');
const servers:ReturnType<typeof createServer>[]=[];
const clients:Database[]=[];
export const password='Frase de prueba sintetica larga 9871236450';
const appendReceipt=async(record:Record<string,unknown>)=>await appendFile(log,JSON.stringify({at:new Date().toISOString(),task:'S07-P04',...record})+'\n');
export function assertOwnUri(uri:string){const u=new URL(uri);if(u.hostname!=='127.0.0.1'||!u.port||['27017','27181'].includes(u.port)||u.searchParams.get('replicaSet')!=='caudelyx-manual')throw Error('Protected/unknown Mongo profile');}
async function size(path:string):Promise<number>{let n=0;for(const e of await readdir(path,{withFileTypes:true})){const p=join(path,e.name),s=await lstat(p);if(s.isSymbolicLink())throw Error('Refuse linked controls');n+=e.isDirectory()?await size(p):s.size;}return n;}
async function removeOwn(path:string){
  if(![folder,mongoFolder].includes(resolve(path))||resolve(await realpath(path))!==resolve(path)||(await lstat(path)).isSymbolicLink())throw Error('Unowned control path');
  if(resolve(await realpath(root))!==root)throw Error('Linked runtime root');
  await size(path);await rm(path,{recursive:true,force:false,maxRetries:3});
}
export async function s07Profile(){
  const executionId=randomUUID(),receipt=(record:Record<string,unknown>)=>appendReceipt({...record,runId:executionId,groupId:id});
  const portProbe=probe().listen(0,'127.0.0.1');await once(portProbe,'listening');const address=portProbe.address();
  if(!address||typeof address==='string'||[27017,27181].includes(address.port))throw Error('Protected test port');
  const port=address.port;await new Promise<void>(r=>portProbe.close(()=>r()));
  await receipt({event:'reserved-before-create',runId:id,ownerPid:process.pid,port,databases:names,folder,mongoFolder,budget:{groups:1,mongoStorageAndIndexBytes:262144000,dbPathBytes:536870912,controlBytes:125829120}});
  for(const path of [folder,mongoFolder]){try{await lstat(path);await receipt({event:'existing-resource-blocked',path,resourcesCreated:0});throw Error('Existing own resource requires inventory before reuse');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
  await mkdir(root,{recursive:true});
  if(resolve(await realpath(root))!==root||(await lstat(root)).isSymbolicLink())throw Error('Linked runtime root');
  await mkdir(folder);
  const owner={id,runId:executionId,pid:process.pid,nonce:randomUUID(),names,port};await writeFile(join(folder,'owner.json'),JSON.stringify(owner),{flag:'wx'});
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
          {$match:{'clientMetadata.application.name':{$ne:'S07_P02_CLEANUP'},$or:[{'command.$db':{$in:names}},{$expr:{$in:[{$arrayElemAt:[{$split:[{$ifNull:['$ns','']},'.']},0]},names]}}]}},
          {$project:{_id:0,active:1}}
        ]).toArray();
        if(foreign.length)throw Error('Unclosed or unknown fixture consumer');
        for(const name of names){const s=await control.db(name).command({dbStats:1});stats.push({name,dataSize:s['dataSize'],storageSize:s['storageSize'],indexSize:s['indexSize']});}
        const controlBytes=await size(folder),dbPathBytes=await size(mongoFolder),mongoBytes=stats.reduce((n,r)=>n+Number(r.storageSize)+Number(r.indexSize),0);
        await receipt({event:'cleanup-before',stats,controlBytes,dbPathBytes,mongoBytes,overBudget:mongoBytes>262144000||dbPathBytes>536870912||controlBytes>125829120});
        for(const name of names)await control.db(name).dropDatabase();
        const remaining=await control.db('admin').command({listDatabases:1,nameOnly:true,filter:{name:{$in:names}}});
        if((remaining['databases'] as unknown[]).length)throw Error('Test databases remain');
        await control.close();control=undefined;
      }
      try{await replica?.stop();}catch(error){
        // The legacy helper can wait on an already exited ChildProcess. Never
        // infer cleanup success from a timeout: prove own PID and port absent.
        const rows=(await readFile(join(mongoFolder,'mongo.log'),'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line) as {msg?:string;attr?:{pid?:number;dbPath?:string}}),started=rows.find(row=>row.msg==='MongoDB starting');
        const pid=started?.attr?.pid;if(!pid||!started?.attr?.dbPath||resolve(started.attr.dbPath)!==mongoFolder)throw error;
        let absent=false;try{process.kill(pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')absent=true;else throw e;}
        if(!absent)throw error;
        await new Promise<void>((resolvePort,reject)=>{const check=probe();check.once('error',reject);check.listen(port,'127.0.0.1',()=>check.close(()=>resolvePort()));});
        await receipt({event:'cleanup-stop-timeout-recovered',pid,port,ownPIDAbsent:true,ownPortAbsent:true,reason:String(error)});
      }
      try{await removeOwn(mongoFolder);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      await removeOwn(folder);disposed=true;await receipt({event:'cleanup-complete',databases:names,remaining:0,controlRemoved:true,mongoProcessStopped:true});
    }catch(error){await receipt({event:'cleanup-failed',reason:String(error).slice(0,200),retainUntil:new Date(Date.now()+86400000).toISOString()});throw error;}
  };
  try{
    replica=await startReplicaSet({manualProfile:'test-'+uuid,port});assertOwnUri(replica.uri);
    control=new MongoClient(replica.uri,{appName:'S07_P02_CLEANUP'});await control.connect();
    await receipt({event:'created',databases:names,port,folder,mongoFolder});
    const fixture=async(options:{failSetup?:boolean;legacy?:boolean}={})=>{
      await closeConsumers();
      const prior=[];
      for(const name of names){const s=await control!.db(name).command({dbStats:1});prior.push({name,dataSize:s['dataSize'],storageSize:s['storageSize'],indexSize:s['indexSize']});}
      const controlBytes=await size(folder),mongoBytes=prior.reduce((n,r)=>n+Number(r.storageSize)+Number(r.indexSize),0);
      await receipt({event:'reuse-before',stats:prior,controlBytes,mongoBytes});
      if(mongoBytes>262144000||controlBytes>125829120)throw Error('Own resource budget exceeded');
      for(const name of names)await control!.db(name).dropDatabase();
      for(const e of await readdir(folder))if(e!=='owner.json'){
        const p=join(folder,e),s=await lstat(p);if(s.isDirectory()||s.isSymbolicLink())throw Error('Unexpected test control');await rm(p);
      }
      await receipt({event:'group-reused',databases:names});
      const database=new Database(replica!.uri,databaseName);Reflect.set(database.client,'monitorCommands',true);clients.push(database);await database.connect();
      if(options.failSetup){await database.close();clients.splice(clients.indexOf(database),1);await receipt({event:'partial-setup-failure-consumer-closed'});throw Error('Injected own partial setup failure');}
      const clock={value:Math.floor(Date.now()/30000)*30000+1000,open:true},now=()=>clock.value;
      const keys={version:1 as const,...(options.legacy?{}:{priority:randomBytes(32)}),mail:randomBytes(32),totp:randomBytes(32),journal:randomBytes(32),cursor:randomBytes(32)};
      const restore=new RestoreController(database,join(folder,'gate.json'),keys.journal,keys.priority);await restore.initialize();
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
        const kind=purposeClass(purpose);
        const current=await sessions.contexts.findOne({_id:a.issued.context._id});
        if(kind==='WORK_ONLY'||kind==='BALANCE_60M'&&current?.balanceGrant&&current.balanceGrant.expiresAt>now())return a.issued;
        const result=await identity.work!.prepare(a.issued.context,{purpose,method:'TOTP',...(command?{command}:{}),...(resourceId?{resourceId}:{})});clock.value+=30000;
        a.issued=(await identity.work!.verify(a.issued.context,{intentId:result.intentId,method:'TOTP',code:await generate({secret:a.secret,epoch:Math.floor(now()/1000)})})).issued;return a.issued;
      };
      const https=async(withClient=false,overrideIdentity:IdentityService=identity)=>{
        await promisify(execFile)('C:/Program Files/Git/usr/bin/openssl.exe',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(folder,'key.pem'),'-out',join(folder,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,DNS:platform.localhost,IP:127.0.0.1'],{windowsHide:true});
        const cert=await readFile(join(folder,'cert.pem')),key=await readFile(join(folder,'key.pem'));
        const reservation=probe().listen(0,'127.0.0.1');await once(reservation,'listening');const reserved=reservation.address();
        if(!reserved||typeof reserved==='string'||[27017,27181,port].includes(reserved.port))throw Error('Protected HTTPS port');
        await new Promise<void>(r=>reservation.close(()=>r()));await receipt({event:'https-reserved-before-listen',port:reserved.port});
        const app=createApp({identity:overrideIdentity,config});
        const server=createServer({cert,key},(req,res)=>{
          if(!withClient||(req.url??'').toLowerCase().startsWith('/api/'))return app(req,res);
          void(async()=>{
            const directory=resolve('../cliente/dist-s07-p04'),url=new URL(req.url??'/', 'https://localhost'),relative=decodeURIComponent(url.pathname).replace(/^\/+/, ''),file=resolve(directory,relative||'index.html');
            if(!file.startsWith(directory+'/')&&!file.startsWith(directory+'\\')&&file!==join(directory,'index.html')){res.statusCode=404;res.end();return;}
            try{
              const bytes=await readFile(file);res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':file.endsWith('.png')?'image/png':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.woff2')?'font/woff2':'application/octet-stream');res.setHeader('Cache-Control','no-store');res.end(bytes);
            }catch{res.statusCode=404;res.end();}
          })().catch(()=>{res.statusCode=503;res.end();});
        });servers.push(server);server.listen(reserved.port,'127.0.0.1');await once(server,'listening');
        const a=server.address();if(!a||typeof a==='string')throw Error('No HTTPS listener');config.tenantOrigin='https://localhost:'+a.port;config.platformOrigin='https://platform.localhost:'+a.port;Object.assign(runtime.webauthn.origins,{TENANT:config.tenantOrigin,PLATFORM:config.platformOrigin});
        await receipt({event:'https-created',port:a.port});return{client:new ApiClient(a.port,cert),port:a.port,cert};
      };
      const proxy=async(backend:{port:number;cert:Buffer},dropResponsePath?:string)=>{let dropped=false;
        if(!servers.some(s=>{const a=s.address();return a&&typeof a!=='string'&&a.port===backend.port;}))throw Error('Proxy requires a live owned backend');
        const key=await readFile(join(folder,'key.pem')),server=createServer({key,cert:backend.cert},(req,res)=>{
          const forwarded=httpsRequest({host:'127.0.0.1',port:backend.port,servername:'localhost',ca:backend.cert,method:req.method,path:req.url,headers:{...req.headers,host:'localhost:'+backend.port}},upstream=>{if(dropResponsePath&&!dropped&&req.method==='POST'&&req.url===dropResponsePath){dropped=true;upstream.resume();upstream.on('end',()=>{void receipt({event:'proxy-response-dropped-after-commit',status:upstream.statusCode,path:dropResponsePath});res.destroy();});}else{res.writeHead(upstream.statusCode??503,upstream.headers);upstream.pipe(res);}});forwarded.on('error',()=>{res.statusCode=503;res.end();});req.pipe(forwarded);
        });
        const reservation=probe().listen(0,'127.0.0.1');await once(reservation,'listening');const reserved=reservation.address();if(!reserved||typeof reserved==='string'||[27017,27181].includes(reserved.port))throw Error('Protected proxy port');await new Promise<void>(r=>reservation.close(()=>r()));
        await receipt({event:'proxy-reserved-before-listen',port:reserved.port,backendPort:backend.port});servers.push(server);server.listen(reserved.port,'127.0.0.1');await once(server,'listening');const a=server.address();if(!a||typeof a==='string')throw Error('No own proxy port');await receipt({event:'proxy-created',port:a.port});return{port:a.port,cert:backend.cert};
      };
      return{database,clock,now,keys,restore,sessions,messages,identity,runtime,config,signup,actor,proof,https,proxy};
    };
    const peerRead=async(token:string,now:number)=>{
      const source=`import {Database} from './dist-s07-p04/src/shared/database.js';import {Sessions} from './dist-s07-p04/src/modules/sessions/service.js';
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
    const peer=async(data:Record<string,unknown>)=>{
      await receipt({event:'operation-peer-reserved',port});liveLeases++;
      const child=spawn(process.execPath,[fileURLToPath(new URL('./worker.js',import.meta.url))],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
      await receipt({event:'operation-peer-created',pid:child.pid});const exited=once(child,'exit');let closed=false;
      const receive=async()=>await new Promise<Record<string,unknown>>((resolveMessage,reject)=>{const timeout=setTimeout(()=>{child.removeListener('message',message);reject(Error('Own peer timeout'));},30000);const message=(v:unknown)=>{clearTimeout(timeout);resolveMessage(v as Record<string,unknown>);};child.once('message',message);child.once('error',reject);});
      const close=async()=>{if(closed)return;closed=true;try{if(child.exitCode===null){child.send({type:'stop'});await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(Error('Own peer shutdown timeout')),10000))]);}}finally{if(child.exitCode===null&&!child.killed){child.kill();await exited;}liveLeases--;await receipt({event:'operation-peer-stopped',pid:child.pid});}};
      try{const ready=receive();child.send({type:'initialize',uri:replica!.uri,name:databaseName,folder,...data});const result=await ready;if(result['type']!=='ready')throw Error('Own peer initialization failed');return{pid:child.pid,execute:async(command:Record<string,unknown>)=>{const pending=receive();child.send({type:'execute',...command});return await pending;},close};}catch(e){await close();throw e;}
    };
    return{runId:executionId,fixture,dispose,folder,names,port,uri:replica.uri,peerRead,peer,hold:()=>{liveLeases++;let active=true;return()=>{if(active){liveLeases--;active=false;}};}};
  }catch(error){
    let startupTail='';try{startupTail=(await readFile(join(mongoFolder,'mongo.log'),'utf8')).split('\n').slice(-8).join('\n');}catch{/* Setup may fail before its own log exists. */}
    await receipt({event:'setup-failed',reason:String(error),startupTail});await dispose();throw error;
  }
}
export type MejFixture=Awaited<ReturnType<Awaited<ReturnType<typeof s07Profile>>['fixture']>>;
