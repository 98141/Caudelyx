import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { financeFixture } from './fixture.js';
import { etag,today } from '../../src/modules/finance/service.js';
import { RestoreController } from '../../src/shared/restore.js';
import { ApiClient } from '../helpers/client.js';
import { generate } from 'otplib';
import { rename } from 'node:fs/promises';
import type { Result } from '../../src/modules/finance/models.js';

const data=(r:Result)=>r.data as Record<string,unknown>;
const error=(code:string)=>(e:unknown)=>e instanceof Error&&'code'in e&&e.code===code;
const account=(code:string,kind='GENERAL',accountClass='EQUITY')=>({code,name:`Cuenta ${code}`,accountClass,kind,currency:'COP'});
const posting=(date:string,bank:string,equity:string,amount='100.00')=>({currency:'COP',effectiveDate:date,sourceId:randomUUID(),supportReference:'Soporte sintético',description:'Aporte sintético',lines:[{accountId:bank,debit:amount,credit:'0.00'},{accountId:equity,debit:'0.00',credit:amount}]});
const setup=async()=>{
  const f=await financeFixture();try{
    const a=await f.actor(),org=await f.organization(a);
    const bank=String(data(await f.mutate(a,org,'createAccount',account('BANK','BANK','ASSET'))).id);
    const cash=String(data(await f.mutate(a,org,'createAccount',account('CASH','CASH','ASSET'))).id);
    const equity=String(data(await f.mutate(a,org,'createAccount',account('EQUITY'))).id);
    return{f,a,org,bank,cash,equity,date:today(f.now())};
  }catch(e){await f.close();throw e;}
};

test('AT04/05/11: exact Decimal128 postings, immutable accounts, dates and repeatable balances',{timeout:120000},async()=>{
  const {f,a,org,bank,cash,equity,date}=await setup();try{
    const first=await f.mutate(a,org,'postJournal',{...posting(date,bank,equity,'0.30'),lines:[{accountId:bank,debit:'0.10',credit:'0.00'},{accountId:cash,debit:'0.20',credit:'0.00'},{accountId:equity,debit:'0.00',credit:'0.30'}]});
    assert.equal(first.status,201);const stored=await f.runtime.finance.journals.findOne({_id:String(data(first).id)});assert.equal(stored?.lines[0]?.debit._bsontype,'Decimal128');
    const balances=data(await f.runtime.finance.read(a.issued.context,'balances',org,undefined,{asOf:date}));const cut=String(balances.recordedThrough);
    assert.equal((balances.items as Record<string,string>[]).find(b=>b.accountId===bank)?.naturalBalance,'0.10');
    await f.mutate(a,org,'postJournal',posting(date,bank,equity,'1.00'));
    assert.deepEqual(data(await f.runtime.finance.read(a.issued.context,'balances',org,undefined,{asOf:date,recordedThrough:cut})),balances);
    for(const input of [{...posting(date,bank,equity),lines:[{accountId:bank,debit:'1.005',credit:'0.00'},{accountId:equity,debit:'0.00',credit:'1.00'}]},
      {...posting(date,bank,equity),lines:[{accountId:bank,debit:1,credit:'0.00'},{accountId:equity,debit:'0.00',credit:'1.00'}]},
      {...posting(date,bank,equity),effectiveDate:'2099-01-01'}])await assert.rejects(f.mutate(a,org,'postJournal',input),error('INPUT_INVALID'));
    await assert.rejects(f.mutate(a,org,'postJournal',{...posting(date,bank,equity),lines:[{accountId:bank,debit:'0.01',credit:'0.00'},{accountId:equity,debit:'0.00',credit:'0.02'}]}),error('UNBALANCED_ENTRY'));
    await assert.rejects(f.mutate(a,org,'createAccount',account('BANK','BANK','ASSET')),error('INPUT_INVALID'));
    const before=data(await f.runtime.finance.read(a.issued.context,'readAccount',org,bank));
    await assert.rejects(f.runtime.finance.mutate(a.issued.context,'renameAccount',org,{name:'Nombre'},randomUUID(),bank),error('ETAG_REQUIRED'));
    await assert.rejects(f.mutate(a,org,'renameAccount',{name:'Nombre'},{id:bank,etag:'"stale"'}),error('PRECONDITION_FAILED'));
    const renamed=await f.mutate(a,org,'renameAccount',{name:' Nombre '},{id:bank,etag:`"${bank}:1"`});assert.equal(data(renamed).version,2);assert.equal(data(renamed).name,'Nombre');
    assert.equal(data(await f.mutate(a,org,'renameAccount',{name:'Nombre'},{id:bank,etag:renamed.etag!})).version,2);assert.equal(before.version,1);
    const large=posting('2020-01-01',bank,equity,'9999999999999999.99');await assert.rejects(f.mutate(a,org,'postJournal',large),error('INPUT_INVALID')); // existing totals would exceed range
    assert.equal(await f.runtime.finance.journals.countDocuments(),2);
  }finally{await f.close();}
});

