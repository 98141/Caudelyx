import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Collection} from 'mongodb';
import {generate} from 'otplib';
import {profile,password,errorCode,setup} from './fixture.js';
import {initialBalances} from '../../src/modules/finance/initial-balances.js';
import {today} from '../../src/modules/finance/service.js';
import {BALANCE_PURPOSES,WORK_PURPOSES,SECURITY_PURPOSES} from '../../src/modules/sessions/work-policy.js';

test('MEJ business: initial balance, JIT, purpose enforcement, atomicity and races',async t=>{
  const group=await profile();
  await t.test('never-factor works, records initial balance, JIT retains organization and opens one hour',async()=>{
    const f=await group.fixture(),reg=await f.signup(),confirmed=await f.identity.confirmEmail(reg.issued.context,{purpose:'ACTIVATION',token:reg.token});
    let context=confirmed.issued.context;
    const org=(await f.runtime.organizations.create(context,{name:'Inicial',currency:'COP',timezone:'America/Bogota'},randomUUID())).data.organization.id;
    const account=async(code:string)=>{const r=await f.runtime.finance.mutate(context,'createAccount',org,{code,name:code,currency:'COP',accountClass:'ASSET',kind:'CASH'},randomUUID());return (r.data as {id:string}).id;};
    const one=await account('A'),two=await account('B'),input={effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN',description:'Capital propio',items:[{accountId:one,amount:'100.00'},{accountId:two,amount:'25.50'}]},key=randomUUID();
    const initial=await initialBalances(f.runtime.finance,context,org,input,key),data=initial.data as {capitalAccountId:string;journal:{lines:{debit:string;credit:string}[]}};
    assert.equal(initial.status,201);assert.equal(data.journal.lines.at(-1)?.credit,'125.50');
    assert.equal((await initialBalances(f.runtime.finance,context,org,input,key)).status,200);
    await assert.rejects(initialBalances(f.runtime.finance,context,org,{...input,description:'changed'},key),errorCode('IDEMPOTENCY_CONFLICT'));
    await assert.rejects(initialBalances(f.runtime.finance,context,org,{...input,sourceId:randomUUID()},randomUUID()),errorCode('INITIAL_BALANCE_UNAVAILABLE'));
    const posting={currency:'COP',effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN',description:'Aporte posterior',lines:[{accountId:one,debit:'1.00',credit:'0.00'},{accountId:data.capitalAccountId,debit:'0.00',credit:'1.00'}]},postingKey=randomUUID();
    await assert.rejects(f.runtime.finance.mutate(context,'postJournal',org,posting,postingKey),errorCode('R_REQUIRED'));
    const stepUp={purpose:'FINANCE_JOURNAL_POST',method:'TOTP' as const,command:{organizationId:org,idempotencyKey:postingKey,payload:posting}};
    await assert.rejects(f.identity.work!.prepare(context,stepUp),errorCode('MFA_ENROLLMENT_REQUIRED'));
    const enroll=await f.runtime.totp.enroll(context,'JIT',password,stepUp),secret=new URL(enroll.provisioningUri).searchParams.get('secret')!;
    const completed=await f.runtime.totp.confirm(context,enroll.enrollmentId,await generate({secret,epoch:Math.floor(f.now()/1000)}));context=completed.issued!.context;
    assert.equal((await f.identity.identities.findOne({_id:context.subjectId!}))?.organizationId,org);
    assert.equal(context.balanceGrant?.expiresAt,f.now()+3600000);
    assert.equal((await f.runtime.finance.mutate(context,'postJournal',org,posting,postingKey)).status,201);
    const next={...posting,sourceId:randomUUID()};assert.equal((await f.runtime.finance.mutate(context,'postJournal',org,next,randomUUID())).status,201);
    assert.equal((await f.sessions.contexts.findOne({_id:context._id}))?.balanceGrant?.expiresAt,context.balanceGrant!.expiresAt);
    await assert.rejects(f.database.transaction(async session=>f.sessions.consumeProof(context,'RECOVERY_CODES_REGENERATE',null,session)),errorCode('REAUTH_REQUIRED'));
    f.clock.value+=3600000;await f.sessions.contexts.updateOne({_id:context._id},{$set:{lastSeenAt:f.now()-1000}});
    await assert.rejects(f.runtime.finance.mutate(context,'postJournal',org,{...posting,sourceId:randomUUID()},randomUUID()),errorCode('R_REQUIRED'));
  });
  await t.test('every purpose enforces exact class; money never satisfies security and proofs are one-shot',async()=>{
    const f=await setup(group),context=f.a.issued.context;
    for(const purpose of WORK_PURPOSES)await f.database.transaction(async session=>f.sessions.consumeProof(context,purpose,null,session));
    for(const purpose of [...BALANCE_PURPOSES,...SECURITY_PURPOSES])await assert.rejects(f.database.transaction(async session=>f.sessions.consumeProof(context,purpose,null,session)),errorCode('REAUTH_REQUIRED'));
    await f.proof(f.a,'RECOVERY_CODES_REGENERATE');
    const codes=await f.runtime.recovery.regenerate(f.a.issued.context);assert.equal(codes.codes.length,10);
    await assert.rejects(f.runtime.recovery.regenerate(f.a.issued.context),errorCode('REAUTH_REQUIRED'));
    await f.proof(f.a,'PASSWORD_CHANGE');f.clock.value+=300000;
    await assert.rejects(f.identity.changePassword(f.a.issued.context,{newPassword:password+' nueva'}),errorCode('REAUTH_REQUIRED'));
  });
  await t.test('initial balance races and invalid references never duplicate or cross organizations',async()=>{
    const f=await setup(group),input={effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN',description:'Race',items:[{accountId:f.account,amount:'10.00'}]},key=randomUUID();
    for(const items of [[{accountId:f.account,amount:'0.00'}],[{accountId:f.account,amount:'-1.00'}],[{accountId:randomUUID(),amount:'1.00'}],[...input.items,...input.items]])await assert.rejects(initialBalances(f.runtime.finance,f.a.issued.context,f.org,{...input,items},randomUUID()));
    const results=await Promise.all([initialBalances(f.runtime.finance,f.a.issued.context,f.org,input,key),initialBalances(f.runtime.finance,f.a.issued.context,f.org,input,key)]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:f.org}),1);
    assert.equal(await f.runtime.finance.accounts.countDocuments({organizationId:f.org,name:'Capital inicial'}),1);
    const other=await f.newActor(),own=await f.tenant(other);
    await assert.rejects(initialBalances(f.runtime.finance,other.issued.context,own.org,input,randomUUID()),errorCode('RESOURCE_NOT_FOUND'));
    await f.identity.identities.updateOne({_id:other.issued.context.subjectId!},{$set:{roles:['A']}});
    await assert.rejects(initialBalances(f.runtime.finance,other.issued.context,own.org,{...input,items:[{accountId:own.account,amount:'1.00'}]},randomUUID()),errorCode('ACCESS_DENIED'));
  });
  await t.test('initial balance rollback after writes preserves complete pre-state',async()=>{
    for(const location of ['accounts','journals','idempotency','audit','notification']){
      const f=await setup(group),context=f.a.issued.context,input={effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN',description:'Fault',items:[{accountId:f.account,amount:'10.00'}]};
      const target=location==='accounts'?f.runtime.finance.accounts:location==='journals'?f.runtime.finance.journals:location==='idempotency'?f.runtime.finance.idempotency:location==='audit'?f.identity.audit:f.messages;
      const method=location==='audit'?'append':location==='notification'?'notify':'insertOne',original=Reflect.get(target,method) as (...args:unknown[])=>Promise<unknown>;
      Reflect.set(target,method,async(...args:unknown[])=>{await original.apply(target,args);throw Error('MEJ fault after '+location);});
      try{await assert.rejects(initialBalances(f.runtime.finance,context,f.org,input,randomUUID()),/MEJ fault/);}finally{Reflect.set(target,method,original);}
      assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:f.org}),0);
      assert.equal(await f.runtime.finance.accounts.countDocuments({organizationId:f.org,name:'Capital inicial'}),0);
      assert.equal(await f.runtime.finance.idempotency.countDocuments({organizationId:f.org,operation:'initialBalances'}),0);
      assert.equal((await f.database.db.collection<{_id:string;initialBalanceJournalId?:string}>('financial_books').findOne({_id:f.org}))?.['initialBalanceJournalId'],undefined);
    }
  });
  await t.test('grant has exact fixed boundary and is invalid for another session/org, removed factor or changed epoch',async()=>{
    const f=await setup(group),context=f.a.issued.context,subject=(await f.identity.identities.findOne({_id:context.subjectId!}))!;
    await f.proof(f.a,'RECOVERY_CODES_REGENERATE');await f.runtime.recovery.regenerate(f.a.issued.context);
    // A real money verification is prepared against a valid journal command.
    const equity=(await f.runtime.finance.mutate(f.a.issued.context,'createAccount',f.org,{code:'E',name:'Equity',currency:'COP',accountClass:'EQUITY',kind:'GENERAL'},randomUUID())).data as {id:string};
    const payload={currency:'COP',effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN',description:'Boundary',lines:[{accountId:f.account,debit:'1.00',credit:'0.00'},{accountId:equity.id,debit:'0.00',credit:'1.00'}]};
    await f.proof(f.a,'FINANCE_JOURNAL_POST',{organizationId:f.org,idempotencyKey:randomUUID(),payload});const granted=f.a.issued.context,deadline=granted.balanceGrant!.expiresAt;
    const check=()=>f.database.transaction(async session=>f.sessions.consumeProof(granted,'FINANCE_JOURNAL_POST',null,session));
    const other=await f.sessions.issue('TENANT','W',subject);await assert.rejects(f.database.transaction(async session=>f.sessions.consumeProof(other.context,'FINANCE_JOURNAL_POST',null,session)),errorCode('REAUTH_REQUIRED'));
    f.clock.value=deadline-1;await f.sessions.contexts.updateOne({_id:granted._id},{$set:{lastSeenAt:f.now()}});await check();
    assert.equal((await f.sessions.contexts.findOne({_id:granted._id}))!.balanceGrant!.expiresAt,deadline);
    f.clock.value=deadline;await assert.rejects(check(),errorCode('REAUTH_REQUIRED'));
    f.clock.value=deadline-1;await f.sessions.factors.updateOne({_id:granted.balanceGrant!.factorId},{$set:{state:'REVOKED'}});await assert.rejects(check(),errorCode('REAUTH_REQUIRED'));
    await f.sessions.factors.updateOne({_id:granted.balanceGrant!.factorId},{$set:{state:'ACTIVE'}});await f.sessions.contexts.updateOne({_id:granted._id},{$set:{'balanceGrant.organizationId':randomUUID()}});await assert.rejects(check(),errorCode('REAUTH_REQUIRED'));
    await f.identity.identities.updateOne({_id:subject._id},{$set:{authEpoch:randomUUID()}});assert.equal(await f.sessions.find(f.a.issued.token,'TENANT'),null);
  });
  await t.test('initial balance closed limits, capital conflicts and advanced opening cannot create orphan effects',async()=>{
    const f=await setup(group),context=f.a.issued.context,input={effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN',description:'Limits',items:[{accountId:f.account,amount:'10.00'}]};
    const general=(await f.runtime.finance.mutate(context,'createAccount',f.org,{code:'G',name:'General',currency:'COP',accountClass:'ASSET',kind:'GENERAL'},randomUUID())).data as {id:string};
    for(const invalid of [{...input,ownerId:f.org},{...input,effectiveDate:'2199-01-01'},{...input,items:Array.from({length:100},()=>input.items[0])},{...input,items:[{accountId:general.id,amount:'1.00'}]},{...input,items:[{accountId:f.account,amount:'10000000000000000.00'}]}])await assert.rejects(initialBalances(f.runtime.finance,context,f.org,invalid,randomUUID()));
    const fake=await f.runtime.finance.mutate(context,'createAccount',f.org,{code:'CAP_FAKE',name:'Capital inicial',currency:'COP',accountClass:'ASSET',kind:'GENERAL'},randomUUID());
    await assert.rejects(initialBalances(f.runtime.finance,context,f.org,input,randomUUID()),errorCode('INITIAL_BALANCE_CONFLICT'));
    await f.runtime.finance.accounts.updateOne({_id:(fake.data as {id:string}).id},{$set:{name:'Otra'}});
    // State fixture, only to isolate the conflict guard; no opening is executed or synthesized as approved.
    await f.database.db.collection('opening_files').insertOne({organizationId:f.org,status:'DRAFT'});
    await assert.rejects(initialBalances(f.runtime.finance,context,f.org,input,randomUUID()),errorCode('INITIAL_BALANCE_CONFLICT'));
    assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:f.org}),0);assert.equal(await f.runtime.finance.accounts.countDocuments({organizationId:f.org,code:'MEJ_CAPITAL_INICIAL'}),0);
  });

  await t.test('advanced opening replace and cancel remain WORK, with no journal and fresh ETags',async()=>{
    const f=await setup(group),capital=(await f.runtime.finance.mutate(f.a.issued.context,'createAccount',f.org,{code:'E',name:'Patrimonio',accountClass:'EQUITY',kind:'GENERAL',currency:'COP'},randomUUID())).data as {id:string},support=randomUUID();
    const snapshot={cutoffDate:'2020-01-01',supports:[{id:support,reference:'SYN-OPENING',asOfDate:'2020-01-01',declaration:'OWNER_CHECKED'}],references:[],components:[{id:randomUUID(),category:'CASH',accountId:f.account,amount:'100.00',supportIds:[support]},{id:randomUUID(),category:'EQUITY',accountId:capital.id,amount:'100.00',equityKind:'CONTRIBUTED',supportIds:[support]}],historicalInterest:[],informationalHistory:[]};
    const created=await f.runtime.opening.mutate(f.a.issued.context,'createOpening',f.org,{snapshot},randomUUID()),one=created.data as {id:string;version:number};
    const replaced=await f.runtime.opening.mutate(f.a.issued.context,'replaceOpening',f.org,{snapshot,changeReason:'Revisión sintética'},randomUUID(),one.id,created.etag),two=replaced.data as {id:string;version:number};
    await assert.rejects(f.runtime.opening.mutate(f.a.issued.context,'cancelOpening',f.org,{reason:'Cancelación'},randomUUID(),two.id,created.etag),errorCode('PRECONDITION_FAILED'));
    const cancelled=await f.runtime.opening.mutate(f.a.issued.context,'cancelOpening',f.org,{reason:'Cancelación'},randomUUID(),two.id,replaced.etag);assert.equal((cancelled.data as {status:string}).status,'CANCELLED');
    assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:f.org}),0);
  });
  await t.test('JIT exact expiry, factor history and post-RESET outbox failure preserve enrollment transaction',async()=>{
    const f=await group.fixture(),reg=await f.signup(),confirmed=await f.identity.confirmEmail(reg.issued.context,{purpose:'ACTIVATION',token:reg.token}),context=confirmed.issued.context;
    await assert.rejects(f.runtime.totp.enroll(context,'Sin password'),errorCode('AUTH_INVALID'));
    const enrollment=await f.runtime.totp.enroll(context,'Cinco minutos',password),secret=new URL(enrollment.provisioningUri).searchParams.get('secret')!;f.clock.value+=300000;
    await assert.rejects(f.runtime.totp.confirm(context,enrollment.enrollmentId,await generate({secret,epoch:Math.floor(f.now()/1000)})));
    assert.equal((await f.identity.identities.findOne({_id:context.subjectId!}))!.hasEverConfirmedFactor,false);
    await f.identity.identities.updateOne({_id:context.subjectId!},{$set:{resetCompletedAt:f.now()-1}});
    const next=await f.runtime.totp.enroll(context,'RESET notice rollback',password),nextSecret=new URL(next.provisioningUri).searchParams.get('secret')!,notify=f.messages.notify.bind(f.messages);
    f.messages.notify=async(...args:Parameters<typeof notify>)=>{await notify(...args);if(args[2]==='FIRST_FACTOR_AFTER_PASSWORD_RESET')throw Error('MEJ outbox failure');};
    try{await assert.rejects(f.runtime.totp.confirm(context,next.enrollmentId,await generate({secret:nextSecret,epoch:Math.floor(f.now()/1000)})),/MEJ outbox failure/);}finally{f.messages.notify=notify;}
    assert.equal((await f.identity.identities.findOne({_id:context.subjectId!}))!.hasEverConfirmedFactor,false);assert.equal((await f.sessions.factors.findOne({_id:next.enrollmentId}))!.confirmed,false);
    assert.equal(await f.messages.notifications.countDocuments({subjectId:context.subjectId!,kind:'FIRST_FACTOR_AFTER_PASSWORD_RESET'}),0);
  });

  await t.test('initial marker and financial evidence faults roll back the last write boundaries',async()=>{
    for(const at of ['marker','evidence']){
      const f=await setup(group),input={effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN',description:'Last boundary',items:[{accountId:f.account,amount:'1.00'}]},original=Collection.prototype.updateOne;
      Collection.prototype.updateOne=async function(...args:Parameters<typeof original>){const result=await original.apply(this,args);if(at==='marker'&&this.collectionName==='financial_books'&&(args[1] as Record<string,Record<string,unknown>>)['$set']?.['initialBalanceJournalId']||at==='evidence'&&this.collectionName==='financial_evidence_head')throw Error('MEJ last boundary');return result;};
      try{await assert.rejects(initialBalances(f.runtime.finance,f.a.issued.context,f.org,input,randomUUID()),/MEJ last boundary/);}finally{Collection.prototype.updateOne=original;}
      assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:f.org}),0);assert.equal(await f.runtime.finance.accounts.countDocuments({organizationId:f.org,code:'MEJ_CAPITAL_INICIAL'}),0);
      assert.equal((await f.database.db.collection<{_id:string;initialBalanceJournalId?:string}>('financial_books').findOne({_id:f.org}))?.initialBalanceJournalId,undefined);
    }
  });

});
