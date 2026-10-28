/* eslint-disable security/detect-object-injection -- Fixed synthetic response keys. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {s08Profile,password} from './profile.js';
import {activate} from './fixture.js';
import {cashSetup,setup,code} from '../s07/fixture.js';
import {ProjectionRuntime} from '../../src/modules/reporting/projection/service.js';
import {today} from '../../src/modules/finance/service.js';
import {originals,collections} from '../../src/modules/reporting/projection/catalog.js';
import {hash} from '../../src/modules/reporting/projection/codec.js';
import type {ProjectionHead,ManifestChunk} from '../../src/modules/reporting/projection/store.js';
import type {Data} from '../../src/modules/reporting/models.js';
const metric=(data:Data,id:string,scope='organizationMetrics')=>(data[scope] as Data[]).find(row=>row['id']===id)?.['value'];

async function projectedCase(group:Awaited<ReturnType<typeof s08Profile>>){
  let projection:ProjectionRuntime|undefined;const release=group.hold();
  try{
    const f=await cashSetup(group),web=await f.https(),base='/api/v1/organizations/'+f.org+'/reporting';
    web.client.cookies.set('__Host-caudelyx-session',f.a.issued.token);
    const query='?from=2026-10-01&to='+today(f.now())+'&asOf='+today(f.now());
    const before=await web.client.call('GET',base+'/dashboard'+query);
    if(before.status!==200){
      try{await f.identity.reporting!.read(f.a.issued.context,'getReportingDashboard',f.org,undefined,{from:'2026-10-01',to:today(f.now()),asOf:today(f.now())});}
      catch(error){process.stdout.write('PROJECTED_READ_FAILURE '+String(error)+'\n');}
    }
    assert.equal(before.status,200,JSON.stringify(before.body));
    const ownership=async()=>{
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Exact live owned fixture control path, checked by the harness.
      const owner=JSON.parse(await readFile(join(group.folder,'owner.json'),'utf8'));
      return owner.runId===group.runId&&owner.pid===process.pid&&owner.names[0]===f.database.db.databaseName&&group.names[0]===f.database.db.databaseName;
    };
    projection=await ProjectionRuntime.createOwned(f.identity,f.keys.cursor,ownership);
    f.identity.reporting!.projection=projection;
    const current=await web.client.call('GET',base+'/dashboard'+query);assert.equal(current.status,200,JSON.stringify(current.body));
    const actual=current.body.data!,expected=before.body.data!;
    assert.deepEqual(actual['organizationMetrics'],expected['organizationMetrics']);
    assert.deepEqual((actual['meta'] as Data)['coverage'],(expected['meta'] as Data)['coverage']);
    assert.equal(metric(actual,'PRINCIPAL_OUTSTANDING'),'1760000.00');
    assert.equal(metric(actual,'INTEREST_RECEIVED'),'60000.00');assert.equal(metric(actual,'PRINCIPAL_RECOVERED'),'240000.00');
    const token=encodeURIComponent(String((actual['meta'] as Data)['snapshotToken']));
    for(const report of ['PORTFOLIO','INSTALLMENTS','MOVEMENTS','CASH','RECONCILIATION','COLLECTORS','CONCENTRATION']){
      const page=await web.client.call('GET',base+'/reports/'+report+'?snapshotToken='+token+'&limit=20');assert.equal(page.status,200,report+JSON.stringify(page.body));
      if(report==='MOVEMENTS'){const funded=(page.body.data!['items'] as Data[]).find(row=>row['nature']==='DISBURSE')!;assert.equal(funded['amount'],'2000000.00');assert.equal(funded['principal'],'2000000.00');}
    }
    const domainHash=async()=>{
      const rows=[];
      for(const name of [...originals,...Object.values(collections).filter(name=>name!==collections.barriers),'audit_events','outbox','transaction_fence','security_sequence','security_evidence_outbox','security_evidence_projection','contexts','identities','organizations'])rows.push([name,await f.database.db.collection(name).find({}).sort({_id:1}).toArray()]);
      return hash(rows);
    };
    const state=await domainHash();
    await Promise.all([1,2].map(()=>web.client.call('GET',base+'/dashboard'+query+'&snapshotToken='+token)));
    assert.equal(await domainHash(),state,'GET changes no original/book/audit/evidence/fence');
    web.client.cookies.set('__Host-caudelyx-session',f.c.issued.token);
    const c=await web.client.call('GET',base+'/dashboard'+query);assert.equal(c.status,200,JSON.stringify(c.body));
    assert.equal(metric(c.body.data!,'PRINCIPAL_OUTSTANDING','assignedMetrics'),'1760000.00');assert.equal('organizationMetrics' in c.body.data!,false);
    const p=await f.member('P'),a=await f.member('A');
    web.client.cookies.set('__Host-caudelyx-session',p.issued.token);
    const pd=await web.client.call('GET',base+'/dashboard'+query);assert.equal(pd.status,200,JSON.stringify(pd.body));
    assert.equal('organizationMetrics' in pd.body.data!,false);
    assert.deepEqual((pd.body.data!['ownActivityMetrics'] as Data[]).map(row=>row['id']),['RECEIPTS_REGISTERED']);
    web.client.cookies.set('__Host-caudelyx-session',a.issued.token);assert.equal((await web.client.call('GET',base+'/dashboard'+query)).status,403);
    web.client.cookies.set('__Host-caudelyx-session',f.o.issued.token);
    const od=await web.client.call('GET',base+'/dashboard'+query);assert.equal(od.status,200,JSON.stringify(od.body));
    const ot=encodeURIComponent(String((od.body.data!['meta'] as Data)['snapshotToken']));
    assert.equal((await web.client.call('GET',base+'/reports/PORTFOLIO?snapshotToken='+ot)).status,403);
    assert.equal((await web.client.call('GET',base+'/reports/CASH?snapshotToken='+ot)).status,200);
    web.client.cookies.set('__Host-caudelyx-session',f.a.issued.token);
    const requested=await (await f.request()).execute(),id=String((requested.data as Data)['entityId']);
    await f.act('dispatchCashDelivery',id,f.c);await f.act('receiveCashDelivery',id,f.o);await f.count(id);await(await f.confirm(id)).execute();
    const stale=await web.client.call('GET',base+'/reports/PORTFOLIO?snapshotToken='+token);assert.equal(stale.status,409,JSON.stringify(stale.body));
    const delivered=await web.client.call('GET',base+'/dashboard'+query);assert.equal(delivered.status,200,JSON.stringify(delivered.body));
    assert.equal(metric(delivered.body.data!,'DELIVERED_NET'),'250000.00');assert.equal(metric(delivered.body.data!,'LIQUIDITY_RESERVED'),'50000.00');
    const otherActor=await f.newActor(),other=await f.tenant(otherActor);
    const equityPayload={code:'OTHER_EQUITY',name:'Capital sintético de otra organización',currency:'COP',accountClass:'EQUITY',kind:'GENERAL'},accountKey=randomUUID();
    await f.proof(otherActor,'FINANCE_ACCOUNT_CREATE',{organizationId:other.org,idempotencyKey:accountKey,payload:equityPayload});
    const equity=(await f.runtime.finance.mutate(otherActor.issued.context,'createAccount',other.org,equityPayload,accountKey)).data as Data;
    const journal={currency:'COP',effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'S08-PROJECTION-OTHER',description:'Capital sintético ajeno',lines:[{accountId:other.account,debit:'777000.00',credit:'0.00'},{accountId:equity['id'],debit:'0.00',credit:'777000.00'}]},journalKey=randomUUID();
    await f.proof(otherActor,'FINANCE_JOURNAL_POST',{organizationId:other.org,idempotencyKey:journalKey,payload:journal});
    await f.runtime.finance.mutate(otherActor.issued.context,'postJournal',other.org,journal,journalKey);
    const stableToken=encodeURIComponent(String((delivered.body.data!['meta'] as Data)['snapshotToken']));
    const stillValid=await web.client.call('GET',base+'/dashboard'+query+'&snapshotToken='+stableToken);assert.equal(stillValid.status,200,JSON.stringify(stillValid.body));
    assert.deepEqual(stillValid.body.data!['organizationMetrics'],delivered.body.data!['organizationMetrics']);
    assert.equal((await web.client.call('GET',base.replace(f.org,other.org)+'/dashboard'+query)).status,404);
    const raw=f.database.client.db(f.database.db.databaseName).collection<{_id:string;principalOutstanding:string}>('loan_positions');
    const row=await raw.findOne({_id:f.l.id});assert.ok(row);
    await raw.updateOne({_id:f.l.id},{$set:{principalOutstanding:'1.00'}});
    await raw.updateOne({_id:f.l.id},{$set:{principalOutstanding:row!.principalOutstanding}});
    const invalid=await web.client.call('GET',base+'/dashboard'+query);assert.equal(invalid.status,503,JSON.stringify(invalid.body));
    assert.equal(await f.database.db.collection<ProjectionHead>(collections.heads).countDocuments({_id:f.org}),1);
    const oldHead=await f.database.db.collection<{_id:string;generation:string}>(collections.heads).findOne({_id:f.org});
    const previousToken=encodeURIComponent(String((delivered.body.data!['meta'] as Data)['snapshotToken']));
    // Explicit synthetic operator rebuild after reverting and inspecting the source.
    projection=await ProjectionRuntime.createOwned(f.identity,f.keys.cursor,ownership,true);f.identity.reporting!.projection=projection;
    const newHead=await f.database.db.collection<{_id:string;generation:string}>(collections.heads).findOne({_id:f.org});
    assert.notEqual(newHead!.generation,oldHead!.generation);
    assert.ok(await f.database.db.collection(collections.units).countDocuments({generation:oldHead!.generation}));
    assert.equal((await web.client.call('GET',base+'/dashboard'+query+'&snapshotToken='+previousToken)).status,409);
    const rebuilt=await web.client.call('GET',base+'/dashboard'+query);assert.equal(rebuilt.status,200,JSON.stringify(rebuilt.body));
    assert.deepEqual(rebuilt.body.data!['organizationMetrics'],delivered.body.data!['organizationMetrics']);
    const restartToken=encodeURIComponent(String((rebuilt.body.data!['meta'] as Data)['snapshotToken']));
    await f.restore.flush();
    const peer=await group.peer({keys:f.keys,now:f.now()});
    try{
      const read=await peer.execute({operation:'getReportingDashboard',org:f.org,token:f.a.issued.token,query:{from:'2026-10-01',to:today(f.now()),asOf:today(f.now()),snapshotToken:decodeURIComponent(restartToken)}});
      assert.equal(read['status'],200,JSON.stringify(read));
      assert.deepEqual((read['data'] as Data)['organizationMetrics'],delivered.body.data!['organizationMetrics']);
      const parent=await web.client.call('GET',base+'/dashboard'+query+'&snapshotToken='+restartToken);assert.equal(parent.status,200,JSON.stringify(parent.body));
    }finally{await peer.close();}
    await projection.stop();projection=await ProjectionRuntime.createOwned(f.identity,f.keys.cursor,ownership);f.identity.reporting!.projection=projection;
    assert.equal((await web.client.call('GET',base+'/dashboard'+query+'&snapshotToken='+restartToken)).status,200);
    await projection.stop();
    const head=await f.database.db.collection<ProjectionHead>(collections.heads).findOne({_id:f.org});
    const rawManifests=f.database.client.db(f.database.db.databaseName).collection<ManifestChunk>(collections.manifests);
    const chunk=await rawManifests.findOne({_id:head!.lastManifest+':0'});assert.ok(chunk);
    await rawManifests.updateOne({_id:chunk!._id},{$set:{'mutations.0.after':'0'.repeat(64)}});
    await assert.rejects(ProjectionRuntime.createOwned(f.identity,f.keys.cursor,ownership));
    assert.equal((await rawManifests.findOne({_id:chunk!._id}))!.mutations[0]!.after,'0'.repeat(64),'No startup repair');
    await rawManifests.replaceOne({_id:chunk!._id},chunk!);
    projection=await ProjectionRuntime.createOwned(f.identity,f.keys.cursor,ownership);f.identity.reporting!.projection=projection;
    const snapshot=await f.restore.snapshot();for(const name of Object.values(collections))assert.equal(name in snapshot.collections,false);
    await f.restore.beginRestore(snapshot);await f.restore.reconcile({approved:true,reviewId:'S08-projection-owned-current-cut'});
    assert.equal(f.restore.isOpen(),true);assert.equal(await f.database.db.collection(collections.heads).countDocuments(),0);
    const oldSession=await web.client.call('GET',base+'/dashboard'+query);assert.ok([401,403].includes(oldSession.status),JSON.stringify(oldSession.body));
    const login=await f.identity.login('TENANT','S08-PROJECTION-RESTORE',f.a.email,password);web.client.cookies.set('__Host-caudelyx-session',login.issued.token);
    projection=await ProjectionRuntime.createOwned(f.identity,f.keys.cursor,ownership);f.identity.reporting!.projection=projection;
    const afterRestore=await web.client.call('GET',base+'/dashboard'+query);assert.equal(afterRestore.status,200,JSON.stringify(afterRestore.body));
    assert.deepEqual(afterRestore.body.data!['organizationMetrics'],delivered.body.data!['organizationMetrics']);
    assert.equal((await web.client.call('GET',base+'/dashboard'+query+'&snapshotToken='+restartToken)).status,409);
    process.stdout.write('PROJECTED_FINANCIAL_PROOF '+JSON.stringify({principal:'1760000.00',interest:'60000.00',recovered:'240000.00',delivered:'250000.00',reserved:'50000.00',sameTokenSevenReports:true,getOriginalAndProjectionWrites:0,copScopesAndADenied:true,otherTenant777kDoesNotInvalidateToken:true,tamperUndoBlocked:true,verifiedRebuildNewGeneration:true,realPeerTokenAndParentPreserved:true,restartTokenPreserved:true,coldManifestCorruptionBlockedWithoutRepair:true,restoreInvalidatesDerivedAndOldW:true,restoreEconomyEqual:true})+'\n');
  }finally{await projection?.stop();release();}
}

test('S08-P04 integrated projected finance, permissions, restore and D2',{timeout:900000},async t=>{
 const group=await s08Profile();try{
 await t.test('projected seven reports, exact300/250/50, purity, scopes,peer,restart,restore and tamper',()=>projectedCase(group));
 await t.test('D2 exact250/230 in discrepancy and investigation, unchanged book/reserve and final physical facts',async()=>{
  const f=await cashSetup(group),nonparty=await f.member('C'),projection=await activate(group,f);
  try{for(const investigate of [false,true]){
   const created=await(await f.request('250000.00')).execute(),id=String((created.data as Data)['entityId']);
   await f.act('dispatchCashDelivery',id,f.c);await f.act('receiveCashDelivery',id,f.o);await f.count(id,'230000.00');if(investigate)await f.act('investigateCashDelivery',id);
   const before=(await f.collections.table('cash_deliveries').findOne({_id:id,organizationId:f.org}))!,journals=await f.runtime.finance.journals.countDocuments({organizationId:f.org}),versions=await f.collectionsState(),key=randomUUID(),payload={resourceETag:'"'+id+':'+before.version+'"',occurredAt:new Date(f.now()).toISOString(),reason:'Solicitud no certifica retorno',supportReference:'S08-P04'};
   await assert.rejects(f.collections.mutate(nonparty.issued.context,'requestCashDeliveryReturn',f.org,payload,randomUUID(),versions.collectionsBookETag,id),code('RESOURCE_NOT_FOUND'));
   const requested=await f.collections.mutate(f.c.issued.context,'requestCashDeliveryReturn',f.org,payload,key,versions.collectionsBookETag,id);assert.equal(requested.status,201);
   const after=(await f.collections.table('cash_deliveries').findOne({_id:id,organizationId:f.org}))!;assert.equal(after.lastCount,'230000.00');assert.equal(after.countId,before.countId);assert.equal(after.amount,'250000.00');assert.equal(after.returnFrom,investigate?'INVESTIGATION':'DISCREPANCY');assert.equal(after.state,'RETURN_REQUIRED');
   assert.equal((await f.collections.mutate(f.c.issued.context,'requestCashDeliveryReturn',f.org,payload,key,versions.collectionsBookETag,id)).status,200);
   await assert.rejects(f.collections.mutate(f.c.issued.context,'requestCashDeliveryReturn',f.org,{...payload,reason:'Conflicto'},key,versions.collectionsBookETag,id),code('IDEMPOTENCY_CONFLICT'));
   await assert.rejects(f.collections.mutate(f.c.issued.context,'requestCashDeliveryReturn',f.org,payload,randomUUID(),versions.collectionsBookETag,id),code('PRECONDITION_FAILED'));
   const money=((await f.readCollections('getCashPosition',f.c.issued.context.subjectId!,f.c)).data as {items:Data[]}).items[0]!;
   assert.equal(money['ledgerBalance'],'300000.00');assert.equal(money['retainedAtOrigin'],'300000.00');assert.equal(money['committed'],'250000.00');assert.equal(money['available'],'0.00');
   await f.act('recordCashDeliveryReturnFact',id,f.o,{kind:'RECEIVER_RETURN_DISPATCHED',amount:'250000.00'});await f.act('recordCashDeliveryReturnFact',id,f.c,{kind:'SOURCE_RECEIVED',amount:'250000.00'});await f.act('recordCashDeliveryReturnFact',id,f.c,{kind:'SOURCE_COUNT',amount:'230000.00'});
   await assert.rejects(f.act('confirmCashDeliveryReturn',id),code('DELIVERY_COUNTERPARTY_REQUIRED'));assert.equal((await f.delivery(id)).state,'RETURN_RECEIVED');
   await f.act('recordCashDeliveryReturnFact',id,f.c,{kind:'SOURCE_COUNT',amount:'250000.00'});await f.act('confirmCashDeliveryReturn',id);assert.equal((await f.delivery(id)).state,'CANCELLED');
   assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:f.org}),journals);
  }assert.equal(await f.database.db.collection('audit_events').countDocuments({action:'CASH_DELIVERY_RETURN_REQUEST'}),2);
  process.stdout.write('P04_D2_PROOF '+JSON.stringify({amount:'250000.00',count:'230000.00',bothStates:true,ledgerAndReservation:'300000.00',commitmentDuringRequest:'250000.00',available:'0.00',exactPhysicalFinalOnly:true,journalWrites:0,auditRequests:2})+'\n');
  }finally{await projection.stop();}
 });
 await t.test('projected100k already accrued and2M principal recovery; original ledger independently summed',async()=>{
  const f=await setup(group),bank=await f.accountS06('BANK_P04','ASSET','BANK'),l=await f.loan({principal:'3333333.33'});await f.disburse(l);const zero=await f.loan({principal:'2000000.00',installmentCount:1,rate:{type:'EFFECTIVE',unit:'MONTH',value:'0.000000000000'}});await f.disburse(zero);
  const projection=await activate(group,f);try{
   const position=await f.position(l.id);await(await f.make({kind:'ACCRUE',loanId:l.id,positionETag:position.etag!,throughDate:today(f.now()),effectiveDate:today(f.now()),supportReference:'P04-ACCRUE'})).execute();
   await(await f.preparePayment({kind:'REGISTER',mode:'DIRECT',effectiveDate:today(f.now()),intent:await f.intent(l,bank.id,'100000.00')})).execute();
   await(await f.preparePayment({kind:'REGISTER',mode:'DIRECT',effectiveDate:today(f.now()),intent:await f.intent(zero,bank.id,'2000000.00')})).execute();
   const web=await f.https();web.client.cookies.set('__Host-caudelyx-session',f.a.issued.token);const r=await web.client.call('GET','/api/v1/organizations/'+f.org+'/reporting/dashboard?from=2026-10-01&to='+today(f.now())+'&asOf='+today(f.now()));assert.equal(r.status,200,JSON.stringify(r.body));
   for(const [id,value] of [['INTEREST_ACCRUED','100000.00'],['INTEREST_RECEIVED','100000.00'],['PRINCIPAL_RECOVERED','2000000.00'],['INTEREST_RECEIVABLE','0.00']])assert.equal(metric(r.body.data!,id!),value);
   const token=encodeURIComponent(String((r.body.data!['meta'] as Data)['snapshotToken'])),moves=await web.client.call('GET','/api/v1/organizations/'+f.org+'/reporting/reports/MOVEMENTS?snapshotToken='+token);
   assert.equal(moves.status,200,JSON.stringify(moves.body));const accrual=(moves.body.data!['items'] as Data[]).find(row=>row['nature']==='ACCRUE')!;assert.equal(accrual['amount'],'100000.00');assert.equal(accrual['interest'],'100000.00');
   const cents=(value:unknown)=>{const text=String(value);assert.match(text,/^-?[0-9]+\.[0-9]{2}$/);return BigInt(text.replace('.',''));};
   const balances=new Map<string,bigint>();for(const j of await f.runtime.finance.journals.find({organizationId:f.org}).toArray()){let total=0n;for(const line of j.lines){const n=cents(line.debit)-cents(line.credit);total+=n;balances.set(line.accountId,(balances.get(line.accountId)??0n)+n);}assert.equal(total,0n,'Each original journal balances');}
   assert.equal(balances.get(bank.id),210000000n);assert.equal(balances.get(f.profile.interestIncomeAccountId),-10000000n);
   process.stdout.write('P04_LEDGER_PROOF '+JSON.stringify({priorAccrued:'100000.00',collectedInterest:'100000.00',principalRecovery:'2000000.00',bank:'2100000.00',income:'100000.00',allOriginalJournalsBalanced:true})+'\n');
  }finally{await projection.stop();}
 });
 }finally{await group.dispose();}
});