test('AT06: two real R, simultaneous replay, changed payload/source conflicts, one-use R',{timeout:120000},async()=>{
  const {f,a,org,bank,equity,date}=await setup();try{
    const second=await f.login(a),payload=posting(date,bank,equity),key=randomUUID(),command={organizationId:org,idempotencyKey:key,payload};
    await f.proof(a,'FINANCE_JOURNAL_POST',command);await f.proof(second,'FINANCE_JOURNAL_POST',command);
    const results=await Promise.all([a,second].map(actor=>f.runtime.finance.mutate(actor.issued.context,'postJournal',org,payload,key)));
    assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);assert.deepEqual(data(results[0]!),data(results[1]!));assert.equal(await f.runtime.finance.journals.countDocuments(),1);
    const altered={...payload,description:'Distinto'};await assert.rejects(f.mutate(a,org,'postJournal',altered,{key}),error('IDEMPOTENCY_CONFLICT'));
    await assert.rejects(f.mutate(a,org,'postJournal',payload),error('SOURCE_CONFLICT'));
    const same=posting(date,bank,equity,'0.01'),sameKey=randomUUID();await f.proof(a,'FINANCE_JOURNAL_POST',{organizationId:org,idempotencyKey:sameKey,payload:same});
    const oneUse=await Promise.allSettled([1,2].map(()=>f.runtime.finance.mutate(a.issued.context,'postJournal',org,same,sameKey)));
    assert.equal(oneUse.filter(r=>r.status==='fulfilled').length,1);assert.equal(await f.runtime.finance.journals.countDocuments(),2);
    assert.equal(await f.database.db.collection('audit_events').countDocuments({action:'FINANCE_postJournal'}),2);
  }finally{await f.close();}
});

