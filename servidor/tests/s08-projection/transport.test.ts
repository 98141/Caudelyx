import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {appendFile} from 'node:fs/promises';
import {MongoClient} from 'mongodb';
import {Database} from '../../src/shared/database.js';
import {ProjectionStore,type ProjectionHead,type ManifestHeader} from '../../src/modules/reporting/projection/store.js';
import {ProjectionObserver} from '../../src/modules/reporting/projection/observer.js';
import {collections} from '../../src/modules/reporting/projection/catalog.js';
import {hash} from '../../src/modules/reporting/projection/codec.js';

test('owned Mongo transport: exact manifest, concurrent writers, atomic abort and hot tamper',{timeout:30000},async()=>{
  const runId=randomBytes(12).toString('hex'),name='caudelyx_s08_projection_test_'+runId;
  const uri='mongodb://127.0.0.1:27017/?replicaSet=rs0';
  const receipt=async(data:Record<string,unknown>)=>appendFile('../../Construccion/Sprints/S08/Evidencias/S08-P02-PROJECTION-RESOURCES.jsonl',JSON.stringify({atUTC:new Date().toISOString(),runId,database:name,...data})+'\n');
  await receipt({event:'reserved-before-connect',ownerPid:process.pid,databases:[name],companions:[],controls:[],budgetBytes:4294967296});
  const control=new MongoClient(uri,{appName:'S08_PROJECTION_TRANSPORT_CONTROL',serverSelectionTimeoutMS:3000});
  const database=new Database(uri,name,{monitorCommands:true}),store=new ProjectionStore(database,Buffer.alloc(32,19));
  let created=false,observer:ProjectionObserver|undefined,failPublication=false;
  try{
    await control.connect();
    const listed=await control.db('admin').command({listDatabases:1,filter:{name},nameOnly:true});assert.equal(listed.databases.length,0);
    await control.db(name).collection<{_id:string}>('owner').insertOne({_id:runId});created=true;
    await database.connect();
    for(const collection of ['loan_positions',...Object.values(collections)])await database.db.createCollection(collection,{changeStreamPreAndPostImages:{enabled:true}});
    await database.db.collection(collections.barriers).createIndex({expiresAt:1},{expireAfterSeconds:0});
    const raw=control.db(name).collection<{_id:string;organizationId:string;value:number}>('loan_positions');
    const baseline=async()=>{
      const rows=await raw.find({organizationId:'org'}).sort({_id:1}).toArray();
      const head=await database.db.collection<ProjectionHead>(collections.heads).findOne({_id:'org'});
      assert.equal(head?.sourceVector??hash([]),hash(rows));
    };
    store.install(async(session,changes)=>{
      if(failPublication)throw new Error('INJECTED_PUBLICATION_FAILURE');
      const heads=[];
      for(const org of changes.organizations){
        const old=await database.db.collection<ProjectionHead>(collections.heads).findOne({_id:org},{session});
        const rows=await database.db.collection<{_id:string;organizationId:string;value:number}>('loan_positions').find({organizationId:org},{session}).sort({_id:1}).toArray();
        heads.push({_id:org,organizationId:org,generation:'fixture-generation',materialRevision:(old?.materialRevision??0)+1,
          formatVersion:1 as const,restoreEpoch:'fixture-epoch',sourceVector:hash(rows),knowledgeMax:'2026-10-27T00:00:00.000Z',economicMax:'2026-10-27',roots:{units:{hash:hash([]),count:0}}});
      }
      return heads;
    });
    observer=new ProjectionObserver(database.db,store.codec,'fixture-epoch');await observer.start(baseline);
    const tracked=database.db.collection<{_id:string;organizationId:string;value:number}>('loan_positions');
    await database.transaction(async session=>{
      await tracked.insertOne({_id:'a',organizationId:'org',value:0},{session});
      await tracked.updateOne({_id:'a'},{$set:{value:1}},{session});
      await tracked.updateOne({_id:'a'},{$set:{value:2}},{session});
    });
    const barrier=await observer.barrierAfter(performance.now(),performance.now()+5000);observer.assertCertified(barrier);
    assert.equal(observer.ready,true);
    assert.equal(await database.db.collection(collections.manifests).countDocuments({kind:'HEADER'}),1);
    failPublication=true;
    await assert.rejects(database.transaction(async session=>tracked.updateOne({_id:'a'},{$set:{value:9}},{session})),/INJECTED_PUBLICATION_FAILURE/);
    failPublication=false;
    assert.equal((await raw.findOne({_id:'a'}))!.value,2);
    await Promise.all([1,2].map(()=>database.transaction(async session=>tracked.updateOne({_id:'a'},{$inc:{value:1}},{session}))));
    observer.assertCertified(await observer.barrierAfter(performance.now(),performance.now()+5000));
    assert.equal((await raw.findOne({_id:'a'}))!.value,4);
    assert.equal(await database.db.collection(collections.manifests).countDocuments({kind:'HEADER'}),3);
    await database.transaction(async session=>tracked.findOneAndUpdate({_id:'upsert',organizationId:'org',value:0},{$set:{value:1}},{upsert:true,session}));
    observer.assertCertified(await observer.barrierAfter(performance.now(),performance.now()+5000));
    assert.equal((await raw.findOne({_id:'upsert'}))!.value,1);
    const publish=database.projectionPublisher!;
    database.projectionPublisher=async(session,changes)=>{await publish(session,changes);throw new Error('INJECTED_AFTER_HEAD');};
    await assert.rejects(database.transaction(async session=>tracked.updateOne({_id:'a'},{$inc:{value:100}},{session})),/INJECTED_AFTER_HEAD/);
    database.projectionPublisher=publish;
    assert.equal((await raw.findOne({_id:'a'}))!.value,4);
    assert.equal(await database.db.collection(collections.manifests).countDocuments({kind:'HEADER'}),4);
    await database.transaction(async session=>tracked.insertMany(Array.from({length:600},(_,i)=>({_id:'batch-'+i,organizationId:'org',value:0})),{session}));
    observer.assertCertified(await observer.barrierAfter(performance.now(),performance.now()+5000));
    const currentHead=await database.db.collection<ProjectionHead>(collections.heads).findOne({_id:'org'});
    const header=await database.db.collection<ManifestHeader>(collections.manifests).findOne({_id:currentHead!.lastManifest});
    assert.equal(header!['chunkHashes'].length,2);assert.equal(header!['mutationCount'],600);
    const getMoreCommands:{maxTimeMS:unknown}[]=[];
    database.client.on('commandStarted',event=>{
      if(event.commandName==='getMore'&&event.command['collection']==='loan_positions')getMoreCommands.push({maxTimeMS:event.command['maxTimeMS']});
    });
    await database.client.withSession(async session=>session.withTransaction(async()=>{
      const context=Reflect.get(session,'timeoutContext');assert.ok(context);
      const rows=await tracked.find({organizationId:'org'},{session}).batchSize(2).toArray();
      assert.equal(rows.length,602);assert.equal(Reflect.get(session,'timeoutContext'),context);
    },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'},timeoutMS:10000}));
    assert.ok(getMoreCommands.length>1);assert.ok(getMoreCommands.every(command=>command.maxTimeMS===undefined));
    await assert.rejects(database.transaction(async session=>tracked.findOneAndUpdate({organizationId:'unknown',value:0},{$set:{value:1}},{upsert:true,session})),
      (error:unknown)=>error instanceof Error&&'status' in error&&error.status===503);
    assert.equal(await raw.countDocuments({organizationId:'unknown'}),0);
    await raw.updateOne({_id:'a'},{$set:{value:999}});await raw.updateOne({_id:'a'},{$set:{value:4}});
    await assert.rejects(observer.barrierAfter(performance.now(),performance.now()+5000));
    assert.equal(observer.ready,false);assert.equal((await raw.findOne({_id:'a'}))!.value,4);
    process.stdout.write('TRANSPORT_PROOF '+JSON.stringify({manifestTransactions:5,publicationAbortBeforeAndAfterHead:true,concurrentUpdates:2,upsertChangingPredicateCaptured:true,unknownUpsertBlockedBeforeWrite:true,chunkBoundary600Into2:true,multiBatchSingleDeadline:true,getMoreCommands:getMoreCommands.length,tamperUndoDetected:true,observerFailure:observer.failureReason})+'\n');
  }finally{
    store.uninstall();await observer?.stop();await database.close();
    try{
      if(created){
        assert.ok(await control.db(name).collection<{_id:string}>('owner').findOne({_id:runId}));
        const stats=await control.db(name).command({dbStats:1});assert.ok(stats.storageSize+stats.indexSize<4294967296);
        await receipt({event:'cleanup-before',dataSize:stats.dataSize,storageSize:stats.storageSize,indexSize:stats.indexSize});
        await control.db(name).dropDatabase();
        const left=await control.db('admin').command({listDatabases:1,filter:{name},nameOnly:true});assert.equal(left.databases.length,0);
        await receipt({event:'cleanup-complete',retained:[],databasesRemoved:[name]});
      }else await receipt({event:'cleanup-complete',resourcesCreated:0,retained:[]});
    }finally{await control.close();}
  }
});
