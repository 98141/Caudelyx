/* eslint-disable security/detect-non-literal-fs-filename -- Exact own paths and nonce/PID/port guards verified before offline cleanup. */
// One diagnosed, recorded S06 run only. Never cleanup by prefix.
import {readFile,appendFile,lstat,realpath,readdir,rm} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import net from 'node:net';
import {MongoClient} from 'mongodb';
const root=resolve('.runtime'),folder=join(root,'s06-p02-c6b2026e10a64d42a01c7c80'),mongo=join(root,'manual-test-c6b2026e-10a6-4d42-a01c-7c80ecb80602');
const log=resolve('../../Construccion/Sprints/S06/Evidencias/S06-P02-RESOURCES.jsonl'),owner=JSON.parse(await readFile(join(folder,'owner.json'),'utf8'));
const names=['caudelyx_s06_p02_c6b2026e10a64d42a01c7c80','caudelyx_s06_p02_c6b2026e10a64d42a01c7c80_external_mail','caudelyx_s06_p02_c6b2026e10a64d42a01c7c80_external_security'];
if(owner.runId!=='11fc4e36-120d-41f0-bf15-0d966aa93feb'||owner.nonce!=='fa90c45d-13b6-44f8-9281-ddfaddf52094'||owner.pid!==2848||owner.port!==51464||JSON.stringify(owner.names)!==JSON.stringify(names))throw Error('Unproved exact owner');
let ownerAbsent=false;try{process.kill(owner.pid,0);}catch(e){if(e.code==='ESRCH')ownerAbsent=true;else throw e;}if(!ownerAbsent)throw Error('Own test lease still active');
async function inspect(path){const absolute=resolve(path);if(!absolute.startsWith(root+sep)||await realpath(path)!==absolute||(await lstat(path)).isSymbolicLink())throw Error('Unsafe own path');let bytes=0;for(const e of await readdir(path,{withFileTypes:true})){const p=join(path,e.name),s=await lstat(p);if(s.isSymbolicLink()||await realpath(p)!==resolve(p))throw Error('Linked own control');bytes+=e.isDirectory()?await inspect(p):s.size;}return bytes;}
const uri='mongodb://127.0.0.1:51464/?replicaSet=caudelyx-manual',client=new MongoClient(uri,{appName:'S06_P02_DEAD_CLEANUP',serverSelectionTimeoutMS:3000});
const receipt=async(v)=>await appendFile(log,JSON.stringify({task:'S06-P02',runId:owner.runId,at:new Date().toISOString(),...v})+'\n');
let pid;
try{await client.connect();}catch(error){
 await client.close();
 const rows=(await readFile(join(mongo,'mongo.log'),'utf8')).split('\n').filter(Boolean).map(x=>JSON.parse(x));const start=rows.find(x=>x.msg==='MongoDB starting');
 if(!start?.attr?.pid||resolve(start.attr.dbPath)!==mongo)throw error;
 let absent=false;try{process.kill(start.attr.pid,0);}catch(e){if(e.code==='ESRCH')absent=true;else throw e;}if(!absent)throw error;
 await new Promise((yes,no)=>{const p=net.createServer();p.once('error',no);p.listen(owner.port,'127.0.0.1',()=>p.close(yes));});
 const controlBytes=await inspect(folder),dbPathBytes=await inspect(mongo);
 await receipt({event:'dead-run-offline-cleanup-before',mongoPid:start.attr.pid,ownMongoPIDAbsent:true,ownPortAbsent:true,controlBytes,dbPathBytes,logicalDropVerified:false,reason:'Mongo exited with its killed test process; exact isolated dbPath removal replaces online drops'});
 for(const path of [mongo,folder]){await inspect(path);await rm(path,{recursive:true,force:false,maxRetries:3});}
 await receipt({event:'dead-run-cleanup-complete',databases:names,remainingOwnDirectories:0,ownMongoPIDAbsent:true,ownPortAbsent:true,controlsRemoved:true,logicalDropVerified:false,method:'OFFLINE_REMOVAL_OF_EXACT_STOPPED_OWN_ISOLATED_PATH'});console.log('Own stopped fixture paths removed; online logical drop not claimed');process.exit(0);
}
try{
 const opts=await client.db('admin').command({getCmdLineOpts:1});if(resolve(opts.parsed.storage.dbPath)!==mongo)throw Error('Unproved own Mongo dbPath');
 const active=await client.db('admin').aggregate([{$currentOp:{allUsers:true,idleConnections:true,idleSessions:true}},{$match:{'clientMetadata.application.name':{$ne:'S06_P02_DEAD_CLEANUP'},$or:[{'command.$db':{$in:names}},{$expr:{$in:[{$arrayElemAt:[{$split:[{$ifNull:['$ns','']},'.']},0]},names]}}]}}]).toArray();if(active.length)throw Error('Unknown or live own consumer');
 pid=(await client.db('admin').command({serverStatus:1})).pid;
 const stats=[];for(const n of names){const s=await client.db(n).command({dbStats:1});stats.push({name:n,dataSize:s.dataSize,storageSize:s.storageSize,indexSize:s.indexSize});}
 await receipt({event:'dead-run-cleanup-before',ownerPIDAbsent:true,mongoPid:pid,databases:names,stats,controlBytes:await inspect(folder),dbPathBytes:await inspect(mongo)});
 for(const n of names)await client.db(n).dropDatabase();const remaining=await client.db('admin').command({listDatabases:1,nameOnly:true,filter:{name:{$in:names}}});if(remaining.databases.length)throw Error('Own databases remain');
 try{await client.db('admin').command({shutdown:1,timeoutSecs:5});}catch{/* Prove shutdown below rather than infer it from this socket exception. */}
}finally{await client.close();}
let stopped=false;for(let i=0;i<50;i++){try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH'){stopped=true;break;}throw e;}await new Promise(r=>setTimeout(r,100));}if(!stopped)throw Error('Own Mongo PID still live');
await new Promise((yes,no)=>{const p=net.createServer();p.once('error',no);p.listen(owner.port,'127.0.0.1',()=>p.close(yes));});
for(const path of [mongo,folder]){await inspect(path);await rm(path,{recursive:true,force:false,maxRetries:3});}
await receipt({event:'dead-run-cleanup-complete',remaining:0,databases:names,ownMongoPIDAbsent:true,ownPortAbsent:true,controlsRemoved:true});console.log('S06 dead run cleanup proved, protected profiles untouched');