test('AT07: real Mongo audit failure rolls back domain/idempotency/outbox/proof; concurrent debits cannot overdraw',{timeout:120000},async()=>{
  const {f,a,org,bank,cash,equity,date}=await setup();try{
    const payload=posting(date,bank,equity),key=randomUUID();await f.proof(a,'FINANCE_JOURNAL_POST',{organizationId:org,idempotencyKey:key,payload});
    const count=await f.runtime.finance.idempotency.countDocuments(),outbox=await f.database.db.collection('outbox').countDocuments();
    await f.database.db.command({collMod:'audit_events',validator:{$expr:{$ne:['$action','FINANCE_postJournal']}}});
    try{await assert.rejects(f.runtime.finance.mutate(a.issued.context,'postJournal',org,payload,key));}finally{await f.database.db.command({collMod:'audit_events',validator:{}});}
    assert.equal(await f.runtime.finance.journals.countDocuments(),0);assert.equal(await f.runtime.finance.idempotency.countDocuments(),count);assert.equal(await f.database.db.collection('outbox').countDocuments(),outbox);assert.equal((await f.context(a.issued.context)).reauth?.consumed,false);
    await f.runtime.finance.mutate(a.issued.context,'postJournal',org,payload,key);
    const b=await f.login(a);const transfer={currency:'COP',effectiveDate:date,sourceId:randomUUID(),supportReference:'Prueba',description:'Transferencia',fromAccountId:bank,toAccountId:cash,amount:'75.00'};
    const firstKey=randomUUID(),secondKey=randomUUID(),other={...transfer,sourceId:randomUUID()};
    await f.proof(a,'FINANCE_TRANSFER',{organizationId:org,idempotencyKey:firstKey,payload:transfer});await f.proof(b,'FINANCE_TRANSFER',{organizationId:org,idempotencyKey:secondKey,payload:other});
    const race=await Promise.allSettled([f.runtime.finance.mutate(a.issued.context,'createTransfer',org,transfer,firstKey),f.runtime.finance.mutate(b.issued.context,'createTransfer',org,other,secondKey)]);
    assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.ok(race.some(r=>r.status==='rejected'&&error('ACCOUNT_OVERDRAFT')(r.reason)));assert.equal(await f.runtime.finance.journals.countDocuments(),2);
  }finally{await f.close();}
});

test('AT08/09/11: transfer and compensating reversal preserve original and dated totals; retroactive overdraft rejected',{timeout:120000},async()=>{
  const {f,a,org,bank,cash,equity}=await setup();try{
    await f.mutate(a,org,'postJournal',posting('2020-01-01',bank,equity));
    const transfer=await f.mutate(a,org,'createTransfer',{currency:'COP',effectiveDate:'2020-01-02',sourceId:randomUUID(),supportReference:'Prueba',description:'Transferencia',fromAccountId:bank,toAccountId:cash,amount:'25.50'});
    const id=String(data(transfer).id),original=data(await f.runtime.finance.read(a.issued.context,'readJournal',org,id));
    const at=(date:string)=>f.runtime.finance.read(a.issued.context,'balances',org,undefined,{asOf:date});
    const at2=data(await at('2020-01-02')).items as Record<string,string>[];
    assert.equal(at2.find(b=>b.accountId===bank)?.naturalBalance,'74.50');assert.equal(at2.find(b=>b.accountId===cash)?.naturalBalance,'25.50');
    const page=data(await f.runtime.finance.read(a.issued.context,'listJournals',org,undefined,{limit:'1',asOf:'2020-01-02'}));assert.equal(typeof page.nextCursor,'string');
    const next=data(await f.runtime.finance.read(a.issued.context,'listJournals',org,undefined,{limit:'1',asOf:'2020-01-02',cursor:page.nextCursor}));assert.equal((next.items as Record<string,unknown>[])[0]?.id,id);assert.equal(next.nextCursor,null);
    await assert.rejects(f.runtime.finance.read(a.issued.context,'listJournals',org,undefined,{limit:'1',asOf:'2020-01-01',cursor:page.nextCursor}),error('INPUT_INVALID'));
    const reversal={effectiveDate:'2020-01-03',sourceId:randomUUID(),supportReference:'Prueba',reason:'Compensación sintética'},key=randomUUID();
    const reversed=await f.mutate(a,org,'reverseJournal',reversal,{key,id,etag:transfer.etag!});assert.equal(data(reversed).reversalOfId,id);
    const replay=await f.mutate(a,org,'reverseJournal',reversal,{key,id,etag:transfer.etag!});assert.equal(replay.status,200);assert.deepEqual(data(replay),data(reversed));
    await assert.rejects(f.mutate(a,org,'reverseJournal',{...reversal,sourceId:randomUUID()},{id,etag:transfer.etag!}),error('ALREADY_REVERSED'));
    await assert.rejects(f.mutate(a,org,'reverseJournal',{...reversal,sourceId:randomUUID()},{id:String(data(reversed).id),etag:reversed.etag!}),error('INPUT_INVALID'));
    assert.deepEqual(data(await f.runtime.finance.read(a.issued.context,'readJournal',org,id)),original);
    const at3=data(await at('2020-01-03')).items as Record<string,string>[];assert.equal(at3.find(b=>b.accountId===bank)?.naturalBalance,'100.00');assert.equal(at3.find(b=>b.accountId===cash)?.naturalBalance,'0.00');
    // A new backdated withdrawal cannot rely on future funds to hide a negative earlier cut.
    await assert.rejects(f.mutate(a,org,'createTransfer',{currency:'COP',effectiveDate:'2019-12-31',sourceId:randomUUID(),supportReference:'Prueba',description:'Retroactivo',fromAccountId:bank,toAccountId:cash,amount:'0.01'}),error('ACCOUNT_OVERDRAFT'));
    assert.equal(await f.runtime.finance.journals.countDocuments(),3);
  }finally{await f.close();}
});

