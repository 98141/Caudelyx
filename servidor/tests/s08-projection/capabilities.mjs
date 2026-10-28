// Owned synthetic capability gate. No product configuration or global Mongo writes.
import {MongoClient, BSON} from 'mongodb';
import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {ProjectionFragments} from '../../dist-s08-projection/src/modules/reporting/projection/observer.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..');
const evidence=resolve(root,'Construccion/Sprints/S08/Evidencias');
const stem='S08-P02-PROJECTION-';
const inputs=JSON.parse(await readFile(resolve(evidence,stem+'INPUTS.json'),'utf8'));
const {runId,database:name,uri}=inputs.runtime;
assert.match(name,/^caudelyx_s08_projection_cap_[a-f0-9]{16}$/);
assert.equal(name,'caudelyx_'+runId);
assert.equal(uri,'mongodb://127.0.0.1:27017/?replicaSet=rs0');
const owner=runId+':'+process.pid;
const resources=resolve(evidence,stem+'RESOURCES.jsonl');
const receipt=async event=>appendFile(resources,JSON.stringify({atUTC:new Date().toISOString(),runId,ownerPid:process.pid,database:name,...event})+'\n');
await receipt({event:'reserved-before-connect',databases:[name],companions:[],controls:[],budget:inputs.runtime});
const client=new MongoClient(uri,{appName:'S08_PROJECTION_CAPABILITY',monitorCommands:true,serverSelectionTimeoutMS:3000,maxPoolSize:5});
let priorAttempts=[],priorRuns=[];
try{const previous=JSON.parse(await readFile(resolve(evidence,stem+'CAPABILITIES.json'),'utf8'));priorAttempts=[...(previous.priorAttempts??[]),{...previous,priorAttempts:undefined}];}catch(error){if(error.code!=='ENOENT')throw error;}
try{priorRuns=JSON.parse(await readFile(resolve(evidence,stem+'RUNS.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const result={runId,database:name,status:'RUNNING',tests:[],cleanup:{status:'NOT_STARTED'},priorAttempts};
const started=performance.now();let created=false,stream;
const commands=[];
client.on('commandStarted',event=>{
 if(event.commandName==='find')commands.push({name:event.commandName,readConcern:event.command.readConcern,startTransaction:event.command.startTransaction});
});
const save=async()=>writeFile(resolve(evidence,stem+'CAPABILITIES.json'),JSON.stringify(result,null,2)+'\n');
const pass=(id,data)=>{result.tests.push({id,status:'PASS',...data});console.log(JSON.stringify({id,status:'PASS',...data}));};
const simplify=e=>({op:e.operationType,ns:e.ns?.coll,key:e.documentKey?._id,before:e.fullDocumentBeforeChange?.value,after:e.fullDocument?.value,clusterTime:e.clusterTime?.toString(),txn:e.txnNumber?.toString(),lsid:e.lsid?BSON.EJSON.stringify(e.lsid):undefined,description:e.operationDescription});
const until=async predicate=>{
 const events=[],end=performance.now()+6000;
 while(performance.now()<end){const event=await stream.tryNext();if(event){events.push(event);if(predicate(event))return events;}}
 throw Object.assign(new Error('Capability stream deadline'),{observed:events.map(simplify)});
};
try{
 await client.connect();
 const hello=await client.db('admin').command({hello:1}),build=await client.db('admin').command({buildInfo:1});
 assert.equal(hello.setName,'rs0');assert.equal(hello.isWritablePrimary,true);
 result.server={version:build.version,setName:hello.setName,maxBsonObjectSize:hello.maxBsonObjectSize,maxWireVersion:hello.maxWireVersion};
 const before=await client.db('admin').command({listDatabases:1,filter:{name},nameOnly:true});assert.equal(before.databases.length,0,'Existing database is not owned');
 const db=client.db(name);
 await db.createCollection('owner');created=true;await db.collection('owner').insertOne({_id:owner,runId,pid:process.pid});
 for(const collection of ['source','manifests','barriers'])await db.createCollection(collection,{changeStreamPreAndPostImages:{enabled:true}});
 await receipt({event:'created',databases:[name]});
 stream=db.watch([{$unset:'updateDescription'},{$changeStreamSplitLargeEvent:{}}], {showExpandedEvents:true,fullDocument:'required',fullDocumentBeforeChange:'required',maxAwaitTimeMS:200});
 await stream.tryNext();
 const source=db.collection('source');
 await source.insertOne({_id:'a',value:0},{writeConcern:{w:'majority'}});
 await until(e=>e.ns?.coll==='source'&&e.operationType==='insert');
 await client.withSession(async session=>session.withTransaction(async()=>{
  await source.updateOne({_id:'a'},{$set:{value:1}},{session});
  await source.updateOne({_id:'a'},{$set:{value:2}},{session});
  await db.collection('manifests').insertOne({_id:'transaction',value:2},{session});
 },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'}}));
 const txEvents=await until(e=>e.ns?.coll==='manifests'&&e.documentKey?._id==='transaction');
 result.transactionEvents=txEvents.map(simplify);
 const changes=txEvents.filter(e=>e.ns?.coll==='source');
 assert.equal(changes.length,2,'Both committed mutation steps must be observable');
 assert.deepEqual(changes.map(e=>[e.fullDocumentBeforeChange?.value,e.fullDocument?.value]),[[0,1],[1,2]]);
 assert.ok(txEvents.every(e=>e.txnNumber&&e.lsid&&e.clusterTime.equals(txEvents[0].clusterTime)));
 pass('CAP_IMAGES_TRANSACTION',{events:result.transactionEvents});
 await source.updateOne({_id:'a'},{$set:{value:999}},{writeConcern:{w:'majority'}});
 await source.updateOne({_id:'a'},{$set:{value:2}},{writeConcern:{w:'majority'}});
 const tamper=await until(e=>e.ns?.coll==='source'&&e.fullDocument?.value===2);
 assert.deepEqual(tamper.filter(e=>e.ns?.coll==='source').map(e=>[e.fullDocumentBeforeChange?.value,e.fullDocument?.value]),[[2,999],[999,2]]);
 pass('CAP_TAMPER_UNDO',{events:tamper.map(simplify)});
 const issued=performance.now();await db.collection('barriers').insertOne({_id:'b0',value:1},{writeConcern:{w:'majority'}});
 const barriers=await until(e=>e.ns?.coll==='barriers'&&e.documentKey?._id==='b0');const b0=barriers.at(-1);
 assert.ok(b0.clusterTime.greaterThan(txEvents[0].clusterTime));
 const prior=commands.length;
 await client.withSession({causalConsistency:true},async session=>{
  session.advanceOperationTime(b0.clusterTime);
  await session.withTransaction(async()=>assert.equal((await source.findOne({_id:'a'},{session})).value,2),{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},readPreference:'primary'});
 });
 const command=commands.slice(prior).find(c=>c.startTransaction);
 assert.equal(command?.readConcern?.level,'snapshot');assert.ok(command.readConcern.afterClusterTime.equals(b0.clusterTime));
 const lastRead=performance.now();await db.collection('barriers').insertOne({_id:'b1',value:2},{writeConcern:{w:'majority'}});
 const after=await until(e=>e.ns?.coll==='barriers'&&e.documentKey?._id==='b1');assert.ok(after.at(-1).clusterTime.greaterThan(b0.clusterTime));
 pass('CAP_CAUSAL_BARRIERS',{issuedBeforeReadMs:lastRead-issued,b0:b0.clusterTime.toString(),b1:after.at(-1).clusterTime.toString(),readConcern:BSON.EJSON.stringify(command.readConcern)});
 const largeBase={_id:'large',value:0,payload:''};
 const payloadSize=hello.maxBsonObjectSize-BSON.calculateObjectSize(largeBase);
 const large={...largeBase,payload:'a'.repeat(payloadSize)};
 assert.equal(BSON.calculateObjectSize(large),hello.maxBsonObjectSize);
 await source.insertOne(large,{writeConcern:{w:'majority'}});
 const insertFrames=await until(e=>e.splitEvent?e.splitEvent.fragment===e.splitEvent.of:e.documentKey?._id==='large');
 const insertAssembler=new ProjectionFragments();let inserted;
 for(const frame of insertFrames){const complete=insertAssembler.feed(frame);if(complete)inserted=complete;}
 assert.equal(inserted.fullDocument.payload.length,payloadSize);
 await source.updateOne({_id:'large'},{$set:{value:1}},{writeConcern:{w:'majority'}});
 const imageFrames=await until(e=>e.splitEvent?e.splitEvent.fragment===e.splitEvent.of:e.documentKey?._id==='large');
 const imageAssembler=new ProjectionFragments();let replaced;
 for(const frame of imageFrames){const complete=imageAssembler.feed(frame);if(complete)replaced=complete;}
 assert.equal(replaced.fullDocumentBeforeChange.payload.length,payloadSize);assert.equal(replaced.fullDocument.payload.length,payloadSize);
 assert.equal(replaced.fullDocumentBeforeChange.payload[0],'a');assert.equal(replaced.fullDocument.payload[0],'a');
 assert.equal(replaced.fullDocumentBeforeChange.value,0);assert.equal(replaced.fullDocument.value,1);
 pass('CAP_MAX_BSON_FULL_IMAGES',{documentBytes:BSON.calculateObjectSize(large),serverMaximumBytes:hello.maxBsonObjectSize,insertFragments:insertFrames.length,updateFragments:imageFrames.length,reconstructedEventBytes:BSON.calculateObjectSize(replaced)});
 await db.command({collMod:'source',changeStreamPreAndPostImages:{enabled:false}});
 await db.collection('barriers').insertOne({_id:'ddl-end',value:3},{writeConcern:{w:'majority'}});
 const ddl=await until(e=>e.ns?.coll==='barriers'&&e.documentKey?._id==='ddl-end');result.ddlEvents=ddl.map(simplify);
 assert.ok(ddl.some(e=>e.operationType==='modify'&&e.ns?.coll==='source'),'Disabling images must be visible');
 pass('CAP_DDL_DISABLE_IMAGES',{events:result.ddlEvents});
 result.status='PASS_CAPABILITY_GATE_ONLY';
}catch(error){result.status='FAIL_CAPABILITY_GATE';result.failure={name:error.name,message:error.message,observed:error.observed};console.error(JSON.stringify(result.failure));process.exitCode=1;
}finally{
 await stream?.close().catch(()=>{});
 try{
  if(created){
   const db=client.db(name);assert.ok(await db.collection('owner').findOne({_id:owner,runId,pid:process.pid}),'Owner mismatch');
   const stats=await db.command({dbStats:1});
   const bytes=stats.storageSize+stats.indexSize;assert.ok(bytes<=inputs.runtime.maxGroupStorageBytes,'Storage quota exceeded');
   await receipt({event:'cleanup-before',dataSize:stats.dataSize,storageSize:stats.storageSize,indexSize:stats.indexSize});
   await db.dropDatabase();
   const remaining=await client.db('admin').command({listDatabases:1,filter:{name},nameOnly:true});assert.equal(remaining.databases.length,0);
   result.cleanup={status:'COMPLETE',databasesRemoved:[name],retained:[],storageBeforeBytes:bytes};
  }else result.cleanup={status:'NO_RESOURCES_CREATED',retained:[]};
  await receipt({event:'cleanup-complete',...result.cleanup});
 }catch(error){result.cleanup={status:'FAIL',message:error.message};process.exitCode=1;await receipt({event:'cleanup-failed',message:error.message});}
 await client.close();result.durationSeconds=(performance.now()-started)/1000;await save();
 await writeFile(resolve(evidence,stem+'RUNS.json'),JSON.stringify([...priorRuns,{command:'node tests/s08-projection/capabilities.mjs',cwd:'Caudelyx/servidor',durationSeconds:result.durationSeconds,result:result.status,exitCode:process.exitCode??0,runId}],null,2)+'\n');
 console.log(JSON.stringify({status:result.status,cleanup:result.cleanup,durationSeconds:result.durationSeconds}));
}
