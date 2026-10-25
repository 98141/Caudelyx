import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {profile,setup,view,fundedSetup} from './fixture.js';
import {today} from '../../src/modules/finance/service.js';
import type {Event,PublicPosition,Intent} from '../../src/modules/lending/operations-models.js';
import {head,lendingEvidenceMatches} from '../../src/modules/lending/integrity.js';
import {transportChecks} from './transport.test.js';
import {BSON,type CommandStartedEvent,type CommandSucceededEvent,type CommandFailedEvent,type Document} from 'mongodb';
import {createHash,createHmac} from 'node:crypto';
import {domainCollections,evidenceMetrics,headDigest,verifyV2,maxEvidenceDepth,type Ref,type V2Head} from '../../src/modules/lending/evidence-v2.js';
import {operationsEvidenceMatches} from '../../src/modules/lending/operations-service.js';
import {lendingDigest} from '../../src/modules/lending/integrity.js';
import type {SyntheticSnapshot} from '../../src/shared/restore.js';
import {verifyAllLoans} from '../../src/modules/lending/verification.js';
import {quoteQuota} from '../../src/modules/lending/quota.js';
const err=(code:string)=>(e:unknown)=>e instanceof Error&&'code'in e&&e.code===code;
type F=Awaited<ReturnType<typeof fundedSetup>>;
async function economic(f:F){
  const hash=createHash('sha256');for(const name of [...domainCollections,'lending_merkle_nodes','lending_merkle_orgs','financial_accounts','financial_books','financial_journals','financial_evidence_head','audit_events','outbox','security_evidence_outbox']){hash.update(name);hash.update(BSON.EJSON.stringify(await f.database.db.collection(name).find().sort({_id:1}).toArray(),{relaxed:false}));}return hash.digest('hex');
}
async function balances(f:F){return (await f.runtime.finance.read(f.a.issued.context,'balances',f.org,undefined,{asOf:today(f.now())})).data as {items:{accountId:string;naturalBalance:string}[]};}
async function receipt(f:F,l:{id:string;borrowerId:string},value:string,mode:'REGULAR'|'EXTRA_PRINCIPAL'='REGULAR',excess:'REJECT'|'CREDIT'='REJECT'){
  const p=await f.position(l.id);return await f.make({kind:'RECEIPT',borrowerId:l.borrowerId,destinationAccountId:f.account,destinationAccountETag:(await f.runtime.finance.read(f.a.issued.context,'readAccount',f.org,f.account)).etag!,receivedAmount:value,targets:[{loanId:l.id,positionETag:p.etag!,amount:value,mode}],excessDisposition:excess,receiptReference:'SYN-'+randomUUID(),effectiveDate:today(f.now()),supportReference:'SYN-RECEIPT'});
}
async function proofOnly(f:F,command:Awaited<ReturnType<F['make']>>){await f.proof(f.a,command.purpose,{organizationId:f.org,idempotencyKey:command.key,payload:command.payload,expectedETag:command.etag},command.id);}
async function failAfter(target:object,method:string,work:()=>Promise<unknown>){
  const original=Reflect.get(target,method) as (...args:unknown[])=>Promise<unknown>;
  Reflect.set(target,method,async(...args:unknown[])=>{await original.apply(target,args);throw Error('Injected S05 atomic failure: '+method);});try{await work();}finally{Reflect.set(target,method,original);}
}
// Hook the underlying driver method of an already-created authenticated proxy.
// Reading proxy.insertOne as the original would recurse through its own wrapper.
async function failDriverAfter(target:object,method:string,work:()=>Promise<unknown>){
  const descriptor=Object.getOwnPropertyDescriptor(target,method),original=Reflect.get(Object.getPrototypeOf(target),method) as (...args:unknown[])=>Promise<unknown>;
  Object.defineProperty(target,method,{configurable:true,writable:true,value:async(...args:unknown[])=>{await original.apply(target,args);throw Error('Injected S05 atomic failure: '+method);}});
  try{await work();}finally{if(descriptor)Object.defineProperty(target,method,descriptor);else Reflect.deleteProperty(target,method);}
}
async function failCollection(f:F,name:string,method:string,work:()=>Promise<unknown>){
  const original=f.database.db.collection;
  f.database.db.collection=((...args:unknown[])=>{const table=Reflect.apply(original,f.database.db,args) as object;if(args[0]!==name)return table;return new Proxy(table,{get(target,p){const value=Reflect.get(target,p,target);if(p===method)return async(...xs:unknown[])=>{await Reflect.apply(value,target,xs);throw Error('Injected S05 atomic failure: '+name);};return typeof value==='function'?value.bind(target):value;}});}) as typeof original;
  try{await work();}finally{f.database.db.collection=original;}
}
import {ApiClient} from '../helpers/client.js';
const output='../../Construccion/Sprints/S05/Evidencias/';
async function measureDepth(f:F,scenario:string){
  const nodes=await f.database.db.collection<{_id:string;namespace:string;left:Ref|null;right:Ref|null;height:number}>('lending_merkle_nodes').find().toArray(),byId=new Map(nodes.map(n=>[n._id,n]));
  const organizations=await f.database.db.collection<{_id:string;root:Ref|null}>('lending_merkle_orgs').find().toArray(),h=(await head(f.database))! as V2Head;
  const roots=[...organizations.map(o=>({namespace:o._id,root:o.root})),{namespace:'@global',root:h.root}],measurements=[];
  for(const {namespace,root}of roots){const visited=new Set<string>();const walk=(r:Ref|null):number=>{if(!r)return 0;assert.equal(visited.has(r.id),false,'No duplicate/cyclic child in actual tree');visited.add(r.id);const n=byId.get(r.id);assert.ok(n);assert.equal(n.namespace,namespace);const actual=1+Math.max(walk(n.left),walk(n.right));assert.equal(r.height,actual);assert.equal(n.height,actual);assert.ok(actual<=maxEvidenceDepth);return actual;};const height=walk(root);measurements.push({namespace,actualMaxDepth:height,nodes:visited.size});}
  const file=output+'S05-P02-DEPTH.json';let prior:{measurements:unknown[]}={measurements:[]};try{prior=JSON.parse(await readFile(file,'utf8')) as typeof prior;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  prior.measurements.push({scenario,timeUTC:new Date().toISOString(),limit:maxEvidenceDepth,countConvention:'Root=1; empty=0. Traverse actual persisted child pointers, independently recompute height and compare committed node/ref height.',maximum:Math.max(...measurements.map(m=>m.actualMaxDepth)),trees:measurements,installments:await f.ops.rows.countDocuments(),positions:await f.ops.positions.countDocuments()});await writeFile(file,JSON.stringify(prior,null,2));
}
test('S05 baseline H01 H02',{timeout:900000},async t=>{
  const group=await profile();
  try{
    await t.test('H01 reproduction: altered principal must be rejected (expected baseline FAIL)',async()=>{
      const f=await setup(group),b=view(await f.borrower()),q=view(await f.quote(b.id)),binding={quoteId:q.id,quoteFingerprint:q.fingerprint};
      const draft=await f.mutate('createLoanDraft',binding),l=view(draft);
      await f.runtime.lending.loans.updateOne({_id:l.id},{$set:{'terms.principal':'9000.00'}});
      let actual=200,code='';
      try{await f.mutate('confirmLoanTerms',{...binding,termsVersion:1},{id:l.id,etag:draft.etag!});}catch(e){actual=(e as {status:number}).status;code=(e as {code:string}).code;}
      // Exact registered documentary output, never derived from HTTP input.
      await writeFile(output+'S05-P02-H01-REPRODUCTION.json',JSON.stringify({phase:'BEFORE_FIX',expectedStatus:503,actualStatus:actual,code,status:actual===503?'PASS':'FAIL',fixtureOnly:true},null,2));
      assert.equal(actual,503,'H-S4-01 baseline accepts altered stored terms');
    });
    await t.test('H02 before: A quote growth versus B HTTPS quote latency',async()=>{
      const f=await setup(group),a=view(await f.borrower()),other=await f.tenant(await f.newActor());
      const b=view(await f.mutate('createBorrower',{borrowerCode:'SYN_B',profile:{displayName:'Persona B sintética',schemaVersion:1,extras:{}}},{actor:other.actor,org:other.org}));
      const https=await f.https(),client=new ApiClient(https.port,https.cert);client.cookies.set('__Host-caudelyx-session',other.actor.issued.token);await client.refreshCsrf();
      const records=[];let count=0;
      for(const target of [0,100,300]){
        while(count<target){if(count%25===0)f.clock.value+=60000;await f.quote(a.id);count++;}
        const samples=[];
        for(let k=0;k<5;k++){
          const at=performance.now(),r=await client.call('POST',`/api/v1/organizations/${other.org}/loan-quotes`,{terms:{...f.terms(b.id),plannedFundingAccountId:other.account}},{'Idempotency-Key':randomUUID()});
          assert.equal(r.status,201);samples.push(performance.now()-at);
        }
        const sorted=[...samples].sort((a,b)=>a-b);records.push({quotesInA:target,samplesMs:samples,p50:sorted[2],p95:sorted[4],sourceCollections:9,algorithm:'lending-v1 global scan'});console.log('BASELINE H02',target,sorted[2]);
      }
      await writeFile(output+'S05-P02-H02-BENCHMARK.json',JSON.stringify({before:records,after:null,profile:'one isolated group/same actor workloads/5 B HTTPS samples per point; window advances every25 A quotes; no persistent databases'},null,2));
    });
  }finally{await group.dispose();}
});
test('S05 backend candidate',{timeout:900000},async t=>{
  const group=await profile();
  let interrupted:Promise<void>|undefined;const onInterrupt=()=>{interrupted=group.dispose();};process.once('SIGINT',onInterrupt);process.once('SIGTERM',onInterrupt);
  // eslint-disable-next-line security/detect-non-literal-regexp -- Author-only case selector; never loaded in the product.
  const focus=process.env['S05_FOCUS'];const scenario=async(name:string,fn:(ctx:TestContext)=>Promise<void>)=>{await t.test(name,{skip:focus?!new RegExp(focus).test(name):false},fn);};
  try{
    await scenario('AT15:protected URI,live lease and failed setup reuse one registered group',async()=>{
      const {assertOwnUri}=await import('./fixture.js');for(const uri of ['mongodb://localhost:27017/?replicaSet=rs0','mongodb://127.0.0.1:27181/?replicaSet=caudelyx-manual','mongodb://remote.invalid:35000/?replicaSet=caudelyx-manual'])assert.throws(()=>assertOwnUri(uri));
      await assert.rejects(profile(),/Existing own resource/);
      const release=group.hold();await assert.rejects(group.dispose(),/lease/);release();await assert.rejects(group.fixture({failSetup:true}),/Injected own partial setup/);
    });
    await scenario('AT01/03/04/06/07/08: funded2M,300k partial, replay and exact evidence',async()=>{
      const f=await fundedSetup(group),l=await f.loan({principal:'2000000.00'}),before=await f.database.db.collection('financial_journals').countDocuments();
      const funding=await f.disburse(l),event=(funding.result.data as {event:Event}).event;assert.equal(event.kind,'DISBURSE');assert.equal(event.plan.postings.length,2);
      assert.equal(await f.database.db.collection('financial_journals').countDocuments(),before+1);assert.equal((await f.position(l.id)).data && ((await f.position(l.id)).data as PublicPosition).principalOutstanding,'2000000.00');
      const p=await f.position(l.id),request:Intent={kind:'RECEIPT',borrowerId:l.borrowerId,destinationAccountId:f.account,destinationAccountETag:(await f.runtime.finance.read(f.a.issued.context,'readAccount',f.org,f.account)).etag!,receivedAmount:'300000.00',targets:[{loanId:l.id,positionETag:p.etag!,amount:'300000.00',mode:'REGULAR'}],excessDisposition:'REJECT',receiptReference:'SYN-300K',effectiveDate:today(f.now()),supportReference:'SYN-300K'};
      const command=await f.make(request),result=await command.execute(),receipt=(result.data as {event:Event}).event;
      assert.deepEqual(receipt.plan.allocations.map(a=>[a.component,a.amount]),[['INTEREST','60000.00'],['DUE_PRINCIPAL','240000.00']]);
      assert.equal(((await f.position(l.id)).data as PublicPosition).principalOutstanding,'1760000.00');assert.equal(((await f.position(l.id)).data as PublicPosition).accruedOutstandingInterest,'0.00');
      const count=await f.database.db.collection('financial_journals').countDocuments();assert.equal((await command.execute()).status,200);assert.equal(await f.database.db.collection('financial_journals').countDocuments(),count);
      assert.equal(await lendingEvidenceMatches(f.database,(await head(f.database))!),true);
      await f.restore.flush();await f.restore.initialize();assert.equal(f.restore.isOpen(),true);
    });
    await scenario('AT01/02/04/08:10M funding,2M principal recovery creates zero profit; GET has no financial effects',async()=>{
      const f=await fundedSetup(group),l=await f.loan({principal:'10000000.00',installmentCount:1,rate:{type:'EFFECTIVE',unit:'MONTH',value:'0.000000000000'}});
      const {command}=await f.disburse(l);let b=await balances(f);assert.equal(b.items.find(a=>a.accountId===f.account)!.naturalBalance,'10000000.00');assert.equal(b.items.find(a=>a.accountId===f.profile.principalAccountId)!.naturalBalance,'10000000.00');assert.equal(b.items.find(a=>a.accountId===f.profile.interestIncomeAccountId)!.naturalBalance,'0.00');
      const zeroCount=await f.database.db.collection('financial_journals').countDocuments(),zero=await f.make({kind:'ACCRUE',loanId:l.id,positionETag:(await f.position(l.id)).etag!,throughDate:today(f.now()),effectiveDate:today(f.now()),supportReference:'SYN-ZERO'}),zeroResult=await zero.execute();assert.equal((zeroResult.data as {event:Event}).event.journalId,null);assert.equal(await f.database.db.collection('financial_journals').countDocuments(),zeroCount);
      await (await receipt(f,l,'2000000.00')).execute();b=await balances(f);assert.equal(b.items.find(a=>a.accountId===f.profile.principalAccountId)!.naturalBalance,'8000000.00');assert.equal(b.items.find(a=>a.accountId===f.profile.interestIncomeAccountId)!.naturalBalance,'0.00');
      const before=await economic(f);for(const op of ['getLoanOperationsPolicy','getLoanOperationsBook','listLoanPositions','listLoanEvents'])await f.ops.read(f.a.issued.context,op,f.org);
      await f.ops.read(f.a.issued.context,'getLoanCommandResult',f.org,command.key);await f.ops.read(f.a.issued.context,'listLoanInstallments',f.org,l.id);await f.ops.read(f.a.issued.context,'listLoanScheduleVersions',f.org,l.id);assert.equal(await economic(f),before);assert.equal(await operationsEvidenceMatches(f.database),true);
    });
    await scenario('AT03/04:100k already accrued, overlap and zero rate never duplicate income',async()=>{
      const f=await fundedSetup(group),l=await f.loan({principal:'10000000.00',method:'INTEREST_ONLY',rate:{type:'EFFECTIVE',unit:'MONTH',value:'0.010000000000'}});await f.disburse(l);
      const p=await f.position(l.id),a=await f.make({kind:'ACCRUE',loanId:l.id,positionETag:p.etag!,throughDate:today(f.now()),effectiveDate:today(f.now()),supportReference:'SYN-ACCRUAL'});await a.execute();
      const b=await balances(f);assert.equal(b.items.find(a=>a.accountId===f.profile.interestIncomeAccountId)!.naturalBalance,'100000.00');
      const command=await receipt(f,l,'100000.00'),r=await command.execute();assert.equal((r.data as {event:Event}).event.plan.accruals.length,0);const after=await balances(f);assert.equal(after.items.find(a=>a.accountId===f.profile.interestIncomeAccountId)!.naturalBalance,'100000.00');assert.equal(after.items.find(a=>a.accountId===f.profile.interestReceivableAccountId)!.naturalBalance,'0.00');
      await assert.rejects(f.make({kind:'ACCRUE',loanId:l.id,positionETag:(await f.position(l.id)).etag!,throughDate:today(f.now()),effectiveDate:today(f.now()),supportReference:'SYN-OVERLAP'}),err('NO_ACCRUAL_DUE'));
    });
    await scenario('AT05/07:joint same borrower and extra CP preserve history/dates',async()=>{
      const f=await fundedSetup(group),l1=await f.loan({principal:'1000.00',rate:{type:'EFFECTIVE',unit:'MONTH',value:'0.010000000000'}}),l2=await f.loan({principal:'2000.00',rate:{type:'EFFECTIVE',unit:'MONTH',value:'0.000000000000'}},l1.borrowerId);await f.disburse(l1);await f.disburse(l2);
      const command=await f.make({kind:'RECEIPT',borrowerId:l1.borrowerId,destinationAccountId:f.account,destinationAccountETag:(await f.runtime.finance.read(f.a.issued.context,'readAccount',f.org,f.account)).etag!,receivedAmount:'600.00',targets:[{loanId:l1.id,positionETag:(await f.position(l1.id)).etag!,amount:'260.00',mode:'REGULAR'},{loanId:l2.id,positionETag:(await f.position(l2.id)).etag!,amount:'340.00',mode:'REGULAR'}],excessDisposition:'REJECT',receiptReference:'SYN-JOINT',effectiveDate:today(f.now()),supportReference:'SYN-JOINT'});await command.execute();assert.equal(((await f.position(l1.id)).data as PublicPosition).principalOutstanding,'750.00');assert.equal(((await f.position(l2.id)).data as PublicPosition).principalOutstanding,'1660.00');
      assert.equal(await operationsEvidenceMatches(f.database),true);
      const x=await fundedSetup(group),l=await x.loan({principal:'1000.00',rate:{type:'EFFECTIVE',unit:'MONTH',value:'0.010000000000'}});await x.disburse(l);const result=await(await receipt(x,l,'360.00','EXTRA_PRINCIPAL')).execute();const e=(result.data as {event:Event}).event;
      assert.deepEqual(e.plan.scheduleRevisions[0]!.futureInstallments.map(r=>[r.dueDate,r.principal,r.interest,r.payment]),[['2026-11-30','216.66','6.50','223.16'],['2026-12-31','216.66','4.33','220.99'],['2027-01-31','216.68','2.17','218.85']]);
      assert.equal(((await x.position(l.id)).data as PublicPosition).principalOutstanding,'650.00');assert.equal((await x.ops.read(x.a.issued.context,'listLoanScheduleVersions',x.org,l.id)).data&&((await x.ops.read(x.a.issued.context,'listLoanScheduleVersions',x.org,l.id)).data as {items:unknown[]}).items.length,2);
      await assert.rejects(x.mutate('cancelLoan',{reason:'No cancelación S4 tras desembolso'},{id:l.id,etag:l.etag}),err('STATE_CONFLICT'));assert.equal(await operationsEvidenceMatches(x.database),true);
    });
    await scenario('AT05/08:advance liability then credit application without cash; early settlement retains credit',async()=>{
      const f=await fundedSetup(group,'2026-10-30T12:00:00-05:00'),l=await f.loan({principal:'1000.00',rate:{type:'EFFECTIVE',unit:'MONTH',value:'0.010000000000'}});await f.disburse(l);await(await receipt(f,l,'100.00','REGULAR','CREDIT')).execute();let c=await f.ops.read(f.a.issued.context,'getBorrowerCredit',f.org,l.borrowerId);assert.equal((c.data as {balance:string}).balance,'100.00');assert.equal(((await f.position(l.id)).data as PublicPosition).principalOutstanding,'1000.00');
      f.clock.value=Date.parse('2026-10-31T12:00:00-05:00');f.a.issued=(await f.login(f.a)).issued;const cash=(await balances(f)).items.find(a=>a.accountId===f.account)!.naturalBalance;
      const apply=await f.make({kind:'APPLY_CREDIT',borrowerId:l.borrowerId,creditETag:c.etag!,amount:'100.00',targets:[{loanId:l.id,positionETag:(await f.position(l.id)).etag!,amount:'100.00',mode:'REGULAR'}],effectiveDate:today(f.now()),supportReference:'SYN-APPLY'});await apply.execute();assert.equal((await balances(f)).items.find(a=>a.accountId===f.account)!.naturalBalance,cash);assert.equal(((await f.position(l.id)).data as PublicPosition).principalOutstanding,'910.00');c=await f.ops.read(f.a.issued.context,'getBorrowerCredit',f.org,l.borrowerId);assert.equal((c.data as {balance:string}).balance,'0.00');assert.equal(await operationsEvidenceMatches(f.database),true);
      const x=await fundedSetup(group),end=await x.loan({principal:'1000.00',rate:{type:'EFFECTIVE',unit:'MONTH',value:'0.010000000000'}});await x.disburse(end);await(await receipt(x,end,'1100.00','EXTRA_PRINCIPAL','CREDIT')).execute();assert.equal(((await x.position(end.id)).data as PublicPosition).status,'SETTLED');assert.equal((await x.ops.read(x.a.issued.context,'getBorrowerCredit',x.org,end.borrowerId)).data&&((await x.ops.read(x.a.issued.context,'getBorrowerCredit',x.org,end.borrowerId)).data as {balance:string}).balance,'90.00');assert.equal(await operationsEvidenceMatches(x.database),true);
    });
    await scenario('AT06:idempotency,R,CAS,expiry boundary,uncertain response replay',async()=>{
      const f=await fundedSetup(group),l=await f.loan({principal:'2000000.00'}),fund=await f.disburse(l);
      await assert.rejects(f.ops.mutate(f.a.issued.context,fund.command.operation,f.org,fund.command.payload,fund.command.key,fund.command.etag),err('R_REQUIRED'));
      const first=await receipt(f,l,'300000.00'),stale=await receipt(f,l,'100000.00');await first.execute();await assert.rejects(stale.execute(),err('PRECONDITION_FAILED'));
      const conflicting={...first.payload,request:{...first.payload.request,receivedAmount:'300001.00'}};await f.proof(f.a,first.purpose,{organizationId:f.org,idempotencyKey:first.key,payload:conflicting,expectedETag:first.etag},first.id);await assert.rejects(f.ops.mutate(f.a.issued.context,first.operation,f.org,conflicting,first.key,first.etag),err('IDEMPOTENCY_CONFLICT'));
      const expiration=await receipt(f,l,'100000.00'),time=f.now();f.clock.value=time+270000;await f.proof(f.a,expiration.purpose,{organizationId:f.org,idempotencyKey:expiration.key,payload:expiration.payload,expectedETag:expiration.etag},expiration.id);await assert.rejects(f.ops.mutate(f.a.issued.context,expiration.operation,f.org,expiration.payload,expiration.key,expiration.etag),err('PREVIEW_EXPIRED'));
      const count=await f.database.db.collection('financial_journals').countDocuments();f.clock.value+=600000;assert.equal((await first.execute()).status,200);assert.equal(await f.database.db.collection('financial_journals').countDocuments(),count);
      const recovered=await f.ops.read(f.a.issued.context,'getLoanCommandResult',f.org,first.key);assert.deepEqual(recovered.data,(await first.execute()).data);
    });
    await scenario('AT01/02/09/10:real contents before confirm/replace/disburse; no reseal; source dependency/tenant/role guards',async()=>{
      const f=await fundedSetup(group),b=view(await f.borrower()),q=view(await f.quote(b.id)),bind={quoteId:q.id,quoteFingerprint:q.fingerprint},draft=await f.mutate('createLoanDraft',bind),l=view(draft);await f.runtime.lending.loans.updateOne({_id:l.id},{$set:{'terms.principal':'9000.00'}});
      await assert.rejects(f.mutate('confirmLoanTerms',{...bind,termsVersion:1},{id:l.id,etag:draft.etag!}),err('INTEGRITY_MISMATCH'));
      const replacement=view(await f.quote(b.id,{principal:'1500.00'}));await assert.rejects(f.mutate('replaceLoanTerms',{quoteId:replacement.id,quoteFingerprint:replacement.fingerprint,changeReason:'No lavar corrupción'},{id:l.id,etag:draft.etag!}),err('INTEGRITY_MISMATCH'));assert.equal(await lendingEvidenceMatches(f.database,(await head(f.database))!),false);
      const x=await fundedSetup(group),saved=await x.loan({principal:'1000.00'});await x.runtime.lending.loans.updateOne({_id:saved.id},{$set:{'terms.principal':'9000.00'}});await assert.rejects(x.disburse(saved),err('INTEGRITY_MISMATCH'));assert.equal(await x.database.db.collection('loan_events').countDocuments(),0);
      const y=await fundedSetup(group),valid=await y.loan({principal:'1000.00'}),a=await y.runtime.finance.read(y.a.issued.context,'readAccount',y.org,y.account),payload={name:'Caja sintética versión2'},key=randomUUID();await y.proof(y.a,'FINANCE_ACCOUNT_UPDATE',{organizationId:y.org,idempotencyKey:key,payload,expectedETag:a.etag!},y.account);await y.runtime.finance.mutate(y.a.issued.context,'renameAccount',y.org,payload,key,y.account,a.etag);await assert.rejects(y.disburse(valid),err('TERMS_STALE'));
      const foreign=await y.tenant(await y.newActor());await assert.rejects(y.ops.read(foreign.actor.issued.context,'getLoanPosition',y.org,valid.id),err('RESOURCE_NOT_FOUND'));
      const actor=await y.identity.identities.findOne({_id:y.a.issued.context.subjectId!});for(const roles of [['A'],['O'],['C'],['P'],['L'],['T','SA']]){await y.identity.identities.updateOne({_id:actor!._id},{$set:{roles}});await assert.rejects(y.ops.read(y.a.issued.context,'getLoanOperationsBook',y.org),err('ACCESS_DENIED'));}await y.identity.identities.updateOne({_id:actor!._id},{$set:{roles:['T']}});
    });
    await scenario('AT09/12/13:HTTPS transport and closed read projections',async child=>{const f=await fundedSetup(group);await transportChecks(child,f);});
    await scenario('AT09:quote and preview cannot be reused by another actor of the same organization',async()=>{
      const f=await fundedSetup(group),l=await f.loan({principal:'1000.00'}),command=await f.make(await f.fundingRequest(l)),other=await f.newActor(),invite={email:other.email,roleIds:['O']};await f.proof(f.a,'MEMBER_INVITE',invite,f.org);await f.runtime.organizations.invite(f.a.issued.context,invite);await f.identity.dispatchMail();const row=await f.runtime.organizations.invitations.findOne({organizationId:f.org,email:other.email});const notice=[...f.messages.notificationInbox.values()].find(n=>n.kind==='INVITATION'&&n.subjectId===row!._id)!;await f.runtime.organizations.accept(other.issued.context,{mode:'CONFIRM',token:notice.payload['token']},'S05-synthetic');other.issued=(await f.login(other)).issued;
      // Negative actor-binding fixture only: account/MFA/affiliation used real flows.
      // Existing member APIs do not grant a second T; no successful financial operation uses this role simulation.
      await f.identity.identities.updateOne({_id:other.issued.context.subjectId!},{$set:{roles:['T']}});
      await f.proof(other,command.purpose,{organizationId:f.org,idempotencyKey:command.key,payload:command.payload,expectedETag:command.etag},command.id);const before=await economic(f);await assert.rejects(f.ops.mutate(other.issued.context,command.operation,f.org,command.payload,command.key,command.etag),err('PREVIEW_STALE'));assert.equal(await economic(f),before);
      const payload={quoteId:l.quote.id,quoteFingerprint:l.quote.fingerprint},key=randomUUID();await f.proof(other,'LOAN_DRAFT_CREATE',{organizationId:f.org,idempotencyKey:key,payload});await assert.rejects(f.runtime.lending.mutate(other.issued.context,'createLoanDraft',f.org,payload,key),err('QUOTE_BINDING_MISMATCH'));assert.equal(await f.database.db.collection('loan_events').countDocuments(),0);
      await f.identity.identities.updateOne({_id:other.issued.context.subjectId!},{$set:{roles:['O']}});
    });
    await scenario('AT05/09:ten-loan receipt, invalid batches/reference/credit and revoked account have no partial effects',async()=>{
      const f=await fundedSetup(group),loans=[];
      const first=await f.loan({principal:'1000.00'});loans.push(first);await f.disburse(first);
      for(let n=1;n<10;n++){const l=await f.loan({principal:'1000.00'},first.borrowerId);loans.push(l);await f.disburse(l);}
      const targets=[];for(const l of loans)targets.push({loanId:l.id,positionETag:(await f.position(l.id)).etag!,amount:'20.00',mode:'REGULAR' as const});
      const intent:Intent={kind:'RECEIPT',borrowerId:first.borrowerId,destinationAccountId:f.account,destinationAccountETag:(await f.runtime.finance.read(f.a.issued.context,'readAccount',f.org,f.account)).etag!,receivedAmount:'200.00',targets,excessDisposition:'REJECT',receiptReference:'SYN-TEN',effectiveDate:today(f.now()),supportReference:'SYN-TEN'};
      let before=await economic(f);
      await assert.rejects(f.make({...intent,targets:[...targets,targets[0]!]}),err('INPUT_INVALID'));
      await assert.rejects(f.make({...intent,targets:[targets[0]!,targets[0]!]}),err('INPUT_INVALID'));
      await assert.rejects(f.make({...intent,receivedAmount:'199.99'}),err('INPUT_INVALID'));
      await assert.rejects(f.make({...intent,targets:[...targets.slice(0,9),{...targets[9]!,loanId:randomUUID()}]}),err('RESOURCE_NOT_FOUND'));
      assert.equal(await economic(f),before);const other=view(await f.borrower());before=await economic(f);await assert.rejects(f.make({...intent,borrowerId:other.id}),err('INPUT_INVALID'));
      assert.equal(await economic(f),before);
      const result=await(await f.make(intent)).execute(),event=(result.data as {event:Event}).event;
      assert.equal(event.plan.accruals.length,10);assert.equal(event.plan.allocations.length,10);assert.equal(event.plan.allocations.every(a=>a.component==='INTEREST'),true);
      for(const t of targets)t.positionETag=(await f.position(t.loanId)).etag!;
      before=await economic(f);await assert.rejects(f.make(intent),err('RECEIPT_REFERENCE_CONFLICT'));
      await assert.rejects(f.make({kind:'APPLY_CREDIT',borrowerId:first.borrowerId,creditETag:`"${first.borrowerId}:0"`,amount:'1.00',targets:[{...targets[0]!,amount:'1.00'}],effectiveDate:today(f.now()),supportReference:'SYN-NO-CREDIT'}),err('CREDIT_INSUFFICIENT'));
      assert.equal(await economic(f),before);
      assert.equal(await verifyV2(f.database,(await head(f.database))!),true,'Trees after ten-loan receipt');await verifyAllLoans(f.database);assert.equal(await operationsEvidenceMatches(f.database),true,'Economic relations after ten-loan receipt');
      const l=await f.loan({principal:'1000.00'}),command=await f.make(await f.fundingRequest(l));await proofOnly(f,command);
      const account=await f.runtime.finance.accounts.findOne({_id:f.account});await f.database.db.collection<{_id:string;status:string}>('financial_accounts').updateOne({_id:f.account},{$set:{status:'INACTIVE'}});
      before=await economic(f);try{await assert.rejects(f.ops.mutate(f.a.issued.context,command.operation,f.org,command.payload,command.key,command.etag),err('ACCOUNT_INELIGIBLE'));assert.equal(await economic(f),before);}finally{await f.runtime.finance.accounts.replaceOne({_id:f.account},account!);}
      await measureDepth(f,'TEN_LOAN_RECEIPT');
      assert.equal(await verifyV2(f.database,(await head(f.database))!),true,'Trees after rejected revoked source');await verifyAllLoans(f.database);assert.equal(await operationsEvidenceMatches(f.database),true,'Economics after rejected revoked source');
      assert.equal(await lendingEvidenceMatches(f.database,(await head(f.database))!),true);
    });
    await scenario('AT11/14:depth ceiling128 and actual360-installment tree survives startup without purging',async()=>{
      const f=await fundedSetup(group),l=await f.loan({principal:'360000.00',installmentCount:360});await f.disburse(l);assert.equal(await f.ops.rows.countDocuments({loanId:l.id}),360);
      await measureDepth(f,'360_INSTALLMENTS');assert.equal(await lendingEvidenceMatches(f.database,(await head(f.database))!),true);await f.restore.flush();await f.restore.initialize();assert.equal(await f.ops.rows.countDocuments({loanId:l.id}),360);await measureDepth(f,'360_INSTALLMENTS_AFTER_STARTUP');
      const orgs=f.database.db.collection<{_id:string;root:Ref}>('lending_merkle_orgs'),org=(await orgs.findOne({_id:f.org}))!;await orgs.updateOne({_id:f.org},{$set:{'root.height':129}});const before=await economic(f);try{await assert.rejects(f.ops.read(f.a.issued.context,'getLoanOperationsBook',f.org),err('INTEGRITY_MISMATCH'));assert.equal(await economic(f),before);}finally{await orgs.replaceOne({_id:f.org},org);}
      assert.equal(await lendingEvidenceMatches(f.database,(await head(f.database))!),true);
    });
    await scenario('AT10:altered content, root hash, missing index root and recomputed unsigned head are rejected without reseal',async()=>{
      const f=await fundedSetup(group),l=await f.loan({principal:'1000.00'});await f.disburse(l);
      const command=await receipt(f,l,'10.00');await proofOnly(f,command);
      const probe=async()=>await f.ops.mutate(f.a.issued.context,command.operation,f.org,command.payload,command.key,command.etag);
      const orgTree=await f.database.db.collection<{_id:string;root:{id:string}}>('lending_merkle_orgs').findOne({_id:f.org});const raw=f.database.db.collection<{_id:string}>('lending_merkle_nodes'),node=await raw.findOne({_id:orgTree!.root.id});assert.ok(node);
      await raw.updateOne({_id:node._id},{$set:{hash:'0'.repeat(64)}});let before=await economic(f);await assert.rejects(probe(),err('INTEGRITY_MISMATCH'));assert.equal(await economic(f),before);await raw.replaceOne({_id:node._id},node);
      await raw.deleteOne({_id:node._id});before=await economic(f);await assert.rejects(probe(),err('INTEGRITY_MISMATCH'));assert.equal(await economic(f),before);await raw.insertOne(node);
      const original=(await head(f.database))! as V2Head,forged={...original,revision:original.revision+1,previousDigest:'0'.repeat(64)};forged.digest=headDigest(forged);
      const heads=f.database.db.collection<V2Head>('lending_domain_state');await heads.replaceOne({_id:'evidence'},forged);before=await economic(f);await assert.rejects(probe(),err('INTEGRITY_MISMATCH'));assert.equal(await economic(f),before);await heads.replaceOne({_id:'evidence'},original);
      const loan=await f.runtime.lending.loans.findOne({_id:l.id});await f.runtime.lending.loans.updateOne({_id:l.id},{$set:{'calculation.totals.interest':'9999.00'}});before=await economic(f);await assert.rejects(probe(),err('INTEGRITY_MISMATCH'));assert.equal(await economic(f),before);await f.runtime.lending.loans.replaceOne({_id:l.id},loan!);
      assert.equal(await lendingEvidenceMatches(f.database,(await head(f.database))!),true);
    });
    await scenario('AT01/02/06/09/10:state, independent insufficient cash, foreign batch, wrong/expired R and missing version',async()=>{
      const f=await fundedSetup(group),first=await f.loan({principal:'1000.00'});await f.disburse(first);
      await assert.rejects(f.make(await f.fundingRequest(first)),err('ALREADY_DISBURSED'));
      const big=await f.loan({principal:'30000000.00'});await assert.rejects(f.make(await f.fundingRequest(big)),err('ACCOUNT_OVERDRAFT'));
      const b=view(await f.borrower()),q=view(await f.quote(b.id)),draft=await f.mutate('createLoanDraft',{quoteId:q.id,quoteFingerprint:q.fingerprint}),d={borrowerId:b.id,id:view(draft).id,etag:draft.etag!,quote:q};
      await assert.rejects(f.make(await f.fundingRequest(d)),err('STATE_CONFLICT'));
      const cancelled=await f.mutate('cancelLoan',{reason:'Cancelación sintética de negativo'},{id:d.id,etag:d.etag});d.etag=cancelled.etag!;await assert.rejects(f.make(await f.fundingRequest(d)),err('STATE_CONFLICT'));
      const other=await f.tenant(await f.newActor()),foreignBorrower=view(await f.mutate('createBorrower',{borrowerCode:'SYN-FOREIGN',profile:{displayName:'Persona ajena sintética',schemaVersion:1,extras:{}}},{actor:other.actor,org:other.org})),foreignQuote=view(await f.mutate('createLoanQuote',{terms:f.terms(foreignBorrower.id,{plannedFundingAccountId:other.account})},{actor:other.actor,org:other.org})),foreignLoan=view(await f.mutate('createLoanDraft',{quoteId:foreignQuote.id,quoteFingerprint:foreignQuote.fingerprint},{actor:other.actor,org:other.org}));
      const command=await receipt(f,first,'10.00'),request=command.payload.request;assert.equal(request.kind,'RECEIPT');if(request.kind!=='RECEIPT')throw Error('Test fixture');
      let before=await economic(f);await assert.rejects(f.make({...request,receivedAmount:'20.00',targets:[...request.targets,{...request.targets[0]!,loanId:foreignLoan.id}]}),err('RESOURCE_NOT_FOUND'));assert.equal(await economic(f),before);
      const accrue=await f.make({kind:'ACCRUE',loanId:first.id,positionETag:(await f.position(first.id)).etag!,throughDate:today(f.now()),effectiveDate:today(f.now()),supportReference:'SYN-WRONG-R'});await proofOnly(f,accrue);before=await economic(f);await assert.rejects(f.ops.mutate(f.a.issued.context,command.operation,f.org,command.payload,command.key,command.etag),err('R_REQUIRED'));assert.equal(await economic(f),before);
      await proofOnly(f,command);f.clock.value=(await f.sessions.contexts.findOne({_id:f.a.issued.context._id}))!.reauth!.expiresAt;before=await economic(f);await assert.rejects(f.ops.mutate(f.a.issued.context,command.operation,f.org,command.payload,command.key,command.etag),err('R_REQUIRED'));assert.equal(await economic(f),before);
      const versions=f.database.db.collection<{_id:string}>('lending_loan_versions'),version=await versions.findOne({loanId:first.id});assert.ok(version);await versions.deleteOne({_id:version._id});before=await economic(f);try{await assert.rejects(receipt(f,first,'10.00'),err('INTEGRITY_MISMATCH'));assert.equal(await economic(f),before);}finally{await versions.insertOne(version);}
      assert.equal(await lendingEvidenceMatches(f.database,(await head(f.database))!),true);
    });
    await scenario('AT06/07:failures after posting/rows/idempotency/audit/outbox/evidence roll back R and all effects',async()=>{
      const f=await fundedSetup(group),l=await f.loan({principal:'2000000.00'});
      for(const [target,method]of [[f.runtime.finance,'postOperation'],[f.identity.audit,'append']] as const){
        const command=await f.make(await f.fundingRequest(l));await proofOnly(f,command);const before=await economic(f);await failAfter(target,method,async()=>{await assert.rejects(f.ops.mutate(f.a.issued.context,command.operation,f.org,command.payload,command.key,command.etag),/Injected S05 atomic failure/);});assert.equal(await economic(f),before,method);
        assert.equal((await f.sessions.contexts.findOne({_id:f.a.issued.context._id}))!.reauth!.consumed,false);
      }
      for(const target of [f.ops.positions,f.ops.rows,f.ops.idempotency]){
        const command=await f.make(await f.fundingRequest(l));await proofOnly(f,command);const before=await economic(f);await failDriverAfter(target,'insertOne',async()=>{await assert.rejects(f.ops.mutate(f.a.issued.context,command.operation,f.org,command.payload,command.key,command.etag),/Injected S05 atomic failure/);});assert.equal(await economic(f),before);
        assert.equal((await f.sessions.contexts.findOne({_id:f.a.issued.context._id}))!.reauth!.consumed,false);
      }
      for(const [table,method]of [['outbox','insertOne'],['security_evidence_outbox','insertOne'],['lending_merkle_nodes','bulkWrite'],['financial_evidence_head','updateOne']] as const){
        const command=await f.make(await f.fundingRequest(l));await proofOnly(f,command);const before=await economic(f);await failCollection(f,table,method,async()=>{await assert.rejects(f.ops.mutate(f.a.issued.context,command.operation,f.org,command.payload,command.key,command.etag),/Injected S05 atomic failure/);});assert.equal(await economic(f),before,table);
      }
      await f.disburse(l);const command=await receipt(f,l,'300000.00');await proofOnly(f,command);const before=await economic(f);await failDriverAfter(f.ops.accruals,'insertOne',async()=>{await assert.rejects(f.ops.mutate(f.a.issued.context,command.operation,f.org,command.payload,command.key,command.etag),/Injected S05 atomic failure/);});assert.equal(await economic(f),before);assert.equal(await lendingEvidenceMatches(f.database,(await head(f.database))!),true);
    });
    await scenario('AT06/09:permission revoked after planning but before commit cannot authorize money',async()=>{
      const f=await fundedSetup(group),l=await f.loan({principal:'10000000.00'}),command=await f.make(await f.fundingRequest(l));await proofOnly(f,command);const before=await economic(f),original=f.runtime.finance.postOperation.bind(f.runtime.finance);let injected=false;
      f.runtime.finance.postOperation=async(...args:Parameters<typeof original>)=>{const journal=await original(...args);if(!injected){injected=true;await f.identity.identities.updateOne({_id:f.a.issued.context.subjectId!},{$set:{roles:['A'],authzVersion:randomUUID()}});}return journal;};
      try{await assert.rejects(f.ops.mutate(f.a.issued.context,command.operation,f.org,command.payload,command.key,command.etag),e=>err('AUTH_INVALID')(e)||err('ACCESS_DENIED')(e));}finally{f.runtime.finance.postOperation=original;}
      assert.equal(injected,true);assert.equal(await economic(f),before);assert.equal(await f.database.db.collection('loan_events').countDocuments(),0);
    });
    await scenario('AT02/06:two OS processes,15M against two10M commands, one event and no overdraft',async()=>{
      const f=await fundedSetup(group),equity=await f.runtime.finance.accounts.findOne({organizationId:f.org,code:'E'}),payload={currency:'COP',effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN-15M',description:'Ajuste de capital sintético de prueba',lines:[{accountId:equity!._id,debit:'5000000.00',credit:'0.00'},{accountId:f.account,debit:'0.00',credit:'5000000.00'}]},key=randomUUID();await f.proof(f.a,'FINANCE_JOURNAL_POST',{organizationId:f.org,idempotencyKey:key,payload});await f.runtime.finance.mutate(f.a.issued.context,'postJournal',f.org,payload,key);
      const one=await f.loan({principal:'10000000.00'}),two=await f.loan({principal:'10000000.00'},one.borrowerId),a=await f.make(await f.fundingRequest(one)),b=await f.make(await f.fundingRequest(two)),session2=await f.login(f.a);
      await proofOnly(f,a);await f.proof(session2,b.purpose,{organizationId:f.org,idempotencyKey:b.key,payload:b.payload,expectedETag:b.etag},b.id);await f.restore.flush();
      const serialized=Object.fromEntries(Object.entries(f.keys).filter(([,v])=>Buffer.isBuffer(v)).map(([k,v])=>[k,(v as Buffer).toString('base64')])),data={keys:serialized,now:f.now(),config:f.config},prepared=await Promise.allSettled([group.peer(data),group.peer(data)]),peers=prepared.flatMap(r=>r.status==='fulfilled'?[r.value]:[]);
      if(peers.length!==2){await Promise.all(peers.map(p=>p.close()));throw Error('Two own peer processes did not initialize');}
      try{assert.notEqual(peers[0]!.pid,peers[1]!.pid);const results=await Promise.all(peers.map((peer,index)=>{const cmd=index===0?a:b;return peer.execute({token:index===0?f.a.issued.token:session2.issued.token,operation:cmd.operation,organizationId:f.org,payload:cmd.payload,key:cmd.key,etag:cmd.etag});}));assert.deepEqual(results.map(r=>r['status']).sort(),[201,412]);console.log('TWO_PROCESS',results.map(r=>({pid:r['pid'],status:r['status'],code:r['code']})));}
      finally{await Promise.all(peers.map(p=>p.close()));}
      assert.equal(await f.database.db.collection('loan_events').countDocuments(),1);assert.equal((await balances(f)).items.find(a=>a.accountId===f.account)!.naturalBalance,'5000000.00');assert.equal(await lendingEvidenceMatches(f.database,(await head(f.database))!),true);
    });
    await scenario('AT07:manual journal/reversal of S05 or baseline bound accounts blocked; source cash remains usable',async()=>{
      const f=await fundedSetup(group),e=await f.runtime.finance.accounts.findOne({organizationId:f.org,code:'E'}),baseline={currency:'COP',effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN-BASELINE',description:'Saldo previo sintético',lines:[{accountId:f.profile.principalAccountId,debit:'1.00',credit:'0.00'},{accountId:e!._id,debit:'0.00',credit:'1.00'}]},bk=randomUUID();await f.proof(f.a,'FINANCE_JOURNAL_POST',{organizationId:f.org,idempotencyKey:bk,payload:baseline});const old=await f.runtime.finance.mutate(f.a.issued.context,'postJournal',f.org,baseline,bk),l=await f.loan({principal:'1000.00'}),fund=await f.disburse(l),event=(fund.result.data as {event:{journalId:string}}).event;
      for(const[id,etag,code]of [[event.journalId,`"${event.journalId}:1"`,'DOMAIN_REVERSAL_FORBIDDEN'],[(old.data as {id:string}).id,old.etag!,'DOMAIN_ACCOUNT_PROTECTED']] as const){const payload={effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN-REVERSE',reason:'Prueba de protección'},key=randomUUID();await f.proof(f.a,'FINANCE_JOURNAL_REVERSE',{organizationId:f.org,idempotencyKey:key,payload,expectedETag:etag},id);await assert.rejects(f.runtime.finance.mutate(f.a.issued.context,'reverseJournal',f.org,payload,key,id,etag),err(code));}
      const key=randomUUID(),payload={...baseline,sourceId:randomUUID()};await f.proof(f.a,'FINANCE_JOURNAL_POST',{organizationId:f.org,idempotencyKey:key,payload});await assert.rejects(f.runtime.finance.mutate(f.a.issued.context,'postJournal',f.org,payload,key),err('DOMAIN_ACCOUNT_PROTECTED'));assert.equal(await operationsEvidenceMatches(f.database),true);
    });
    await scenario('AT02/07/08:S3 opening cutoff/history intact; only a genuinely new loan is disbursed',async()=>{
      const f=await fundedSetup(group,'2026-10-31T12:00:00-05:00',true);assert.equal(f.opening!.status,'POSTED');
      const b=view(await f.mutate('createBorrower',{borrowerCode:'SYN_HIST',profile:{displayName:'Persona histórica sintética',schemaVersion:1,extras:{}},openingBorrowerReference:{openingId:f.opening!.id,referenceId:f.borrowerReference!}})),l=await f.loan({principal:'1000.00'},b.id),request=await f.fundingRequest(l);
      assert.equal(await f.database.db.collection('financial_journals').countDocuments(),1,'S4 quote/save/confirm never post');
      assert.ok(request.kind==='DISBURSE');await assert.rejects(f.make({...request,loanId:f.historicalLoanReference!}),err('RESOURCE_NOT_FOUND'));await assert.rejects(f.make({...request,effectiveDate:'2026-09-30'}),err('OPENING_CUTOFF_CONFLICT'));await assert.rejects(f.make({...request,effectiveDate:'2026-11-01'}),err('INPUT_INVALID'));
      await f.disburse(l);assert.equal((await balances(f)).items.find(a=>a.accountId===f.profile.principalAccountId)!.naturalBalance,'1100.00');assert.equal(await f.ops.positions.countDocuments(),1);assert.equal((await f.ops.books.findOne({_id:f.org}))!.baseline.find(a=>a.accountId===f.profile.principalAccountId)!.debit,'100.00');
      const journal=f.opening!.commit!.journalId,payload={effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN-OPENING-REVERSE',reason:'No reversar apertura'},key=randomUUID(),expected=`"${journal}:1"`;await f.proof(f.a,'FINANCE_JOURNAL_REVERSE',{organizationId:f.org,idempotencyKey:key,payload,expectedETag:expected},journal);await assert.rejects(f.runtime.finance.mutate(f.a.issued.context,'reverseJournal',f.org,payload,key,journal,expected),err('OPENING_IMMUTABLE'));assert.equal(await lendingEvidenceMatches(f.database,(await head(f.database))!),true);
    });
    await scenario('AT14:complete restore, old cut, missing applications and corrupted content fail closed',async()=>{
      const f=await fundedSetup(group),l=await f.loan({principal:'2000000.00'});await f.disburse(l);const early=await f.restore.snapshot();await(await receipt(f,l,'300000.00')).execute();const current=await f.restore.snapshot();
      await f.restore.beginRestore(current);assert.equal(f.restore.isOpen(),false);
      // Existing S1 restore review fixture marker, not a lending approval or real independent review.
      await f.restore.reconcile({approved:true,reviewId:'S05-SYNTHETIC-RESTORE-FIXTURE'});assert.equal(f.restore.isOpen(),true);f.a.issued=(await f.login(f.a)).issued;assert.equal(((await f.position(l.id)).data as PublicPosition).principalOutstanding,'1760000.00');
      await f.restore.beginRestore(early);await assert.rejects(f.restore.reconcile({approved:true,reviewId:'S05-OLD-CUT-NEGATIVE'}),err('SERVICE_UNAVAILABLE'));assert.equal(f.restore.isOpen(),false);
      const sign=(collections:Record<string,string>):SyntheticSnapshot=>{const data={watermark:current.watermark,collections};return{...data,signature:createHmac('sha256',f.keys.journal).update(JSON.stringify(data)).digest('hex')};};
      const missing={...current.collections};delete missing['loan_applications'];await f.restore.beginRestore(sign(missing));await assert.rejects(f.restore.reconcile({approved:true,reviewId:'S05-MISSING-NEGATIVE'}),err('SERVICE_UNAVAILABLE'));assert.equal(f.restore.isOpen(),false);
      const modified={...current.collections},positions=BSON.EJSON.parse(modified['loan_positions']!) as Record<string,unknown>[];positions[0]!['principalOutstanding']='9999.00';modified['loan_positions']=BSON.EJSON.stringify(positions);await f.restore.beginRestore(sign(modified));await assert.rejects(f.restore.reconcile({approved:true,reviewId:'S05-CORRUPT-NEGATIVE'}),err('SERVICE_UNAVAILABLE'));assert.equal(f.restore.isOpen(),false);
      const noHead={...current.collections},states=BSON.EJSON.parse(noHead['lending_domain_state']!) as {_id:string}[];noHead['lending_domain_state']=BSON.EJSON.stringify(states.filter(s=>s._id!=='evidence'));await f.restore.beginRestore(sign(noHead));await f.restore.initialize();assert.equal(f.restore.isOpen(),false);assert.equal(await head(f.database),null);
    });
    await scenario('AT10/14:verified legacy-v1 transition preserves terms/history; signed inconsistent loan is rejected',async()=>{
      const makeLegacy=async(corrupt:boolean)=>{
        const f=await setup(group),b=view(await f.borrower()),q=view(await f.quote(b.id)),body={quoteId:q.id,quoteFingerprint:q.fingerprint},draft=await f.mutate('createLoanDraft',body),loan=view(draft);await f.mutate('confirmLoanTerms',{...body,termsVersion:1},{id:loan.id,etag:draft.etag!});
        await f.database.transaction(async s=>{for(const c of ['lending_merkle_nodes','lending_merkle_orgs','lending_v2_checkpoint'])await f.database.db.collection(c).deleteMany({},{session:s});if(corrupt)await f.database.db.collection<{_id:string;terms:{principal:string}}>('lending_loans').updateOne({_id:loan.id},{$set:{'terms.principal':'9000.00'}},{session:s});const old=(await head(f.database,s))!,digest=await lendingDigest(f.database,s);await f.database.db.collection<{_id:string;format:string;digest:string;revision:number}>('lending_domain_state').replaceOne({_id:'evidence'},{format:'lending-v1',digest,revision:old.revision+1},{session:s});await f.identity.audit.append({realm:'TENANT',actorId:f.a.issued.context.subjectId!,subjectId:f.a.issued.context.subjectId!,action:'S05_TEST_LEGACY_FIXTURE',outcome:'SUCCESS'},s);});await f.restore.flush();return{f,loan};
      };
      const good=await makeLegacy(false),legacy=(await head(good.f.database))!,before=await good.f.runtime.lending.loans.findOne({_id:good.loan.id});await good.f.restore.initialize();assert.equal((await head(good.f.database))!.format,'lending-v2');assert.deepEqual(await good.f.runtime.lending.loans.findOne({_id:good.loan.id}),before);assert.equal(await good.f.database.db.collection('financial_journals').countDocuments(),0);assert.equal(await good.f.database.db.collection('lending_v2_checkpoint').countDocuments(),1);assert.equal(await lendingEvidenceMatches(good.f.database,(await head(good.f.database))!),true);const checkpoint=await good.f.database.db.collection('lending_v2_checkpoint').findOne();assert.equal(checkpoint!['legacyDigest'],legacy.digest);
      const revision=(await head(good.f.database))!.revision;await good.f.restore.initialize();assert.equal((await head(good.f.database))!.revision,revision);
      const bad=await makeLegacy(true);await assert.rejects(bad.f.restore.initialize(),err('SERVICE_UNAVAILABLE'));assert.equal(bad.f.restore.isOpen(),false);assert.equal((await head(bad.f.database))!.format,'lending-v1');assert.equal(await bad.f.database.db.collection('lending_v2_checkpoint').countDocuments(),0);
    });
    await scenario('AT11/H02:measured0/100/300 retained quotesA, B local readset and HTTP cost',async()=>{
      evidenceMetrics.captureOrganizations=true;evidenceMetrics.documentOrganizations.clear();
      const f=await setup(group),a=view(await f.borrower()),other=await f.tenant(await f.newActor()),b=view(await f.mutate('createBorrower',{borrowerCode:'SYN_B',profile:{displayName:'Persona B sintética',schemaVersion:1,extras:{}}},{actor:other.actor,org:other.org}));
      const https=await f.https(),client=new ApiClient(https.port,https.cert);client.cookies.set('__Host-caudelyx-session',other.actor.issued.token);await client.refreshCsrf();const records=[];let count=0;
      let measuring=false,hashBytesBefore=0,hashCallsBefore=0;
      const wireStats={commandCount:0,commandBytes:0,responseBytes:0,cursorDocuments:0,cursorDocumentBytes:0,writes:0,fences:0,transactionStarts:0,commits:0,aborts:0,commandFailures:0},pending=new Set<number>();
      const started=(event:CommandStartedEvent)=>{if(!measuring)return;pending.add(event.requestId);wireStats.commandCount++;if(event.command['startTransaction']===true)wireStats.transactionStarts++;if(event.commandName==='commitTransaction')wireStats.commits++;if(event.commandName==='abortTransaction')wireStats.aborts++;wireStats.commandBytes+=BSON.calculateObjectSize(event.command);if(['insert','update','delete','bulkWrite'].includes(event.commandName))wireStats.writes++;if(event.commandName==='update'&&event.command['update']==='transaction_fence')wireStats.fences++;};
      const succeeded=(event:CommandSucceededEvent)=>{if(!pending.delete(event.requestId))return;const reply=event.reply as Document;wireStats.responseBytes+=BSON.calculateObjectSize(reply);const cursor=reply['cursor'] as {firstBatch?:Document[];nextBatch?:Document[]}|undefined;for(const doc of cursor?.firstBatch??cursor?.nextBatch??[]){wireStats.cursorDocuments++;wireStats.cursorDocumentBytes+=BSON.calculateObjectSize(doc);}};
      const failed=(event:CommandFailedEvent)=>{if(pending.delete(event.requestId))wireStats.commandFailures++;};
      Reflect.set(f.database.client,'monitorCommands',true);f.database.client.on('commandFailed',failed);f.database.client.on('commandStarted',started);f.database.client.on('commandSucceeded',succeeded);
      try{
      for(const target of [0,100,300]){
        while(count<target){if(count%25===0)f.clock.value+=60000;await f.quote(a.id);count++;}
        const samples=[],readsets=[];
        for(let k=0;k<5;k++){
          const reads=evidenceMetrics.documentReads,nodes=evidenceMetrics.indexNodesRead,writes=evidenceMetrics.documentWrites,foreign=evidenceMetrics.documentOrganizations.get(f.org)??0,start=performance.now(),cpuStart=process.cpuUsage();hashBytesBefore=evidenceMetrics.hashBytes;hashCallsBefore=evidenceMetrics.hashCalls;Object.assign(wireStats,{commandCount:0,commandBytes:0,responseBytes:0,cursorDocuments:0,cursorDocumentBytes:0,writes:0,fences:0,transactionStarts:0,commits:0,aborts:0,commandFailures:0});pending.clear();measuring=true;
          const r=await client.call('POST',`/api/v1/organizations/${other.org}/loan-quotes`,{terms:{...f.terms(b.id),plannedFundingAccountId:other.account}},{'Idempotency-Key':randomUUID()});measuring=false;assert.equal(r.status,201);assert.ok(wireStats.commandCount>0,'Mongo command observer must actually capture work');assert.ok(wireStats.commandBytes>0&&wireStats.responseBytes>0);samples.push(performance.now()-start);
          const foreignReads=(evidenceMetrics.documentOrganizations.get(f.org)??0)-foreign;assert.equal(foreignReads,0);readsets.push({domainDocumentReads:evidenceMetrics.documentReads-reads,domainDocumentWrites:evidenceMetrics.documentWrites-writes,indexNodesRead:evidenceMetrics.indexNodesRead-nodes,foreignAReads:foreignReads,v2EJSONHashCalls:evidenceMetrics.hashCalls-hashCallsBefore,v2EJSONHashBytes:evidenceMetrics.hashBytes-hashBytesBefore,wire:{...wireStats},nodeCPU:process.cpuUsage(cpuStart)});
        }
        const explain=await f.runtime.lending.quotes.find({organizationId:other.org},{hint:'lending_domain_org'}).explain('executionStats');assert.ok(JSON.stringify(explain).includes('lending_domain_org'));const docsExamined=(explain['executionStats'] as {totalDocsExamined:number}).totalDocsExamined;assert.ok(docsExamined<=15,'Only the B quote partition is scanned for cardinality');
        const sorted=[...samples].sort((a,b)=>a-b);records.push({quotesInA:target,samplesMs:samples,p50:sorted[2],p95:sorted[4],readsets,organizationIndex:{name:'lending_domain_org',docsExamined},algorithm:'lending-v2 authenticated per-organization ordered trees'});console.log('AFTER H02',target,sorted[2]);
      }
      }finally{measuring=false;f.database.client.removeListener('commandStarted',started);f.database.client.removeListener('commandSucceeded',succeeded);f.database.client.removeListener('commandFailed',failed);Reflect.set(f.database.client,'monitorCommands',false);}
      f.clock.value+=900000;assert.equal(await f.runtime.lending.quotes.countDocuments({organizationId:f.org}),300);assert.equal(await f.runtime.lending.quotes.countDocuments({organizationId:f.org,expiresAt:{$lte:new Date(f.now()).toISOString()}}),300);
      const quote=await f.runtime.lending.quotes.findOne({organizationId:f.org},{sort:{createdAt:1,_id:1}}),oldResult=await f.runtime.lending.idempotency.findOne({organizationId:f.org,operation:'createLoanQuote','result.data.id':quote!._id});assert.ok(oldResult);const quotaWindowsBefore=await f.database.db.collection('lending_rate_windows').countDocuments();assert.equal((await f.mutate('createLoanQuote',{terms:quote!.terms},{key:oldResult!.key})).status,200);assert.equal(await f.database.db.collection('lending_rate_windows').countDocuments(),quotaWindowsBefore);
      assert.equal(await lendingEvidenceMatches(f.database,(await head(f.database))!),true);await f.restore.flush();await f.restore.initialize();assert.equal(await f.runtime.lending.quotes.countDocuments({organizationId:f.org}),300);const indexes=[];for(const {name}of await f.database.db.listCollections({name:{$in:[...domainCollections]}},{nameOnly:true}).toArray()){const idx=await f.database.db.collection(name).listIndexes().toArray();assert.equal(idx.some(i=>i['expireAfterSeconds']!==undefined),false);indexes.push(name);}
      const file=output+'S05-P02-H02-BENCHMARK.json',old=JSON.parse(await readFile(file,'utf8')) as Record<string,unknown>;old['after']=records;old['retentionVerified']={quotesA:300,expiredUnusedQuotes:300,replayCreatedNoNewQuota:true,noTTLOnDomain:true,indexesChecked:indexes};old['residual']='S1 identity capture, global security fence, full startup/restore verification and financial-v1 digest remain; no absolute latency promise.';await writeFile(file,JSON.stringify(old,null,2));evidenceMetrics.captureOrganizations=false;evidenceMetrics.documentOrganizations.clear();
    });
    await scenario('AT11:30actor shared quotes/previews, replay and60org atomic counters/windows',async()=>{
      const f=await fundedSetup(group),l=await f.loan({principal:'1000.00'}),intent=await f.fundingRequest(l);f.clock.value=(Math.floor(f.now()/60000)+1)*60000+1000;let firstQuote:string|undefined;
      for(let k=0;k<29;k++){const q=view(await f.quote(l.borrowerId));firstQuote??=q.id;}
      await f.make(intent);const count=await f.runtime.lending.quotes.countDocuments();await assert.rejects(f.make(intent),err('RATE_LIMITED'));await assert.rejects(f.quote(l.borrowerId),err('RATE_LIMITED'));assert.equal(await f.runtime.lending.quotes.countDocuments(),count);
      const https=await f.https();https.client.cookies.set('__Host-caudelyx-session',f.a.issued.token);await https.client.refreshCsrf();const limited=await https.client.call('POST',`/api/v1/organizations/${f.org}/loan-quotes`,{terms:f.terms(l.borrowerId)},{'Idempotency-Key':randomUUID()});assert.equal(limited.status,429);assert.ok(Number(limited.headers['retry-after'])>=1);
      const q=await f.runtime.lending.quotes.findOne({_id:firstQuote!}),record=await f.runtime.lending.idempotency.findOne({'result.data.id':q!._id});assert.equal((await f.mutate('createLoanQuote',{terms:q!.terms},{key:record!.key})).status,200);
      f.clock.value+=60000;assert.equal((await f.quote(l.borrowerId)).status,201);
      // Counter component only: no extra Titular is provisioned and no business action is authorized.
      f.clock.value+=60000;const actors=[randomUUID(),randomUUID(),randomUUID()];for(let n=0;n<60;n++)await f.database.transaction(async s=>{await quoteQuota(f.identity,actors[n<30?0:1]!,f.org,s);});await assert.rejects(f.database.transaction(async s=>{await quoteQuota(f.identity,actors[2]!,f.org,s);}),err('RATE_LIMITED'));
      assert.equal(await f.database.db.collection<{_id:string}>('lending_rate_windows').countDocuments({_id:`actor:${f.org}:${actors[2]}:${Math.floor(f.now()/60000)}`}),0,'Org rejection rolls back attempted actor counter');
    });
    await scenario('AT15:controlled SIGINT handler closes only owned active fixture resources',async()=>{
      const f=await setup(group);await f.https();process.emit('SIGINT');await interrupted;assert.ok(interrupted);await group.dispose();
    });
  }finally{process.removeListener('SIGINT',onInterrupt);process.removeListener('SIGTERM',onInterrupt);await interrupted;await group.dispose();}
});