test('AT10/12: tenants/roles/realm/provisional/R binding/expiry, current role revocation and opaque cursor binding',{timeout:120000},async()=>{
  const {f,a,org,bank,equity,date}=await setup();try{
    const other=await f.actor(),orgB=await f.organization(other);
    await assert.rejects(f.runtime.finance.read(a.issued.context,'listAccounts',orgB),error('RESOURCE_NOT_FOUND'));
    const foreign=String(data(await f.mutate(other,orgB,'createAccount',account('OTHER'))).id);
    await assert.rejects(f.runtime.finance.read(a.issued.context,'readAccount',org,foreign),error('RESOURCE_NOT_FOUND'));
    const foreignPayload=posting(date,bank,foreign),foreignKey=randomUUID();await f.proof(a,'FINANCE_JOURNAL_POST',{organizationId:org,idempotencyKey:foreignKey,payload:foreignPayload});
    await assert.rejects(f.runtime.finance.mutate(a.issued.context,'postJournal',org,foreignPayload,foreignKey),error('RESOURCE_NOT_FOUND'));
    assert.equal((await f.context(a.issued.context)).reauth?.consumed,false);assert.equal(await f.runtime.finance.journals.countDocuments(),0);
    const bound=posting(date,bank,equity),boundKey=randomUUID();await f.proof(a,'FINANCE_JOURNAL_POST',{organizationId:org,idempotencyKey:boundKey,payload:bound});
    for(const changed of [{...bound,effectiveDate:'2020-01-01'},{...bound,sourceId:randomUUID()}, {...bound,lines:[{accountId:bank,debit:'99.00',credit:'0.00'},{accountId:equity,debit:'0.00',credit:'99.00'}]}])await assert.rejects(f.runtime.finance.mutate(a.issued.context,'postJournal',org,changed,boundKey),error('R_REQUIRED'));
    await assert.rejects(f.mutate(a,org,'createAccount',{...account('INJECTED'),ownerId:orgB}),error('INPUT_INVALID'));
    await assert.rejects(f.runtime.finance.read(a.issued.context,'listAccounts',org,undefined,{scope:'PERSONAL'}),error('INPUT_INVALID'));
    for(const role of ['A','O','C','P','L','SA']){await f.identity.identities.updateOne({_id:a.issued.context.subjectId!},{$set:{roles:[role]}});await assert.rejects(f.runtime.finance.read(a.issued.context,'listAccounts',org),error('ACCESS_DENIED'));}
    await f.identity.identities.updateOne({_id:a.issued.context.subjectId!},{$set:{roles:['T']}});
    await assert.rejects(f.runtime.finance.read({...a.issued.context,realm:'PLATFORM'},'listAccounts',org),error('ACCESS_DENIED'));
    const p=await f.sessions.issue('TENANT','P',null);await assert.rejects(f.runtime.finance.read(p.context,'listAccounts',org),error('AUTH_INVALID'));
    const login=await f.identity.login('TENANT',randomUUID(),a.email,f.password);await assert.rejects(f.runtime.finance.read(login.issued.context,'listAccounts',org),error('AUTH_INVALID'));
    await f.runtime.organizations.organizations.updateOne({_id:org},{$set:{status:'SUSPENDED'}});
    await assert.rejects(f.runtime.finance.read(a.issued.context,'listAccounts',org),error('ACCESS_DENIED'));
    await f.runtime.organizations.organizations.updateOne({_id:org},{$set:{status:'ACTIVE'}});
    const payload=account('NEW'),key=randomUUID();await f.proof(a,'FINANCE_ACCOUNT_CREATE',{organizationId:org,idempotencyKey:key,payload});
    await assert.rejects(f.runtime.finance.mutate(a.issued.context,'createAccount',org,{...payload,name:'Sustituido'},key),error('R_REQUIRED'));assert.equal((await f.context(a.issued.context)).reauth?.consumed,false);
    await assert.rejects(f.runtime.finance.mutate(a.issued.context,'createAccount',org,payload,randomUUID()),error('R_REQUIRED'));
    f.clock.value+=300001;await assert.rejects(f.runtime.finance.mutate(a.issued.context,'createAccount',org,payload,key),error('R_REQUIRED'));
    const bankRow=await f.runtime.finance.accounts.findOne({_id:bank});assert.ok(bankRow);
    const renameKey=randomUUID(),renamePayload={name:'Renombrada'};await f.proof(a,'FINANCE_ACCOUNT_UPDATE',{organizationId:org,idempotencyKey:renameKey,expectedETag:etag(bankRow),payload:renamePayload},bank.toUpperCase());
    await assert.rejects(f.runtime.finance.mutate(a.issued.context,'renameAccount',org,renamePayload,renameKey,bank,'"different"'),error('R_REQUIRED'));
    const page=data(await f.runtime.finance.read(a.issued.context,'listAccounts',org,undefined,{limit:'1'}));assert.equal((page.items as unknown[]).length,1);assert.equal(typeof page.nextCursor,'string');
    const page2=data(await f.runtime.finance.read(a.issued.context,'listAccounts',org,undefined,{limit:'1',cursor:page.nextCursor}));assert.notDeepEqual(page.items,page2.items);
    await assert.rejects(f.runtime.finance.read(other.issued.context,'listAccounts',orgB,undefined,{limit:'1',cursor:page.nextCursor}),error('INPUT_INVALID'));
    await assert.rejects(f.runtime.finance.read(a.issued.context,'listAccounts',org,undefined,{limit:'2',cursor:page.nextCursor}),error('INPUT_INVALID'));
    await assert.rejects(f.runtime.finance.read(a.issued.context,'listAccounts',org,undefined,{limit:'1',cursor:String(page.nextCursor).slice(0,-4)+'AAAA'}),error('INPUT_INVALID'));
    // Hold the real security fence, launch a command, then revoke and commit. Retried transaction must reread authorization.
    await f.proof(a,'FINANCE_ACCOUNT_CREATE',{organizationId:org,idempotencyKey:key,payload});
    const session=f.database.client.startSession();session.startTransaction();
    await f.database.db.collection<{_id:string;value:number}>('transaction_fence').updateOne({_id:'security'},{$inc:{value:1}},{session});
    const pending=f.runtime.finance.mutate(a.issued.context,'createAccount',org,payload,key);const outcome=assert.rejects(pending,error('AUTH_INVALID'));
    await f.identity.identities.updateOne({_id:a.issued.context.subjectId!},{$set:{roles:['A'],authzVersion:randomUUID()}},{session});await session.commitTransaction();await session.endSession();await outcome;
    assert.equal(await f.runtime.finance.accounts.countDocuments({code:'NEW'}),0);assert.ok(await f.runtime.finance.accounts.findOne({_id:bank}));
  }finally{await f.close();}
});

