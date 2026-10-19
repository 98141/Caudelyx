import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate } from 'otplib';
import { fixture,totpActor,stepUp } from './helpers/fixture.js';
import { RecoveryService } from '../src/modules/recovery/service.js';

async function begin(f:Awaited<ReturnType<typeof fixture>>){
  const actor=await totpActor(f),recovery=new RecoveryService(f.identity,f.lifecycle);
  const proof=await stepUp(f,actor.issued.context,actor.secret,'RECOVERY_CODES_REGENERATE');
  const codes=await recovery.regenerate(proof.context);
  const login=await f.identity.login('TENANT','recovery-login',f.email,f.password);
  const first=codes.codes[0];assert.ok(first);
  const started=await recovery.start(login.issued.context,first,'recovery-source');
  return {actor,recovery,codes:codes.codes,first,started};
}
async function pending(f:Awaited<ReturnType<typeof fixture>>,context:import('../src/modules/identity/models.js').Context,label:string){
  const e=await f.totp.enroll(context,label),secret=new URL(e.provisioningUri).searchParams.get('secret');assert.ok(secret);
  const code=await generate({secret,epoch:Math.floor(f.now()/1000)});
  const result=await f.totp.confirm(context,e.enrollmentId,code);
  assert.equal(result.issued,undefined);return {id:e.enrollmentId,secret};
}
test('recovery code consumed once; A31 activates selected real factor, discards others atomically and applies24h cooldown',{timeout:120000},async()=>{
  const f=await fixture();try{
    const r=await begin(f);
    assert.equal(await f.sessions.find(r.actor.issued.token,'TENANT'),null);
    const first=await pending(f,r.started.issued.context,'Elegido'),other=await pending(f,r.started.issued.context,'No elegido');
    assert.equal(await f.sessions.factors.countDocuments({state:'ACTIVE'}),1);
    const methods=await r.recovery.methods(r.started.issued.context);assert.ok(methods.items.every(m=>m.id!==first.id&&m.id!==other.id));
    const commits=await Promise.allSettled([r.recovery.complete(r.started.issued.context,first.id,[r.actor.factorId]),
      r.recovery.complete(r.started.issued.context,first.id,[r.actor.factorId])]);
    assert.equal(commits.filter(c=>c.status==='fulfilled').length,1);
    assert.equal((await f.sessions.factors.findOne({_id:first.id}))?.state,'ACTIVE');
    assert.equal((await f.sessions.factors.findOne({_id:other.id}))?.state,'REVOKED');
    assert.equal((await f.sessions.factors.findOne({_id:r.actor.factorId}))?.state,'REVOKED');
    assert.equal(await r.recovery.codes.countDocuments({consumed:false}),10);
    const subject=await f.identity.identities.findOne({email:f.email});assert.equal(subject?.cooldownUntil,f.now()+86400000);
    assert.equal(await f.sessions.find(r.started.issued.token,'TENANT'),null);
    const login=await f.identity.login('TENANT','after-recovery',f.email,f.password);
    await assert.rejects(r.recovery.start(login.issued.context,r.first,'already-consumed'));
    f.clock.value+=30000;
    const code=await generate({secret:first.secret,epoch:Math.floor(f.now()/1000)});
    const strong=await f.totp.authenticate(login.issued.context,code,'LOGIN',null);
    const proof=await stepUp(f,strong.issued.context,first.secret,'RECOVERY_CODES_REGENERATE');
    await assert.rejects(r.recovery.regenerate(proof.context));
    assert.equal(await r.recovery.codes.countDocuments({consumed:false}),10);
  }finally{await f.close();}
});
test('exact15min expiration never activates confirmed recovery factors or refunds consumed code',{timeout:120000},async()=>{
  const f=await fixture();try{
    const r=await begin(f),method=await pending(f,r.started.issued.context,'Pendiente al vencer');
    f.clock.value=r.started.issued.context.expiresAt;
    await assert.rejects(r.recovery.complete(r.started.issued.context,method.id,[]));
    await Promise.all([r.recovery.expire(),r.recovery.expire()]);
    assert.equal((await f.sessions.factors.findOne({_id:method.id}))?.state,'REVOKED');
    assert.equal((await f.identity.identities.findOne({email:f.email}))?.state,'AUTHENTICATED_NO_ORG');
    const login=await f.identity.login('TENANT','expired-login',f.email,f.password);
    await assert.rejects(r.recovery.start(login.issued.context,r.first,'expired-reuse'));
    assert.equal(await r.recovery.codes.countDocuments({consumed:false}),9);
  }finally{await f.close();}
});
test('surviving factor permits defensive login and discards pending material without A31',{timeout:120000},async()=>{
  const f=await fixture();try{
    const r=await begin(f),method=await pending(f,r.started.issued.context,'Pendiente defensivo');
    const login=await f.identity.login('TENANT','defensive-login',f.email,f.password);
    assert.equal(login.data.authState,'RECOVERY_RESTRICTED');f.clock.value+=30000;
    const code=await generate({secret:r.actor.secret,epoch:Math.floor(f.now()/1000)});
    const strong=await f.totp.authenticate(login.issued.context,code,'LOGIN',null);
    assert.equal(strong.issued.context.kind,'S');assert.equal((await f.sessions.factors.findOne({_id:method.id}))?.state,'REVOKED');
    assert.equal((await f.identity.identities.findOne({email:f.email}))?.state,'AUTHENTICATED_NO_ORG');
    assert.equal(await r.recovery.codes.countDocuments({consumed:false}),9);
  }finally{await f.close();}
});
