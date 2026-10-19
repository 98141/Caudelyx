import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate } from 'otplib';
import { fixture,totpActor,stepUp } from './helpers/fixture.js';
import { Database } from '../src/shared/database.js';
import { Sessions } from '../src/modules/sessions/service.js';
import { FactorLifecycle } from '../src/modules/factors/service.js';
import { TotpService } from '../src/modules/totp/service.js';
import { IdentityService } from '../src/modules/identity/service.js';
import { SyntheticMessaging } from '../src/modules/messaging/service.js';
import { PasswordHasher } from '../src/modules/identity/password.js';

test('R requires password+factor, is one-use across instances and transaction failure restores consumption', {timeout:120000},async()=>{
  const f=await fixture();
  try{
    const actor=await totpActor(f);
    await assert.rejects(f.identity.revokeSessions(actor.issued.context));
    await f.identity.reauthenticate(actor.issued.context,{password:f.password,purpose:'SESSION_REVOKE_ALL'});
    await assert.rejects(f.identity.revokeSessions(actor.issued.context)); // Password step is not R.
    f.clock.value+=30000;
    const code=await generate({secret:actor.secret,epoch:Math.floor(f.now()/1000)});
    const strong=(await f.totp.authenticate(actor.issued.context,code,'SESSION_REVOKE_ALL',null)).issued;
    await assert.rejects(f.database.transaction(async session=>{
      await f.sessions.consumeProof(strong.context,'SESSION_REVOKE_ALL',null,session);throw new Error('synthetic rollback');
    }));
    const second=new Database(f.uri,f.database.db.databaseName);
    await second.connect();
    try{
      const sessions=new Sessions(second,f.now);
      const results=await Promise.allSettled([f.database.transaction(async s=>await f.sessions.consumeProof(strong.context,'SESSION_REVOKE_ALL',null,s)),
        second.transaction(async s=>await sessions.consumeProof(strong.context,'SESSION_REVOKE_ALL',null,s))]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    }finally{await second.close();}
  }finally{await f.close();}
});

test('real two-instance TOTP replay, strong-session cap, inactivity and absolute expiry', {timeout:120000},async()=>{
  const f=await fixture();
  try{
    const actor=await totpActor(f);
    const sessions2=new Sessions(f.database,f.now);
    const identity2=new IdentityService(f.database,sessions2,new SyntheticMessaging(f.database,f.mailKey,f.now),new PasswordHasher(),()=>true,f.now);
    await identity2.initialize();const totp2=new TotpService(new FactorLifecycle(identity2),f.totpKey);
    const tokens=[actor.issued.token];
    for(let n=0;n<5;n++){
      f.clock.value+=30000;
      const login=await f.identity.login('TENANT',`cap-${n}`,f.email,f.password);
      const code=await generate({secret:actor.secret,epoch:Math.floor(f.now()/1000)});
      const results=await Promise.allSettled([f.totp.authenticate(login.issued.context,code,'LOGIN',null),totp2.authenticate(login.issued.context,code,'LOGIN',null)]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      const winner=results.find(r=>r.status==='fulfilled');if(winner?.status==='fulfilled')tokens.push(winner.value.issued.token);
    }
    assert.equal(await sessions2.find(tokens[0],'TENANT'),null);
    const newest=tokens.at(-1);assert.ok(await sessions2.find(newest,'TENANT'));
    for(let n=0;n<24;n++){f.clock.value+=29*60000;assert.ok(await sessions2.find(newest,'TENANT'));}
    f.clock.value+=25*60000;assert.equal(await sessions2.find(newest,'TENANT'),null); // Absolute12h even with recent activity.
    const idleLogin=await f.identity.login('TENANT','idle-test',f.email,f.password);
    const idleCode=await generate({secret:actor.secret,epoch:Math.floor(f.now()/1000)});
    const idle=await f.totp.authenticate(idleLogin.issued.context,idleCode,'LOGIN',null);
    f.clock.value+=1800000;assert.equal(await sessions2.find(idle.issued.token,'TENANT'),null);
  }finally{await f.close();}
});

test('A32 payload-dependent proof is denied while frozen contract decision D01 is unresolved', {timeout:90000},async()=>{
  const f=await fixture();
  try{
    const actor=await totpActor(f);
    await assert.rejects(f.identity.reauthenticate(actor.issued.context,{password:f.password,purpose:'ORGANIZATION_CREATE'}));
    const valid=await stepUp(f,actor.issued.context,actor.secret,'SESSION_REVOKE_ALL');
    await f.identity.revokeSessions(valid.context);
    assert.equal(await f.sessions.find(valid.token,'TENANT'),null);
  }finally{await f.close();}
});
