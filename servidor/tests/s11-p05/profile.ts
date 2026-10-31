// S11-P05 (Claude): mechanical copy of tests/s11-p04/fixture.ts. Only changes: control .runtime/s11-p05-<id>, receipts S11-P05-RESOURCES.jsonl,
// cleanup appName S11_P05_CLEANUP. Guards, exact names, leases and teardown are the author's; expectations live in own tests.
import {ProjectionRuntime} from '../../src/modules/reporting/projection/service.js';
import {wealthContract} from '../../src/modules/wealth/contract.js';
import {managementContract} from '../../src/modules/obligations/contract.js';
import {today} from '../../src/modules/obligations/calendar.js';
import type {Data} from '../../src/modules/obligations/models.js';
/* eslint-disable security/detect-non-literal-fs-filename -- Exact registered test paths, never HTTP input. */
import {purposeClass} from '../../src/modules/sessions/work-policy.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile, rm, lstat, realpath, readdir, rmdir } from 'node:fs/promises';
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
import { ApiClient } from '../helpers/client.js';

const id=randomBytes(12).toString('hex');
const root=resolve('.runtime'),folder=join(root,'s11-p05-'+id);
const databaseName='caudelyx_s08_p02_'+id;
const names=[databaseName,databaseName+'_external_mail',databaseName+'_external_security'];
const evidencePrefix=process.env['S11_EVIDENCE_PREFIX']??'S11-P05';
if(evidencePrefix!=='S11-P05')throw Error('Invalid independent evidence namespace');
const log=resolve('../../Construccion/Sprints/S11/Evidencias/'+evidencePrefix+'-RESOURCES.jsonl');
const servers:ReturnType<typeof createServer>[]=[];
const clients:Database[]=[];
export const password='Frase de prueba sintetica larga 9871236450';
const appendReceipt=async(record:Record<string,unknown>)=>await appendFile(log,JSON.stringify({at:new Date().toISOString(),task:evidencePrefix,...record})+'\n');
export function assertOwnUri(uri:string){const u=new URL(uri);if(!['127.0.0.1','localhost'].includes(u.hostname)||u.port!=='27017'||u.searchParams.get('replicaSet')!=='rs0')throw Error('Protected/unknown Mongo profile');}
async function size(path:string):Promise<number>{let n=0;for(const e of await readdir(path,{withFileTypes:true})){const p=join(path,e.name),s=await lstat(p);if(s.isSymbolicLink())throw Error('Refuse linked controls');n+=e.isDirectory()?await size(p):s.size;}return n;}
async function removeOwn(path:string){
  if(![folder].includes(resolve(path))||resolve(await realpath(path))!==resolve(path)||(await lstat(path)).isSymbolicLink())throw Error('Unowned control path');
  if(resolve(await realpath(root))!==root)throw Error('Linked runtime root');
  await size(path);await rm(path,{recursive:true,force:false,maxRetries:3});
}
export async function s11Profile(){
  const executionId=randomUUID(),receipt=(record:Record<string,unknown>)=>appendReceipt({...record,runId:executionId,groupId:id});
  const portProbe=probe().listen(0,'127.0.0.1');await once(portProbe,'listening');const address=portProbe.address();
  if(!address||typeof address==='string'||[27017,27181].includes(address.port))throw Error('Protected test port');
  const port=address.port;await new Promise<void>(r=>portProbe.close(()=>r()));
  await receipt({event:'reserved-before-create',runId:id,ownerPid:process.pid,port,databases:names,folder,privateRoot:join(folder,'private'),controls:['owner.json','gate.json','key.pem','cert.pem'],sharedMongo:true,budget:{groups:1,mongoStorageAndIndexBytes:805306368,dbPathBytes:536870912,controlBytes:125829120}});
  for(const path of [folder]){try{await lstat(path);await receipt({event:'existing-resource-blocked',path,resourcesCreated:0});throw Error('Existing own resource requires inventory before reuse');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
  await mkdir(root,{recursive:true});
  if(resolve(await realpath(root))!==root||(await lstat(root)).isSymbolicLink())throw Error('Linked runtime root');
  await mkdir(folder);
  const owner={id,runId:executionId,pid:process.pid,nonce:randomUUID(),names,port};await writeFile(join(folder,'owner.json'),JSON.stringify(owner),{flag:'wx'});
  let replica:{uri:string;stop:()=>Promise<void>}|undefined;
  let control:MongoClient|undefined;let controlConnected=false;let ownsDatabaseNames=false;
  let disposed=false;
  let liveLeases=0;
  const closeConsumers=async()=>{for(const server of servers.splice(0))await new Promise<void>(r=>server.close(()=>r()));for(const db of clients.splice(0))await db.close();};
  const dispose=async()=>{const cleanupStarted=performance.now();
    if(disposed)return;
    if(liveLeases){await receipt({event:'cleanup-blocked-live-lease',runId:id});throw Error('Own fixture lease is live');}
    try{
      if(JSON.stringify(JSON.parse(await readFile(join(folder,'owner.json'),'utf8')))!==JSON.stringify(owner))throw Error('Ownership changed');
      await closeConsumers();
      const stats=[];
      if(control&&controlConnected&&ownsDatabaseNames){
        const topology=await control.db('admin').command({hello:1});if(topology['setName']!=='rs0'||!topology['isWritablePrimary'])throw Error('Unexpected installed topology');
        const foreign=await control.db('admin').aggregate([
          {$currentOp:{allUsers:true,idleConnections:true,idleSessions:true}},
          {$match:{'clientMetadata.application.name':{$ne:'S11_P05_CLEANUP'},$or:[{'command.$db':{$in:names}},{$expr:{$in:[{$arrayElemAt:[{$split:[{$ifNull:['$ns','']},'.']},0]},names]}}]}},
          {$project:{_id:0,active:1}}
        ]).toArray();
        if(foreign.length)throw Error('Unclosed or unknown fixture consumer');
        for(const name of names){const s=await control.db(name).command({dbStats:1});stats.push({name,dataSize:s['dataSize'],storageSize:s['storageSize'],indexSize:s['indexSize']});}
        const controlBytes=await size(folder),dbPathBytes=0,mongoBytes=stats.reduce((n,r)=>n+Number(r.storageSize)+Number(r.indexSize),0);
        await receipt({event:'cleanup-before',stats,controlBytes,dbPathBytes,mongoBytes,overBudget:mongoBytes>805306368||dbPathBytes>536870912||controlBytes>125829120});
        for(const name of names)await control.db(name).dropDatabase();
        const remaining=await control.db('admin').command({listDatabases:1,nameOnly:true,filter:{name:{$in:names}}});
        if((remaining['databases'] as unknown[]).length)throw Error('Test databases remain');
        await control.close();control=undefined;
      }
      if(control&&(!controlConnected||!ownsDatabaseNames)){await control.close();control=undefined;}
      // Installed Mongo service is shared: never stop it or remove its dbPath.
      await removeOwn(folder);disposed=true;await receipt({event:'cleanup-complete',databases:names,remaining:ownsDatabaseNames?0:null,absenceVerified:ownsDatabaseNames,createdDatabaseNames:ownsDatabaseNames?names:[],controlRemoved:true,sharedMongoServiceUnchanged:true,durationMs:performance.now()-cleanupStarted});
    }catch(error){await receipt({event:'cleanup-failed',reason:String(error).slice(0,200),retainUntil:new Date(Date.now()+86400000).toISOString()});throw error;}
  };
  try{
    replica={uri:'mongodb://127.0.0.1:27017/?replicaSet=rs0',stop:async()=>{}};assertOwnUri(replica.uri);
    control=new MongoClient(replica.uri,{appName:'S11_P05_CLEANUP'});await control.connect();controlConnected=true;
    const present=await control.db('admin').command({listDatabases:1,filter:{name:{$in:names}},nameOnly:true});
    if(present['databases'].length)throw Error('Pre-existing database name is not owned; refuse adoption or cleanup');
    ownsDatabaseNames=true;
    await receipt({event:'created',databases:names,port:27017,folder,sharedMongo:true});
    const fixture=async(options:{failSetup?:boolean;legacy?:boolean}={})=>{
      if(liveLeases){await receipt({event:'reuse-blocked-live-lease'});throw Error('Own fixture lease is live');}
      await closeConsumers();
      const consumers=await control!.db('admin').aggregate([
        {$currentOp:{allUsers:true,idleConnections:true,idleSessions:true}},
        {$match:{'clientMetadata.application.name':{$ne:'S11_P05_CLEANUP'},$or:[{'command.$db':{$in:names}},{$expr:{$in:[{$arrayElemAt:[{$split:[{$ifNull:['$ns','']},'.']},0]},names]}}]}},
        {$project:{_id:0,active:1}}
      ]).toArray();
      if(consumers.length)throw Error('Refuse group reuse with a live or unknown consumer');
      const prior=[];
      for(const name of names){const s=await control!.db(name).command({dbStats:1});prior.push({name,dataSize:s['dataSize'],storageSize:s['storageSize'],indexSize:s['indexSize']});}
      const controlBytes=await size(folder),mongoBytes=prior.reduce((n,r)=>n+Number(r.storageSize)+Number(r.indexSize),0);
      await receipt({event:'reuse-before',stats:prior,controlBytes,mongoBytes});
      if(mongoBytes>805306368||controlBytes>125829120)throw Error('Own resource budget exceeded');
      for(const name of names)await control!.db(name).dropDatabase();
      for(const e of await readdir(folder))if(e!=='owner.json'){
        const p=join(folder,e),stat=await lstat(p);if(stat.isSymbolicLink())throw Error('Unexpected linked control');
        if(stat.isDirectory()){
          if(e!=='private'||await realpath(p)!==p)throw Error('Unknown directory');
          for(const name of await readdir(p)){if(!/^[a-f0-9-]{36}(?:\.part)?$/.test(name)||(await lstat(join(p,name))).isSymbolicLink())throw Error('Unknown private object');await rm(join(p,name));}await rmdir(p);
        }else await rm(p);
      }
      await receipt({event:'group-reused',databases:names});
      const database=new Database(replica!.uri,databaseName,{monitorCommands:true});clients.push(database);await database.connect();
      if(options.failSetup){await database.close();clients.splice(clients.indexOf(database),1);await receipt({event:'partial-setup-failure-consumer-closed'});throw Error('Injected own partial setup failure');}
      const clock={value:Math.floor(Date.now()/30000)*30000+1000,open:true},now=()=>clock.value;
      const keys={version:1 as const,...(options.legacy?{}:{priority:randomBytes(32)}),mail:randomBytes(32),totp:randomBytes(32),journal:randomBytes(32),cursor:randomBytes(32)};
      const restore=new RestoreController(database,join(folder,'gate.json'),keys.journal,keys.priority,keys.cursor);await restore.initialize();
      const sessions=new Sessions(database,now),messages=new SyntheticMessaging(database,keys.mail,now);
      const identity=new IdentityService(database,sessions,messages,new PasswordHasher(),()=>clock.open&&restore.isOpen(),now);await identity.initialize();
      const config={mongoUri:replica!.uri,databaseName,port:0,tenantOrigin:'https://localhost:0',platformOrigin:'https://platform.localhost:0'};
      await mkdir(join(folder,'private'));const runtime=await attachRuntime(identity,keys,config,{exchangePrivateRoot:join(folder,'private')});
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
        a.issued=(await identity.work!.verify(a.issued.context,{intentId:result.intentId,method:'TOTP',code:await generate({secret:a.secret,epoch:Math.floor(now()/1000)})},a.issued.token)).issued;return a.issued;
      };
      const https=async(overrideIdentity:IdentityService=identity,uiOrigin?:string)=>{
        await promisify(execFile)('C:/Program Files/Git/usr/bin/openssl.exe',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(folder,'key.pem'),'-out',join(folder,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,DNS:platform.localhost,IP:127.0.0.1'],{windowsHide:true});
        const cert=await readFile(join(folder,'cert.pem')),key=await readFile(join(folder,'key.pem'));
        const reservation=probe().listen(0,'127.0.0.1');await once(reservation,'listening');const reserved=reservation.address();
        if(!reserved||typeof reserved==='string'||[27017,27181,port].includes(reserved.port))throw Error('Protected HTTPS port');
        await new Promise<void>(r=>reservation.close(()=>r()));await receipt({event:'https-reserved-before-listen',port:reserved.port});
        const app=createApp({identity:overrideIdentity,config});const server=createServer({cert,key},app);servers.push(server);server.listen(reserved.port,'127.0.0.1');await once(server,'listening');
        const a=server.address();if(!a||typeof a==='string')throw Error('No HTTPS listener');config.tenantOrigin=uiOrigin??'https://localhost:'+a.port;config.platformOrigin='https://platform.localhost:'+a.port;Object.assign(runtime.webauthn.origins,{TENANT:config.tenantOrigin,PLATFORM:config.platformOrigin});
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
    const peer=async(data:Record<string,unknown>)=>{
      await receipt({event:'operation-peer-reserved',port});liveLeases++;
      const child=spawn(process.execPath,[fileURLToPath(new URL('./worker.js',import.meta.url))],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
      await receipt({event:'operation-peer-created',pid:child.pid});const exited=once(child,'exit');let closed=false;
      const receive=async()=>await new Promise<Record<string,unknown>>((resolveMessage,reject)=>{const done=()=>{clearTimeout(timeout);child.removeListener('message',message);child.removeListener('error',error);child.removeListener('exit',exit);};const message=(v:unknown)=>{done();resolveMessage(v as Record<string,unknown>);},error=(e:Error)=>{done();reject(e);},exit=()=>error(Error('Own peer exited before reply')),timeout=setTimeout(()=>error(Error('Own peer timeout')),30000);child.once('message',message);child.once('error',error);child.once('exit',exit);});
      const close=async()=>{if(closed)return;closed=true;let timer:ReturnType<typeof setTimeout>|undefined;try{if(child.exitCode===null){child.send({type:'stop'});await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Own peer shutdown timeout')),10000);})]);}}finally{clearTimeout(timer);if(child.exitCode===null&&!child.killed){child.kill();await exited;}liveLeases--;await receipt({event:'operation-peer-stopped',pid:child.pid});}};
      try{const ready=receive();child.send({type:'initialize',uri:replica!.uri,name:databaseName,folder,...data});const result=await ready;if(result['type']!=='ready')throw Error('Own peer initialization failed: '+JSON.stringify(result));return{pid:child.pid,execute:async(command:Record<string,unknown>)=>{const pending=receive();child.send({type:'execute',...command});return await pending;},close};}catch(e){await close();throw e;}
    };
    return{runId:executionId,fixture,dispose,folder,names,port,uri:replica.uri,peer,phase:async(phase:string,durationMs:number)=>receipt({event:'phase',phase,durationMs}),hold:()=>{liveLeases++;let active=true;return()=>{if(active){liveLeases--;active=false;}};}};
  }catch(error){
    const startupTail='No Mongo subprocess/service/dbPath created by this fixture';
    await receipt({event:'setup-failed',reason:String(error),startupTail});await dispose();throw error;
  }
}
export type ExchangeFixture=Awaited<ReturnType<Awaited<ReturnType<typeof s11Profile>>['fixture']>>;


export async function world(group:Awaited<ReturnType<typeof s11Profile>>,clockValue=Date.parse('2026-10-30T12:00:00-05:00')){
 const setup=performance.now(),f=await group.fixture();await group.phase('setup',performance.now()-setup);const seed=performance.now();f.clock.value=clockValue;const a=await f.actor();
 const org=(await f.runtime.organizations.create(a.issued.context,{name:'Organización sintética S09',currency:'COP',timezone:'America/Bogota'},randomUUID())).data.organization.id;
 const account=async(code:string,accountClass='ASSET',kind='GENERAL')=>{const payload={code,name:'Cuenta sintética '+code,currency:'COP',accountClass,kind};return(await f.runtime.finance.mutate(a.issued.context,'createAccount',org,payload,randomUUID())).data as{id:string;version:number};};
 const bank=await account('BANK_S09','ASSET','BANK'),equity=await account('EQUITY_S09','EQUITY');
 const capital={currency:'COP',effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN-S09-CAPITAL',description:'Capital sintético S09',lines:[{accountId:bank.id,debit:'20000000.00',credit:'0.00'},{accountId:equity.id,debit:'0.00',credit:'20000000.00'}]},key:string=randomUUID();
 await f.proof(a,'FINANCE_JOURNAL_POST',{organizationId:org,idempotencyKey:key,payload:capital});await f.runtime.finance.mutate(a.issued.context,'postJournal',org,capital,key);await f.restore.flush();
 const owner=async()=>{const o=JSON.parse(await readFile(join(group.folder,'owner.json'),'utf8')) as{pid:number;runId:string;names:string[]};return o.pid===process.pid&&o.runId===group.runId&&o.names[0]===f.database.db.databaseName;};
 await group.phase('seed',performance.now()-seed);const verification=performance.now();const service=f.runtime.obligations;await service.prepareOwned(owner);await f.runtime.wealth.prepareOwned(owner);const projection=await ProjectionRuntime.createOwned(f.identity,f.keys.cursor,owner,false,()=>service.activateOwned(owner));f.identity.reporting!.projection=projection;await group.phase('verification',performance.now()-verification);
 const mutate=async(operation:string,payload:Data,params:Record<string,string>={},expected?:string,key:string=randomUUID(),actor=a,proof=true)=>{
  const p=managementContract().operations.get(operation)!.definition['x-purpose']!,command={operationId:operation,idempotencyKey:key,...(params['organizationId']?{organizationId:params['organizationId']}:{}),...(params['bookId']?{bookId:params['bookId']}:{}),pathParameters:params,payload,...(expected?{expectedETag:expected}:{})};
  if(proof)await f.proof(actor,p,command,params['expenseId']??params['ruleId']??params['liabilityId']??params['relationshipId']);
  return await service.mutate(actor.issued.context,operation,payload,params,key,expected);
 };
 const book=(await mutate('createPersonalBook',{currency:'COP'})).data as{id:string};
 const personal=async(label:string,accountClass='ASSET',kind='GENERAL')=>(await mutate('createPersonalAccount',{code:label,name:'Personal sintética '+label,currency:'COP',accountClass,kind},{bookId:book.id})).data as{id:string;version:number};
 const read=async(operation:string,params:Record<string,string>={},query:Data={asOf:today(f.now())},actor=a)=>await service.read(actor.issued.context,operation,params,query);
 const wealth=f.runtime.wealth;
 const wealthMutate=async(operation:string,payload:Data,params:Record<string,string>,expected?:string,key:string=randomUUID(),actor=a,proof=true)=>{
  const purpose=wealthContract().operations.get(operation)!.definition['x-purpose']!,command={operationId:operation,idempotencyKey:key,...(params['organizationId']?{organizationId:params['organizationId']}:{}),...(params['bookId']?{bookId:params['bookId']}:{}),pathParameters:params,payload,...(expected?{expectedETag:expected}:{})};
  if(proof)await f.proof(actor,purpose,command,params['assetId']??params['fundId']);return await wealth.mutate(actor.issued.context,operation,payload,params,key,expected);
 };
 const wealthRead=async(operation:string,params:Record<string,string>={},query:Data={asOf:today(f.now())},actor=a)=>await wealth.read(actor.issued.context,operation,params,query);
 return{...f,owner,a,org,bank,equity,account,personal,book,service,projection,mutate,read,group,wealth,wealthMutate,wealthRead};
}
