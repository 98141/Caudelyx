/* MS-P05-R2 private mongod: own process, own ephemeral port, own dbPath in the session scratchpad.
 * Never connects to the shared service (27017) nor 27181. Inventory receipt BEFORE create, teardown with receipts. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {randomBytes,randomUUID} from 'node:crypto';
import {MongoClient} from 'mongodb';
import {receipt} from './guard.mjs';
const binary='C:/Program Files/MongoDB/Server/8.3/bin/mongod.exe';
const PROTECTED=[27017,27181];
async function freePort(){const s=createServer().listen(0,'127.0.0.1');await once(s,'listening');const a=s.address();await new Promise(r=>s.close(r));if(!a||typeof a==='string'||PROTECTED.includes(a.port))throw Error('PROTECTED_PORT');return a.port;}
export async function startMongo(){
 const scratch=process.env['MS_P05_R2_SCRATCH'];if(!scratch||!path.isAbsolute(scratch))throw Error('SCRATCH_REQUIRED');
 const id=randomBytes(12).toString('hex'),runId=randomUUID(),dbPath=path.join(path.resolve(scratch),'ms-p05-r2-mongo-'+id),port=await freePort();
 await receipt({event:'reserved-before-create',resourceKind:'mongod',mongoGroupId:id,runId,ownerPid:process.pid,binary,port,bind:'127.0.0.1',replSet:'rs0',dbPath,budget:{dbPathBytes:536870912},protectedPorts:PROTECTED,sharedServiceTouched:false});
 try{await fs.lstat(dbPath);throw Error('OWN_DBPATH_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
 await fs.mkdir(dbPath);
 const log=path.join(dbPath,'mongod.log'),child=spawn(binary,['--port',String(port),'--bind_ip','127.0.0.1','--replSet','rs0','--dbpath',dbPath,'--logpath',log,'--wiredTigerCacheSizeGB','0.25','--setParameter','diagnosticDataCollectionEnabled=false'],{windowsHide:true,stdio:'ignore'});
 const exited=once(child,'exit');await receipt({event:'created',resourceKind:'mongod',mongoGroupId:id,runId,pid:child.pid,port,dbPath});
 const uri='mongodb://127.0.0.1:'+port+'/?replicaSet=rs0';
 const stop=async()=>{
  const started=performance.now();let shutdown='command';
  try{const c=new MongoClient('mongodb://127.0.0.1:'+port+'/?directConnection=true',{serverSelectionTimeoutMS:5000});await c.connect();await c.db('admin').command({shutdown:1,force:true}).catch(()=>undefined);await c.close().catch(()=>undefined);}catch{shutdown='kill';}
  let timer;await Promise.race([exited,new Promise(r=>{timer=setTimeout(r,20000);})]);clearTimeout(timer);
  if(child.exitCode===null&&child.signalCode===null){shutdown='kill';child.kill();await exited;}
  await fs.rm(dbPath,{recursive:true,force:false,maxRetries:5,retryDelay:300});
  const absent=await fs.lstat(dbPath).then(()=>false,e=>{if(e.code==='ENOENT')return true;throw e;});
  await receipt({event:'cleanup-complete',resourceKind:'mongod',mongoGroupId:id,runId,pid:child.pid,port,dbPath,shutdown,exitCode:child.exitCode,processExited:true,dbPathRemoved:absent,absenceVerified:absent,remaining:absent?0:1,durationMs:performance.now()-started,sharedServiceTouched:false});
  if(!absent)throw Error('OWN_DBPATH_REMAINS');
 };
 try{
  const deadline=Date.now()+60000;let ready=false;
  while(!ready){
   if(child.exitCode!==null)throw Error('MONGOD_EXITED:'+(await fs.readFile(log,'utf8').catch(()=>'')).slice(-1500));
   try{const c=new MongoClient('mongodb://127.0.0.1:'+port+'/?directConnection=true',{serverSelectionTimeoutMS:1000});await c.connect();
    const hello=await c.db('admin').command({hello:1});
    if(!hello['setName'])await c.db('admin').command({replSetInitiate:{_id:'rs0',members:[{_id:0,host:'127.0.0.1:'+port}]}}).catch(e=>{if(!/already initialized/i.test(String(e)))throw e;});
    ready=(await c.db('admin').command({hello:1}))['isWritablePrimary']===true;await c.close();
   }catch(e){if(Date.now()>deadline)throw e;}
   if(!ready)await new Promise(r=>setTimeout(r,500));
  }
  await receipt({event:'ready',resourceKind:'mongod',mongoGroupId:id,runId,port});
 }catch(e){await stop().catch(()=>undefined);throw e;}
 return{port,uri,stop,id};
}
