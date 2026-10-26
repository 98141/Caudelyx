import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {generate} from 'otplib';
import {profile,password,errorCode} from './fixture.js';
import {WORK_PURPOSES,BALANCE_PURPOSES,SECURITY_PURPOSES,workContract} from '../../src/modules/sessions/work-policy.js';
import {assertOwnUri} from '../helpers/mej-profile.js';
import {AppError} from '../../src/shared/errors.js';

test('MEJ auth: W, atomic completion, timers, catalog and revocation',async t=>{
  const group=await profile();
  await t.test('N01: password login W and legacy factor response match GET',async()=>{
    const f=await group.fixture(),a=await f.actor(),{client}=await f.https();
    await client.refreshCsrf();const login=await client.call('POST','/api/v1/auth/login',{email:a.email,password});
    assert.equal(login.status,200);assert.equal(login.body.data?.['sessionContext'],'W');
    assert.equal((await client.call('GET','/api/v1/auth/me')).body.data?.['userId'],a.issued.context.subjectId);
    const subject=(await f.identity.identities.findOne({_id:a.issued.context.subjectId!}))!;
    const legacy=await f.sessions.issue('TENANT','L',subject);client.cookies.clear();client.cookies.set('__Host-caudelyx-pre',legacy.token);client.csrf=legacy.csrf;f.clock.value+=30000;
    const checked=await client.call('POST','/api/v1/auth/mfa/challenges/verify',{method:'TOTP',purpose:'LOGIN',code:await generate({secret:a.secret,epoch:Math.floor(f.now()/1000)})});
    assert.equal(checked.status,200);assert.equal(checked.body.data?.['sessionContext'],'W');
    const me=await client.call('GET','/api/v1/auth/me');assert.equal(me.status,200);assert.equal(me.body.data?.['userId'],subject._id);
  });
  await t.test('response validation failure rolls back factor step, activation and rotation',async()=>{
    const f=await group.fixture(),a=await f.signup(),confirmed=await f.identity.confirmEmail(a.issued.context,{purpose:'ACTIVATION',token:a.token}),context=confirmed.issued.context;
    const enrollment=await f.runtime.totp.enroll(context,'Atomic',password),secret=new URL(enrollment.provisioningUri).searchParams.get('secret')!;
    const original=f.sessions.completionValidator;f.sessions.completionValidator=()=>{throw new AppError(503,'SERVICE_UNAVAILABLE');};
    try{await assert.rejects(f.runtime.totp.confirm(context,enrollment.enrollmentId,await generate({secret,epoch:Math.floor(f.now()/1000)})),errorCode('SERVICE_UNAVAILABLE'));}finally{if(original)f.sessions.completionValidator=original;else delete f.sessions.completionValidator;}
    assert.equal((await f.sessions.factors.findOne({_id:enrollment.enrollmentId}))?.confirmed,false);
    assert.equal((await f.sessions.contexts.findOne({_id:context._id}))?.revoked,false);
    assert.equal((await f.identity.identities.findOne({_id:context.subjectId!}))?.hasEverConfirmedFactor,false);
    await f.runtime.totp.confirm(context,enrollment.enrollmentId,await generate({secret,epoch:Math.floor(f.now()/1000)}));
  });
  await t.test('39 purposes partition exactly; closed intents reject WORK/password/wildcards',()=>{
    const all=[...WORK_PURPOSES,...BALANCE_PURPOSES,...SECURITY_PURPOSES];assert.equal(all.length,39);assert.equal(new Set(all).size,39);
    for(const purpose of [...WORK_PURPOSES,'FINANCE_*','LOAN_*'])assert.throws(()=>workContract().validate('StepUpPrepare',{purpose,method:'TOTP'}));
    assert.throws(()=>workContract().validate('StepUpPrepare',{purpose:'PASSWORD_CHANGE',method:'TOTP',password}));
    workContract().validate('StepUpPrepare',{purpose:'PASSWORD_CHANGE',method:'TOTP'});
  });
  await t.test('idle exact, GET no touch, explicit activity, absolute and old policy rejection',async()=>{
    const f=await group.fixture(),a=await f.actor(),{client}=await f.https();
    client.cookies.set('__Host-caudelyx-session',a.issued.token);client.csrf=a.issued.csrf;
    const original=(await f.sessions.contexts.findOne({_id:a.issued.context._id}))!;
    f.clock.value+=3599999;assert.equal((await client.call('GET','/api/v1/auth/me')).status,200);
    assert.equal((await f.sessions.contexts.findOne({_id:original._id}))?.lastSeenAt,original.lastSeenAt);
    assert.equal((await client.call('POST','/api/v1/auth/session/activity',{})).status,200);
    f.clock.value+=3600000;assert.equal(await f.sessions.find(a.issued.token,'TENANT'),null);
    const subject=(await f.identity.identities.findOne({_id:original.subjectId!}))!,fresh=await f.sessions.issue('TENANT','W',subject);
    await f.sessions.contexts.updateOne({_id:fresh.context._id},{$unset:{policyVersion:''}});assert.equal(await f.sessions.find(fresh.token,'TENANT'),null);
    const next=await f.sessions.issue('TENANT','W',subject);f.clock.value=next.context.expiresAt;assert.equal(await f.sessions.find(next.token,'TENANT'),null);
  });
  await t.test('logout revokes both browser contexts and stale cookies cannot revive either',async()=>{
    const f=await group.fixture(),a=await f.actor(),p=await f.sessions.issue('TENANT','P',null),{client}=await f.https();client.cookies.set('__Host-caudelyx-session',a.issued.token);client.cookies.set('__Host-caudelyx-pre',p.token);client.csrf=a.issued.csrf;
    assert.equal((await client.call('POST','/api/v1/auth/logout')).status,204);
    assert.equal(await f.sessions.find(a.issued.token,'TENANT'),null);assert.equal(await f.sessions.find(p.token,'TENANT'),null);
    assert.equal((await client.call('GET','/api/v1/auth/me')).status,401);
  });
  await t.test('factor history mismatch/realm/legacy A32/epochs do not bypass',async()=>{
    const f=await group.fixture(),a=await f.actor(),subject=(await f.identity.identities.findOne({_id:a.issued.context.subjectId!}))!;
    assert.equal(await f.identity.eligible(subject),false);
    assert.equal(await f.identity.eligible({...subject,hasEverConfirmedFactor:false,factorCount:0}),false);
    await assert.rejects(f.identity.reauthenticate(a.issued.context,{password,purpose:'PASSWORD_CHANGE'}),errorCode('ACCESS_DENIED'));
    await assert.rejects(f.identity.work!.prepare({...a.issued.context,realm:'PLATFORM'},{purpose:'PASSWORD_CHANGE',method:'TOTP'}));
    await f.identity.identities.updateOne({_id:subject._id},{$set:{authEpoch:randomUUID()}});assert.equal(await f.sessions.find(a.issued.token,'TENANT'),null);
  });
  await t.test('environment guard rejects protected/foreign profiles and closes partial setup before safe reuse',async()=>{
    for(const uri of ['mongodb://127.0.0.1:27017/?replicaSet=caudelyx-manual','mongodb://127.0.0.1:27181/?replicaSet=caudelyx-manual','mongodb://other.example.test:34567/?replicaSet=caudelyx-manual','mongodb://127.0.0.1:34567/?replicaSet=unknown'])assert.throws(()=>assertOwnUri(uri));
    await assert.rejects(group.fixture({failSetup:true}),/Injected own partial setup failure/);
    const next=await group.fixture();assert.equal((await next.actor()).issued.context.kind,'W');
  });

});
