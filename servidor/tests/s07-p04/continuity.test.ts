import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {appendFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {BSON,type Db} from 'mongodb';
import {s07Profile} from './profile.js';
import {cashSetup,setup,code} from './fixture.js';
import {fundedSetup} from '../operations/fixture.js';
import {Database} from '../../src/shared/database.js';
import {RestoreController} from '../../src/shared/restore.js';
import {head,lendingEvidenceMatches} from '../../src/modules/lending/integrity.js';
import {collectionTables} from '../../src/modules/collections/models.js';
type Data=Record<string,unknown>;
const value=(r:{data:unknown})=>r.data as Data;
const isDenied=(e:unknown)=>e instanceof Error&&'status'in e&&[401,403].includes(Number(e.status));
async function moneyDigest(db:Database){const h=createHash('sha256');for(const name of ['financial_journals','loan_positions','loan_installments','loan_applications','cash_custody','held_funds_reservations','cash_deliveries']){h.update(name);h.update(BSON.EJSON.stringify(await db.db.collection(name).find({}).sort({_id:1}).toArray(),{relaxed:false}));}return h.digest('hex');}
function intercept(db:Db,table:string,method:string,work:(original:(...args:unknown[])=>Promise<unknown>,args:unknown[])=>Promise<unknown>){
 const original=db.collection.bind(db);
 db.collection=((name:string,...opts:unknown[])=>{
  const c=Reflect.apply(original,db,[name,...opts]);return new Proxy(c,{get(target,p){const v=Reflect.get(target,p);if(name===table&&p===method)return(...args:unknown[])=>work((...values)=>Reflect.apply(v,target,values),args);return typeof v==='function'?v.bind(target):v;}});
 }) as typeof db.collection;
 return()=>{db.collection=original;};
}
test('P04 integrated S07 continuity, interrupted HMAC and fixed session clocks',{timeout:1200000},async t=>{
 const group=await s07Profile();
 const scenario=async(name:string,run:()=>Promise<void>)=>{if(!process.env['S07_FOCUS']||name.includes(process.env['S07_FOCUS']!))await t.test(name,run);};
 try{
  await scenario('restore all ten S07 sources, online affected readers and older/current cuts',async()=>{
   const f=await cashSetup(group),journey=value(await f.mutateCollections('openCollectionJourney',{supportReference:'SYN'},undefined,f.c)),jid=String(journey['entityId']);
   await f.mutateCollections('recordCollectionAction',{resourceETag:journey['resourceETag'],loanId:f.l.id,kind:'NOTE',occurredAt:new Date(f.now()).toISOString(),note:'Evidencia interna',supportReference:'SYN',promisedAmount:null,promisedDate:null},jid,f.c);
   const older=await f.restore.snapshot(),id=String(value(await(await f.request()).execute())['entityId']);await f.act('dispatchCashDelivery',id,f.c);await f.act('receiveCashDelivery',id,f.o);await f.count(id);await(await f.confirm(id)).execute();
   const position=(value(await f.readCollections('getCashPosition',f.c.issued.context.subjectId!))['items'] as Data[])[0]!,account=await f.runtime.finance.read(f.a.issued.context,'readAccount',f.org,f.cash.id);
   const close=value(await f.mutateCollections('createCashClose',{accountId:f.cash.id,accountETag:account.etag,subjectId:f.c.issued.context.subjectId,journeyId:jid,observedAt:new Date(f.now()).toISOString(),counted:position['physical'],countStatus:'DECLARED',denominations:[],supersedesCloseId:null,reason:'Conteo de remanente',supportReference:'SYN'},undefined,f.c));
   await f.mutateCollections('finalizeCashClose',{resourceETag:close['resourceETag'],mode:'EXACT',reason:'Exacto con remanente en custodia',supportReference:'SYN'},String(close['entityId']),f.c);
   const snapshot=await f.restore.snapshot(),moneyBefore=await moneyDigest(f.database),peer=new Database(group.uri,f.database.db.databaseName);await peer.connect();
   try{
    for(const name of collectionTables){
     const row=await f.database.db.collection(name).findOne({organizationId:f.org});assert.ok(row,name+' populated');
     await f.database.db.collection(name).updateOne({_id:row!._id},{$set:{S07Tamper:true}});
     const read=async()=>{
      if(name==='collection_books')return await f.readCollections('getCollectionsState');
      if(name==='collection_journeys')return await f.readCollections('getCollectionJourney',String(row!._id));
      if(name==='collection_actions')return await f.readCollections('getCollectionAction',String(row!._id));
      if(name==='cash_stations')return await f.readCollections('getCashStation',String(row!._id));
      if(name==='cash_deliveries')return await f.readCollections('getCashDelivery',String(row!._id));
      if(name==='cash_delivery_facts')return await f.readCollections('listCashDeliveryFacts',String(row!['deliveryId']));
      if(name==='cash_delivery_allocations')return await f.readCollections('getCashPosition',f.c.issued.context.subjectId!);
      if(name==='cash_close_records')return await f.readCollections('getCashClose',String(row!._id));
      const command=name==='collection_commands'?row:await f.database.db.collection('collection_commands').findOne({_id:row!._id});
      return await f.readCollections('getCollectionCommand',String(command!['key']));
     };
     await assert.rejects(read(),code('INTEGRITY_MISMATCH'));
     const closed=new RestoreController(peer,join(group.folder,'gate.json'),f.keys.journal,(f.keys as unknown as {priority:Buffer}).priority);await closed.initialize();assert.equal(closed.isOpen(),false,name);
     await assert.rejects(closed.reconcile({approved:true,reviewId:'SYN-tamper-'+name}));
     await f.database.db.collection(name).replaceOne({_id:row!._id},row!);
     await closed.reconcile({approved:true,reviewId:'SYN-reverted-'+name});assert.equal(closed.isOpen(),true,name);
    }
    assert.equal(await moneyDigest(f.database),moneyBefore);
    const restored=new RestoreController(peer,join(group.folder,'gate.json'),f.keys.journal,(f.keys as unknown as {priority:Buffer}).priority);await restored.initialize();
    await restored.beginRestore(older);await assert.rejects(restored.reconcile({approved:true,reviewId:'SYN-older-cut'}));assert.equal(restored.isOpen(),false);
    await restored.beginRestore(snapshot);await restored.reconcile({approved:true,reviewId:'SYN-current-cut'});assert.equal(restored.isOpen(),true);assert.equal(await moneyDigest(f.database),moneyBefore);
   }finally{await peer.close();}
  });
  for(const boundary of ['before_nodes','mid_nodes','before_checkpoint','before_external_flush','before_open']){
   await scenario('HMAC '+boundary+' rollback, reviewed reopen and key guards',async()=>{
    const f=await fundedSetup({...group,fixture:()=>group.fixture({legacy:true})}),l=await f.loan();await f.disburse(l);await f.restore.flush();const before=await moneyDigest(f.database),oldHead=await head(f.database);
    const peer=new Database(group.uri,f.database.db.databaseName);await peer.connect();const key=randomBytes(32),attempt=new RestoreController(peer,join(group.folder,'gate.json'),f.keys.journal,key);let hit=false,undo=()=>{};
    if(['before_nodes','mid_nodes'].includes(boundary))undo=intercept(peer.db,'lending_merkle_nodes','bulkWrite',async(original,args)=>{if(boundary==='mid_nodes'){const operations=args[0] as unknown[];await original(operations.slice(0,Math.max(1,Math.floor(operations.length/2))),args[1]);}hit=true;throw Error('HMAC_INJECT_'+boundary);});
    else if(boundary==='before_checkpoint')undo=intercept(peer.db,'lending_priority_checkpoint','insertOne',async()=>{hit=true;throw Error('HMAC_INJECT_'+boundary);});
    else if(boundary==='before_external_flush')undo=intercept(Reflect.get(attempt,'external') as Db,'events','insertOne',async()=>{hit=true;throw Error('HMAC_INJECT_'+boundary);});
    else{const original=Reflect.get(attempt,'writeGate').bind(attempt);Reflect.set(attempt,'writeGate',(gate:{open:boolean})=>{if(gate.open){hit=true;throw Error('HMAC_INJECT_'+boundary);}original(gate);});}
    try{
     await assert.rejects(attempt.initialize());assert.equal(hit,true,boundary);assert.equal(attempt.isOpen(),false);undo();assert.equal(await moneyDigest(peer),before);
     if(['before_nodes','mid_nodes','before_checkpoint'].includes(boundary))assert.equal((await head(peer))?.digest,oldHead?.digest);
     if(boundary==='before_external_flush'){
      const queued=await peer.db.collection('security_evidence_outbox').findOne({},{sort:{_id:-1}});assert.ok(queued);
      const audit=await peer.db.collection('audit_events').findOne({eventId:queued!['eventId']});assert.ok(audit);
      await peer.db.collection('audit_events').updateOne({_id:audit!._id},{$set:{action:'UNRELATED_PENDING_EVENT'}});
      const wrongAction=new RestoreController(peer,join(group.folder,'gate.json'),f.keys.journal,key);await wrongAction.initialize();await assert.rejects(wrongAction.reconcile({approved:true,reviewId:'SYN-unrelated-pending'}));assert.equal(wrongAction.isOpen(),false);
      await peer.db.collection('audit_events').replaceOne({_id:audit!._id},audit!);
      await peer.db.collection('security_evidence_outbox').updateOne({_id:queued!._id},{$set:{'state.lending.digest':'0'.repeat(64)}});
      const wrongState=new RestoreController(peer,join(group.folder,'gate.json'),f.keys.journal,key);await wrongState.initialize();await assert.rejects(wrongState.reconcile({approved:true,reviewId:'SYN-altered-pending-state'}));assert.equal(wrongState.isOpen(),false);
      await peer.db.collection('security_evidence_outbox').replaceOne({_id:queued!._id},queued!);assert.equal(await moneyDigest(peer),before);
     }
     const reviewed=new RestoreController(peer,join(group.folder,'gate.json'),f.keys.journal,key);await reviewed.initialize();assert.equal(reviewed.isOpen(),false);
     await reviewed.reconcile({approved:true,reviewId:'SYN-review-'+boundary});assert.equal(reviewed.isOpen(),true);assert.equal(await moneyDigest(peer),before);
     const h=await peer.db.collection('lending_domain_state').findOne({_id:'evidence' as never});assert.equal(h!['priorityPolicy'],'HMAC-SHA256-v1');assert.equal(h!['priorityKeyId'],createHash('sha256').update(key).digest('hex'));assert.equal(await lendingEvidenceMatches(peer,await head(peer)??undefined),true);
     const restarted=new RestoreController(peer,join(group.folder,'gate.json'),f.keys.journal,key);await restarted.initialize();assert.equal(restarted.isOpen(),true);assert.equal((await head(peer))?.digest,h!['digest']);
     if(boundary==='before_open'){
      for(const priority of [undefined,randomBytes(32)]){
       const badDb=new Database(group.uri,f.database.db.databaseName);await badDb.connect();try{const bad=new RestoreController(badDb,join(group.folder,'gate.json'),f.keys.journal,priority);await bad.initialize();assert.equal(bad.isOpen(),false);await assert.rejects(bad.reconcile({approved:true,reviewId:'SYN-wrong-key'}));}finally{await badDb.close();}
      }
      const recover=new RestoreController(peer,join(group.folder,'gate.json'),f.keys.journal,key);await recover.initialize();await recover.reconcile({approved:true,reviewId:'SYN-right-key'});assert.equal(recover.isOpen(),true);
     }
    }finally{undo();await peer.close();}
   });
  }
  await scenario('HMAC actual own child dies after flush before open; next review verifies active policy',async()=>{
   const f=await fundedSetup({...group,fixture:()=>group.fixture({legacy:true})}),l=await f.loan();await f.disburse(l);await f.restore.flush();const before=await moneyDigest(f.database),priority=randomBytes(32);
   const log=resolve('../../Construccion/Sprints/S07/Evidencias/S07-P04-RESOURCES.jsonl'),receipt=async(event:string,data:Data={})=>await appendFile(log,JSON.stringify({at:new Date().toISOString(),task:'S07-P04',event,runId:group.runId,groupId:'f7b2026a15c64d42a01c7c86',...data})+'\n');
   const release=group.hold();await receipt('crash-peer-reserved',{path:fileURLToPath(new URL('./worker.js',import.meta.url))});
   const child=spawn(process.execPath,[fileURLToPath(new URL('./worker.js',import.meta.url))],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});const exited=once(child,'exit');child.stderr?.resume();await receipt('crash-peer-created',{pid:child.pid,spawnfile:child.spawnfile,args:child.spawnargs});
   try{
    const reached=new Promise<void>((resolveReached,reject)=>{const timeout=setTimeout(()=>reject(Error('Own child boundary timeout')),45000);child.on('message',(m:Data)=>{if(m['type']==='migration-before-open'){clearTimeout(timeout);resolveReached();}});child.once('error',reject);});
    const keys=Object.fromEntries(Object.entries({...f.keys,priority}).filter(([,v])=>Buffer.isBuffer(v)).map(([k,v])=>[k,(v as Buffer).toString('base64')]));
    child.send({type:'initialize',uri:group.uri,name:f.database.db.databaseName,folder:group.folder,keys,config:f.config,now:f.now(),pauseBeforeOpen:true});await reached;
    await receipt('crash-peer-before-stop',{pid:child.pid,spawnfile:child.spawnfile,args:child.spawnargs,exitCode:child.exitCode,connected:child.connected,ownLiveHandle:true});child.kill();await exited;
    const peer=new Database(group.uri,f.database.db.databaseName);await peer.connect();try{const recovered=new RestoreController(peer,join(group.folder,'gate.json'),f.keys.journal,priority);await recovered.initialize();assert.equal(recovered.isOpen(),false);await recovered.reconcile({approved:true,reviewId:'SYN-after-own-process-death'});assert.equal(recovered.isOpen(),true);assert.equal(await moneyDigest(peer),before);}finally{await peer.close();}
   }finally{if(child.exitCode===null&&!child.killed){child.kill();await exited;}release();await receipt('crash-peer-stopped',{pid:child.pid,exitCode:child.exitCode});}
  });
  await scenario('sessions one-shot five minutes, one-use and fixed sixty-minute grant',async()=>{
   const f=await cashSetup(group),id=String(value(await(await f.request()).execute())['entityId']);await f.act('dispatchCashDelivery',id,f.c);await f.act('receiveCashDelivery',id,f.o);await f.count(id);
   const ctx=(await f.sessions.contexts.findOne({_id:f.a.issued.context._id}))!,expires=ctx.balanceGrant!.expiresAt;
   const https=await f.https(),clients=[];
   for(const actor of [f.a,f.c,f.o]){const c=new (await import('../helpers/client.js')).ApiClient(https.port,https.cert);c.cookies.set('__Host-caudelyx-session',actor.issued.token);await c.refreshCsrf();clients.push(c);}
   f.clock.value=expires-60000;for(const c of clients)assert.equal((await c.call('POST','/api/v1/auth/session/activity',{})).status,200);
   assert.equal((await f.sessions.contexts.findOne({_id:ctx._id}))!.balanceGrant!.expiresAt,expires);await(await f.confirm(id)).execute();
   f.clock.value=expires+1;
   const second=String(value(await(await f.request('50000.00')).execute())['entityId']);await f.act('dispatchCashDelivery',second,f.c);await f.act('receiveCashDelivery',second,f.o);await f.count(second,'50000.00');const pending=await f.confirm(second);
   await assert.rejects(f.collections.mutate(f.a.issued.context,pending.operation,f.org,pending.payload,pending.key,pending.etag,second),isDenied);
   const station=await f.readCollections('getCashStation',f.stationId),receiver=await f.identity.identities.findOne({_id:f.o.issued.context.subjectId!}),account=await f.runtime.finance.read(f.a.issued.context,'readAccount',f.org,f.central.id);
   const payload={stationId:f.stationId,resourceETag:station.etag,accountId:f.central.id,accountETag:account.etag,receiverId:receiver!._id,receiverETag:receiver!.version,active:true,supportReference:'SYN-five-minute'};
   const key=(await import('node:crypto')).randomUUID(),state=await f.collectionsState(),command={organizationId:f.org,idempotencyKey:key,expectedETag:state.collectionsBookETag,operationId:'setCashStation',resourceId:null,payload};
   await f.proof(f.a,'CASH_STATION_SET',command);let proof=(await f.sessions.contexts.findOne({_id:ctx._id}))!.reauth!;f.clock.value=proof.expiresAt;
   await assert.rejects(f.collections.mutate(f.a.issued.context,'setCashStation',f.org,payload,key,state.collectionsBookETag),isDenied);
   await f.proof(f.a,'CASH_STATION_SET',command);proof=(await f.sessions.contexts.findOne({_id:ctx._id}))!.reauth!;f.clock.value=proof.expiresAt-1;
   assert.equal((await f.collections.mutate(f.a.issued.context,'setCashStation',f.org,payload,key,state.collectionsBookETag)).status,201);
   await assert.rejects(f.collections.mutate(f.a.issued.context,'setCashStation',f.org,payload,key,state.collectionsBookETag),isDenied);
  });
  await scenario('sessions absolute twelve hours with real activity route and no product TTL change',async()=>{
   const f=await setup(group),https=await f.https(),client=https.client;client.cookies.set('__Host-caudelyx-session',f.a.issued.token);await client.refreshCsrf();
   const ctx=(await f.sessions.contexts.findOne({_id:f.a.issued.context._id}))!;
   while(f.now()+59*60000<ctx.expiresAt){f.clock.value+=59*60000;assert.equal((await client.call('POST','/api/v1/auth/session/activity',{})).status,200);}
   f.clock.value=ctx.expiresAt-1;assert.equal((await client.call('POST','/api/v1/auth/session/activity',{})).status,200);assert.equal((await client.call('GET','/api/v1/organizations/'+f.org+'/collections/state')).status,200);
   assert.equal((await f.sessions.contexts.findOne({_id:ctx._id}))!.expiresAt,ctx.expiresAt);
   f.clock.value=ctx.expiresAt;assert.equal((await client.call('GET','/api/v1/organizations/'+f.org+'/collections/state')).status,401);
  });
 }finally{await group.dispose();}
});
