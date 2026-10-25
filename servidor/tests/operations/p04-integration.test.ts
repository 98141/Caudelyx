/* eslint-disable security/detect-non-literal-fs-filename -- Exact owned synthetic integration controls. */
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {profile,view,fundedSetup} from './p04-fixture.js';
import {today} from '../../src/modules/finance/service.js';
import type {Event,PublicPosition,Intent} from '../../src/modules/lending/operations-models.js';
import {head,lendingEvidenceMatches} from '../../src/modules/lending/integrity.js';
import {transportChecks} from './p04-transport.js';
import {BSON} from 'mongodb';
import {createHash,createHmac} from 'node:crypto';
import {domainCollections} from '../../src/modules/lending/evidence-v2.js';
import {operationsEvidenceMatches} from '../../src/modules/lending/operations-service.js';
import type {SyntheticSnapshot} from '../../src/shared/restore.js';
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
const output=evidenceDirectory;

import {createServer as controlServer} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {join,resolve,dirname} from 'node:path';
import {access} from 'node:fs/promises';
import {generate} from 'otplib';
import {password,evidenceDirectory} from './p04-profile.js';
const root=resolve('..');
async function stop(child:ChildProcess,ipc?:string){
 if(child.exitCode!==null)return;const ended=once(child,'exit');
 if(ipc&&child.connected)child.send(ipc);else child.kill();const timer=setTimeout(()=>child.kill(),15000);try{await ended;}finally{clearTimeout(timer);}
}
async function ready(url:string,cert:Buffer){return await new Promise<boolean>(done=>{const req=httpsRequest(url,{ca:cert,servername:'localhost',timeout:500},res=>{res.resume();res.once('end',()=>done(res.statusCode===200));});req.on('error',()=>done(false));req.on('timeout',()=>req.destroy());req.end();});}
test('S05 P04 actual installed integration',{timeout:900000},async t=>{
 const group=await profile(),children:ChildProcess[]=[];
 const shutdown=async()=>{for(const c of children.splice(0).reverse())await stop(c,c.connected?'LOCAL_DEV_STOP':undefined);await group.dispose();};
 let interruption:Promise<void>|undefined;const signal=()=>{interruption=shutdown();};process.once('SIGINT',signal);process.once('SIGTERM',signal);
 const focus=process.env['S05_P04_FOCUS'];
 // eslint-disable-next-line security/detect-non-literal-regexp -- Author-only impact selection.
 const selected=focus?new RegExp(focus):null;
 const scenario=async(name:string,fn:(ctx:TestContext)=>Promise<void>)=>{await t.test(name,{skip:selected?!selected.test(name):false},fn);};
 try{
 await scenario('AT15: registered group guards, live lease and partial setup cleanup',async()=>{
  const {assertOwnUri}=await import('./p04-profile.js');for(const u of ['mongodb://remote.invalid:27017','mongodb://127.0.0.1:27181','mongodb://127.0.0.1:27017/caudelyx_dev'])assert.throws(()=>assertOwnUri(u));
  const release=group.hold();await assert.rejects(group.dispose(),/lease/);release();await assert.rejects(group.fixture({failSetup:true}),/partial setup/);
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
    const f=await fundedSetup(group,new Date().toISOString()),https=await f.https();
    const other=await f.tenant(await f.newActor());
    const nonce=randomUUID(),browserResults:unknown[]=[];let finalLoan='',finalToken='';
    const control=controlServer((req,res)=>{
      if(req.headers['x-p04-owner']!==nonce){res.writeHead(403).end();return;}
      const run=async()=>{
        if(req.url==='/session'){res.end(JSON.stringify({token:f.a.issued.token,foreignToken:other.actor.issued.token,org:f.org,account:f.account,password,profile:f.profile,date:today(f.now())}));return;}
        if(req.url==='/tick'){f.clock.value+=30000;res.end(JSON.stringify({code:await generate({secret:f.a.secret,epoch:Math.floor(f.now()/1000)})}));return;}
        if(req.url==='/check'){
          const chunks:Buffer[]=[];for await(const b of req)chunks.push(Buffer.from(b as Uint8Array));
          const body=JSON.parse(Buffer.concat(chunks).toString()) as {phase:string;loan:string;token?:string};
          const events=await f.ops.events.find({organizationId:f.org}).toArray(),journals=await f.runtime.finance.journals.find({organizationId:f.org}).toArray();
          if(body.phase==='terms'){assert.equal(events.length,0);assert.equal(journals.length,1);}
          if(body.phase==='funding'){assert.equal(events.length,1);assert.equal(journals.length,2);assert.equal(events[0]!.kind,'DISBURSE');assert.equal(events[0]!.plan.postings.some(p=>p.accountId===f.profile.interestIncomeAccountId),false);}
          if(body.phase==='complete'){
            assert.equal(events.length,4);assert.equal(journals.length,5);
            const p=await f.ops.positions.findOne({loanId:body.loan});assert.ok(p);assert.equal(p.principalOutstanding,'1710000.00');assert.equal(events.flatMap(e=>e.plan.accruals).reduce((n,a)=>n+BigInt(a.interest.replace('.','')),0n),6000000n);assert.equal(events.flatMap(e=>e.plan.allocations).filter(a=>a.component==='INTEREST').reduce((n,a)=>n+BigInt(a.amount.replace('.','')),0n),6000000n);
            const credit=await f.ops.credits.findOne({borrowerId:p.borrowerId});assert.equal(credit?.balance,'50000.00');
            const totals=new Map<string,bigint>();for(const j of journals){let dr=0n,cr=0n;for(const l of j.lines){const d=BigInt(l.debit.toString().replace('.','')),c=BigInt(l.credit.toString().replace('.',''));dr+=d;cr+=c;totals.set(l.accountId,(totals.get(l.accountId)??0n)+d-c);}assert.equal(dr,cr);}
            assert.equal(totals.get(f.account),1840000000n);assert.equal(totals.get(f.profile.principalAccountId),171000000n);assert.equal(totals.get(f.profile.interestIncomeAccountId),-6000000n);assert.equal(totals.get(f.profile.interestReceivableAccountId),0n);assert.equal(totals.get(f.profile.borrowerCreditAccountId),-5000000n);
            assert.equal(await operationsEvidenceMatches(f.database),true);assert.equal(await lendingEvidenceMatches(f.database,(await head(f.database))!),true);
            finalLoan=body.loan;finalToken=body.token!;await f.restore.flush();
          }
          browserResults.push({phase:body.phase,events:events.length,journals:journals.length});res.end(JSON.stringify({ok:true}));return;
        }
        res.writeHead(404).end();
      };void run().catch(e=>{console.error('P04 control assertion',e);res.writeHead(500).end(JSON.stringify({error:'P04_ASSERTION'}));});
    });
    await group.receipt({event:'control-reserved-before-listen',port:0});control.listen(0,'127.0.0.1');await once(control,'listening');const address=control.address();assert.ok(address&&typeof address!=='string');
    await group.receipt({event:'control-created',port:address.port});
    const env={...process.env,CAUDELYX_MODE:'local-synthetic',CAUDELYX_DEV_TEST_ID:group.id,MONGODB_URI:group.uri,MONGODB_DATABASE:group.names[0],CAUDELYX_DEV_UI_PORT:'47231',CAUDELYX_DEV_API_PORT:'47232',CAUDELYX_DEV_PLATFORM_PORT:'47233',CAUDELYX_DEV_TLS_DIRECTORY:join(group.folder,'tls')};
    try{
      const vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','localhost','--port','47231','--strictPort'],{cwd:join(root,'cliente'),env,windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(vite);await group.receipt({event:'own-vite-created',pid:vite.pid,port:47231});
      const deadline=Date.now()+25000;while(!await ready('https://localhost:47231',https.cert)){if(Date.now()>deadline||vite.exitCode!==null)throw Error('Own UI readiness failed');await new Promise(r=>setTimeout(r,200));}
      await scenario('AT01–15: actual browser UI, uncertain replay, due accrual, collection, credit and exact ledger',async()=>{
        const browser=spawn(process.execPath,['node_modules/@playwright/test/cli.js','test','--config','tests/integration/s05-p04.config.ts'],{cwd:join(root,'cliente'),env:{...env,P04_URL:'https://localhost:47231',P04_CONTROL:`http://127.0.0.1:${address.port}`,P04_OWNER:nonce,P04_OUTPUT:group.folder,P04_VISUAL:resolve(output,'S05-P04-VISUAL.png')},windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(browser);await group.receipt({event:'own-browser-created',pid:browser.pid});browser.stdout?.on('data',b=>process.stdout.write(b));browser.stderr?.on('data',b=>process.stderr.write(b));const [code]=await once(browser,'exit');assert.equal(code,0);assert.ok(finalLoan);
      });
    }finally{for(const c of children.splice(0).reverse())await stop(c);await new Promise<void>(r=>control.close(()=>r()));await f.restore.flush();await group.closeConsumers();await writeFile(resolve(output,'S05-P04-BROWSER.json'),JSON.stringify({results:browserResults,complete:Boolean(finalLoan)},null,2));}
    await scenario('AT14/15: npm run dev actual HTTPS and native restart preserves money, sessions and integrity',async()=>{
      assert.ok(finalLoan,'Browser must finish before native persistence test');
      const npm=spawn(process.execPath,[join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),'run','dev'],{cwd:root,env:{...env,CAUDELYX_DEV_SMOKE:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(npm);let out='';npm.stdout?.on('data',b=>out+=String(b));npm.stderr?.on('data',b=>out+=String(b));await group.receipt({event:'npm-run-dev-created',pid:npm.pid});const [code]=await once(npm,'exit');assert.equal(code,0,out.slice(-1500));assert.match(out,/S02 LOCAL SINTÉTICO/);await group.receipt({event:'npm-run-dev-https-ready-and-exited',exitCode:code});
      const native=spawn(process.execPath,['scripts/dev.mjs'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});children.push(native);let isReady=false,details='';native.on('message',m=>{if(m==='S02_INSTALLED_READY')isReady=true;});native.stdout?.on('data',b=>details+=String(b));native.stderr?.on('data',b=>details+=String(b));await group.receipt({event:'native-restart-created',pid:native.pid});const deadline=Date.now()+60000;while(!isReady){if(Date.now()>deadline||native.exitCode!==null)throw Error('Native restart failure '+details.slice(-1500));await new Promise(r=>setTimeout(r,200));}
      const client=new ApiClient(47232,await readFile(join(group.folder,'tls/cert.pem')));client.cookies.set('__Host-caudelyx-session',finalToken);const read=await client.call('GET',`/api/v1/organizations/${f.org}/loan-operations/positions/${finalLoan}`,undefined,{Host:'localhost:47231',Origin:'https://localhost:47231'});assert.equal(read.status,200);assert.equal(read.body.data?.['principalOutstanding'],'1710000.00');assert.equal(read.body.data?.['accruedInterestTotal'],'60000.00');await stop(native,'LOCAL_DEV_STOP');await assert.rejects(access(join(group.folder,'runner.lock')));await group.receipt({event:'native-persistence-verified-and-stopped',principal:'1710000.00',accruedInterest:'60000.00'});
    });
  }finally{process.removeListener('SIGINT',signal);process.removeListener('SIGTERM',signal);await shutdown();if(interruption)await interruption;}
});

// Exercise the same cancellation path with a live owned consumer, without signalling another PID.
test('S05 P04 interruption cleanup',{timeout:30000},async()=>{
 const group=await profile();let completion:Promise<void>|undefined;
 const interrupt=()=>{completion=group.dispose();};
 process.once('SIGINT',interrupt);
 try{await group.fixture();await group.receipt({event:'controlled-interruption-with-live-consumer'});process.emit('SIGINT');assert.ok(completion);await completion;await assert.rejects(access(group.folder));}
 finally{process.removeListener('SIGINT',interrupt);await group.dispose();}
});