test('AT06/12: two actual backend processes, shared signed journal/background dispatch and one financial effect',{timeout:120000},async()=>{
  const {f,a,org,bank,equity,date}=await setup();try{
    const other=await f.login(a),payload=posting(date,bank,equity,'0.01'),key=randomUUID(),command={organizationId:org,idempotencyKey:key,payload};
    await f.proof(a,'FINANCE_JOURNAL_POST',command);await f.proof(other,'FINANCE_JOURNAL_POST',command);await f.restore.flush();
    await f.https(a); // Own generated TLS is reused by both native children; manual TLS is untouched.
    const first=await f.native(a),second=await f.native(other),url=`/api/v1/organizations/${org}/financial/journal-entries`;
    const results=await Promise.all([first.client,second.client].map(client=>client.call('POST',url,payload,{'Idempotency-Key':key})));
    assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);assert.deepEqual(results[0]?.body.data,results[1]?.body.data);
    assert.equal(await f.runtime.finance.journals.countDocuments(),1);
    // Wait for the real one-second dispatchers; do not disable background work to obtain a pass.
    await new Promise(r=>setTimeout(r,1200));
    for(const client of [first.client,second.client])assert.equal((await client.call('GET',`/api/v1/organizations/${org}/financial/balances?asOf=${date}`)).status,200);
  }finally{await f.close();}
});

