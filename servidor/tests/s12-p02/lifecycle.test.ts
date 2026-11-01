/* eslint-disable security/detect-non-literal-fs-filename -- Read-only paths enumerated by the pinned P01 manifest and three exact historical artifacts; no historical writes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {s12Profile,world,password} from './fixture.js';
import {definition} from './oracle.js';
import {today} from '../../src/modules/obligations/calendar.js';
import {hash} from '../../src/modules/simulation/codec.js';
import {simulationHead,simulationEvidenceMatches,protectedTables} from '../../src/modules/simulation/evidence.js';
import {tables,type Data,type Row} from '../../src/modules/simulation/models.js';
import {reconstructSecurityState} from '../../src/shared/evidence.js';
const code=(c:string)=>(e:unknown)=>e instanceof Error&&'code'in e&&e.code===c;
test('S12 lifecycle: atomic failure, exact replay/CAS, cold peer, stale/retention and hot corruption latch',{timeout:360000},async t=>{
 const group=await s12Profile();
 const p01=JSON.parse(await readFile('../../Construccion/Sprints/S12/Evidencias/S12-P01-HASHES.json','utf8')) as {files:Record<string,unknown>},protectedNames=[...Object.keys(p01.files),'Construccion/Sprints/S11/Evidencias/S11-P04-RUNS.json','Construccion/Sprints/S11/Evidencias/S11-P04-VERIFY.json','Caudelyx/servidor/dist-s11-p04/src/app.js'];
 const inventory=async()=>await Promise.all(protectedNames.map(async name=>{const file=resolve('../..',name),s=await stat(file);return[name,createHash('sha256').update(await readFile(file)).digest('hex'),s.size,s.mtimeMs];})),sealedBefore=await inventory();
 try{
  const receipt=resolve('../../Construccion/Sprints/S12/Evidencias/S12-P02-RESOURCES.jsonl'),receiptBefore=await readFile(receipt),stamp=(await stat(receipt)).mtimeMs,oldPrefix=process.env['S12_EVIDENCE_PREFIX'];process.env['S12_EVIDENCE_PREFIX']='S11-P04';
  try{await assert.rejects(()=>import(new URL('./fixture.js?invalid-output-before-receipt',import.meta.url).href),/Invalid independent evidence namespace/);}finally{if(oldPrefix===undefined)delete process.env['S12_EVIDENCE_PREFIX'];else process.env['S12_EVIDENCE_PREFIX']=oldPrefix;}
  assert.deepEqual(await readFile(receipt),receiptBefore);assert.equal((await stat(receipt)).mtimeMs,stamp);
  await assert.rejects(()=>group.fixture({failSetup:true}),/Injected own partial setup failure/);assert.deepEqual(await inventory(),sealedBefore);
  const f=await world(group),service=f.runtime.simulation,params={organizationId:f.org},call=async(op:string,input:Data={},ps:Record<string,string>=params,key:string=randomUUID(),etag?:string)=>await service.execute(f.a.issued.context,op,input,ps,{},key,etag);
  await f.restore.flush();
  const legacyState=reconstructSecurityState(await f.restore.fileJournal.readVerified());
  assert.equal(Object.hasOwn(legacyState,'simulation'),false,'legacy evidence shape has no synthetic S12 field');
  const captured=await call('captureBaseBusinessSimulation',{asOf:today(f.now()),currency:'COP'}),d={...definition(),baseId:captured.data['id'],baseToken:captured.data['baseToken']},input={name:'Escenario privado de ciclo',...d},key=randomUUID();
  const result=await call('createScenarioBusinessSimulation',input,params,key),id=String(result.data['id']),sp={...params,scenarioId:id};
  const replay=await call('createScenarioBusinessSimulation',input,params,key);assert.equal(replay.status,200);assert.deepEqual(replay.data,result.data);
  await assert.rejects(()=>call('createScenarioBusinessSimulation',{...input,name:'Distinto'},params,key),code('IDEMPOTENCY_CONFLICT'));
  await t.test('audit/evidence failure rolls back all technical headers, chunks, rate and command rows',async()=>{
   const names=[...tables,'s12_projection_heads','s12_projection_manifests','audit_events','outbox','security_sequence','security_evidence_outbox'],state=async()=>hash(await Promise.all(names.map(async n=>[n,await f.database.db.collection(n).find({}).sort({_id:1}).toArray()]))),before=await state(),append=f.identity.audit.append.bind(f.identity.audit);
   f.identity.audit.append=async(...args)=>{await append(...args);if(args[0].action==='SIMULATION_TECHNICAL_STATE_COMMITTED')throw Error('SYN_S12_AUDIT_ROLLBACK');};
   try{await assert.rejects(()=>call('createScenarioBusinessSimulation',{...input,name:'Rollback'}),/SYN_S12_AUDIT_ROLLBACK/);}finally{f.identity.audit.append=append;}
   assert.equal(await state(),before);
  });
  await t.test('cold second process reads exact private scenario and verifies native+S12 roots',async()=>{
   await f.restore.flush();const peer=await group.peer({keys:f.keys,now:f.now(),enableBusiness:true,enableSimulation:true});
   try{
    const r=await peer.execute({operation:'getScenarioBusinessSimulation',params:sp,token:f.a.issued.token});assert.equal(r['type'],'result',JSON.stringify(r));assert.deepEqual(r['data'],result.data);
    const race=await Promise.allSettled([
     call('createVersionBusinessSimulation',d,sp,randomUUID(),result.etag),
     peer.execute({operation:'createVersionBusinessSimulation',params:sp,payload:d,key:randomUUID(),expected:result.etag,token:f.a.issued.token})
    ]);
    const outcomes=race.map(r=>r.status==='fulfilled'?r.value:{code:(r.reason as {code:string}).code});
    assert.equal(outcomes.filter(r=>'status'in r&&r.status===201).length,1,JSON.stringify(outcomes));
    assert.equal(outcomes.filter(r=>'code'in r&&r.code==='PRECONDITION_FAILED').length,1,JSON.stringify(outcomes));
   }finally{await peer.close();}
   assert.equal(await simulationEvidenceMatches(f.database,await simulationHead(f.database)),true);
  });
  await t.test('versions are immutable, stale CAS/token fail, archive preserves prior version',async()=>{
   await assert.rejects(()=>call('createVersionBusinessSimulation',d,sp,randomUUID(),'"stale:1"'),code('PRECONDITION_FAILED'));
   const current=await call('getScenarioBusinessSimulation',{},sp),archived=await call('archiveScenarioBusinessSimulation',{},sp,randomUUID(),current.etag);assert.equal(archived.data['status'],'ARCHIVED');
   const version=await call('getVersionBusinessSimulation',{}, {...sp,versionNumber:'1'});assert.equal(version.data['baseId'],captured.data['id']);
   f.clock.value+=300001;await assert.rejects(()=>call('createScenarioBusinessSimulation',input),code('BASE_STALE'));
  });
  await t.test('authenticated retention scrubs payload and leaves only tombstone hashes',async()=>{
   f.clock.value+=86400001;await service.reconcile();f.a.issued=(await f.identity.login('TENANT',randomUUID(),f.a.email,password)).issued;
   await assert.rejects(()=>call('getBaseBusinessSimulation',{}, {...params,baseId:String(captured.data['id'])}),code('RESOURCE_EXPIRED'));
   const r=await f.database.db.collection<Row>('s12_bases').findOne({_id:String(captured.data['id'])});assert.ok(r);assert.equal(r['tombstone'],true);assert.equal(r['chunks'],undefined);assert.equal(r['baseToken'],undefined);assert.equal(await f.database.db.collection('s12_payload_chunks').countDocuments({parent:captured.data['id']}),0);
   await assert.rejects(()=>call('createScenarioBusinessSimulation',{...input,name:'Expired key must not create again'},params,key),code('RESOURCE_EXPIRED'));
   assert.equal(await simulationEvidenceMatches(f.database,await simulationHead(f.database)),true);
  });
  await t.test('hot signed-row tamper followed by undo stays unavailable and cannot be resealed',async()=>{
   const row=await f.database.db.collection<Row>('s12_scenarios').findOne({_id:id});assert.ok(row);
   await f.database.db.collection<Row>('s12_scenarios').updateOne({_id:id},{$set:{name:'SYN_UNMANIFESTED'}});
   await f.database.db.collection<Row>('s12_scenarios').replaceOne({_id:id},row);
   await assert.rejects(()=>call('getScenarioBusinessSimulation',{},sp));
   for(let i=0;i<50&&service.store.active;i++)await new Promise<void>(r=>setTimeout(r,20));
   assert.equal(service.store.active,false);assert.equal(await simulationEvidenceMatches(f.database,await simulationHead(f.database)),false);
  });
  // One group is reset only after a latched failure, never adopted/repaired.
  // Each reset is receipted and cannot carry the preceding corrupted controls.
  for(const variant of ['missing-payload','missing-table','bad-global-mac','rollback','bad-key','economic-source'] as const)await t.test('cold '+variant+' refuses initialized data without resealing',{timeout:80000},async()=>{
   const z=await world(group),sim=z.runtime.simulation,ps={organizationId:z.org},c=await sim.execute(z.a.issued.context,'captureBaseBusinessSimulation',{asOf:today(z.now()),currency:'COP'},ps,{},randomUUID());
   const snapshots=new Map<string,import('mongodb').Document[]>();if(variant==='rollback')for(const name of protectedTables.filter(n=>!n.endsWith('barriers')))snapshots.set(name,await z.database.db.collection(name).find({}).toArray());
   if(variant==='rollback')await sim.execute(z.a.issued.context,'createScenarioBusinessSimulation',{name:'Posterior al corte',...definition(),baseId:c.data['id'],baseToken:c.data['baseToken']},ps,{},randomUUID());
   await z.restore.flush();await z.database.projectionShutdown?.();
   if(variant==='missing-payload'){const row=await z.database.db.collection('s12_payload_chunks').findOne({parent:c.data['id']});assert.ok(row);await z.database.db.collection('s12_payload_chunks').deleteOne({_id:row._id});}
   if(variant==='missing-table')await z.database.db.collection('s12_payload_chunks').drop();
   if(variant==='bad-global-mac')await z.database.db.collection<Row>('s12_projection_heads').updateOne({_id:'GLOBAL'},{$set:{mac:'0'.repeat(64)}});
   if(variant==='rollback')for(const[name,rows]of snapshots){await z.database.db.collection(name).deleteMany({});if(rows.length)await z.database.db.collection(name).insertMany(rows);}
   if(variant==='economic-source')await z.database.db.collection('financial_journals').updateOne({organizationId:z.org},{$set:{supportReference:'SYN_CORRUPT_UNAUTHENTICATED'}});
   const names=protectedTables.filter(n=>!n.endsWith('barriers')),state=async()=>hash(await Promise.all(names.map(async n=>[n,await z.database.db.collection(n).find({}).sort({_id:1}).toArray()]))),badBefore=await state();
   await assert.rejects(()=>group.peer({keys:variant==='bad-key'?{...z.keys,cursor:randomBytes(32)}:z.keys,now:z.now(),enableBusiness:true,enableSimulation:true}),/RESTORE|closed|INTEGRITY|SERVICE/);
   assert.equal(await state(),badBefore,'cold refusal does not repair/re-sign S12 data');
   if(variant==='missing-table')assert.equal((await z.database.db.listCollections({name:'s12_payload_chunks'}).toArray()).length,0);
  });
 }finally{await group.dispose();assert.deepEqual(await inventory(),sealedBefore,'H01 actual fixture success/failure and all child paths preserve sealed bytes/mtime');}
});
