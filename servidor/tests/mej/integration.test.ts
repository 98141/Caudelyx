import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {BSON} from 'mongodb';
import {generate} from 'otplib';
import {profile,setup,fundedSetup,password,errorCode,view} from './fixture.js';
import {today} from '../../src/modules/finance/service.js';
import {initialBalances} from '../../src/modules/finance/initial-balances.js';
import type {Event,PublicPosition} from '../../src/modules/lending/operations-models.js';

test('MEJ integrated backend: S1–S5, RESET, invitations, two processes and restore',async t=>{
  const group=await profile();
  await t.test('S5: 2M funding, 300k receipt, replay, GET no financial write and full restore revokes W/grant',async()=>{
    const f=await fundedSetup(group),l=await f.loan({principal:'2000000.00'});await f.disburse(l);
    const position=await f.position(l.id),request={kind:'RECEIPT' as const,borrowerId:l.borrowerId,destinationAccountId:f.account,destinationAccountETag:(await f.runtime.finance.read(f.a.issued.context,'readAccount',f.org,f.account)).etag!,receivedAmount:'300000.00',targets:[{loanId:l.id,positionETag:position.etag!,amount:'300000.00',mode:'REGULAR' as const}],excessDisposition:'REJECT' as const,receiptReference:'SYN-'+randomUUID(),effectiveDate:today(f.now()),supportReference:'SYN'};
    const command=await f.make(request),result=await command.execute(),event=(result.data as {event:Event}).event;
    assert.deepEqual(event.plan.allocations.map(x=>[x.component,x.amount]),[['INTEREST','60000.00'],['DUE_PRINCIPAL','240000.00']]);
    assert.equal(((await f.position(l.id)).data as PublicPosition).principalOutstanding,'1760000.00');
    assert.equal((await command.execute()).status,200);
    const state=async()=>{const h=createHash('sha256');for(const name of ['financial_journals','financial_accounts','financial_evidence_head','loan_positions','loan_installments','loan_events','loan_applications','lending_merkle_nodes','lending_merkle_orgs'])h.update(BSON.EJSON.stringify(await f.database.db.collection(name).find().sort({_id:1}).toArray(),{relaxed:false}));return h.digest('hex');};
    const before=await state();await f.position(l.id);await f.ops.read(f.a.issued.context,'listLoanScheduleVersions',f.org,l.id);assert.equal(await state(),before);
    const token=f.a.issued.token,snapshot=await f.restore.snapshot();await f.restore.beginRestore(snapshot);assert.equal(f.restore.isOpen(),false);
    await f.restore.reconcile({approved:true,reviewId:'MEJ-2-OWN-SYNTHETIC-RESTORE'});assert.equal(f.restore.isOpen(),true);assert.equal(await f.sessions.find(token,'TENANT'),null);
    f.a.issued=(await f.identity.login('TENANT',randomUUID(),f.a.email,password)).issued;
    assert.equal(((await f.position(l.id)).data as PublicPosition).principalOutstanding,'1760000.00');
    await assert.rejects(f.database.transaction(async session=>f.sessions.consumeProof(f.a.issued.context,'LOAN_RECEIPT_POST',l.borrowerId,session)),errorCode('REAUTH_REQUIRED'));
  });
  await t.test('S3 opening still uses work for draft/validation/approval and a window for commit',async()=>{
    const f=await fundedSetup(group,'2026-10-31T12:00:00-05:00',true);assert.equal(f.opening?.status,'POSTED');
    assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:f.org}),1);
    await assert.rejects(initialBalances(f.runtime.finance,f.a.issued.context,f.org,{effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN',description:'blocked',items:[{accountId:f.account,amount:'1.00'}]},randomUUID()),errorCode('INITIAL_BALANCE_UNAVAILABLE'));
  });
  await t.test('RESET after organization but never-factor permits JIT and queues notification atomically',async()=>{
    const f=await group.fixture(),reg=await f.signup(),verified=await f.identity.confirmEmail(reg.issued.context,{purpose:'ACTIVATION',token:reg.token}),context=verified.issued.context;
    const org=(await f.runtime.organizations.create(context,{name:'RESET',currency:'COP',timezone:'America/Bogota'},randomUUID())).data.organization.id;
    const anon=await f.sessions.issue('TENANT','P',null);
    await f.identity.requestEmail('TENANT',randomUUID(),'RESET',reg.email,anon.context);await f.identity.dispatchMail();
    const mail=[...f.messages.inbox.values()].find(m=>m.subjectId===context.subjectId&&m.purpose==='RESET')!;assert.ok(mail);
    const preview=await f.identity.reset(anon.context,{mode:'PREVIEW',token:mail.token},randomUUID());assert.equal(preview.warningRequired,false);
    await f.identity.reset(anon.context,{mode:'CONFIRM',token:mail.token,newPassword:password+' nueva',warningAcknowledged:false},randomUUID());
    const logged=await f.identity.login('TENANT',randomUUID(),reg.email,password+' nueva'),enrollment=await f.runtime.totp.enroll(logged.issued.context,'Después RESET',password+' nueva'),secret=new URL(enrollment.provisioningUri).searchParams.get('secret')!;
    await f.runtime.totp.confirm(logged.issued.context,enrollment.enrollmentId,await generate({secret,epoch:Math.floor(f.now()/1000)}));
    assert.equal((await f.identity.identities.findOne({_id:context.subjectId!}))?.organizationId,org);
    assert.equal(await f.messages.notifications.countDocuments({subjectId:context.subjectId!,kind:'FIRST_FACTOR_AFTER_PASSWORD_RESET'}),1);
  });
  await t.test('A12 proof and A15 no-factor confirmed invitee preserve fixed roles; role administration cannot escalate',async()=>{
    const f=await setup(group),reg=await f.signup(),verified=await f.identity.confirmEmail(reg.issued.context,{purpose:'ACTIVATION',token:reg.token}),command={email:reg.email,roleIds:['O']};
    await f.proof(f.a,'MEMBER_INVITE',command,f.org);await f.runtime.organizations.invite(f.a.issued.context,command);await f.identity.dispatchMail();
    const note=[...f.messages.notificationInbox.values()].find(n=>n.kind==='INVITATION'&&n.payload['email']===reg.email)!;assert.ok(note);
    await f.runtime.organizations.accept(verified.issued.context,{mode:'CONFIRM',token:note.payload['token']},randomUUID());
    const target=(await f.identity.identities.findOne({_id:verified.issued.context.subjectId!}))!;assert.equal(target.factorCount,0);assert.equal(target.organizationId,f.org);assert.deepEqual(target.roles,['O']);
    await assert.rejects(f.runtime.finance.read(verified.issued.context,'listAccounts',f.org),errorCode('ACCESS_DENIED'));
    await f.proof(f.a,'MEMBER_ROLE_CHANGE',{roleIds:['A']},target._id);await f.runtime.organizations.roles(f.a.issued.context,target._id,{roleIds:['A']},target.version);
    const admin=(await f.identity.login('TENANT',randomUUID(),reg.email,password)).issued;
    await assert.rejects(f.runtime.organizations.memberCommand(admin.context,f.a.issued.context.subjectId!,'SUSPEND',f.a.issued.context.managementId),errorCode('ACCESS_DENIED'));
  });
  await t.test('transfer and reversal share money window, preserve exact ledger and cannot reopen initial balance',async()=>{
    const f=await setup(group),bank=(await f.runtime.finance.mutate(f.a.issued.context,'createAccount',f.org,{code:'BANK',name:'Banco',accountClass:'ASSET',kind:'BANK',currency:'COP'},randomUUID())).data as {id:string};
    await initialBalances(f.runtime.finance,f.a.issued.context,f.org,{effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN',description:'Capital',items:[{accountId:f.account,amount:'100.00'}]},randomUUID());
    const payload={currency:'COP',effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN',description:'Transferencia',fromAccountId:f.account,toAccountId:bank.id,amount:'25.50'},key=randomUUID();
    await f.proof(f.a,'FINANCE_TRANSFER',{organizationId:f.org,idempotencyKey:key,payload});const posted=await f.runtime.finance.mutate(f.a.issued.context,'createTransfer',f.org,payload,key),id=(posted.data as {id:string}).id;
    const reversal={effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN',reason:'Reversión sintética'};
    assert.equal((await f.runtime.finance.mutate(f.a.issued.context,'reverseJournal',f.org,reversal,randomUUID(),id,posted.etag)).status,201);
    const balances=(await f.runtime.finance.read(f.a.issued.context,'balances',f.org,undefined,{asOf:today(f.now())})).data as {items:{accountId:string;naturalBalance:string}[]};
    assert.equal(balances.items.find(x=>x.accountId===f.account)?.naturalBalance,'100.00');assert.equal(balances.items.find(x=>x.accountId===bank.id)?.naturalBalance,'0.00');
  });
  await t.test('explicit accrual and applying borrower credit require the same financial authorization policy',async()=>{
    const f=await fundedSetup(group),l=await f.loan({principal:'1000.00'});await f.disburse(l);
    const accrual=await f.make({kind:'ACCRUE',loanId:l.id,positionETag:(await f.position(l.id)).etag!,throughDate:today(f.now()),effectiveDate:today(f.now()),supportReference:'SYN-ACCRUE'});assert.equal((await accrual.execute()).status,201);
    const receipt=await f.make({kind:'RECEIPT',borrowerId:l.borrowerId,destinationAccountId:f.account,destinationAccountETag:(await f.runtime.finance.read(f.a.issued.context,'readAccount',f.org,f.account)).etag!,receivedAmount:'220.00',targets:[{loanId:l.id,positionETag:(await f.position(l.id)).etag!,amount:'100.00',mode:'REGULAR'}],excessDisposition:'CREDIT',receiptReference:randomUUID(),effectiveDate:today(f.now()),supportReference:'SYN-CREDIT'});await receipt.execute();
    const credit=await f.ops.read(f.a.issued.context,'getBorrowerCredit',f.org,l.borrowerId);assert.equal((credit.data as {balance:string}).balance,'120.00');
    const apply=await f.make({kind:'APPLY_CREDIT',borrowerId:l.borrowerId,creditETag:credit.etag!,amount:'100.00',targets:[{loanId:l.id,positionETag:(await f.position(l.id)).etag!,amount:'100.00',mode:'REGULAR'}],effectiveDate:today(f.now()),supportReference:'SYN-APPLY'});await apply.execute();
    assert.equal(((await f.ops.read(f.a.issued.context,'getBorrowerCredit',f.org,l.borrowerId)).data as {balance:string}).balance,'20.00');
  });
  await t.test('two processes share an initial-balance fence and commit one economic effect',async()=>{
    const f=await setup(group),input={effectiveDate:today(f.now()),sourceId:randomUUID(),supportReference:'SYN',description:'Two processes',items:[{accountId:f.account,amount:'100.00'}]},key=randomUUID();
    const keys=Object.fromEntries(['mail','totp','journal','cursor'].map(name=>[name,Reflect.get(f.keys,name).toString('base64')]));
    const peer=await group.peer({keys,now:f.now(),config:f.config});
    try{
      const [local,remote]=await Promise.all([initialBalances(f.runtime.finance,f.a.issued.context,f.org,input,key),peer.execute({operation:'initialBalances',token:f.a.issued.token,organizationId:f.org,payload:input,key})]);
      assert.deepEqual([local.status,remote['status']].sort(),[200,201]);assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:f.org}),1);
      await f.database.transaction(async session=>f.sessions.revokeAll(f.a.issued.context.subjectId!,session));
      const revoked=await peer.execute({operation:'initialBalances',token:f.a.issued.token,organizationId:f.org,payload:input,key});assert.equal(revoked['type'],'error');assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:f.org}),1);
    }finally{await peer.close();}
  });
  await t.test('security commands bind payload/version and exercise member, session, factor and password actions',async()=>{
    const f=await setup(group),reg=await f.signup(),verified=await f.identity.confirmEmail(reg.issued.context,{purpose:'ACTIVATION',token:reg.token}),orgs=f.runtime.organizations;
    await f.proof(f.a,'MEMBER_INVITE',{email:reg.email,roleIds:['O']},f.org);await orgs.invite(f.a.issued.context,{email:reg.email,roleIds:['O']});await f.identity.dispatchMail();
    const note=[...f.messages.notificationInbox.values()].find(n=>n.kind==='INVITATION'&&n.payload['email']===reg.email)!;await orgs.accept(verified.issued.context,{mode:'CONFIRM',token:note.payload['token']},randomUUID());
    const id=verified.issued.context.subjectId!,target=()=>f.identity.identities.findOne({_id:id});
    await f.proof(f.a,'MEMBER_ROLE_CHANGE',{roleIds:['C']},id);await assert.rejects(orgs.roles(f.a.issued.context,id,{roleIds:['P']},(await target())!.version),errorCode('REAUTH_REQUIRED'));
    await orgs.roles(f.a.issued.context,id,{roleIds:['C']},(await target())!.version);
    for(const [purpose,command] of [['MEMBER_SUSPEND','SUSPEND'],['MEMBER_REACTIVATE','REACTIVATE'],['MEMBER_SESSIONS_REVOKE','REVOKE']] as const){
      await f.proof(f.a,purpose,undefined,id);await orgs.memberCommand(f.a.issued.context,id,command,(await target())!.version);
      await assert.rejects(f.database.transaction(async session=>f.sessions.consumeProof(f.a.issued.context,purpose,id,session)),errorCode('REAUTH_REQUIRED'));
    }
    const other=(await f.identity.login('TENANT',randomUUID(),f.a.email,password)).issued;
    await f.proof(f.a,'SESSION_REVOKE_OTHER',undefined,other.context.managementId);await f.identity.revokeSessions(f.a.issued.context,other.context.managementId);assert.equal(await f.sessions.find(other.token,'TENANT'),null);
    await f.proof(f.a,'MFA_ENROLL',{methodType:'TOTP',label:'Adicional'});const enrolled=await f.runtime.totp.enroll(f.a.issued.context,'Adicional'),secret=new URL(enrolled.provisioningUri).searchParams.get('secret')!;
    await f.runtime.totp.confirm(f.a.issued.context,enrolled.enrollmentId,await generate({secret,epoch:Math.floor(f.now()/1000)}));
    f.a.issued=(await f.identity.login('TENANT',randomUUID(),f.a.email,password)).issued;
    assert.equal((await f.runtime.recovery.methods(f.a.issued.context)).items.length,2);
    await f.proof(f.a,'MFA_REMOVE',undefined,enrolled.enrollmentId);await f.runtime.recovery.remove(f.a.issued.context,enrolled.enrollmentId,(await f.sessions.factors.findOne({_id:enrolled.enrollmentId}))!.version);
    await f.proof(f.a,'ORGANIZATION_SESSIONS_REVOKE',undefined,f.org);await orgs.revokeOrganization(f.a.issued.context,(await orgs.organizations.findOne({_id:f.org}))!.version);
    f.a.issued=(await f.identity.login('TENANT',randomUUID(),f.a.email,password)).issued;
    await f.proof(f.a,'SESSION_REVOKE_ALL');await f.identity.revokeSessions(f.a.issued.context);assert.equal(await f.sessions.find(f.a.issued.token,'TENANT'),null);
    f.a.issued=(await f.identity.login('TENANT',randomUUID(),f.a.email,password)).issued;
    await f.proof(f.a,'PASSWORD_CHANGE');await f.identity.changePassword(f.a.issued.context,{newPassword:password+' nueva'});
    await assert.rejects(f.identity.login('TENANT',randomUUID(),f.a.email,password),errorCode('AUTH_INVALID'));
    assert.equal((await f.identity.login('TENANT',randomUUID(),f.a.email,password+' nueva')).issued.context.kind,'W');
  });
  await t.test('offline recovery remains restricted, survivor login reconciles and replacement enforces cooldown/15min',async()=>{
    const f=await group.fixture(),a=await f.actor();await f.proof(a,'RECOVERY_CODES_REGENERATE');const codes=(await f.runtime.recovery.regenerate(a.issued.context)).codes;
    a.issued=(await f.identity.login('TENANT',randomUUID(),a.email,password)).issued;
    const started=await f.runtime.recovery.start(a.issued.context,codes[0]!,randomUUID());assert.equal(started.issued.context.kind,'E_RECOVERY');
    assert.equal(await f.sessions.find(a.issued.token,'TENANT'),null);await assert.rejects(f.identity.work!.prepare(started.issued.context,{purpose:'PASSWORD_CHANGE',method:'TOTP'}));
    const survivor=(await f.identity.login('TENANT',randomUUID(),a.email,password)).issued;assert.equal(survivor.context.kind,'L');f.clock.value+=30000;
    const reconciled=await f.runtime.totp.authenticate(survivor.context,await generate({secret:a.secret,epoch:Math.floor(f.now()/1000)}),'LOGIN',null);assert.equal(reconciled.issued.context.kind,'W');
    assert.equal(await f.sessions.find(started.issued.token,'TENANT'),null);
    a.issued=(await f.identity.login('TENANT',randomUUID(),a.email,password)).issued;await assert.rejects(f.runtime.recovery.start(a.issued.context,codes[0]!,randomUUID()),errorCode('AUTH_INVALID'));
    const flow=await f.runtime.recovery.start(a.issued.context,codes[1]!,randomUUID()),enroll=await f.runtime.totp.enroll(flow.issued.context,'Recovery'),secret=new URL(enroll.provisioningUri).searchParams.get('secret')!;
    await f.runtime.totp.confirm(flow.issued.context,enroll.enrollmentId,await generate({secret,epoch:Math.floor(f.now()/1000)}));
    assert.equal((await f.sessions.factors.findOne({_id:enroll.enrollmentId}))!.state,'PENDING_RECOVERY');
    await f.runtime.recovery.complete(flow.issued.context,enroll.enrollmentId,[]);
    a.issued=(await f.identity.login('TENANT',randomUUID(),a.email,password)).issued;assert.equal(a.issued.context.kind,'W');
    await f.proof(a,'RECOVERY_CODES_REGENERATE');await assert.rejects(f.runtime.recovery.regenerate(a.issued.context),errorCode('RECOVERY_RESTRICTED'));
    f.clock.value+=86400000;a.issued=(await f.identity.login('TENANT',randomUUID(),a.email,password)).issued;
    const again=await f.runtime.recovery.start(a.issued.context,codes[2]!,randomUUID()).catch(()=>null);assert.equal(again,null);
    // The original batch was invalidated by completion; no expired code is repaired.
    const own=await f.actor();await f.proof(own,'RECOVERY_CODES_REGENERATE');const fresh=(await f.runtime.recovery.regenerate(own.issued.context)).codes;
    own.issued=(await f.identity.login('TENANT',randomUUID(),own.email,password)).issued;const exp=await f.runtime.recovery.start(own.issued.context,fresh[0]!,randomUUID());f.clock.value+=900000;
    await f.runtime.recovery.expire();assert.equal(await f.sessions.find(exp.issued.token,'TENANT'),null);
    assert.equal((await f.identity.identities.findOne({_id:own.issued.context.subjectId!}))!.state,'AUTHENTICATED_NO_ORG');
  });

  await t.test('WORK mutations retain versions, financial isolation and zero ledger effects before funding',async()=>{
    const f=await setup(group),b0=await f.borrower(),b=view(b0),schema=await f.read('getCurrentBorrowerSchema');
    await f.mutate('publishBorrowerSchema',{fields:[],changeReason:'Versión sintética'},{etag:schema.etag!});
    const updated=await f.mutate('replaceBorrower',{profile:{displayName:'Cambio sintético',schemaVersion:2,extras:{}},changeReason:'Edición'},{id:b.id,etag:b0.etag!});
    const inactive=await f.mutate('deactivateBorrower',{reason:'Pausa'},{id:b.id,etag:updated.etag!});await f.mutate('reactivateBorrower',{reason:'Retorno'},{id:b.id,etag:inactive.etag!});
    const q=view(await f.quote(b.id)),binding={quoteId:q.id,quoteFingerprint:q.fingerprint},key=randomUUID(),draft=await f.mutate('createLoanDraft',binding,{key}),id=view(draft).id;
    const confirmed=await f.mutate('confirmLoanTerms',{...binding,termsVersion:1},{id,etag:draft.etag!});
    const q2=view(await f.quote(b.id,{principal:'1200.00'})),binding2={quoteId:q2.id,quoteFingerprint:q2.fingerprint},replacement=await f.mutate('replaceLoanTerms',{...binding2,changeReason:'Revisión'},{id,etag:confirmed.etag!});
    const terms=await f.mutate('confirmLoanTerms',{...binding2,termsVersion:2},{id,etag:replacement.etag!});await f.mutate('cancelLoan',{reason:'Cancelación'},{id,etag:terms.etag!});
    assert.equal((await f.mutate('createLoanDraft',binding,{key})).status,200);assert.equal(await f.runtime.finance.journals.countDocuments({organizationId:f.org}),0);
    assert.equal(await f.runtime.operations.events.countDocuments({organizationId:f.org}),0);
    const org=(await f.runtime.organizations.organizations.findOne({_id:f.org}))!;await f.runtime.organizations.edit(f.a.issued.context,{name:'Editada'},org.version);
    const account=(await f.runtime.finance.read(f.a.issued.context,'readAccount',f.org,f.account)).data as {code:string;name:string;accountClass:string;kind:string;currency:string};
    await f.runtime.finance.mutate(f.a.issued.context,'renameAccount',f.org,{name:account.name+' editada'},randomUUID(),f.account,(await f.runtime.finance.read(f.a.issued.context,'readAccount',f.org,f.account)).etag!);
    await f.proof(f.a,'MEMBER_INVITE',{email:'revocar-mej@example.test',roleIds:['O']},f.org);await f.runtime.organizations.invite(f.a.issued.context,{email:'revocar-mej@example.test',roleIds:['O']});
    const invitation=(await f.runtime.organizations.invitations.findOne({organizationId:f.org,status:'PENDING'}))!;await f.runtime.organizations.revokeInvitation(f.a.issued.context,invitation._id,invitation.version);
  });

});