test('AT12 HTTP: real HTTPS/A32/A27/CSRF/schema errors and financial routes, no password-only or PLATFORM access',{timeout:120000},async()=>{
  const {f,a,org}=await setup();try{
    const {client,port,cert}=await f.https(a),base=`/api/v1/organizations/${org}/financial`;
    const payload=account('HTTP'),key=randomUUID(),command={organizationId:org,idempotencyKey:key,payload};
    assert.equal((await client.call('POST','/api/v1/auth/reauthenticate',{password:f.password,purpose:'FINANCE_ACCOUNT_CREATE',command})).status,200);
    f.clock.value+=30000;
    const factor=await client.call('POST','/api/v1/auth/mfa/challenges/verify',{method:'TOTP',purpose:'FINANCE_ACCOUNT_CREATE',code:await generate({secret:a.secret,epoch:Math.floor(f.now()/1000)})});assert.equal(factor.status,200);
    await client.refreshCsrf();
    assert.equal((await client.call('POST',`${base}/accounts`,payload,{'Idempotency-Key':key,'X-CSRF-Token':'invalid'})).status,400);
    const created=await client.call('POST',`${base}/accounts`,payload,{'Idempotency-Key':key});assert.equal(created.status,201);assert.ok(created.headers.etag);assert.deepEqual(Object.keys(created.body).sort(),['data','requestId']);
    const invalidJson=await client.call('POST',`${base}/accounts`,null,{'Idempotency-Key':randomUUID()});assert.equal(invalidJson.status,400);assert.deepEqual(Object.keys(invalidJson.body.error??{}),['code']);assert.equal(invalidJson.body.error?.code,'INPUT_INVALID');
    assert.equal((await client.call('GET',`${base}/accounts?scope=PERSONAL`)).status,422);assert.equal((await client.call('GET',`${base}/accounts?limit=1`)).status,200);
    assert.equal((await client.call('POST',`${base}/accounts`,{...payload,balance:'100.00'},{'Idempotency-Key':randomUUID()})).status,422);
    const anon=new ApiClient(port,cert);await anon.refreshCsrf();assert.equal((await anon.call('GET',`${base}/accounts`)).status,401);
    const platform=new ApiClient(port,cert,'platform.localhost');assert.equal((await platform.call('GET',`${base}/accounts`)).status,403);
    const failed=await client.call('POST',`${base}/accounts`,payload,{'Idempotency-Key':key});assert.equal(failed.status,403);assert.deepEqual(Object.keys(failed.body.error??{}),['code']);
    const self=await client.call('GET','/api/v1/auth/me');assert.equal(self.status,200);
  }finally{await f.close();}
});

