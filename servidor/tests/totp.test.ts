import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate, verify } from 'otplib';
import { fixture,totpActor } from './helpers/fixture.js';

test('TOTP policy uses current 30-second step only against RFC6238 secret/vector', async () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal((await verify({ secret, token: '287082', epoch: 59, epochTolerance: 0, period: 30, digits: 6 })).valid, true);
  assert.equal((await verify({ secret, token: '287082', epoch: 89, epochTolerance: 0, period: 30, digits: 6 })).valid, false);
});

test('replayed valid TOTP contributes to distributed failure limit instead of bypassing it',{timeout:90000},async()=>{
  const f=await fixture();try{
    const actor=await totpActor(f),login=await f.identity.login('TENANT','replay-limit',f.email,f.password);
    const used=await generate({secret:actor.secret,epoch:Math.floor(f.now()/1000)});
    for(let n=0;n<5;n++)await assert.rejects(f.totp.authenticate(login.issued.context,used,'LOGIN',null),error=>error instanceof Error&&'status'in error&&error.status===401);
    f.clock.value+=30000;
    const fresh=await generate({secret:actor.secret,epoch:Math.floor(f.now()/1000)});
    await assert.rejects(f.totp.authenticate(login.issued.context,fresh,'LOGIN',null),error=>error instanceof Error&&'status'in error&&error.status===429);
  }finally{await f.close();}
});
test('real TOTP enrollment, encrypted at rest, cross-instance replay rejection and MFA-only S', { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    const enrollment = await f.totp.enroll(f.initial.context, 'TOTP sintético');
    const secret = new URL(enrollment.provisioningUri).searchParams.get('secret'); assert.ok(secret);
    const stored = await f.sessions.factors.findOne({ _id: enrollment.enrollmentId }); assert.ok(stored);
    assert.ok(!JSON.stringify(stored).includes(secret));
    const code = await generate({ secret, epoch: Math.floor(f.now()/1000), period: 30, digits: 6 });
    const result = await f.totp.confirm(f.initial.context, enrollment.enrollmentId, code);
    assert.equal(result.issued?.context.kind, 'S');
    const login = await f.identity.login('TENANT', 'totp-login', f.email, f.password);
    await assert.rejects(f.totp.authenticate(login.issued.context, code, 'LOGIN', null));
    f.clock.value += 30000;
    const current = await generate({ secret, epoch: Math.floor(f.now()/1000), period: 30, digits: 6 });
    const results = await Promise.allSettled([f.totp.authenticate(login.issued.context, current, 'LOGIN', null),
      f.totp.authenticate(login.issued.context, current, 'LOGIN', null)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const identity = await f.identity.identities.findOne({ email: f.email }); assert.equal(identity?.hasEverConfirmedFactor, true);
    await assert.rejects(f.totp.enroll(f.initial.context, 'stale-bootstrap'));
  } finally { await f.close(); }
});