test('AT12 restore: historical financial loss cannot be reopened by security-only reconcile; signed evidence intact',{timeout:120000},async()=>{
  const {f,a,org,bank,equity,date}=await setup();try{
    const snapshot=await f.restore.snapshot();await f.mutate(a,org,'postJournal',posting(date,bank,equity));await f.restore.flush();
    const before=await f.restore.fileJournal.readVerified(true);assert.ok(before.some(e=>e.state.finance));
    await f.restore.beginRestore(snapshot);assert.equal(f.restore.isOpen(),false);
    await assert.rejects(f.restore.reconcile({approved:true,reviewId:'synthetic-review'}),error('SERVICE_UNAVAILABLE'));assert.equal(f.restore.isOpen(),false);
    await assert.rejects(f.runtime.finance.read(a.issued.context,'listAccounts',org),error('SERVICE_UNAVAILABLE'));assert.equal(await f.runtime.finance.journals.countDocuments(),0);
    const restarted=new RestoreController(f.database,f.restore.gatePath,f.keys.journal);await restarted.initialize();assert.equal(restarted.isOpen(),false);
    assert.deepEqual(await f.restore.fileJournal.readVerified(true),before);
  }finally{await f.close();}
});

test('AT12 restore: complete financial snapshot reconciles; subsequent missing/altered primary financial data closes on restart',{timeout:120000},async()=>{
  const {f,a,org,bank,equity,date}=await setup();try{
    const result=await f.mutate(a,org,'postJournal',posting(date,bank,equity));const snapshot=await f.restore.snapshot();
    await f.restore.beginRestore(snapshot);await f.restore.reconcile({approved:true,reviewId:'synthetic-complete-cut'});assert.equal(f.restore.isOpen(),true);
    assert.equal(await f.runtime.finance.journals.countDocuments(),1);assert.equal(etag((await f.runtime.finance.journals.findOne({_id:String(data(result).id)}))!),result.etag);
    // Alter only this fixture's account: signed evidence must prevent accepting it after restart.
    await f.runtime.finance.accounts.updateOne({_id:bank},{$set:{name:'Tampered fixture'}});
    const restarted=new RestoreController(f.database,f.restore.gatePath,f.keys.journal);await restarted.initialize();assert.equal(restarted.isOpen(),false);
  }finally{await f.close();}
});

test('AT12 restore: absent external file after financial commit stays closed without manufacturing evidence',{timeout:120000},async()=>{
  const {f,a,org,bank,equity,date}=await setup();try{
    await f.mutate(a,org,'postJournal',posting(date,bank,equity));await f.restore.flush();
    const path=f.restore.gatePath+'.journal.jsonl',withheld=path+'.withheld';
    // Rename only this fixture's generated file; retain and restore it, never delete historical evidence.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await rename(path,withheld);
    try{
      const restarted=new RestoreController(f.database,f.restore.gatePath,f.keys.journal);await restarted.initialize();assert.equal(restarted.isOpen(),false);
      await assert.rejects(f.runtime.finance.read(a.issued.context,'listAccounts',org),error('SERVICE_UNAVAILABLE'));
    }finally{
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Restore the same exact fixture file.
      await rename(withheld,path);
    }
  }finally{await f.close();}
});

test('AT12 restore: orphan financial idempotency without signed domain evidence cannot reopen',{timeout:120000},async()=>{
  const f=await financeFixture();try{
    await f.database.db.collection('financial_idempotency').insertOne({organizationId:randomUUID(),actorId:randomUUID(),operation:'createAccount',key:randomUUID(),hash:'synthetic-orphan',result:{status:201,data:{id:randomUUID()}}});
    const restarted=new RestoreController(f.database,f.restore.gatePath,f.keys.journal);await restarted.initialize();assert.equal(restarted.isOpen(),false);
  }finally{await f.close();}
});
